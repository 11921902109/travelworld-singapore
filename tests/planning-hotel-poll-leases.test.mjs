import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

// Only I/O adapters are replaced; the production hotel job state machine and
// commodity parser execute unchanged. No supplier service is called.
const modules = {
  "./planning-state": "export const commitPlanningDraft=(...args)=>globalThis.__hotelPollTest.commit(...args);",
  "./planning-scenes": "export const readPlanningSceneContext=(...args)=>globalThis.__hotelPollTest.context(...args);",
  "./visit-session": "export const acquirePlanningAgentLease=(...args)=>globalThis.__hotelPollTest.agentLease(...args);",
  "./bailian": "export const askBailianAgent=async()=>null; export const advancePlanningAgentTask=(...args)=>globalThis.__hotelPollTest.advance(...args);",
  "cloudflare:workers": "export const env={DB:{prepare:sql=>globalThis.__hotelPollTest.prepare(sql)}};",
};
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, resolve: { alias: { "@": process.cwd() } },
  optimizeDeps: { noDiscovery: true }, logLevel: "error", plugins: [{ name: "hotel-job-io-test", enforce: "pre",
    resolveId(id) { const normalized = id.replaceAll("\\", "/"); const key = Object.keys(modules).find((value) => normalized === value || value.startsWith("./") && normalized.endsWith(`/${value.slice(2)}.ts`)); return key ? `\0hotel-test:${key}` : null; },
    load(id) { return id.startsWith("\0hotel-test:") ? modules[id.slice("\0hotel-test:".length)] : null; } }] });
after(async () => { delete globalThis.__hotelPollTest; await vite.close(); });
const { createHotelQuoteJob, pollHotelQuoteJob } = await vite.ssrLoadModule("/lib/travel/planning-hotel-jobs.ts");
const clone = (value) => JSON.parse(JSON.stringify(value));
const token = "11111111-1111-4111-8111-111111111111";

function setup() {
  const s = { rows: new Map(), dataHeld: 0, agentHeld: 0, advances: 0, submissions: new Set() };
  s.handoff = { sourceIntentStateVersion: 1, travelers: { total: 2, adults: 2, children: null, seniors: null } };
  s.draft = { version: 1, stage: "stays", handoffId: "handoff-1", sourceIntentStateVersion: 1, boardConfirmed: true,
    staySegments: [{ id: "stay-1", startDay: 1, area: "Bugis", checkInDate: "2026-12-20", checkOutDate: "2026-12-23",
      hotel: { placeId: "hotel-id-a" }, hotelCandidates: [{ placeId: "hotel-id-a", name: "Hotel A", address: "1 Test Road", commerce: null }] }] };
  s.context = async () => { s.dataHeld++; const value = clone({ handoff: s.handoff, draft: s.draft }); s.dataHeld--; return value; };
  s.commit = async (_token, { expectedVersion, nextDraft }) => { assert.equal(s.agentHeld, 0, "remote Agent lock is released before committing result"); if (expectedVersion !== s.draft.version) return { committed: false, draft: s.draft }; s.draft = { ...nextDraft, version: s.draft.version + 1, updatedAt: new Date().toISOString() }; return { committed: true, draft: s.draft }; };
  s.agentLease = async () => { assert.equal(s.dataHeld, 0); s.agentHeld++; await s.onAgentLock?.(); return { release: async () => { s.agentHeld--; } }; };
  s.advance = async (_prompt, turnId) => { assert.equal(s.dataHeld, 0, "supplier waiting holds no data lock"); assert.equal(s.agentHeld, 1); s.advances++; s.submissions.add(turnId); await s.onAdvance?.(); return s.complete ? { status: "completed", text: JSON.stringify({ results: [{ placeId: "hotel-id-a", status: "available", jumpUrl: "https://www.fliggy.com/hotel/123" }] }) } : { status: "running" }; };
  s.prepare = (sql) => {
    let values;
    return { bind(...input) { values = input; return this; }, async first() { return clone(s.rows.get(values[1]) || null); }, async run() {
      let changes = 0;
      if (sql.startsWith("INSERT OR IGNORE")) { const [, id, handoff_id, source_intent_state_version, input_hash, query_json, status, result_json, error_code, created_at, updated_at, deadline_at] = values; if (!s.rows.has(id)) { s.rows.set(id, { job_id: id, handoff_id, source_intent_state_version, input_hash, query_json, status, result_json, error_code, created_at, updated_at, deadline_at, poll_owner: null }); changes = 1; } }
      else if (sql.includes("SET poll_owner=?")) { const [owner, expires, , id, now] = values; const row = s.rows.get(id); if (row && (!row.poll_owner || row.poll_expires_at < now)) { row.poll_owner = owner; row.poll_expires_at = expires; changes = 1; } }
      else if (sql.includes("SET status=?,result_json=?")) { const [status, result_json, error_code, updated_at, deadline_at, , id, owner] = values; const row = s.rows.get(id); if (row?.poll_owner === owner) { Object.assign(row, { status, result_json, error_code, updated_at, deadline_at, poll_owner: null, poll_expires_at: null }); changes = 1; } }
      else if (sql.includes("SET poll_owner=NULL")) { const [, id, owner] = values; const row = s.rows.get(id); if (row?.poll_owner === owner) { row.poll_owner = null; row.poll_expires_at = null; changes = 1; } }
      else if (sql.includes("SET status='superseded'")) { const [updated_at, , id] = values; const row = s.rows.get(id); if (row) { Object.assign(row, { status: "superseded", updated_at }); changes = 1; } }
      else throw new Error(`Unexpected hotel persistence operation: ${sql}`);
      return { meta: { changes } };
    } };
  };
  globalThis.__hotelPollTest = s; return s;
}
async function create(s) { return createHotelQuoteJob(token, await s.context(), { startDay: 1, placeIds: ["hotel-id-a"], expectedVersion: s.draft.version, turnId: "hotel-job-test-1" }); }

test("saved hotel task resumes after refresh with one stable remote turn and no data lock during tools", async () => {
  const s = setup();
  await create(s);
  const savedVersion = s.draft.version;
  await createHotelQuoteJob(token, await s.context(), { startDay: 1, placeIds: ["hotel-id-a"], expectedVersion: 1, turnId: "hotel-job-test-1" });
  assert.equal(s.draft.version, savedVersion, "same task creation retry is idempotent");
  await pollHotelQuoteJob(token);
  s.complete = true;
  const result = await pollHotelQuoteJob(token);
  assert.equal(result.job.status, "completed");
  assert.equal(result.draft.staySegments[0].hotelCandidates[0].commerce.bookingUrl, "https://www.fliggy.com/hotel/123");
  assert.equal(s.submissions.size, 1);
  const advances = s.advances;
  await pollHotelQuoteJob(token);
  assert.equal(s.advances, advances, "a completed task never re-enters remote execution");
  assert.equal(s.agentHeld, 0); assert.equal(s.dataHeld, 0);
});

test("late quote merges into a newer hotel selection and preserves unrelated edits", async () => {
  const s = setup(); await create(s); s.complete = true;
  s.onAdvance = async () => { s.draft = { ...s.draft, version: s.draft.version + 1, stage: "route", otherChoice: "keep", staySegments: s.draft.staySegments.map((segment) => ({ ...segment, hotel: { placeId: "different-selected-hotel" } })) }; };
  const result = await pollHotelQuoteJob(token);
  assert.equal(result.draft.otherChoice, "keep");
  assert.equal(result.draft.staySegments[0].hotel.placeId, "different-selected-hotel");
  assert.equal(result.draft.staySegments[0].hotelCandidates[0].quoteStatus, "available");
  assert.equal(result.draft.stage, "route");
});

test("changed stay dates during tool wait supersede the result instead of mixing quotes", async () => {
  const s = setup(); await create(s); s.complete = true;
  s.onAdvance = async () => { s.draft = { ...s.draft, version: s.draft.version + 1, staySegments: s.draft.staySegments.map((segment) => ({ ...segment, checkOutDate: "2026-12-24" })) }; };
  const result = await pollHotelQuoteJob(token);
  assert.equal(result.job.status, "superseded");
  assert.equal(result.draft.staySegments[0].hotelCandidates[0].commerce, null);
});

test("a newer active job chosen during Agent queueing prevents old submission", async () => {
  const s = setup(); await create(s);
  s.onAgentLock = async () => { s.draft = { ...s.draft, version: s.draft.version + 1, hotelQuoteJob: { id: "new-hotel-task", status: "queued" } }; };
  const result = await pollHotelQuoteJob(token);
  assert.equal(s.advances, 0);
  assert.equal(result.job.id, "new-hotel-task");
  assert.equal(s.rows.get("hotel-job-test-1").status, "superseded");
});

test("a saved V36 discovery job is retired without tool calls and an existing hotel selection survives", async () => {
  for (const status of ["queued", "running", "timed_out", "completed"]) {
    const s = setup();
    await create(s);
    const row = s.rows.get("hotel-job-test-1");
    const { hotels: _hotels, ...query } = JSON.parse(row.query_json);
    row.query_json = JSON.stringify({ ...query, kind: "discovery", searchId: row.job_id });
    row.status = status;
    s.draft.hotelQuoteJob = { ...s.draft.hotelQuoteJob, status, kind: "discovery", placeIds: [], searchId: row.job_id };
    const oldSegment = clone(s.draft.staySegments[0]);
    const result = await pollHotelQuoteJob(token, true);
    assert.equal(result.job.status, "superseded");
    assert.deepEqual(result.job.placeIds, []);
    assert.deepEqual(result.draft.staySegments[0], oldSegment);
    assert.equal(s.rows.get(row.job_id).status, "superseded");
    assert.equal(s.advances, 0);
    const retry = await createHotelQuoteJob(token, await s.context(), {
      startDay: 1, placeIds: ["hotel-id-a"], expectedVersion: s.draft.version, turnId: "new-v35-quote",
    });
    assert.equal(retry.job.status, "queued");
    assert.deepEqual(retry.job.placeIds, ["hotel-id-a"]);
  }
});
