import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";
import { EMPTY_SINGAPORE_TRAVEL_INTENT } from "../lib/travel/singapore-intent.ts";

const vite = await createServer({
  configFile: false,
  appType: "custom",
  server: { middlewareMode: true },
});
after(() => vite.close());
const { preparseIntentInput, tryResolveDeterministicIntentTurn } = await vite.ssrLoadModule("/lib/travel/intent-fast-path.ts");
const currentDate = "2026-10-25";

function request(message, currentIntent = EMPTY_SINGAPORE_TRAVEL_INTENT, currentOutline = []) {
  return { message, currentIntent, currentOutline, conversationHistory: [] };
}

test("完整双年份日期范围走代码，并由服务端计算七天上限", () => {
  const result = tryResolveDeterministicIntentTurn(request("日期改成 2026/10/23-2026/11/01。"), currentDate);
  assert.equal(result.intent.startDate, "2026-10-23");
  assert.equal(result.intent.endDate, "2026-11-01");
  assert.equal(result.intent.durationDays, null);
  assert.equal(result.issues[0].code, "DURATION_OUT_OF_RANGE");
  assert.deepEqual(result.acceptedChanges.map((item) => item.field), ["startDate", "endDate"]);
});

test("单独的每日出发和返店时间走代码，返店同时设置首选和最晚时间", () => {
  const departure = tryResolveDeterministicIntentTurn(request("每天09:30出发"), currentDate);
  assert.equal(departure.intent.dailyStartTime, "09:30");
  const returned = tryResolveDeterministicIntentTurn(request("每天21:00回酒店", departure.intent), currentDate);
  assert.equal(returned.intent.preferredReturnTime, "21:00");
  assert.equal(returned.intent.latestReturnTime, "21:00");
  assert.equal(returned.intent.dailyEndTime, "21:00");
});

test("明确人数、区域和节奏逐轮保留，单人不推断为成人", () => {
  const one = tryResolveDeterministicIntentTurn(request("我一个人"), currentDate);
  assert.equal(one.intent.travelers.total, 1);
  assert.equal(one.intent.travelers.adults, null);
  const area = tryResolveDeterministicIntentTurn(request("住 Bugis 附近", one.intent), currentDate);
  assert.equal(area.intent.accommodation.areaName, "Bugis");
  const pace = tryResolveDeterministicIntentTurn(request("节奏轻松", area.intent), currentDate);
  assert.equal(pace.intent.pace, "relaxed");
  const adults = tryResolveDeterministicIntentTurn(request("2位成人"), currentDate);
  assert.equal(adults.intent.travelers.total, 2);
  assert.equal(adults.intent.travelers.adults, 2);
});

test("明确清除只清除指定的时间或节奏", () => {
  const initial = {
    ...EMPTY_SINGAPORE_TRAVEL_INTENT,
    dailyStartTime: "09:30",
    preferredReturnTime: "18:00",
    latestReturnTime: "20:00",
    dailyEndTime: "20:00",
    pace: "relaxed",
  };
  const first = tryResolveDeterministicIntentTurn(request("清除每日返店时间", initial), currentDate);
  assert.equal(first.intent.preferredReturnTime, null);
  assert.equal(first.intent.latestReturnTime, null);
  assert.equal(first.intent.dailyEndTime, null);
  assert.equal(first.intent.dailyStartTime, "09:30");
  assert.equal(first.intent.pace, "relaxed");
  const second = tryResolveDeterministicIntentTurn(request("清除旅行节奏", first.intent), currentDate);
  assert.equal(second.intent.pace, null);
  assert.equal(second.intent.dailyStartTime, "09:30");
});

test("无效日期时间和复合语义不走代码快路径", () => {
  for (const message of [
    "日期改成 2026/02/30-2026/03/03",
    "每天25:00出发",
    "每天09:30出发，想看夜景",
    "2026/10/23-2026/11/01，我一个人去新加坡，住头上顶船的酒店",
    "不要历史文物展览，但是历史遗迹可以",
    "是的",
    "还缺什么？",
    "住头上顶船的酒店",
    "改住 Orchard",
    "今年10月23日至26日",
  ]) {
    assert.equal(tryResolveDeterministicIntentTurn(request(message), currentDate), null, message);
  }
});

test("已有每日草案时不绕过草案修改流程", () => {
  const currentOutline = [
    { day: 1, theme: "建筑", areas: ["Bugis"], experiences: ["建筑"], summary: "慢游" },
  ];
  assert.equal(tryResolveDeterministicIntentTurn(request("节奏轻松", EMPTY_SINGAPORE_TRAVEL_INTENT, currentOutline), currentDate), null);
});

test("复杂原话只预解析字面候选和风险，不擅自分配起止日期", () => {
  const message = "2026/10/23-2026/11/01，我一个人去新加坡，住头上顶个船的那个酒店。每天09:00出发，通常18:00回酒店，最晚20:00。不要历史文物展览，但历史遗迹可以。";
  const result = preparseIntentInput(message);
  assert.equal(result.originalText, message);
  assert.deepEqual(result.candidates.map(({ kind, value }) => [kind, value]), [
    ["date", "2026-10-23"], ["date", "2026-11-01"],
    ["traveler_count", 1], ["time", "09:00"], ["time", "18:00"], ["time", "20:00"],
  ]);
  assert.ok(result.risks.some((risk) => risk.kind === "hotel_nickname"));
  assert.ok(result.risks.some((risk) => risk.kind === "negation"));
  assert.ok(result.risks.some((risk) => risk.kind === "contrast"));
  assert.ok(result.risks.some((risk) => risk.kind === "pronoun"));
  for (const item of [...result.candidates, ...result.risks]) {
    assert.equal(message.slice(item.startIndex, item.endIndex), item.evidenceText);
  }
  assert.equal(tryResolveDeterministicIntentTurn(request(message), currentDate), null);
});

test("日期改口标记多日期风险，无效日期和缺年份不产生日期候选", () => {
  const changed = preparseIntentInput("不要 2026/10/23-2026/11/01，改成 2026/10/24-2026/10/27。");
  assert.equal(changed.candidates.filter((candidate) => candidate.kind === "date").length, 4);
  assert.ok(changed.risks.some((risk) => risk.kind === "multiple_dates"));
  assert.ok(changed.risks.some((risk) => risk.kind === "contrast"));
  assert.ok(changed.risks.some((risk) => risk.kind === "negation"));
  assert.deepEqual(preparseIntentInput("今年10月23日至26日；2026/02/30再回来").candidates, []);
});
