import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const vite = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false }, resolve: { alias: { "@": process.cwd() } }, optimizeDeps: { noDiscovery: true }, logLevel: "error" });
after(() => vite.close());
const { StayStage } = await vite.ssrLoadModule("/components/travel/planning/stay-stage.tsx");
const noop = () => {};
const base = { days: 3, initialArea: "Bugis", advice: null, segments: [], busy: false, onAdvise: noop, onSegments: noop, onSearchHotels: noop, onSelectHotel: noop, onConfirm: noop, onReviewBoard: noop };
const advice = { recommendationId: "same", basis: "比较已选景点往返路线。", source: { areaHotels: "Google Places", roadTimes: "Google Routes", explanation: "Bailian" }, options: [
  { id: "same", segments: [{ startDay: 1, area: "Bugis" }], totalEstimatedMinutes: 76, estimatedMoveMinutes: 0, advantage: "省去换店和搬运行李。", drawback: "远处地点仍需往返。", dailyBasis: [] },
  { id: "split", segments: [{ startDay: 1, area: "Bugis" }, { startDay: 3, area: "Marina Bay" }], totalEstimatedMinutes: 163, estimatedMoveMinutes: 90, advantage: "后两天离滨海湾较近。", drawback: "需要换住。", dailyBasis: [] },
] };
const savedSegment = { id: "stay-day-1", startDay: 1, area: "Bugis", checkInDate: "2026-12-20", checkOutDate: "2026-12-23", budgetPerNight: { amount: 1500, currency: "CNY" }, hotel: { placeId: "hotel-a", name: "Hotel A" } };
test("new stays have a RMB input and no currency selector", () => {
  const html = renderToStaticMarkup(createElement(StayStage, base));
  assert.match(html, /每晚预算上限（人民币／晚，可选）/);
  assert.doesNotMatch(html, /预算币种|option value="SGD"/);
  assert.match(html, /id="stay-budget-0"[^>]*value=""/);
});
test("old SGD budget remains explicit and is not prefilled as a yuan amount", () => {
  const segment = { id: "stay-day-1", startDay: 1, area: "Bugis", checkInDate: "2026-12-20", checkOutDate: "2026-12-23", budgetPerNight: { amount: 250, currency: "SGD" }, hotel: { placeId: "hotel-a", name: "Hotel A" } };
  const before = structuredClone(segment);
  const html = renderToStaticMarkup(createElement(StayStage, { ...base, segments: [segment] }));
  assert.match(html, /原预算 250 SGD 已保留/);
  assert.match(html, /取消本段预算/);
  assert.match(html, /id="stay-budget-0"[^>]*value=""/);
  assert.match(html, /disabled=""[^>]*>搜索本段酒店与价格/);
  assert.match(html, /disabled=""[^>]*>确认所有住宿段并核算时间/);
  assert.deepEqual(segment, before);
});

test("lodging advice, comparison, current settings and hotels form one ordered workflow", () => {
  const html = renderToStaticMarkup(createElement(StayStage, { ...base, advice, segments: [savedSegment] }));
  const headings = ["建议全程同住", "比较同住与换住", "设置住宿安排", "为每个住宿段选酒店"].map((text) => html.indexOf(text));
  assert.ok(headings.every((position) => position >= 0));
  assert.deepEqual([...headings].sort((a, b) => a - b), headings);
  assert.match(html, /<details\b[^>]*><summary><strong>比较同住与换住/);
  assert.doesNotMatch(html, /或者自行设置住宿段|已采用 ·/);
  assert.match(html, /当前区域 · 全程同住 · 已保存/);
  assert.match(html, /id="stay-area-0"[^>]*value="Bugis"/);
  assert.match(html, /id="stay-budget-0"[^>]*value="1500"/);
});

test("a recommendation is not presented as adopted before a user chooses it", () => {
  const html = renderToStaticMarkup(createElement(StayStage, { ...base, advice }));
  assert.match(html, /采用建议并查看设置/);
  assert.match(html, /role="status">待设置 · 待保存<\/span>/);
  assert.doesNotMatch(html, /已采用 ·|当前区域安排/);
});

test("a saved custom area stays authoritative beside a different recommended option", () => {
  const segment = { ...savedSegment, area: "Orchard" };
  const before = structuredClone(segment);
  const html = renderToStaticMarkup(createElement(StayStage, { ...base, advice, segments: [segment] }));
  assert.match(html, /已自定义 · 已保存/);
  assert.match(html, /id="stay-area-0"[^>]*value="Orchard"/);
  assert.doesNotMatch(html, /当前区域安排/);
  assert.deepEqual(segment, before);
});

test("no-overnight remains a separate valid action without a lodging editor or invented recommendation", () => {
  const html = renderToStaticMarkup(createElement(StayStage, { ...base, noOvernight: true, advice }));
  assert.match(html, /确认无需酒店，核算当天路线/);
  assert.doesNotMatch(html, /设置住宿安排|比较同住与换住|id="stay-budget-/);
});
