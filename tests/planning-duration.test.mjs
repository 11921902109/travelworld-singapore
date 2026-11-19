import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hoursInput, hoursLabel, hoursToMinutes, validRecommendedDuration, outsideRecommendedDuration, durationTextInHours, sceneTimeAdvice, sameVisitPlaceIds } from '../lib/travel/planning-duration.ts';
import { PlanningTimeOverrideSchema } from '../lib/travel/planning-time-overrides.ts';

test('hour display preserves unedited exact minutes and converts actual edits once', () => {
  for (const original of [7, 25, 47, 59, 90, 240]) {
    assert.equal(hoursToMinutes(hoursInput(original), original, false), original);
  }
  assert.equal(hoursLabel(90), '1.5 小时');
  assert.equal(hoursToMinutes('1.5', 59, true), 90);
  assert.equal(hoursToMinutes('0.98', 59, true), 59);
  assert.ok(Number.isNaN(hoursToMinutes('', 59, true)));
  assert.ok(Number.isNaN(hoursToMinutes('no', 59, true)));
});

test('recommended range is checked independently and never enlarged for a selected visit', () => {
  const range = {minMinutes:60,maxMinutes:180,source:'ai_suggestion'};
  assert.deepEqual(validRecommendedDuration(range,90),range);
  assert.equal(validRecommendedDuration(range,240),undefined);
  assert.equal(validRecommendedDuration({...range,minMinutes:200}),undefined);
  assert.equal(validRecommendedDuration(undefined,90),undefined);
  assert.equal(outsideRecommendedDuration(240,range),true);
  assert.equal(outsideRecommendedDuration(90,range),false);
  assert.deepEqual(range,{minMinutes:60,maxMinutes:180,source:'ai_suggestion'});
});

test('hours remain subject to original deterministic time bounds', () => {
  assert.equal(PlanningTimeOverrideSchema.safeParse({day:1,visitMinutesByPlaceId:{one:hoursToMinutes('1.5',59,true)}}).success,true);
  assert.equal(PlanningTimeOverrideSchema.safeParse({day:1,visitMinutesByPlaceId:{one:hoursToMinutes('8.1',59,true)}}).success,false);
  assert.equal(PlanningTimeOverrideSchema.safeParse({day:1,travelTotalMinutes:hoursToMinutes('-1',59,true)}).success,false);
});

test('legacy explanatory text uses consistent hour units', () => {
  assert.equal(durationTextInHours('预留约 24 分钟等待'), '预留约 0.4 小时等待');
  assert.equal(durationTextInHours('1 小时 30 分钟'), '1.5 小时');
  assert.equal(durationTextInHours('15–480 分钟'), '0.25–8 小时');
});


test('changing user visit time keeps model advice unchanged and old user-only data does not become advice', () => {
  const source = {estimatedMinutes:90,estimateSource:'bailian',recommendedMinutes:90,recommendedDuration:{minMinutes:60,maxMinutes:180,source:'ai_suggestion'}};
  const before = sceneTimeAdvice(source,90);
  const after = sceneTimeAdvice({...source,estimatedMinutes:240,estimateSource:'user'},240);
  assert.equal(after.selectedVisitMinutes,240);
  assert.equal(after.recommendedMinutes,before.recommendedMinutes);
  assert.deepEqual(after.recommendedDuration,before.recommendedDuration);
  assert.deepEqual(sceneTimeAdvice({estimatedMinutes:240,estimateSource:'user'},240),{selectedVisitMinutes:240});
});


test('changed place identities reject hidden stale visit keys while order-only changes remain usable', () => {
  assert.equal(sameVisitPlaceIds(['one','two'],['two','one']),true);
  assert.equal(sameVisitPlaceIds(['one','two'],['one']),false);
  assert.equal(sameVisitPlaceIds(['one'],['two']),false);
  assert.equal(sameVisitPlaceIds(['one'],['one','two']),false);
});

test('scheduler short minute units are rendered in hours including compound durations', () => {
  assert.equal(durationTextInHours('预留1 小时 30 分交通与24 分等待'), '预留1.5 小时交通与0.4 小时等待');
  assert.equal(durationTextInHours('1 小时 30 分钟'), '1.5 小时');
});
