import assert from "node:assert/strict";
import test from "node:test";
import { moveBoardPlace, boardSignature, boardPlacePreferences } from "../lib/travel/planning-day-board.ts";
import { planningSceneRole, allowAutomaticFoodScene } from "../lib/travel/planning-scene-role.ts";
import { planningReturnConstraint } from "../lib/travel/planning-time-preference.ts";

test("cross-day moves preserve explicit requirements and untouched rest days without duplicates", () => {
  const constraint = { strength: "hard", source: "user", evidence: "只能下午去" };
  const original = [{ day: 1, orderedCandidateIds: ["place-a", "place-b"], periodByCandidateId: { "place-a": "afternoon" }, periodConstraintByCandidateId: { "place-a": constraint } },
    { day: 2, orderedCandidateIds: ["place-c"] }, { day: 3, orderedCandidateIds: [], dayPurpose: "rest" }];
  const moved = moveBoardPlace(original, 3, "place-a", 2, 0);
  assert.deepEqual(moved[1].orderedCandidateIds, ["place-a", "place-c"]);
  assert.deepEqual(moved[1].periodConstraintByCandidateId["place-a"], constraint);
  assert.equal(moved[0].periodByCandidateId["place-a"], undefined);
  assert.equal(moved[2].dayPurpose, "rest");
  assert.deepEqual(original[0].orderedCandidateIds, ["place-a", "place-b"]);
  const removed = moveBoardPlace(moved, 3, "place-a", null);
  assert.equal(removed.flatMap(day => day.orderedCandidateIds).includes("place-a"), false);
});

test("same-day ordering and semantic signatures detect order or constraint changes", () => {
  const board = [{ day: 1, orderedCandidateIds: ["a", "b", "c"] }];
  assert.deepEqual(moveBoardPlace(board, 1, "a", 1, 1)[0].orderedCandidateIds, ["b", "a", "c"]);
  assert.equal(boardSignature(board), boardSignature([{ ...board[0], periodByCandidateId: {}, periodConstraintByCandidateId: {} }]));
  assert.notEqual(boardSignature(board), boardSignature(moveBoardPlace(board, 1, "a", 1, 1)));
});

test("an explicit time restriction survives moving out to the pool and adding it again", () => {
  const original = [{ day: 1, orderedCandidateIds: ["place-0001"], periodByCandidateId: { "place-0001": "afternoon" }, periodConstraintByCandidateId: { "place-0001": { strength: "hard", source: "user", evidence: "只能下午" } } }, { day: 2, orderedCandidateIds: [] }];
  const preferences = boardPlacePreferences(original);
  const pending = moveBoardPlace(original, 2, "place-0001", null, undefined, preferences);
  const restored = moveBoardPlace(pending, 2, "place-0001", 2, undefined, preferences);
  assert.equal(restored[1].periodByCandidateId["place-0001"], "afternoon");
  assert.equal(restored[1].periodConstraintByCandidateId["place-0001"].strength, "hard");
  assert.deepEqual(pending[0].periodByCandidateId, {});
});

test("adding directly into an AM/PM zone is atomic and ordinary grouping remains a soft preference", () => {
  const original=[{day:1,orderedCandidateIds:[]},{day:2,orderedCandidateIds:[],dayPurpose:"rest"}];
  const added=moveBoardPlace(original,2,"place-0001",1,undefined,{},"morning");
  assert.deepEqual(added[0].orderedCandidateIds,["place-0001"]);assert.equal(added[0].periodByCandidateId["place-0001"],"morning");
  assert.equal(added[0].periodConstraintByCandidateId["place-0001"].strength,"soft");
  const changed=moveBoardPlace(added,2,"place-0001",2,undefined,{},"afternoon");
  assert.equal(changed[1].periodByCandidateId["place-0001"],"afternoon");assert.equal(changed[1].periodConstraintByCandidateId["place-0001"].strength,"soft");assert.equal(changed[1].dayPurpose,"activities");
  assert.deepEqual(original[0].orderedCandidateIds,[]);
});

test("cross-day move retains fixed grouping; an explicitly confirmed zone change records the new fixed requirement",()=>{
 const board=[{day:1,orderedCandidateIds:["place-0001"],periodByCandidateId:{"place-0001":"morning"},periodConstraintByCandidateId:{"place-0001":{strength:"hard",source:"user",evidence:"只能上午"}}},{day:2,orderedCandidateIds:[]}];
 const moved=moveBoardPlace(board,2,"place-0001",2);
 assert.equal(moved[1].periodByCandidateId["place-0001"],"morning");assert.equal(moved[1].periodConstraintByCandidateId["place-0001"].evidence,"只能上午");
 const changed=moveBoardPlace(board,2,"place-0001",2,undefined,{},"afternoon");
 assert.equal(changed[1].periodByCandidateId["place-0001"],"afternoon");assert.equal(changed[1].periodConstraintByCandidateId["place-0001"].strength,"hard");assert.match(changed[1].periodConstraintByCandidateId["place-0001"].evidence,/确认修改固定时段/);
});

test("general food preferences permit real culinary areas but require a named request for a restaurant", () => {
  const court = { name: "Maxwell Food Centre", types: ["food_court", "restaurant"], primaryType: "food_court" };
  const restaurant = { name: "Specific Restaurant", types: ["restaurant"] };
  assert.equal(planningSceneRole(court), "culinary_area");
  assert.equal(planningSceneRole(restaurant), "restaurant_meal");
  assert.equal(planningSceneRole({ name: "Chinatown Food Street", types: ["tourist_attraction"] }), "culinary_area");
  assert.equal(planningSceneRole({ name: "Street Art", types: ["tourist_attraction"] }), "attraction");
  assert.equal(allowAutomaticFoodScene(court, true, false), true);
  assert.equal(allowAutomaticFoodScene(court, false, false), false);
  assert.equal(allowAutomaticFoodScene(restaurant, true, false), false);
  assert.equal(allowAutomaticFoodScene(restaurant, false, true), true);
  assert.deepEqual(court.types, ["food_court", "restaurant"]);
});

test("return preference strength requires evidence; ambiguous old data remains firm", () => {
  assert.deepEqual(planningReturnConstraint(), { strength: "hard", source: "legacy" });
  assert.equal(planningReturnConstraint({ dailyEndTime: { source: "bailian", status: "confirmed", evidence: "希望大概21点回酒店" } }).strength, "soft");
  assert.equal(planningReturnConstraint({ latestReturnTime: { source: "code", status: "confirmed", evidence: "最晚21点必须回酒店" } }).strength, "hard");
  assert.equal(planningReturnConstraint({ latestReturnTime: { source: "derived", status: "confirmed", evidence: "大概21点" } }).source, "legacy");
});
