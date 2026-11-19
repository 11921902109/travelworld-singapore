import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import path from 'node:path';
import { createServer } from 'vite';

// Every provider boundary is replaced; these are deterministic scheduling tests.
globalThis.__localBlocks1117 = { calls: [] };
const loc = { lat: 1.3, lng: 103.85 };
const airport = { placeId: 'airport-sin', name: 'Singapore Changi Airport', address: 'Airport Blvd', location: { lat: 1.36, lng: 103.99 }, primaryType: 'international_airport', types: ['airport'], googleMapsUri: null, source: 'google_places', verified: true };
const mocks = {
  '@/lib/travel/google-maps': `export const SINGAPORE_BOUNDS={west:103.594,east:104.106,south:1.1496,north:1.4784};export class GoogleMapsServiceError extends Error{};export async function computeSingaporeRoute(input){globalThis.__localBlocks1117.calls.push(input);return{mode:'drive',distanceMeters:1000,distanceText:'1km',durationSeconds:600,durationMinutes:10,durationText:'10min',encodedPolyline:''};}export async function getSingaporePlaceDetails(){return ${JSON.stringify(airport)};}export async function searchSingaporePlaces(){return[${JSON.stringify(airport)}];}`,
  '@/lib/travel/planning-scenes': `export const PlanningSceneCandidateSchema={safeParse(value){return{success:true,data:value};},parse(value){return value;}};`,
};
const prefix = '\0local-blocks-1117:';
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false },
  resolve: { alias: [...Object.keys(mocks).map(find => ({ find, replacement: prefix + find })), { find: '@', replacement: process.cwd() }, { find: 'cloudflare:workers', replacement: path.join(process.cwd(), 'tests/fixtures/flight-agent-env.ts') }] },
  plugins: [{ name: 'local-blocks-provider-boundaries', enforce: 'pre', resolveId(id) { if (id.startsWith(prefix)) return id; const key = Object.keys(mocks).find(key => id === key || id === path.join(process.cwd(), key.slice(2))); if (key) return prefix + key; }, load(id) { return id.startsWith(prefix) ? mocks[id.slice(prefix.length)] : null; } }],
  optimizeDeps: { noDiscovery: true }, logLevel: 'error',
});
after(() => vite.close());
const { schedulePlanningDay } = await vite.ssrLoadModule('/lib/travel/planning-scheduler.ts');
const { PlanningLocalBlockSchema, effectivePlanningLocalBlocks, validatePlanningLocalBlocks } = await vite.ssrLoadModule('/lib/travel/planning-local-blocks.ts');
const { PlanningTimeOverrideSchema, mergePlanningTimeOverride } = await vite.ssrLoadModule('/lib/travel/planning-time-overrides.ts');
const { buildPlanningDayTimeline, buildPlanningDayTimelineGroups } = await vite.ssrLoadModule('/lib/travel/planning-day-timeline.ts');
const { calculatePlanningDays, compilePlanningTrip } = await vite.ssrLoadModule('/lib/travel/planning-trip.ts');
const { planningDraftWithReadiness } = await vite.ssrLoadModule('/lib/travel/planning-readiness.ts');
const { legacyPlanningBaggageWaypoints } = await vite.ssrLoadModule('/lib/travel/planning-baggage.ts');
const stop = (id, kind = 'sight', patch = {}) => ({ id, placeId: id, name: id, kind, verified: true, location: loc, time: '00:00', endTime: '00:00', openingHours: [], note: '', area: '', x: 0, y: 0, duration: '', ...patch });
const physical = [stop('hotel-start', 'hotel'), stop('gallery'), stop('hotel-end', 'hotel')];
const day = { id: 'day-2', label: 'Day 2', date: '12/21', weekday: '周一', theme: '', color: '', summary: '', stops: [], legs: [] };
const base = { day, orderedStops: physical, startTime: '09:30', returnBy: '21:00', requestedVisitMinutes: { gallery: 60 }, taxiPickupMinutes: 0 };
const block = (id, kind = 'custom', durationMinutes = 30, nodeId = 'gallery', placement = 'after') => ({ id, day: 2, kind, title: kind === 'custom' ? '取行李' : kind, durationMinutes, anchor: { nodeId, placement }, source: 'user' });
const anchor = id => ({ placeId: id, name: id, address: 'Singapore', location: loc, googleMapsUri: null, source: 'google_places', verified: true });
const scene = id => ({ id, placeId: id, name: id, address: 'Singapore', location: loc, area: '滨海湾', category: '建筑', kind: 'sight', reason: '建筑体验', estimatedMinutes: 60, recommendedMinutes: 60, pros: '适合慢逛', cons: '步行', source: 'preference', sourceNote: '百炼建议', estimateSource: 'bailian', verified: true, googleMapsUri: null, openingHours: [] });
const handoff = { schemaVersion: 1, sourceIntentStateVersion: 1, destination: 'Singapore', dates: { start: '2026-12-20', end: '2026-12-22', days: 3 }, dailyWindow: { start: '09:30', preferredReturn: '21:00', latestReturn: '21:00' }, pace: 'relaxed', preferences: { interests: ['建筑'], mustVisit: [], avoid: [], mobilityConstraints: [], dietaryPreferences: [], preferredTransport: [], allowAutomaticRecommendations: true }, travelers: { total: 2 }, confirmedByUser: true };
function draftFixture() { return { version: 1, handoffId: 'test', sourceIntentStateVersion: 1, stage: 'route', placesConfirmed: true, selectedPlaceIds: ['scene-1', 'scene-2', 'scene-3'], boardConfirmed: true, stayConfirmed: true, flightSelection: { mode: 'none' }, candidates: [1, 2, 3].map(n => scene('scene-' + n)), assignments: [1, 2, 3].map(day => ({ day, orderedCandidateIds: ['scene-' + day], status: 'confirmed', dayPurpose: 'activities' })), staySegments: [{ startDay: 1, area: 'Bugis', checkInDate: '2026-12-20', checkOutDate: '2026-12-23', hotel: anchor('hotel') }], reviewRequired: [] }; }
const endpoint = localDateTime => ({ localDateTime, timeZone: 'Asia/Singapore', airport: { name: airport.name } });
function flightDraft() { const draft = draftFixture(); draft.flightSelection = { mode: 'manual', arrivalAt: '2026-12-20T12:00', departureAt: '2026-12-22T20:00', arrivalAirportPlaceId: airport.placeId, departureAirportPlaceId: airport.placeId, arrivalAirportName: airport.name, departureAirportName: airport.name, journey: { outbound: { source: 'user', departure: endpoint('2026-12-20T07:00'), arrival: endpoint('2026-12-20T12:00') }, inbound: { source: 'user', departure: endpoint('2026-12-22T20:00'), arrival: endpoint('2026-12-23T01:00') } } }; draft.staySegments[0].checkOutDate = '2026-12-22'; return draft; }

test('a new day debits only actual activity and traffic, with no meal or buffer defaults', async () => {
  const result = await schedulePlanningDay(base);
  assert.equal(result.metrics.visitMinutes, 60); assert.equal(result.metrics.travelMinutes, 20);
  for (const key of ['mealReserveMinutes', 'bufferMinutes', 'personalMinutes', 'logisticsMinutes']) assert.equal(result.metrics[key], 0);
  assert.equal(result.metrics.freeMinutes, 610); assert.equal(result.metrics.actualReturnTime, '10:50');
  assert.equal(result.freeWindows.reduce((s, w) => s + w.minutes, 0), result.metrics.freeMinutes);
});

test('add, edit, move, and delete use one balance and one block per id', async () => {
  const plain = await schedulePlanningDay({ ...base, localBlocks: [] });
  const initial = [block('meal', 'meal', 45), block('rest', 'rest', 30), block('custom', 'custom', 30)];
  const added = await schedulePlanningDay({ ...base, localBlocks: initial });
  assert.equal(added.metrics.freeMinutes, plain.metrics.freeMinutes - 105);
  assert.equal(added.metrics.foodMinutes, 45); assert.equal(added.metrics.bufferMinutes, 30); assert.equal(added.metrics.personalMinutes, 30);
  const moved = await schedulePlanningDay({ ...base, localBlocks: initial.map(b => ({ ...b, anchor: { nodeId: 'hotel-start', placement: 'after' } })) });
  assert.equal(moved.metrics.freeMinutes, added.metrics.freeMinutes); assert.equal(moved.scheduledLocalBlocks.length, 3);
  const edited = await schedulePlanningDay({ ...base, localBlocks: initial.map(b => b.id === 'rest' ? { ...b, durationMinutes: 40 } : b) });
  assert.equal(edited.metrics.freeMinutes, added.metrics.freeMinutes - 10);
  const removed = await schedulePlanningDay({ ...base, localBlocks: initial.filter(b => b.id !== 'rest') });
  assert.equal(removed.metrics.freeMinutes, added.metrics.freeMinutes + 30);
  assert.equal((await schedulePlanningDay({ ...base, localBlocks: [] })).metrics.freeMinutes, plain.metrics.freeMinutes);
});

test('same-anchor order and arrival-before-visit order match the timeline, without new routes or coordinates', async () => {
  globalThis.__localBlocks1117.calls = [];
  const blocks = [block('one', 'meal', 20, 'gallery', 'before'), block('two', 'custom', 25, 'gallery', 'before')];
  const result = await schedulePlanningDay({ ...base, localBlocks: blocks });
  assert.equal(globalThis.__localBlocks1117.calls.length, 2);
  assert.deepEqual(result.scheduledLocalBlocks.map(b => [b.id, b.startTime, b.endTime]), [['one', '09:40', '10:00'], ['two', '10:00', '10:25']]);
  assert.equal(result.day.stops.find(s => s.id === 'gallery').time, '10:25');
  for (const local of result.day.stops.filter(s => s.kind === 'buffer')) { assert.equal(local.placeId, undefined); assert.equal(local.location, undefined); assert.equal(local.verified, false); }
  assert.deepEqual(result.day.legs.map(l => [l.from, l.to]), [['hotel-start', 'gallery'], ['gallery', 'hotel-end']]);
  const nodes = buildPlanningDayTimeline({ scheduledDay: result.day, localBlocks: blocks, scheduledLocalBlocks: result.scheduledLocalBlocks });
  assert.deepEqual(nodes.map(n => n.kind), ['place', 'travel', 'block', 'block', 'place', 'travel', 'place']);
  assert.equal(nodes[2].startTime, '09:40');
});

test('changing a position rechecks openings, with user block duration in conflict evidence', async () => {
  const timed = { ...base, visitDate: '2026-12-21', openingHoursByStop: { gallery: ['Monday: 9:00 AM–11:00 AM'] } };
  assert.equal((await schedulePlanningDay({ ...timed, localBlocks: [block('rest', 'rest', 60)] })).metrics.overtimeMinutes, 0);
  await assert.rejects(schedulePlanningDay({ ...timed, localBlocks: [block('rest', 'rest', 60, 'gallery', 'before')] }), error => {
    assert.equal(error.name, 'RegularOpeningConflictError'); assert.equal(error.evidence.localBlockMinutes, 60); return true;
  });
});

test('blocks cannot enter before destination arrival or after departure airport, and stale/duplicate anchors are rejected', () => {
  const stops = [{ id: 'day-2-airport-arrival' }, { id: 'gallery' }, { id: 'day-2-airport-departure' }];
  assert.throws(() => validatePlanningLocalBlocks([block('x', 'meal', 30, stops[0].id, 'before')], 2, stops), /抵达新加坡/);
  assert.throws(() => validatePlanningLocalBlocks([block('x', 'meal', 30, stops[2].id, 'after')], 2, stops), /离境机场/);
  assert.throws(() => validatePlanningLocalBlocks([block('x', 'meal', 30, 'missing')], 2, stops), /失效/);
  assert.throws(() => validatePlanningLocalBlocks([block('x'), block('x')], 2, stops), /编号/);
  assert.throws(() => validatePlanningLocalBlocks([{ ...block('x'), day: 1 }], 2, stops), /日期/);
  assert.equal(PlanningLocalBlockSchema.safeParse({ ...block('x'), anchor: undefined }).success, false);
  validatePlanningLocalBlocks([block('x', 'meal', 30, stops[0].id, 'after'), block('y', 'meal', 30, stops[2].id, 'before')], 2, stops);
});

test('legacy explicit quantities migrate once, including unknown-origin saved handling, and full-array save clears aggregates', () => {
  const old = PlanningTimeOverrideSchema.parse({ day: 2, extraMealReserveMinutes: 45, extraBufferMinutes: 20, personalActivities: [{ name: '购物', minutes: 30 }], baggage: { mode: 'hotel', handlingMinutes: 15 } });
  const blocks = effectivePlanningLocalBlocks(old, { departure: true });
  assert.equal(blocks.length, 4); assert.equal(blocks.reduce((s, b) => s + b.durationMinutes, 0), 110); assert.equal(blocks.every(b => b.source === 'legacy' && !b.anchor), true);
  const merged = mergePlanningTimeOverride(old, { day: 2, localBlocks: blocks });
  assert.equal(merged.extraMealReserveMinutes, undefined); assert.equal(merged.extraBufferMinutes, undefined); assert.equal(merged.personalActivities, undefined);
  assert.deepEqual(effectivePlanningLocalBlocks(merged), blocks);
  assert.deepEqual(effectivePlanningLocalBlocks(mergePlanningTimeOverride(merged, { day: 2, localBlocks: [] })), []);
});

test('legacy pending blocks count once and cannot compile a map before their position is resolved', async () => {
  const pending = [{ id: 'legacy-2-personal-0', day: 2, kind: 'custom', title: '已保存安排', durationMinutes: 30, source: 'legacy' }];
  const result = await schedulePlanningDay({ ...base, localBlocks: pending, personalMinutes: 30, mealReserveMinutes: 45, bufferReserveMinutes: 15 });
  assert.equal(result.metrics.personalMinutes, 30); assert.equal(result.metrics.localBlockMinutes, 30); assert.equal(result.metrics.mealReserveMinutes, 0); assert.equal(result.metrics.bufferMinutes, 0);
  const draft = { ...draftFixture(), stage: 'complete', scheduleOverrides: [{ day: 2, localBlocks: pending }] };
  await assert.rejects(compilePlanningTrip(handoff, draft), error => error.code === 'LOCAL_BLOCK_POSITION_REQUIRED');
  const ready = await planningDraftWithReadiness(handoff, { ...draft, stage: 'route' });
  assert.equal(ready.pendingReviews.some(item => item.kind === 'local_block_position' && item.day === 2), true);
});

test('a rest day stays at the same hotel, and blocks consume only their own minutes', async () => {
  globalThis.__localBlocks1117.calls = [];
  const rest = { ...base, orderedStops: [stop('hotel-start', 'hotel', { placeId: 'same' }), stop('hotel-end', 'hotel', { placeId: 'same' })] };
  const result = await schedulePlanningDay({ ...rest, localBlocks: [block('meal', 'meal', 45, 'hotel-start', 'after')] });
  assert.equal(result.metrics.freeMinutes, 645); assert.equal(result.metrics.visitMinutes, 0); assert.equal(result.metrics.travelMinutes, 0); assert.equal(result.transport.noOuting, true);
  assert.equal(result.day.legs.length, 0); assert.equal(globalThis.__localBlocks1117.calls.length, 0);
});

test('overtime is explicit and unallocated time is never negative', async () => {
  const result = await schedulePlanningDay({ ...base, returnBy: '11:00', localBlocks: [block('rest', 'rest', 30)] });
  assert.equal(result.metrics.freeMinutes, 0); assert.equal(result.metrics.overtimeMinutes, 20); assert.match(result.day.summary, /超出 20 分钟/);
});

test('new three-day calculation retains airport windows and releases hotel handling without inventing baggage detours', async () => {
  const results = await calculatePlanningDays(handoff, flightDraft());
  assert.equal(results[0].estimate.effectiveWindow.start, '14:00'); assert.equal(results[2].estimate.effectiveWindow.returnBy, '17:00');
  assert.equal(results[0].estimate.metrics.logisticsMinutes, 0); assert.equal(results[0].day.stops.find(s => s.id === 'day-1-hotel-arrival').duration, '0 分钟');
  assert.equal(results.every(r => r.estimate.metrics.mealReserveMinutes === 0 && r.estimate.metrics.bufferMinutes === 0 && r.estimate.metrics.personalMinutes === 0), true);
  assert.equal(results.flatMap(r => r.day.stops).some(s => /baggage/.test(s.id)), false);
  assert.equal(results[0].estimate.journey.airportProcessMinutes, 120); assert.equal(results[2].estimate.journey.airportPreparationMinutes, 180);
});

test('only previously verified real baggage waypoints survive, with zero handling and no new text-derived points', async () => {
  const storage = { ...anchor('storage'), openingHours: [] };
  const baggage = { mode: 'other', handlingMinutes: 15, placeId: storage.placeId, storagePlace: storage };
  const legacy = legacyPlanningBaggageWaypoints({ day: 3, baggage, arrival: false, departure: true, hotel: stop('hotel', 'hotel') });
  assert.equal(legacy.deposit.length, 1); assert.equal(legacy.collection.length, 1); assert.equal(legacy.deposit[0].placeId, 'storage');
  const forged = legacyPlanningBaggageWaypoints({ day: 3, baggage: { ...baggage, placeId: 'different' }, arrival: false, departure: true, hotel: stop('hotel', 'hotel') });
  assert.equal(forged.deposit.length, 0);
  const migrated = effectivePlanningLocalBlocks({ day: 3, baggage });
  const merged = mergePlanningTimeOverride({ day: 3, baggage }, { day: 3, localBlocks: migrated.map(b => ({ ...b, anchor: { nodeId: 'day-3-hotel-start', placement: 'after' } })) });
  assert.equal(merged.baggage.storagePlace.placeId, 'storage');
  const draft = flightDraft(); draft.scheduleOverrides = [merged];
  const [result] = await calculatePlanningDays(handoff, draft, { day: 3 });
  assert.equal(result.day.stops.filter(s => s.placeId === 'storage').length, 2); assert.equal(result.estimate.metrics.logisticsMinutes, 0); assert.equal(result.estimate.metrics.personalMinutes, 30);
});

test('map compilation shares exact scheduled block order, timings and unallocated balance', async () => {
  const draft = draftFixture();
  draft.scheduleOverrides = [{ day: 2, localBlocks: [block('meal', 'meal', 45, 'day-2-scene-scene-2', 'before')] }];
  // Obtain the authoritative scene id rather than assuming a display id.
  const first = await calculatePlanningDays(handoff, { ...draft, scheduleOverrides: [] }, { day: 2 });
  draft.scheduleOverrides[0].localBlocks[0].anchor.nodeId = first[0].day.stops.find(s => s.placeId === 'scene-2').id;
  const scheduled = await calculatePlanningDays(handoff, draft);
  draft.dayEstimates = scheduled.map(r => r.estimate); draft.stage = 'complete';
  const { trip, estimates } = await compilePlanningTrip(handoff, draft);
  assert.deepEqual(trip.days[1].stops, scheduled[1].day.stops); assert.deepEqual(trip.days[1].legs, scheduled[1].day.legs);
  assert.equal(estimates[1].metrics.freeMinutes, scheduled[1].estimate.metrics.freeMinutes); assert.equal(trip.days[1].stops.filter(s => s.id === 'local-block-meal').length, 1);
});

test('timeline groups keep three days readable and repeated semantic groups have unique ids', async () => {
  const results = await calculatePlanningDays(handoff, flightDraft());
  for (const result of results) {
    const groups = buildPlanningDayTimelineGroups({ scheduledDay: result.day, journey: result.estimate.journey, scenes: result.estimate.scenes });
    assert.equal(new Set(groups.map(g => g.id)).size, groups.length);
    assert.equal(groups.every(g => g.nodes.length > 0), true);
    assert.equal(groups.flatMap(g => g.nodes).filter(n => n.kind === 'place' && n.scene).length, 1);
  }
  const departure = results[2];
  const groups = buildPlanningDayTimelineGroups({ scheduledDay: departure.day, journey: departure.estimate.journey, scenes: departure.estimate.scenes, localBlocks: [{ id: 'legacy-pending', day: 3, kind: 'custom', title: '待放置', durationMinutes: 15, source: 'legacy' }] });
  assert.equal(new Set(groups.map(g => g.id)).size, groups.length); assert.equal(groups.some(g => g.id === 'pending'), true);
});
