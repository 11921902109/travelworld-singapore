import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false, server: { middlewareMode: true, hmr: false },
  resolve: { alias: { "@": process.cwd(), "cloudflare:workers": path.join(process.cwd(), "tests/fixtures/flight-agent-env.ts") } },
  optimizeDeps: { noDiscovery: true }, logLevel: "error",
});
const originalFetch = globalThis.fetch;
after(async () => { globalThis.fetch = originalFetch; await vite.close(); });
const { buildFlightSearchQuery, flightSearchPrompt } = await vite.ssrLoadModule("/lib/travel/planning-flights.ts");
const { settleFlightJob, flightJobIsCurrent, flightBoardFingerprint, publicFlightJob, mergeFlightSearchResult, flightRetryBaseline, flightSearchContextFingerprint } = await vite.ssrLoadModule("/lib/travel/planning-flight-jobs.ts");
const { advancePlanningAgentTask } = await vite.ssrLoadModule("/lib/travel/bailian.ts");

const input = { originCity: "温州", startDate: "2026-12-20", endDate: "2026-12-23", travelers: { total: 2, adults: 2, children: null, seniors: null } };
const created = Date.parse("2026-11-03T03:35:12Z");
function job() {
  return { job_id: "flight-job-test-1", handoff_id: "handoff-1", source_intent_state_version: 1,
    input_hash: "test-hash", query_json: JSON.stringify({ ...buildFlightSearchQuery(input), boardFingerprint: flightBoardFingerprint({ assignments: [], candidates: [] }) }), status: "running", result_json: null,
    error_code: null, created_at: created, updated_at: created, deadline_at: created + 8 * 60_000 };
}

test("default query has two selected departure days; adjacent dates are opt-in and deduplicated", () => {
  const base = buildFlightSearchQuery(input);
  assert.deepEqual(base.outboundDates, ["2026-12-20"]);
  assert.deepEqual(base.inboundDates, ["2026-12-23"]);
  const flex = buildFlightSearchQuery({ ...input, includePreviousEvening: true, includeNextDayReturn: true });
  assert.deepEqual(flex.outboundDates, ["2026-12-19", "2026-12-20"]);
  assert.deepEqual(flex.inboundDates, ["2026-12-23", "2026-12-24"]);
  assert.deepEqual(buildFlightSearchQuery({ ...input, outboundDepartureDate: "2026-12-19", includePreviousEvening: true }).outboundDates, ["2026-12-19"]);
  assert.throws(() => buildFlightSearchQuery({ ...input, inboundDepartureDate: "2026-12-25" }), /INVALID/);
  const prompt = flightSearchPrompt(base);
  assert.ok(!prompt.includes('"children":null'));
  assert.ok(!prompt.includes("必须恰有四项"));
});

test("a 172-second result completes the saved job instead of becoming a 75-second empty result", () => {
  const waiting = settleFlightJob(job(), { status: "running" }, created + 75_000);
  assert.equal(waiting.status, "running");
  const completed = settleFlightJob(waiting, { status: "completed", text: JSON.stringify({ queries: [
    { direction: "outbound", departureDate: "2026-12-20", status: "empty" },
    { direction: "inbound", departureDate: "2026-12-23", status: "empty" },
  ], outbound: [], inbound: [] }) }, created + 172_000);
  assert.equal(completed.status, "completed");
  assert.equal(JSON.parse(completed.result_json).queryOutcomes.length, 2);
  assert.equal(JSON.parse(completed.result_json).failureReason, "no_eligible_offers");
  assert.equal(settleFlightJob(job(), { status: "running" }, created + 481_000).status, "timed_out");
  assert.match(publicFlightJob({ ...job(), status: "timed_out" }).message, /不代表航班接口失败/);
});

test("old handoff, inactive job or a later stage cannot receive the late result", () => {
  const draft = { stage: "flights", boardConfirmed: true, handoffId: "handoff-1", sourceIntentStateVersion: 1, flightSearchJob: { id: "flight-job-test-1" }, assignments: [], candidates: [] };
  assert.equal(flightJobIsCurrent(job(), draft), true);
  for (const change of [{ stage: "stays" }, { handoffId: "new-handoff" }, { sourceIntentStateVersion: 2 }, { flightSearchJob: { id: "new-query" } }, { assignments: [{ day: 1, orderedCandidateIds: ["new-place"] }] }]) {
    assert.equal(flightJobIsCurrent(job(), { ...draft, ...change }), false);
  }
});

function leaseForTest() {
  const turns = new Map();
  return {
    planningSessionId: "sesn_testonly1234", planningIntentVersion: 1,
    renew: async () => {}, readPlanningHandoff: async () => ({ source_intent_state_version: 1 }), readIntentState: async () => ({ stateVersion: 1 }),
    findTurn: async (id) => turns.get(id) || null,
    reserveTurn: async (id, session_id, input_hash) => { const turn = { session_id, input_hash, status: "reserved", input_event_id: null, input_created_at: null, reply_text: null, created_at: created }; turns.set(id, turn); return turn; },
    markTurnSubmitted: async (id, event, at) => Object.assign(turns.get(id), { status: "submitted", input_event_id: event, input_created_at: at }),
    markTurnComplete: async (id, reply) => Object.assign(turns.get(id), { status: "completed", reply_text: reply }),
    markTurnUncertain: async (id) => Object.assign(turns.get(id), { status: "uncertain" }),
    bindPlanningSession: async () => {},
  };
}

test("polling and completed retries reuse the one remote input event", async () => {
  const lease = leaseForTest();
  let posts = 0;
  let complete = false;
  let inputEvent;
  const answer = JSON.stringify({ queries: [], outbound: [], inbound: [] });
  globalThis.fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (options.method === "POST" && pathname.endsWith("/events")) {
      posts++;
      const body = JSON.parse(options.body);
      inputEvent = { ...body.input[0], id: "input-event-1", created_at: "2026-11-03T03:35:12Z" };
      return Response.json({ data: [{ id: inputEvent.id, created_at: inputEvent.created_at }] });
    }
    if (pathname.endsWith("/events")) return Response.json({ data: [
      { id: "old-end", type: "session_status", content: [{ data: { stop_reason: { type: "end_turn" } } }] },
      inputEvent,
      ...(complete ? [{ type: "message", role: "assistant", content: [{ type: "text", text: answer }] },
        { type: "session_status", content: [{ data: { stop_reason: { type: "end_turn" } } }] }] : []),
    ] });
    return Response.json({ status: "idle" });
  };
  assert.equal((await advancePlanningAgentTask("test flight query", "flight-turn-test-1", lease)).status, "running");
  assert.equal((await advancePlanningAgentTask("test flight query", "flight-turn-test-1", lease)).status, "running");
  complete = true;
  assert.equal((await advancePlanningAgentTask("test flight query", "flight-turn-test-1", lease)).status, "completed");
  assert.equal((await advancePlanningAgentTask("test flight query", "flight-turn-test-1", lease)).status, "completed");
  assert.equal(posts, 1);
});

test("an ambiguous POST is recovered by its marker without a second submission", async () => {
  const lease = leaseForTest();
  let posts = 0;
  let captured;
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === "POST") {
      posts++;
      captured = { ...JSON.parse(options.body).input[0], id: "recovered-input", created_at: "2026-11-03T03:35:12Z" };
      throw new Error("simulated connection loss after acceptance");
    }
    if (new URL(url).pathname.endsWith("/events")) return Response.json({ data: [captured,
      { type: "message", role: "assistant", content: [{ type: "text", text: '{"outbound":[],"inbound":[]}' }] },
      { type: "session_status", content: [{ data: { stop_reason: { type: "end_turn" } } }] },
    ] });
    return Response.json({ status: "idle" });
  };
  const first = await advancePlanningAgentTask("test uncertain query", "flight-turn-test-2", lease);
  assert.equal(first.status, "running");
  assert.equal(first.retryableCode, "submission_uncertain");
  assert.equal((await advancePlanningAgentTask("test uncertain query", "flight-turn-test-2", lease)).status, "completed");
  assert.equal(posts, 1);
});


test("retrying only inbound preserves the successful outbound and never queries it again", () => {
  const query = buildFlightSearchQuery({ ...input, direction: "inbound" });
  const prompt = flightSearchPrompt(query);
  const payload = JSON.parse(prompt.split("查询数据：")[1].split("\n只输出")[0]);
  assert.deepEqual(payload.requestedQueries.map((item) => [item.direction, item.departureDate]), [["inbound", "2026-12-23"]]);
  const previous = { outbound: [{ id: "selected-outbound" }], inbound: [], queriedAt: "old", status: "available", contextFingerprint: "same-context",
    queryOutcomes: [{ direction: "outbound", departureDate: "2026-12-20", status: "available", acceptedCount: 5 }, { direction: "inbound", departureDate: "2026-12-23", status: "failed", errorCode: "search-flight:status1" }] };
  const baseline = flightRetryBaseline(previous, query, "same-context");
  assert.equal(baseline.outbound, previous.outbound);
  assert.equal(baseline.queryOutcomes.length, 1);
  const failed = mergeFlightSearchResult(baseline, { outbound: [], inbound: [], queriedAt: "new", status: "unavailable", queryOutcomes: [{ direction: "inbound", departureDate: "2026-12-23", status: "failed", errorCode: "search-flight:status1" }] }, query, "same-context");
  assert.equal(failed.status, "available");
  assert.equal(failed.outbound[0].id, "selected-outbound");
  assert.equal(failed.queryOutcomes.find((item) => item.direction === "inbound").errorCode, "search-flight:status1");
  const complete = mergeFlightSearchResult(failed, { outbound: [], inbound: [{ id: "new-inbound" }], queriedAt: "later", status: "available", queryOutcomes: [{ direction: "inbound", departureDate: "2026-12-23", status: "available", acceptedCount: 1 }] }, query, "same-context");
  assert.equal(complete.outbound[0].id, "selected-outbound");
  assert.equal(complete.inbound[0].id, "new-inbound");
  assert.equal(complete.queryOutcomes.length, 2);
  assert.throws(() => mergeFlightSearchResult(previous, complete, query, "changed-context"), /CONTEXT_CHANGED/);
  assert.throws(() => mergeFlightSearchResult(undefined, complete, query, "same-context"), /CONTEXT_CHANGED/);
});

test("direction retries share context while changed dates, travellers, preferences, handoff or board cannot merge", async () => {
  const draft = { assignments: [], candidates: [], handoffId: "handoff-1", sourceIntentStateVersion: 1 };
  const query = buildFlightSearchQuery(input);
  const key = await flightSearchContextFingerprint(query, draft);
  assert.equal(await flightSearchContextFingerprint(buildFlightSearchQuery({ ...input, direction: "inbound" }), draft), key);
  for (const change of [{ originCity: "北京" }, { inboundDepartureDate: "2026-12-24" }, { travelers: { ...input.travelers, total: 3, adults: 3 } }, { preferences: { departureAfter: "18:00" } }]) {
    assert.notEqual(await flightSearchContextFingerprint(buildFlightSearchQuery({ ...input, ...change }), draft), key);
  }
  for (const change of [{ handoffId: "other" }, { sourceIntentStateVersion: 2 }, { assignments: [{ day: 1, orderedCandidateIds: ["new-place"] }] }]) {
    assert.notEqual(await flightSearchContextFingerprint(query, { ...draft, ...change }), key);
  }
});


test("flight prompts normalize known location names while preserving the original airport scope", () => {
  const query=buildFlightSearchQuery({...input,originCity:"温州机场",direction:"inbound"});
  const prompt=flightSearchPrompt(query);
  const payload=JSON.parse(prompt.split("查询数据：")[1].split("\n只输出")[0]);
  assert.equal(query.originCity,"温州机场");
  assert.deepEqual(payload.requestedQueries,[{direction:"inbound",origin:"新加坡",destination:"温州龙湾国际机场",departureDate:"2026-12-23"}]);
  assert.equal(payload.locationResolution.origin.kind,"airport");
  assert.equal(payload.locationResolution.origin.input,"温州机场");
  assert.ok(prompt.includes("不猜机场代码"));
});

test("directional retries preserve the other direction's search links but do not turn links into offers", () => {
  const query=buildFlightSearchQuery({...input,direction:"inbound"});
  const previous={outbound:[],inbound:[],queriedAt:"old",status:"unavailable",contextFingerprint:"same",searchLinks:[{direction:"outbound",departureDate:"2026-12-20",url:"https://router.feizhu.com/ws/out"},{direction:"inbound",departureDate:"2026-12-23",url:"https://router.feizhu.com/ws/old-in"}]};
  const result=mergeFlightSearchResult(previous,{outbound:[],inbound:[],status:"unavailable",queriedAt:"new",searchLinks:[{direction:"inbound",departureDate:"2026-12-23",url:"https://router.feizhu.com/ws/new-in"}]},query,"same");
  assert.deepEqual(result.searchLinks.map((x)=>x.url),["https://router.feizhu.com/ws/out","https://router.feizhu.com/ws/new-in"]);
  assert.equal(result.outbound.length+result.inbound.length,0);
});
