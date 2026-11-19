import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";
import { EMPTY_SINGAPORE_TRAVEL_INTENT } from "../lib/travel/singapore-intent.ts";
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true }, logLevel: "error" });
after(() => vite.close());
const { buildPlanningHandoff, createInitialPlanningDraft, evaluatePlaceDiscoveryReadiness } = await vite.ssrLoadModule("/lib/travel/planning-state.ts");

function intentResult(overrides = {}, issues = []) {
  return {
    intent: {
      ...EMPTY_SINGAPORE_TRAVEL_INTENT,
      startDate: "2026-12-20",
      endDate: "2026-12-23",
      durationDays: 4,
      travelers: { total: 2, adults: 2, children: null, seniors: null },
      dailyStartTime: "09:30",
      dailyEndTime: "21:00",
      preferredReturnTime: "21:00",
      latestReturnTime: "21:00",
      pace: "relaxed",
      interests: ["建筑", "夜景"],
      ...overrides,
    },
    issues,
    pendingCandidates: [],
    reply: "整段聊天回复不应进入规划交接",
  };
}

test("地点探索可以在尚未选酒店时开始，交接不携带聊天文本", () => {
  const result = intentResult({}, [{
    issueId: "accommodation-missing", code: "ACCOMMODATION_MISSING", kind: "missing",
    field: "accommodation", message: "还未选住宿", suggestedQuestion: "想住哪儿？",
  }]);
  assert.deepEqual(evaluatePlaceDiscoveryReadiness(result), { ready: true, issues: [] });
  const handoff = buildPlanningHandoff(result, 3);
  assert.equal(handoff.sourceIntentStateVersion, 3);
  assert.equal(handoff.dates.days, 4);
  assert.equal(handoff.accommodationPreference, null);
  assert.ok(handoff.openQuestions.includes("origin_city"));
  assert.ok(handoff.openQuestions.includes("accommodation"));
  assert.equal(JSON.stringify(handoff).includes(result.reply), false);
});

test("超出七天与未解释的歧义阻止交接", () => {
  const tooLong = intentResult({ endDate: "2026-12-29", durationDays: null });
  assert.equal(evaluatePlaceDiscoveryReadiness(tooLong).ready, false);
  const ambiguous = intentResult({}, [{
    issueId: "unknown", code: "MEANING_UNCLEAR", kind: "ambiguity", field: null,
    message: "‘那个地方’尚未确定", suggestedQuestion: "具体是哪儿？",
  }]);
  assert.equal(evaluatePlaceDiscoveryReadiness(ambiguous).ready, false);
});

test("默认推荐与明确拒绝推荐在规划交接中保持区别", () => {
  const result = intentResult({ allowAutomaticRecommendations: false });
  assert.equal(buildPlanningHandoff(result, 3).preferences.recommendationDeclined, false);
  assert.equal(buildPlanningHandoff(result, 3, true).preferences.recommendationDeclined, true);
  assert.equal(buildPlanningHandoff(intentResult({ allowAutomaticRecommendations: true }), 3, true).preferences.recommendationDeclined, false);
});

test("新交接保留已选地点为待复核草稿", () => {
  const old = createInitialPlanningDraft("2ed98892-52ce-4bc6-87b8-22de207a9bb1", 3);
  old.candidates = [{ candidateId: "p1", name: "鱼尾狮" }];
  old.assignments = [{ day: 1, orderedCandidateIds: ["p1"], status: "confirmed" }];
  old.boardConfirmed = true;
  old.reviewRequired = ["住宿预算", "自定义待确认"];
  old.reviewItems = [{id:"pending-budget",kind:"budget",day:1,sourceFingerprint:"a".repeat(64),status:"pending"}];
  const next = createInitialPlanningDraft("4e15bca9-3590-4aa9-9fc2-d3ddf814318f", 4, old);
  assert.equal(next.boardConfirmed, false);
  assert.deepEqual(next.candidates, old.candidates);
  assert.equal(next.assignments[0].status, "provisional");
  assert.ok(next.reviewRequired.includes("地点与分天"));
  assert.ok(next.reviewRequired.includes("住宿预算"));
  assert.ok(next.reviewRequired.includes("自定义待确认"));
  assert.equal(next.reviewItems[0].id,"pending-budget");
});
