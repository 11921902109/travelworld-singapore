import assert from 'node:assert/strict';
import test from 'node:test';
import { assessPlanningCapacity, previewPlanningCapacity } from '../lib/travel/planning-capacity.ts';

const estimate = () => ({ day: 2, dailyWindow: { start: '14:30', preferredReturn: '21:00', latestReturn: '21:00' },
  effectiveWindow: { start: '14:30', returnBy: '21:00' }, metrics: { travelMinutes: 60 }, transport: { status: 'complete' },
  scenes: [{ candidateId: 'gallery', selectedVisitMinutes: 180 }], localBlocks: [{ id: 'rest', durationMinutes: 30 }] });

test('8-hour block fails the hard window before any venue or route check', () => {
  const result = previewPlanningCapacity(estimate(), { localBlocks: [{ durationMinutes: 480 }] });
  assert.equal(result.status, 'hard_exceeded'); assert.equal(result.availableMinutes, 390);
  assert.equal(result.requiredMinutes, 720); assert.equal(result.addedMinutes, 450);
  assert.equal(result.baselineRemainingMinutes, 120); assert.equal(result.deficitMinutes, 330);
  assert.equal(result.lowerBound, true); assert.match(result.message, /原可安排约 2 小时.*净增 7 小时 30 分钟/);
});

test('full pending changes are combined; edits count the difference, moving counts no extra time', () => {
  const source = estimate();
  assert.equal(previewPlanningCapacity(source, { localBlocks: [{ durationMinutes: 30 }] }).addedMinutes, 0);
  assert.equal(previewPlanningCapacity(source, { localBlocks: [] }).addedMinutes, -30);
  const full = previewPlanningCapacity(source, { visitMinutesByPlaceId: { gallery: 240 }, localBlocks: [{ durationMinutes: 120 }], travelTotalMinutes: 90 });
  assert.equal(full.addedMinutes, 180); assert.equal(full.deficitMinutes, 60); assert.equal(full.status, 'hard_exceeded');
});

test('only hard cutoff blocks; exceeding a soft preference remains advice', () => {
  const result = assessPlanningCapacity({ day: 2, startTime: '09:00', preferredEndTime: '18:00', hardEndTime: '23:00', visitMinutes: 540, localBlockMinutes: 60, travelMinutes: 60 });
  assert.equal(result.status, 'soft_overrun'); assert.equal(result.preferredDeficitMinutes, 120); assert.equal(result.deficitMinutes, 0);
  const source = estimate(); source.dailyWindow.returnConstraint = { strength: 'soft', source: 'user' }; source.effectiveWindow.returnBy = '23:59';
  assert.equal(previewPlanningCapacity(source, { localBlocks: [{ durationMinutes: 180 }] }).status, 'soft_overrun');
});

test('unknown traffic, stale estimates and missing durations are not treated as zero free time', () => {
  const unknown = assessPlanningCapacity({ day: 2, startTime: '14:30', hardEndTime: '21:00', visitMinutes: 180, localBlockMinutes: 30 });
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.remainingMinutes, null);
  assert.equal(previewPlanningCapacity(estimate(), {}, { stale: true }).status, 'unknown');
  const source = estimate(); delete source.scenes[0].selectedVisitMinutes;
  assert.equal(previewPlanningCapacity(source, {}).status, 'unknown');
  // A certain lower bound can still reject without assuming missing traffic is zero.
  assert.equal(assessPlanningCapacity({ day: 1, startTime: '14:30', hardEndTime: '21:00', visitMinutes: 180, localBlockMinutes: 480 }).status, 'hard_exceeded');
});

test('changed windows use pending values while flight-constrained unchanged windows retain their effective cutoff', () => {
  const source = estimate(); source.dailyWindow.start = '09:30'; source.effectiveWindow.returnBy = '18:00';
  assert.equal(previewPlanningCapacity(source, { dailyWindow: source.dailyWindow }).availableMinutes, 210);
  assert.equal(previewPlanningCapacity(source, { dailyWindow: { start: '12:00', preferredReturn: '22:00', latestReturn: '22:00' } }).availableMinutes, 600);
});
