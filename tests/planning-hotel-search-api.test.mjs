import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

// Exercise the production search handler and durable job reservation together.
// Only HTTP, context persistence and supplier discovery are controlled fixtures.
const modules = {
  "next/server": "export class NextRequest extends Request{};export const NextResponse={json:(body,options)=>Response.json(body,options)};",
  "lib/travel/planning-state": "export const commitPlanningDraft=(...args)=>globalThis.__hotelSearchTest.commit(...args);",
  "lib/travel/planning-scenes": "export const readPlanningSceneContext=(...args)=>globalThis.__hotelSearchTest.context(...args);",
  "lib/travel/visit-session": "export const readTravelVisitToken=()=>globalThis.__hotelSearchTest.token;",
  "lib/travel/google-maps": "export const searchSingaporePlaces=(...args)=>globalThis.__hotelSearchTest.search(...args);export const getSingaporePlaceDetails=()=>{throw new Error('Unexpected details lookup')};",
  "lib/travel/planning-trip": "export class PlanningScheduleError extends Error{}; export const derivePlanningStayBoundary=()=>({checkInDate:'2026-12-20',checkOutDate:'2026-12-23',nights:3,lastHotelNightDay:3});",
  "lib/travel/planning-stays": "export const suggestStayAdvice=()=>{throw new Error('Unexpected advice lookup')};",
  "lib/travel/bailian": "export const askBailianAgent=()=>{throw new Error('Remote quote must be deferred to the saved task')};",
  "cloudflare:workers": "export const env={DB:{prepare:sql=>globalThis.__hotelSearchTest.prepare(sql)}};",
};
function keyFor(id, importer = "") {
  const normalized = id.replaceAll("\\", "/");
  if (normalized in modules) return normalized;
  if (normalized.startsWith("@/")) return normalized.slice(2) in modules ? normalized.slice(2) : null;
  const full = normalized.startsWith("./") ? `${importer.replaceAll("\\", "/").split("/").slice(0, -1).join("/")}/${normalized.slice(2)}` : normalized;
  return Object.keys(modules).find((key) => full.endsWith(`/${key}`) || full.endsWith(`/${key}.ts`)) || null;
}
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false },
  resolve: { alias: { "@": process.cwd() } }, optimizeDeps: { noDiscovery: true }, logLevel: "error",
  plugins: [{ name: "hotel-search-io", enforce: "pre", resolveId(id, importer) { const key = keyFor(id, importer); return key ? `\0hotel-search:${key}` : null; },
    load(id) { return id.startsWith("\0hotel-search:") ? modules[id.slice("\0hotel-search:".length)] : null; } }] });
after(async () => { delete globalThis.__hotelSearchTest; await vite.close(); });
const { POST } = await vite.ssrLoadModule("/app/api/travel/singapore/planning/stays/route.ts");
const clone = (value) => JSON.parse(JSON.stringify(value));

function setup() {
  const state = { token: crypto.randomUUID(), rows: new Map(), commits: 0, searches: 0, found: [
    { placeId: "hotel-place-a", name: "Hotel A", address: "1 Test Road", types: ["hotel"], rating: 4.2,
      location: { lat: 1.3, lng: 103.85 }, googleMapsUri: null },
    { placeId: "hotel-place-b", name: "Hotel B", address: "2 Test Road", types: ["lodging"], rating: 4.1,
      location: { lat: 1.31, lng: 103.86 }, googleMapsUri: null },
  ] };
  state.handoff = { dates: { start: "2026-12-20", end: "2026-12-23", days: 4 }, travelers: { total: 2, adults: 2, children: null, seniors: null }, sourceIntentStateVersion: 1 };
  state.draft = { version: 1, handoffId: "handoff-test", sourceIntentStateVersion: 1, stage: "stays", boardConfirmed: true,
    flightSelection: { mode: "none" }, hotelQuoteJob: { id: "old-quote", status: "completed", startDay: 1, placeIds: ["hotel-place-a"] },
    staySegments: [{ id: "stay-day-1", startDay: 1, area: "Bugis", checkInDate: "2026-12-20", checkOutDate: "2026-12-23", nights: 3,
      hotel: { placeId: "previous-selection", name: "Previously selected" }, hotelCandidates: [] }] };
  state.context = async () => clone({ handoff: state.handoff, draft: state.draft, handoffId: state.draft.handoffId });
  state.search = async () => { state.searches++; return clone(state.found); };
  state.commit = async (_token, { expectedVersion, nextDraft }) => {
    if (expectedVersion !== state.draft.version) return { committed: false, draft: state.draft };
    state.commits++;
    state.draft = clone({ ...nextDraft, version: state.draft.version + 1, updatedAt: new Date().toISOString() });
    return { committed: true, draft: state.draft };
  };
  state.prepare = (sql) => { let values; return { bind(...input) { values = input; return this; },
    async first() { return clone(state.rows.get(values[1]) || null); }, async run() {
      if (!sql.startsWith("INSERT OR IGNORE")) throw new Error(`Unexpected SQL: ${sql}`);
      const [, id, handoff_id, source_intent_state_version, input_hash, query_json, status, result_json, error_code, created_at, updated_at, deadline_at] = values;
      if (!state.rows.has(id)) state.rows.set(id, { job_id: id, handoff_id, source_intent_state_version, input_hash, query_json, status, result_json, error_code, created_at, updated_at, deadline_at });
      return { meta: { changes: 1 } };
    } }; };
  globalThis.__hotelSearchTest = state;
  return state;
}
const post = (state, data) => POST(new Request("https://local.test/api/travel/singapore/planning/stays", { method: "POST",
  headers: { "content-type": "application/json", "x-travel-visit": state.token }, body: JSON.stringify(data) }));

test("new foreign budgets are rejected without rewriting the saved stay", async () => {
  const state = setup();
  const before = clone(state.draft);
  const response = await post(state, { action: "segments", expectedVersion: 1, turnId: "foreign-budget-submit", segments: [{ startDay: 1, area: "Bugis", budgetPerNight: { amount: 250, currency: "SGD" } }] });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, "CNY_BUDGET_REQUIRED");
  assert.deepEqual(state.draft, before);
  assert.equal(state.commits, 0);
});

test("legacy SGD must be explicitly replaced or removed before hotel lookup and confirmation", async () => {
  for (const action of ["searchHotels", "quoteHotels", "selectHotel", "confirm"]) {
    const state = setup(); state.draft.staySegments[0].budgetPerNight = { amount: 250, currency: "SGD" };
    const before = clone(state.draft);
    const response = await post(state, { action, startDay: 1, placeId: "previous-selection", expectedVersion: 1, turnId: `legacy-currency-${action}` });
    assert.equal(response.status, 422, action);
    assert.equal((await response.json()).error.code, "CNY_BUDGET_REQUIRED");
    assert.deepEqual(state.draft, before);
    assert.equal(state.searches, 0);
  }
});

test("replacing a legacy budget with CNY or explicitly removing it retains hotel identity", async () => {
  for (const budgetPerNight of [{ amount: 1200, currency: "CNY" }, null]) {
    const state = setup(); state.draft.staySegments[0].budgetPerNight = { amount: 250, currency: "SGD" };
    const response = await post(state, { action: "segments", expectedVersion: 1, turnId: "legacy-currency-replace", segments: [{ startDay: 1, area: "Bugis", budgetPerNight }] });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.draft.staySegments[0].budgetPerNight, budgetPerNight);
    assert.equal(payload.draft.staySegments[0].hotel.placeId, "previous-selection");
    assert.equal(payload.draft.staySegments[0].budgetReviewRequired, true);
  }
});

test("one search atomically saves the verified batch and one deferred price task; replay does not requery", async () => {
  const state = setup();
  const request = { action: "searchHotels", startDay: 1, expectedVersion: 1, turnId: "hotel-search-batch-1" };
  let response = await post(state, request);
  assert.equal(response.status, 202);
  let payload = await response.json();
  assert.equal(state.searches, 1);
  assert.equal(state.commits, 1);
  assert.equal(state.rows.size, 1);
  assert.equal(payload.job.status, "queued");
  assert.equal(payload.job.searchId, request.turnId);
  assert.deepEqual(payload.job.placeIds, ["hotel-place-a", "hotel-place-b"]);
  assert.equal(payload.draft.hotelQuoteJob.id, request.turnId);
  assert.equal(payload.draft.staySegments[0].hotelSearchId, request.turnId);
  assert.equal(payload.draft.staySegments[0].hotel.placeId, "previous-selection");
  const query = JSON.parse(state.rows.get(request.turnId).query_json);
  assert.equal(query.travelers.total, 2);
  assert.equal(query.checkInDate, "2026-12-20");
  assert.equal(query.checkOutDate, "2026-12-23");
  response = await post(state, request);
  assert.equal(response.status, 202);
  payload = await response.json();
  assert.equal(payload.replayed, true);
  assert.equal(state.searches, 1);
  assert.equal(state.commits, 1);
});

test("no Google candidates clears an old completion notice and preserves the existing hotel", async () => {
  const state = setup(); state.found = [];
  const response = await post(state, { action: "searchHotels", startDay: 1, expectedVersion: 1, turnId: "hotel-search-empty" });
  assert.equal(response.status, 200);
  const { draft } = await response.json();
  assert.equal(draft.hotelQuoteJob, undefined);
  assert.equal(draft.staySegments[0].hotel.placeId, "previous-selection");
  assert.deepEqual(draft.staySegments[0].hotelCandidates, []);
  assert.equal(state.rows.size, 0);
});

test("confirmation cannot skip a running batch even when an older selected hotel is retained", async () => {
  const state = setup();
  await post(state, { action: "searchHotels", startDay: 1, expectedVersion: 1, turnId: "hotel-search-running" });
  const response = await post(state, { action: "confirm", expectedVersion: 2, turnId: "hotel-confirm-before-prices" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "HOTEL_BATCH_PENDING");
  assert.equal(state.commits, 1);
});

test("another search cannot replace a current queued, running or timed-out batch before Google discovery", async () => {
  for (const status of ["queued", "running", "timed_out"]) {
    const state = setup();
    const firstId = `hotel-active-${status}`;
    await post(state, { action: "searchHotels", startDay: 1, expectedVersion: 1, turnId: firstId });
    state.rows.get(firstId).status = status;
    state.draft.hotelQuoteJob.status = status;
    const before = clone(state.draft);
    const response = await post(state, { action: "searchHotels", startDay: 2, expectedVersion: 2, turnId: `hotel-replacement-${status}` });
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.error.code, "HOTEL_QUOTE_ALREADY_RUNNING");
    assert.equal(payload.job.id, firstId);
    assert.deepEqual(state.draft, before);
    assert.equal(state.searches, 1, "the rejected search never reaches Google");
    assert.equal(state.commits, 1);
    assert.equal(state.rows.size, 1, "the active remote batch is not abandoned for a new task");
  }
});
