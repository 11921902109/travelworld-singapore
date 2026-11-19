import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";

const mocks = {
  "next/server": "export class NextRequest extends Request{};export const NextResponse={json(body,options){return Response.json(body,options)}};",
  "cloudflare:workers": 'export const env={get DB(){return globalThis.__planningHelpTestDb},DASHSCOPE_API_KEY:"test-only",BAILIAN_API_BASE_URL:"https://test.maas.aliyuncs.com/api/v1/agentstudio",BAILIAN_AGENT_ID:"test-agent",BAILIAN_ENVIRONMENT_ID:"test-environment",FLYAI_API_KEY:"do-not-expose"};',
};
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true }, logLevel: "error",
  resolve: { alias: [{ find: "@", replacement: process.cwd() }] },
  plugins: [{ name: "help-api-mocks", enforce: "pre", resolveId(id) { if (id in mocks) return "\0help-test:" + id; }, load(id) { return id.startsWith("\0help-test:") ? mocks[id.slice("\0help-test:".length)] : null; } }],
});
const { POST } = await vite.ssrLoadModule("/app/api/travel/singapore/planning/help/route.ts");
const { PLANNING_HELP_SYSTEM } = await vite.ssrLoadModule("/lib/travel/bailian.ts");
const { acquireTravelVisit } = await vite.ssrLoadModule("/lib/travel/visit-session.ts");
const { directPlanningHelp, planningHelpFacts } = await vite.ssrLoadModule("/lib/travel/planning-help.ts");
const { planningHelpQuestions, planningHelpStages } = await vite.ssrLoadModule("/lib/travel/planning-help-questions.ts");
const migrations = await Promise.all((await readdir("drizzle")).filter((file) => file.endsWith(".sql")).sort().map((file) => readFile(path.join("drizzle", file), "utf8")));
const originalFetch = globalThis.fetch;
const token = "11111111-2222-4333-8444-000000011818", otherToken = "11111111-2222-4333-8444-000000022818";
const handoffId = "10000000-0000-4000-8000-000000011818", otherHandoffId = "10000000-0000-4000-8000-000000022818";
const handoff = {
  schemaVersion: 1, sourceIntentStateVersion: 1, destination: "Singapore", dates: { start: "2026-12-20", end: "2026-12-23", days: 4 },
  originCity: null, travelers: { total: 2, adults: 2, children: null, seniors: null }, dailyWindow: { start: "09:30", preferredReturn: "21:00", latestReturn: "21:00" },
  pace: "relaxed", preferences: { interests: ["建筑"], mustVisit: [], allowAutomaticRecommendations: true, avoid: [], mobilityConstraints: [], dietaryPreferences: [], dietaryScope: null, preferredTransport: [] },
  budget: null, accommodationPreference: null, openQuestions: [], confirmedByUser: true,
};
const draftFor = (id, stage) => ({ version: 0, handoffId: id, sourceIntentStateVersion: 1, stage, candidates: [{ placeId: "gallery", name: "国家美术馆" }],
  selectedPlaceIds: ["gallery"], assignments: [], boardConfirmed: false, updatedAt: new Date().toISOString() });
let sqlite;
afterEach(() => { globalThis.fetch = originalFetch; delete globalThis.__planningHelpTestDb; sqlite?.close(); sqlite = null; });
after(async () => { await vite.close(); });

async function seed(visit, id, stage) {
  const lease = await acquireTravelVisit(visit, new AbortController().signal);
  try {
    await lease.readIntentState();
    await lease.commitIntentTurn({ turnId: "seed-help-intent", inputHash: "a".repeat(64), expectedStateVersion: 0, resultJson: "{}", slotMetaJson: "{}" });
    await lease.commitPlanningHandoff({ handoffId: id, sourceIntentStateVersion: 1, handoffJson: JSON.stringify(handoff), initialDraftJson: JSON.stringify(draftFor(id, stage)) });
    await lease.bindSession("sesn_existingintent");
    await lease.bindPlanningSession("sesn_existingplanning", 1);
  } finally { await lease.release(); }
}
async function setup(state = "places") {
  sqlite = new DatabaseSync(":memory:");
  for (const migration of migrations) sqlite.exec(migration);
  class Statement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; }
    bind(...values) { return new Statement(this.sql, values); }
    runSync() { return { meta: { changes: Number(sqlite.prepare(this.sql).run(...this.values).changes) } }; }
    async run() { return this.runSync(); }
    async first() { return sqlite.prepare(this.sql).get(...this.values) || null; }
  }
  globalThis.__planningHelpTestDb = { prepare: (sql) => new Statement(sql), batch: async (statements) => statements.map((item) => item.runSync()) };
  await seed(token, handoffId, state);
  const calls = { created: [], inputs: [], completion: [], sessions: new Map() };
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = init.method || "GET";
    if (parsed.pathname.endsWith("/chat/completions") && method === "POST") {
      calls.completion.push(JSON.parse(init.body));
      return Response.json({ choices: [{ message: { content: '{"answer":"基于当前规划的只读答复。"}' } }] });
    }
    assert.equal(parsed.hostname, "test.maas.aliyuncs.com");
    if (parsed.pathname.endsWith("/sessions") && method === "POST") {
      const create = JSON.parse(init.body);
      calls.created.push(create);
      const id = `sesn_readonlyhelp000${calls.created.length}`;
      calls.sessions.set(id, { id, metadata: create.metadata, status: "idle", agent: { ...create.agent }, resources: [], mcp_configs: [], vault_ids: [] });
      return Response.json({ id });
    }
    const id = parsed.pathname.split("/sessions/")[1].split("/")[0];
    const session = calls.sessions.get(id);
    assert.ok(session, "never use the intent or planning session");
    if (parsed.pathname.endsWith("/events") && method === "POST") {
      const event = { id: `event-${calls.inputs.length + 1}`, created_at: new Date().toISOString(), ...JSON.parse(init.body).input[0] };
      calls.inputs.push({ id, event });
      await calls.onSend?.();
      return Response.json({ data: [event] });
    }
    if (!parsed.pathname.endsWith("/events")) return Response.json(calls.unsafe ? { ...session, agent: { ...session.agent, tools: [{ type: "builtin_toolkit" }] } } : session);
    const event = calls.inputs.filter((item) => item.id === id).at(-1).event;
    return Response.json({ data: [event, { type: "message", role: "assistant", content: [{ type: "text", text: '{"answer":"这是基于当前已保存安排的说明。"}' }] },
      { type: "session_status", content: [{ type: "data", data: { stop_reason: { type: "end_turn" } } }] }] });
  };
  return calls;
}
let requestNumber = 0;
async function ask(question, extra = {}, visit = token) {
  const response = await POST(new Request("https://travel.invalid/api/travel/singapore/planning/help", {
    method: "POST", headers: { "content-type": "application/json", "x-travel-visit": visit, "cf-connecting-ip": `help-test-${++requestNumber}` },
    body: JSON.stringify({ stage: "places", handoffId, question, ...extra }),
  }));
  return { status: response.status, ...(await response.json()) };
}

test("all fifteen stage questions, plus the optional route replacements, have local-only answers", () => {
  for (const stage of planningHelpStages) {
    const facts = planningHelpFacts(handoff, draftFor(handoffId, stage), stage === "route" ? 2 : undefined);
    const context = { stage, handoffId, ...(stage === "route" ? { day: 2, locked: true } : {}) };
    const questions = planningHelpQuestions(context);
    assert.equal(questions.length, 3);
    assert.ok(questions.every((question) => directPlanningHelp(question, facts)));
    if (stage === "route") assert.ok(planningHelpQuestions({ ...context, locked: false, hasFailure: true }).every((q) => directPlanningHelp(q, facts)));
  }
});

test("help explains the editable time on each flight-bound day", () => {
  const draft = { ...draftFor(handoffId, "route"), flightSelection: { mode: "manual" } };
  const question = "这一天可以修改哪些时间？";
  assert.match(directPlanningHelp(question, planningHelpFacts(handoff, draft, 1)), /调整结束时间/);
  assert.match(directPlanningHelp(question, planningHelpFacts(handoff, draft, 4)), /调整出发时间/);
});

test("status and edit requests stay deterministic with no session or planning mutation", async () => {
  const calls = await setup();
  const picked = await ask("我已经选了哪些地点？", { facts: { name: "FAKE CLIENT VALUE" } });
  assert.equal(picked.mode, "direct"); assert.match(picked.answer, /国家美术馆/); assert.doesNotMatch(picked.answer, /FAKE/);
  const refused = await ask("帮我把 Day 2 改成 16 点出发。");
  assert.equal(refused.mode, "direct"); assert.match(refused.answer, /没有修改行程/);
  assert.equal(calls.created.length + calls.inputs.length + calls.completion.length, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM travel_planning_help_sessions").get().n, 0);
  assert.equal(sqlite.prepare("SELECT version FROM travel_planning_drafts").get().version, 0);
});

test("opens exactly one isolated help session, reuses it across steps, and isolates a different visit", async () => {
  const calls = await setup();
  assert.equal((await ask("展开讲讲这里和我已确认偏好的关系")).status, 200);
  sqlite.prepare("UPDATE travel_planning_drafts SET draft_json=?,version=1 WHERE handoff_id=?")
    .run(JSON.stringify({ ...draftFor(handoffId, "stays"), version: 1 }), handoffId);
  assert.equal((await ask("那这和上一条是什么意思", { stage: "stays", history: [{ question: "为何", answer: "相关解释" }] })).status, 200);
  assert.equal(calls.created.length, 1); assert.equal(calls.inputs.length, 2); assert.equal(calls.inputs[0].id, calls.inputs[1].id);
  const create = calls.created[0];
  assert.deepEqual(create.agent, { type: "agent_with_overrides", id: "test-agent", system: PLANNING_HELP_SYSTEM, tools: [], mcp_servers: [], skills: [] });
  assert.equal(create.environment_variables, undefined);
  assert.equal(calls.completion.length, 0);
  assert.equal((await ask("展开讲讲", { stage: "stays" }, otherToken)).status, 404);
  await seed(otherToken, otherHandoffId, "places");
  assert.equal((await ask("展开讲讲", { handoffId: otherHandoffId }, otherToken)).status, 200);
  assert.notEqual(calls.inputs[2].id, calls.inputs[0].id);
  const unchanged = sqlite.prepare("SELECT planning_session_id, session_id FROM travel_agent_visits").all();
  assert.ok(unchanged.every((item) => item.planning_session_id === "sesn_existingplanning" && item.session_id === "sesn_existingintent"));
});

test("an unsafe provider snapshot is never sent a question; text-only fallback has no tools", async () => {
  const calls = await setup(); calls.unsafe = true;
  assert.equal((await ask("展开讲讲这里的偏好")).status, 200);
  assert.equal((await ask("还可以解释刚刚的意思吗")).status, 200);
  assert.equal(calls.created.length, 1);
  assert.equal(calls.inputs.length, 0);
  assert.equal(calls.completion.length, 2);
  assert.ok(calls.completion.every((body) => !("tools" in body) && !("enable_search" in body)));
});

test("concurrent help is serialized without holding a planning/data lease", async () => {
  const calls = await setup();
  let started, finish;
  const waiting = new Promise((resolve) => { started = resolve; });
  const hold = new Promise((resolve) => { finish = resolve; });
  calls.onSend = async () => { started(); await hold; };
  const first = ask("帮我说明这些地点为什么推荐");
  await waiting;
  try {
    assert.equal(sqlite.prepare("SELECT lease_owner FROM travel_agent_visits").get().lease_owner, null);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM travel_planning_agent_locks").get().n, 0);
    const busy = await ask("再多说一点推荐理由");
    assert.equal(busy.status, 409); assert.equal(busy.error.code, "HELP_BUSY");
    const direct = await ask("我已经选了哪些地点？");
    assert.equal(direct.mode, "direct");
    assert.equal(calls.created.length, 1); assert.equal(calls.inputs.length, 1);
  } finally { finish(); }
  assert.equal((await first).status, 200);
});

test("stale context, invalid date and concurrent edits are kept away from the answer", async () => {
  const calls = await setup();
  assert.equal((await ask("请说明这里", { stage: "route", day: 2 })).status, 409);
  assert.equal((await ask("请说明这里", { day: 7 })).status, 422);
  assert.equal(calls.created.length, 0);
  calls.onSend = () => sqlite.prepare("UPDATE travel_planning_drafts SET draft_json=?,version=1 WHERE handoff_id=?")
    .run(JSON.stringify({ ...draftFor(handoffId, "stays"), version: 1 }), handoffId);
  const result = await ask("请说明这个规划的细节");
  assert.equal(result.status, 409); assert.equal(result.answer, undefined);
  assert.equal(sqlite.prepare("SELECT lease_owner FROM travel_planning_help_sessions").get().lease_owner, null);
});
