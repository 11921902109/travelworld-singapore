import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { createServer } from "vite";

const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false },
  resolve: { alias: { "@": process.cwd(), "cloudflare:workers": path.join(process.cwd(), "tests/fixtures/flight-agent-env.ts") } },
  optimizeDeps: { noDiscovery: true }, logLevel: "error" });
after(() => vite.close());
const { advanceSceneDiscovery, initialSceneDiscoveryState, resumeSceneDiscovery } = await vite.ssrLoadModule("/lib/travel/planning-scene-discovery.ts");
const { publicSceneDiscoveryJob, sceneDiscoveryContext, sceneJobIsCurrent } = await vite.ssrLoadModule("/lib/travel/planning-scene-jobs.ts");
const handoff = { sourceIntentStateVersion: 1, dates: { days: 3 }, preferences: { interests: ["建筑"], mustVisit: [], avoid: [], mobilityConstraints: [], recommendationDeclined: false }, pace: "relaxed", dailyWindow: { startTime: "09:30", endTime: "21:00" } };
const suggestion = (query) => ({ query, kind: "sight", area: "滨海湾", reason: "欣赏建筑", estimatedMinutes: 90, pros: "适合慢逛", cons: "需步行" });
const place = (query) => ({ placeId: `google-${query}`, name: query, address: "1 Singapore Road", location: { lat: 1.3, lng: 103.8 }, primaryType: "tourist_attraction", types: ["tourist_attraction"], businessStatus: "OPERATIONAL", googleMapsUri: null, rating: 4.5, userRatingCount: 200, openingHours: null });
const completed = (suggestions) => ({ status: "completed", text: JSON.stringify({ suggestions }) });

test("86-second response reuses the original turn and is not a verified candidate before Google", async () => {
  const turns = [];
  let remoteFinished = false;
  const deps = { agent: async (_message, id) => { turns.push(id); return remoteFinished ? completed([suggestion("Gallery")]) : { status: "running" }; }, search: async () => { throw new Error("not yet"); } };
  const first = await advanceSceneDiscovery(initialSceneDiscoveryState(), handoff, "scene-stable-job", deps);
  assert.equal(first.status, "running"); assert.equal(first.state.candidates.length, 0);
  remoteFinished = true;
  const second = await advanceSceneDiscovery(first.state, handoff, "scene-stable-job", deps);
  assert.equal(second.state.phase, "verify"); assert.equal(second.state.candidates.length, 0);
  assert.deepEqual([...new Set(turns)], ["scene-stable-job:suggest"]);
});

test("partial Google failure retains successes, and resume retries only failed lookups", async () => {
  const calls = [];
  let fail = true;
  const deps = { agent: async () => completed([suggestion("Gallery"), suggestion("Merlion")]), search: async (query) => { calls.push(query); if (fail && query === "Merlion") throw new Error("timeout"); return [place(query)]; } };
  const parsed = await advanceSceneDiscovery(initialSceneDiscoveryState(), handoff, "scene-lookup-job", deps);
  const partial = await advanceSceneDiscovery(parsed.state, handoff, "scene-lookup-job", deps);
  assert.equal(partial.status, "partial"); assert.equal(partial.errorCode, "google_verification");
  assert.deepEqual(partial.state.candidates.map((item) => item.name), ["Gallery"]);
  fail = false;
  const resumed = await advanceSceneDiscovery(resumeSceneDiscovery(partial.state), handoff, "scene-lookup-job", { ...deps, agent: async () => { throw new Error("must not regenerate suggestions"); } });
  assert.equal(resumed.state.candidates.length, 2); assert.equal(resumed.state.phase, "popular_search");
  assert.deepEqual(calls, ["Gallery", "Merlion", "Merlion"]);
});

test("a malformed suggestion gets one saved repair turn and stops with a specific error", async () => {
  const turns = [];
  const deps = { agent: async (_message, id) => { turns.push(id); return { status: "completed", text: "incomplete JSON" }; }, search: async () => [] };
  const invalid = await advanceSceneDiscovery(initialSceneDiscoveryState(), handoff, "scene-repair-job", deps);
  assert.equal(invalid.state.phase, "repair_suggestions");
  const repaired = await advanceSceneDiscovery(invalid.state, handoff, "scene-repair-job", deps);
  assert.equal(repaired.status, "failed"); assert.equal(repaired.errorCode, "invalid_suggestions");
  assert.deepEqual(turns, ["scene-repair-job:suggest", "scene-repair-job:repair"]);
});

test("popular fallback and its descriptions resume without rerunning completed Google work", async () => {
  let searches = 0; let ready = false; const turns = [];
  const deps = { search: async () => { searches++; return [place("Popular")]; }, agent: async (_message, id) => { turns.push(id); return ready ? { status: "completed", text: JSON.stringify({ assessments: [{ ...suggestion("Popular"), placeId: "google-Popular" }] }) } : { status: "running" }; } };
  const saved = { ...initialSceneDiscoveryState(), phase: "popular_search" };
  const found = await advanceSceneDiscovery(saved, handoff, "scene-popular-job", deps);
  assert.equal(found.state.phase, "assess"); assert.equal(found.state.candidates.length, 0);
  const waiting = await advanceSceneDiscovery(found.state, handoff, "scene-popular-job", deps);
  ready = true;
  const done = await advanceSceneDiscovery(waiting.state, handoff, "scene-popular-job", deps);
  assert.equal(done.status, "completed"); assert.equal(done.state.candidates[0].source, "popular");
  assert.equal(searches, 1); assert.deepEqual([...new Set(turns)], ["scene-popular-job:assess"]);
});

test("permanently closed places and excluded categories never become verified recommendations", async () => {
  const deps = { agent: async () => completed([suggestion("Closed"), suggestion("Museum")]), search: async (query) => [{ ...place(query), ...(query === "Closed" ? { businessStatus: "CLOSED_PERMANENTLY" } : { primaryType: "museum", types: ["museum"] }) }] };
  const h = { ...handoff, preferences: { ...handoff.preferences, avoid: ["博物馆"], recommendationDeclined: true, mustVisit: ["Closed", "Museum"] } };
  const parsed = await advanceSceneDiscovery(initialSceneDiscoveryState(), h, "scene-ineligible", deps);
  const result = await advanceSceneDiscovery(parsed.state, h, "scene-ineligible", deps);
  assert.equal(result.status, "failed"); assert.equal(result.errorCode, "no_eligible_places"); assert.deepEqual(result.state.candidates, []);
});

test("verification considers the first eligible match when Google's first result is not a travel scene", async () => {
  const h = { ...handoff, preferences: { ...handoff.preferences, recommendationDeclined: true, mustVisit: ["Gallery"] } };
  const deps = { agent: async () => completed([suggestion("Gallery")]), search: async () => [{ ...place("Hotel"), primaryType: "hotel", types: ["lodging", "hotel"] }, place("Gallery")] };
  const parsed = await advanceSceneDiscovery(initialSceneDiscoveryState(), h, "scene-match-order", deps);
  const verified = await advanceSceneDiscovery(parsed.state, h, "scene-match-order", deps);
  assert.equal(verified.status, "completed"); assert.equal(verified.state.candidates[0].name, "Gallery");
});

test("task validity follows handoff content rather than candidate selection or draft version", async () => {
  const row = { job_id: "scene-current-job", handoff_id: "handoff-1", source_intent_state_version: 1, input_hash: await sceneDiscoveryContext(handoff), status: "running", result_json: JSON.stringify(initialSceneDiscoveryState()), error_code: null, created_at: Date.now(), deadline_at: Date.now() + 1000 };
  const draft = { stage: "places", handoffId: "handoff-1", sourceIntentStateVersion: 1, sceneDiscoveryJob: { id: row.job_id }, version: 5, selectedPlaceIds: ["chosen-a"] };
  assert.equal(await sceneJobIsCurrent(row, { ...draft, version: 9, selectedPlaceIds: ["chosen-b"] }, handoff), true);
  assert.equal(await sceneJobIsCurrent(row, draft, { ...handoff, dates: { days: 4 } }), false);
  assert.equal(await sceneJobIsCurrent(row, { ...draft, sceneDiscoveryJob: { id: "newer-job" } }, handoff), false);
  assert.equal(await sceneJobIsCurrent(row, { ...draft, stage: "flights" }, handoff), false);
  assert.equal(publicSceneDiscoveryJob({ ...row, status: "timed_out" }).canResume, true);
  assert.equal(publicSceneDiscoveryJob({ ...row, status: "failed", error_code: "invalid_suggestions" }).canResume, false);
  assert.match(publicSceneDiscoveryJob({ ...row, status: "failed", error_code: "google_verification" }).message, /Google 核实/);
});

test("submitted result waits 120 seconds independently of HTTP polls and resumes the same turn", async () => {
  const originalNow = Date.now; let now = originalNow(); Date.now = () => now;
  try {
    const turns=[];let done=false;
    const deps={agent:async(_message,id)=>{turns.push(id);return done?completed([suggestion("Gallery")]):{status:"running",stage:"remote_wait",submitted:true};},search:async()=>[]};
    const first=await advanceSceneDiscovery(initialSceneDiscoveryState(),handoff,"scene-result-budget",deps);
    now+=86_000;const slow=await advanceSceneDiscovery(first.state,handoff,"scene-result-budget",deps);assert.equal(slow.status,"running");
    now+=35_000;const expired=await advanceSceneDiscovery(slow.state,handoff,"scene-result-budget",deps);assert.equal(expired.status,"timed_out");assert.equal(expired.errorCode,"response_wait_timeout");
    const row={job_id:"scene-result-budget",status:expired.status,error_code:expired.errorCode,result_json:JSON.stringify(expired.state),created_at:now-121_000,deadline_at:now+300_000};
    assert.match(publicSceneDiscoveryJob(row).message,/120 秒/);assert.equal(publicSceneDiscoveryJob(row).submissionState,"submitted");
    const resumed=resumeSceneDiscovery(expired.state);done=true;const finish=await advanceSceneDiscovery(resumed,handoff,"scene-result-budget",deps);assert.equal(finish.state.phase,"verify");assert.deepEqual([...new Set(turns)],["scene-result-budget:suggest"]);
  } finally {Date.now=originalNow;}
});

test("submission, reading and uncertain states are explained without masking errors as model work",async()=>{
 const base={job_id:"scene-errors",created_at:Date.now(),deadline_at:Date.now()+480_000};
 const submit=await advanceSceneDiscovery(initialSceneDiscoveryState(),handoff,"scene-errors",{agent:async()=>({status:"failed",reason:"submission_failed",stage:"submit",code:"agent_http_400",submitted:false,retryable:false}),search:async()=>[]});
 assert.equal(submit.status,"failed");assert.match(publicSceneDiscoveryJob({...base,status:submit.status,error_code:submit.errorCode,result_json:JSON.stringify(submit.state)}).message,/未成功提交/);
 assert.match(publicSceneDiscoveryJob({...base,status:submit.status,error_code:submit.errorCode,result_json:JSON.stringify({...submit.state,agentProgress:{...submit.state.agentProgress,code:"agent_http_403"}})}).message,/认证或访问权限/);
 const read=await advanceSceneDiscovery(initialSceneDiscoveryState(),handoff,"scene-errors",{agent:async()=>({status:"failed",reason:"read_failed",stage:"reply_read",code:"agent_http_503",submitted:true,retryable:true}),search:async()=>[]});
 assert.equal(read.status,"failed");assert.match(publicSceneDiscoveryJob({...base,status:read.status,error_code:read.errorCode,result_json:JSON.stringify(read.state)}).message,/读取百炼回复失败/);
 const uncertain=await advanceSceneDiscovery(initialSceneDiscoveryState(),handoff,"scene-errors",{agent:async()=>({status:"running",retryableCode:"submission_uncertain",stage:"submission_recovery",submitted:"unknown"}),search:async()=>[]});
 assert.match(publicSceneDiscoveryJob({...base,status:uncertain.status,error_code:uncertain.errorCode,result_json:JSON.stringify(uncertain.state)}).message,/不会重复发送/);
 assert.equal(publicSceneDiscoveryJob({...base,status:"queued",error_code:null,result_json:JSON.stringify(initialSceneDiscoveryState())}).submissionState,"preparing");
});
