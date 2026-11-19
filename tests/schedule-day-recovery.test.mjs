import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const vite = await createServer({
  configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false },
  resolve: { alias: { '@': process.cwd() } }, optimizeDeps: { noDiscovery: true }, logLevel: 'error',
});
after(() => vite.close());
const { ScheduleStage } = await vite.ssrLoadModule('/components/travel/planning/schedule-stage.tsx');
const noop = () => {};
const day = { day: 1, date: '2026-12-20' };
const props = {
  days: [day], decisions: [], estimates: [], busy: false, onCalculate: noop, onDecide: noop,
  onConfirm: noop, onReviewBoard: noop, onUpdateDay: async () => false,
};

test('a V32 conflicted day without an estimate can change saved labels and visit duration', () => {
  const html = renderToStaticMarkup(createElement(ScheduleStage, {
    ...props,
    conflicts: [{ ...day, code: 'arrival_too_late', draftVersion: 1, message: '原有营业冲突' }],
    assignments: [{ day: 1, orderedCandidateIds: ['scene-a'] }],
    candidates: [{ id: 'scene-a', placeId: 'garden', name: '滨海湾花园', estimatedMinutes: 180 }],
    overrides: [{ day: 1, visitMinutesByPlaceId: { garden: 150 }, localBlocks: [
      { id: 'rest-a', kind: 'rest', day: 1, title: '我的休息', durationMinutes: 480, source: 'user', anchor: { nodeId: 'garden-stop', placement: 'before' } },
    ] }],
  }));
  assert.match(html, /原有营业冲突/);
  assert.match(html, /<h4>修改本日安排/);
  assert.doesNotMatch(html, /<button[^>]*>修改本日安排/);
  assert.match(html, /aria-label="我的休息时长（小时）" value="8"/);
  assert.match(html, /移除安排/);
  assert.match(html, /滨海湾花园 · 停留（小时）<input[^>]*value="2.5"/);
  assert.doesNotMatch(html, /预计约 .* 到达|设置已保存 · 当前核算/);
});

const estimate = {
  ...day, sceneIds: [], notes: [], computedAt: '2026-11-18T00:00:00Z', overrides: { day: 1 },
  scheduledDay: { stops: [], legs: [] }, transport: { status: 'complete', totalMinutes: 60 },
  metrics: { visitMinutes: 120, foodMinutes: 0, mealReserveMinutes: 0, bufferMinutes: 0, travelMinutes: 60,
    pickupMinutes: 0, freeMinutes: 120, overtimeMinutes: 0, actualReturnTime: '19:00',
    requestedReturnTime: '21:00', terminalKind: 'hotel' },
};
test('an unsuccessful save keeps the previous result as a reference and does not signal success', () => {
  const html = renderToStaticMarkup(createElement(ScheduleStage, {
    ...props, estimates: [estimate],
    saveFailure: { day: 1, message: '本日容量不足，超出 330 分钟' },
  }));
  assert.match(html, /本次安排未保存/);
  assert.equal((html.match(/role="alert"/g) || []).length, 1);
  assert.ok(html.indexOf('保存并核算本日') < html.indexOf('本次安排未保存'));
  assert.match(html, /上次核算结果/);
  assert.doesNotMatch(html, /设置已保存 · 当前核算|预计可在截止前返店/);
  assert.match(html, /disabled=""[^>]*>确认全程并准备地图/);
});

test('a stale reference cannot hide the saved problematic arrangement from recovery editing', () => {
  const html = renderToStaticMarkup(createElement(ScheduleStage, {
    ...props, estimates: [estimate], staleScheduleDays: [1],
    conflicts: [{ ...day, code: 'DAY_CAPACITY_EXCEEDED', draftVersion: 2, message: '超出可安排时间' }],
    overrides: [{ day: 1, localBlocks: [
      { id: 'bad-rest', kind: 'rest', day: 1, title: '原来保存的休息', durationMinutes: 480, source: 'user', anchor: { nodeId: 'hotel', placement: 'after' } },
    ] }],
  }));
  assert.match(html, /aria-label="原来保存的休息时长（小时）" value="8"/);
  assert.match(html, /上次核算结果/);
});

test('saved legacy overtime is shown as a deficit, not a feasible result', () => {
  const html = renderToStaticMarkup(createElement(ScheduleStage, {
    ...props, estimates: [{ ...estimate, metrics: { ...estimate.metrics, freeMinutes: 0, overtimeMinutes: 172 } }],
  }));
  assert.match(html, /上次核算预计超过返店截止约 2 小时 52 分钟/);
  assert.doesNotMatch(html, /<button[^>]*>修改本日安排/);
  assert.doesNotMatch(html, /设置已保存 · 当前核算/);
  assert.match(html, /disabled=""[^>]*>确认全程并准备地图/);
});

test('a fresh opening-hours refusal appears once beside save and points to evidence', () => {
  const conflict = { ...day, draftVersion: 1, code: 'arrival_too_late', placeId: 'museum',
    message: '原有营业冲突', placeName: '新加坡国家博物馆',
    window: { reasonCode: 'arrival_too_late', arrivalMinute: 1066, earliestVisitStart: 1066,
      visitMinutes: 90, openingIntervals: [[600, 1140]], closingMinute: 1140, missingMinutes: 16 },
  };
  const html = renderToStaticMarkup(createElement(ScheduleStage, {
    ...props, estimates: [estimate], conflicts: [conflict],
    saveFailure: { day: 1, message: '本日核算未通过', conflicts: [conflict] },
  }));
  assert.equal((html.match(/role="alert"/g) || []).length, 1);
  assert.match(html, /新加坡国家博物馆预计 19:16 参观结束，比常规闭馆时间 19:00 晚约 16 分钟/);
  assert.match(html, /查看核算依据/);
  assert.ok(html.indexOf('保存并核算本日') < html.indexOf('本次安排未保存'));
  assert.doesNotMatch(html, /<button[^>]*>修改本日安排/);
});
