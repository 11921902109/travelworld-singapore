import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildBailianIntentPrompt,
  dateMentionFromMessage,
  EMPTY_SINGAPORE_TRAVEL_INTENT,
  parseSingaporeIntentResult,
} from "../lib/travel/singapore-intent.ts";

const currentDate = "2026-10-25";

test("明确外币预算保留原文币种并提醒人民币重填，明确人民币后解除提醒", () => {
  const message = "预算250新币";
  const first = parseSingaporeIntentResult(model([patch("budgetDetails.amount", "set", 250, "250新币"), patch("budgetDetails.currency", "set", "SGD", "新币")]), request(message), currentDate);
  assert.equal(first.intent.budgetDetails.amount, 250);
  assert.equal(first.intent.budgetDetails.currency, "SGD");
  assert.ok(first.issues.some((issue) => issue.code === "BUDGET_CURRENCY_CONFIRMATION"));
  const second = parseSingaporeIntentResult(model([patch("budgetDetails.amount", "set", 1200, "1200元人民币"), patch("budgetDetails.currency", "set", "CNY", "人民币")]), request("预算改成1200元人民币", first.intent), currentDate);
  assert.equal(second.intent.budgetDetails.amount, 1200);
  assert.equal(second.intent.budgetDetails.currency, "CNY");
  assert.ok(!second.issues.some((issue) => issue.code === "BUDGET_CURRENCY_CONFIRMATION"));
});

function request(message, currentIntent = EMPTY_SINGAPORE_TRAVEL_INTENT, conversationHistory = []) {
  return { message, currentIntent, currentOutline: [], conversationHistory };
}

function model(patches, unresolvedMentions = []) {
  return JSON.stringify({
    purpose: "update_intent", patches, unresolvedMentions,
    acknowledgement: "已记录你给出的旅行条件。",
  });
}

function patch(field, op, value, evidenceText) {
  return { field, op, value, evidenceText, certainty: "explicit" };
}

test("十天行程和船形酒店形成两条统一问题，回复与状态一致", () => {
  const message = "2026/10/23-2026/11/01，我一个人去新加坡，住头上顶个船的酒店。每天09:00出发，通常18:00回酒店，最晚20:00，节奏轻松。";
  const result = parseSingaporeIntentResult(model([
    patch("startDate", "set", "2026-10-23", "2026/10/23"),
    patch("endDate", "set", "2026-11-01", "2026/11/01"),
    patch("travelers.total", "set", 1, "我一个人"),
    patch("accommodation.hotelName", "propose", "滨海湾金沙酒店", "头上顶个船的酒店"),
    patch("dailyStartTime", "set", "09:00", "09:00出发"),
    patch("preferredReturnTime", "set", "18:00", "18:00回酒店"),
    patch("latestReturnTime", "set", "20:00", "最晚20:00"),
    patch("pace", "set", "relaxed", "节奏轻松"),
  ], [{ text: "头上顶个船的酒店", field: "accommodation.hotelName" }]), request(message), currentDate);
  assert.equal(result.complete, false);
  assert.equal(result.intent.durationDays, null);
  assert.equal(result.intent.accommodation.hotelName, null);
  assert.equal(result.issues.length, 2);
  assert.deepEqual(result.issues.map((issue) => issue.code), ["DURATION_OUT_OF_RANGE", "ACCOMMODATION_NAME_UNCONFIRMED"]);
  assert.equal(result.missingInformation.length, 0);
  assert.match(result.reply, /10 天/);
  assert.match(result.reply, /头上顶着船的酒店/);
  assert.equal(result.readiness.complete, false);
});

test("模型的未知确定性标记与纯文本待确认地点仍可保守解析", () => {
  const message = "2026/10/23-2026/11/01，我一个人去新加坡，住头上顶个船的酒店。";
  const response = JSON.stringify({
    purpose: "update_intent",
    patches: [
      { ...patch("startDate", "set", "2026-10-23", "2026/10/23"), certainty: "high" },
      patch("endDate", "set", "2026-11-01", "2026/11/01"),
      patch("travelers.total", "set", 1, "我一个人"),
      { ...patch("accommodation.hotelName", "propose", "滨海湾金沙酒店", "头上顶个船的酒店"), certainty: "high" },
    ],
    unresolvedMentions: ["头上顶个船的酒店", "用户没有说的地点"],
    acknowledgement: "已记录你给出的日期和人数。",
  });
  const result = parseSingaporeIntentResult(response, request(message), currentDate);
  assert.equal(result.intent.startDate, "2026-10-23");
  assert.equal(result.intent.endDate, "2026-11-01");
  assert.equal(result.intent.travelers.total, 1);
  assert.equal(result.intent.accommodation.hotelName, null);
  assert.deepEqual(result.issues.slice(0, 2).map((issue) => issue.code), ["DURATION_OUT_OF_RANGE", "ACCOMMODATION_NAME_UNCONFIRMED"]);
  assert.ok(!result.ambiguities.some((ambiguity) => ambiguity.includes("用户没有说的地点")));
});

test("确认船形酒店只确认名称，不解除十天限制", () => {
  const firstMessage = "2026/10/23-2026/11/01，住头上顶个船的酒店。";
  const first = parseSingaporeIntentResult(model([
    patch("startDate", "set", "2026-10-23", "2026/10/23"),
    patch("endDate", "set", "2026-11-01", "2026/11/01"),
    patch("accommodation.hotelName", "propose", "滨海湾金沙酒店", "头上顶个船的酒店"),
  ]), request(firstMessage), currentDate);
  const confirmation = { ...JSON.parse(model([
    patch("accommodation.hotelName", "set", "滨海湾金沙酒店", "滨海湾金沙酒店"),
  ])), purpose: "answer_clarification" };
  const second = parseSingaporeIntentResult(JSON.stringify(confirmation), request(
    "我说的是滨海湾金沙酒店", first.intent,
    [{ role: "user", content: firstMessage }, { role: "assistant", content: first.reply }],
  ), currentDate);
  assert.equal(second.intent.accommodation.hotelName, "滨海湾金沙酒店");
  assert.ok(second.issues.some((issue) => issue.code === "DURATION_OUT_OF_RANGE"));
  assert.ok(!second.issues.some((issue) => issue.code === "ACCOMMODATION_NAME_UNCONFIRMED"));
});

test("十天限制优先时，裸回答不能误确认酒店", () => {
  const firstMessage = "2026/10/23-2026/11/01，住头上顶个船的酒店。";
  const first = parseSingaporeIntentResult(model([
    patch("startDate", "set", "2026-10-23", "2026/10/23"),
    patch("endDate", "set", "2026-11-01", "2026/11/01"),
    patch("accommodation.hotelName", "propose", "滨海湾金沙酒店", "头上顶个船的酒店"),
  ]), request(firstMessage), currentDate);
  assert.equal(first.primaryIssueId, "duration-out-of-range");
  const answer = request("是的", first.intent, [
    { role: "user", content: firstMessage },
    { role: "assistant", content: first.reply },
  ]);
  answer.replyToIssueId = first.primaryIssueId;
  const second = parseSingaporeIntentResult(model([
    patch("accommodation.hotelName", "set", "滨海湾金沙酒店", "是的"),
  ]), answer, currentDate);
  assert.equal(second.intent.accommodation.hotelName, null);
  assert.deepEqual(second.issues.slice(0, 2).map((issue) => issue.code), [
    "DURATION_OUT_OF_RANGE", "ACCOMMODATION_NAME_UNCONFIRMED",
  ]);
});

test("酒店问题成为主问题后，带对应 issueId 的裸回答可确认酒店", () => {
  const firstMessage = "2026/10/23-2026/10/26，我一个人，住头上顶个船的酒店，每天09:00出发、20:00回酒店，节奏轻松。";
  const first = parseSingaporeIntentResult(model([
    patch("startDate", "set", "2026-10-23", "2026/10/23"),
    patch("endDate", "set", "2026-10-26", "2026/10/26"),
    patch("travelers.total", "set", 1, "我一个人"),
    patch("accommodation.hotelName", "propose", "滨海湾金沙酒店", "头上顶个船的酒店"),
    patch("dailyStartTime", "set", "09:00", "09:00出发"),
    patch("latestReturnTime", "set", "20:00", "20:00回酒店"),
    patch("pace", "set", "relaxed", "节奏轻松"),
  ]), request(firstMessage), currentDate);
  assert.equal(first.primaryIssueId, "accommodation-unconfirmed");
  const history = [
    { role: "user", content: firstMessage },
    { role: "assistant", content: first.reply },
  ];
  const withoutIssue = parseSingaporeIntentResult(model([
    patch("accommodation.hotelName", "set", "滨海湾金沙酒店", "是的"),
  ]), request("是的", first.intent, history), currentDate);
  assert.equal(withoutIssue.intent.accommodation.hotelName, null);

  const answer = request("是的", first.intent, history);
  answer.replyToIssueId = first.primaryIssueId;
  const confirmed = parseSingaporeIntentResult(model([
    patch("accommodation.hotelName", "set", "滨海湾金沙酒店", "是的"),
  ]), answer, currentDate);
  assert.equal(confirmed.intent.accommodation.hotelName, "滨海湾金沙酒店");
  assert.ok(!confirmed.issues.some((issue) => issue.code === "ACCOMMODATION_NAME_UNCONFIRMED"));
});

test("完整四天输入生成结构化意图和四日草案", () => {
  const message = "我和伴侣两位成人，2026 年 12 月 20 日至 23 日去新加坡，住 Bugis 附近；每天 09:30 出发、21:00 回酒店，节奏轻松，喜欢建筑、美食和夜景。";
  const result = parseSingaporeIntentResult(model([
    patch("startDate", "set", "2026-12-20", "2026 年 12 月 20 日"),
    patch("endDate", "set", "2026-12-23", "23 日"),
    patch("travelers.total", "set", 2, "两位成人"),
    patch("travelers.adults", "set", 2, "两位成人"),
    patch("accommodation.areaName", "set", "Bugis", "Bugis"),
    patch("dailyStartTime", "set", "09:30", "09:30 出发"),
    patch("preferredReturnTime", "set", "21:00", "21:00 回酒店"),
    patch("latestReturnTime", "set", "21:00", "21:00 回酒店"),
    patch("pace", "set", "relaxed", "节奏轻松"),
    patch("interests", "add_item", "建筑", "建筑"),
    patch("interests", "add_item", "美食", "美食"),
    patch("interests", "add_item", "夜景", "夜景"),
  ]), request(message), currentDate);
  assert.equal(result.intent.durationDays, 4);
  assert.equal(result.intent.travelers.adults, 2);
  assert.equal(result.intent.accommodation.hotelName, null);
  assert.deepEqual(result.intent.interests, ["建筑", "美食", "夜景"]);
  assert.equal(result.complete, true);
  assert.equal(result.outline.length, 4);
  assert.deepEqual(result.issues, []);
});

test("否定的作用范围不扩大到被允许的历史遗迹", () => {
  const message = "不要历史文物展览，但是历史遗迹可以。";
  const result = parseSingaporeIntentResult(model([
    patch("avoid", "add_item", "历史文物展览", "不要历史文物展览"),
    patch("interests", "add_item", "历史遗迹", "历史遗迹可以"),
  ]), request(message), currentDate);
  assert.deepEqual(result.intent.avoid, ["历史文物展览"]);
  assert.deepEqual(result.intent.interests, ["历史遗迹"]);
});

test("改住新区域会清除旧酒店与旧 Google Place ID", () => {
  const old = {
    ...EMPTY_SINGAPORE_TRAVEL_INTENT,
    accommodation: { hotelName: "Village Hotel Bugis", areaName: "Bugis", googlePlaceId: "old-place-id" },
  };
  const result = parseSingaporeIntentResult(model([
    patch("accommodation.areaName", "set", "Orchard", "改住 Orchard"),
  ]), request("我不住 Bugis 了，改住 Orchard。", old), currentDate);
  assert.deepEqual(result.intent.accommodation, { hotelName: null, areaName: "Orchard", googlePlaceId: null });
});

test("明确撤回自动推荐会把 true 清成 false", () => {
  const old = { ...EMPTY_SINGAPORE_TRAVEL_INTENT, allowAutomaticRecommendations: true };
  const result = parseSingaporeIntentResult(model([
    patch("allowAutomaticRecommendations", "set", false, "不要自动推荐"),
  ]), request("不要自动推荐。", old), currentDate);
  assert.equal(result.intent.allowAutomaticRecommendations, false);
});

test("无原文证据的具体字段变更会被拒绝", () => {
  assert.throws(() => parseSingaporeIntentResult(model([
    patch("accommodation.areaName", "set", "Orchard", "用户说了 Orchard"),
  ]), request("住 Bugis。"), currentDate), /Patch evidence not found/);
});

test("已有草案的明确 Day 编辑仍走原草案契约", () => {
  const input = request("把 Day 2 的主题改成夜景");
  input.currentOutline = [
    { day: 1, theme: "建筑", areas: ["Bugis"], experiences: ["建筑"], summary: "慢游" },
    { day: 2, theme: "美食", areas: ["Marina Bay"], experiences: ["美食"], summary: "夜游" },
  ];
  const prompt = buildBailianIntentPrompt(input, currentDate);
  assert.match(prompt, /outline 必须恰好包含/);
  assert.match(prompt, /把 Day 2 的主题改成夜景/);
});

test("同句否定旧日期并改口时不覆盖最终日期", () => {
  const message = "不要 2026/10/23-2026/11/01，改成 2026/10/24-2026/10/27。";
  assert.equal(dateMentionFromMessage(message), null);
  const result = parseSingaporeIntentResult(model([
    patch("startDate", "set", "2026-10-24", "2026/10/24"),
    patch("endDate", "set", "2026-10-27", "2026/10/27"),
  ]), request(message), currentDate);
  assert.equal(result.intent.startDate, "2026-10-24");
  assert.equal(result.intent.endDate, "2026-10-27");
  assert.equal(result.intent.durationDays, 4);
  assert.ok(!result.issues.some((issue) => issue.code === "DURATION_OUT_OF_RANGE"));
});

test("同句放弃船形酒店并改住 Orchard 不残留酒店歧义", () => {
  const message = "原想住头上顶船的酒店，但改住 Orchard。";
  const result = parseSingaporeIntentResult(model([
    patch("accommodation.hotelName", "propose", "滨海湾金沙酒店", "头上顶船的酒店"),
    patch("accommodation.areaName", "set", "Orchard", "改住 Orchard"),
  ], [{ text: "头上顶船的酒店", field: "accommodation.hotelName" }]), request(message), currentDate);
  assert.deepEqual(result.intent.accommodation, { hotelName: null, areaName: "Orchard", googlePlaceId: null });
  assert.ok(!result.issues.some((issue) => issue.code === "ACCOMMODATION_NAME_UNCONFIRMED"));
  assert.deepEqual(result.pendingCandidates, []);
});

test("刷新后只修改日期，服务端保留上一轮未确认的酒店候选", () => {
  const firstMessage = "2026/10/23-2026/11/01，住头上顶个船的酒店。";
  const first = parseSingaporeIntentResult(model([
    patch("startDate", "set", "2026-10-23", "2026/10/23"),
    patch("endDate", "set", "2026-11-01", "2026/11/01"),
    patch("accommodation.hotelName", "propose", "滨海湾金沙酒店", "头上顶个船的酒店"),
  ]), request(firstMessage), currentDate);
  const nextInput = request("日期改为 2026/10/23-2026/10/26。", first.intent);
  nextInput.previousPendingCandidates = first.pendingCandidates;
  assert.match(buildBailianIntentPrompt(nextInput, currentDate), /previousPendingCandidates/);
  const second = parseSingaporeIntentResult(model([
    patch("startDate", "set", "2026-10-23", "2026/10/23"),
    patch("endDate", "set", "2026-10-26", "2026/10/26"),
  ]), nextInput, currentDate);
  assert.equal(second.intent.durationDays, 4);
  assert.equal(second.pendingCandidates.length, 1);
  assert.ok(second.issues.some((issue) => issue.code === "ACCOMMODATION_NAME_UNCONFIRMED"));
  assert.equal(second.intent.accommodation.hotelName, null);
});

test("明确改住其他区域时清除服务端待确认的酒店候选", () => {
  const nextInput = request("改住 Orchard。", EMPTY_SINGAPORE_TRAVEL_INTENT);
  nextInput.previousPendingCandidates = [{
    field: "accommodation.hotelName", value: "滨海湾金沙酒店", evidenceText: "头上顶个船的酒店",
  }];
  const result = parseSingaporeIntentResult(model([
    patch("accommodation.areaName", "set", "Orchard", "改住 Orchard"),
  ]), nextInput, currentDate);
  assert.equal(result.intent.accommodation.areaName, "Orchard");
  assert.deepEqual(result.pendingCandidates, []);
  assert.ok(!result.issues.some((issue) => issue.code === "ACCOMMODATION_NAME_UNCONFIRMED"));
});
