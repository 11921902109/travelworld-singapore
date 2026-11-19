import assert from "node:assert/strict";
import test from "node:test";
import { selectedPlanningPlaceIds, retainSelectedAssignments, planningBoardConfirmationIssues, workingPlanningPlaceIds, toggleLocalPlanningPlace, samePlanningPlaceSelection, mergePlanningCandidatePool } from "../lib/travel/planning-place-selection.ts";

test("legacy selection restores assigned places, not all recommendations", () => {
  const candidates = [{ placeId: "place-a" }, { placeId: "place-b" }];
  assert.deepEqual(selectedPlanningPlaceIds({ candidates, assignments: [{ day: 1, orderedCandidateIds: ["place-a"] }] }), ["place-a"]);
  assert.deepEqual(selectedPlanningPlaceIds({ candidates, assignments: [] }), []);
});

test("deselecting a place removes its day and period references", () => {
  const next = retainSelectedAssignments([{ day: 1, orderedCandidateIds: ["place-a", "place-b"], periodByCandidateId: { "place-a": "morning", "place-b": "afternoon" }, dayPurpose: "activities" }], ["place-b"]);
  assert.deepEqual(next[0].orderedCandidateIds, ["place-b"]);
  assert.deepEqual(next[0].periodByCandidateId, { "place-b": "afternoon" });
});

test("board confirmation requires an explicit morning or afternoon assignment and preserves rest days", () => {
  const issues = planningBoardConfirmationIssues(["place-a", "place-b"], [{ day: 1, orderedCandidateIds: ["place-a"], periodByCandidateId: { "place-a": "flexible" } }], 2);
  assert.deepEqual(issues, { unassignedPlaceIds: ["place-b"], unconfirmedEmptyDays: [2], unresolvedPeriodDays: [1], unresolvedPeriodPlaceIds: ["place-a"] });
  assert.deepEqual(planningBoardConfirmationIssues(["place-a"], [{ day: 1, orderedCandidateIds: ["place-a"], periodByCandidateId: { "place-a": "morning" } }, { day: 2, orderedCandidateIds: [], dayPurpose: "rest" }], 2),
    { unassignedPlaceIds: [], unconfirmedEmptyDays: [], unresolvedPeriodDays: [], unresolvedPeriodPlaceIds: [] });
  assert.deepEqual(planningBoardConfirmationIssues(["place-a"], [{ day: 1, orderedCandidateIds: ["place-a"] }], 1).unresolvedPeriodPlaceIds, ["place-a"]);
});

test("local selections survive a candidate search and preserve explicit deselections", () => {
  const saved = ["place-a"];
  let edits = toggleLocalPlanningPlace(saved, { added: [], removed: [] }, "place-b");
  edits = toggleLocalPlanningPlace(saved, edits, "place-a");
  assert.deepEqual(workingPlanningPlaceIds(["place-a", "place-c"], edits, ["place-a", "place-b", "place-c"]), ["place-c", "place-b"]);
  assert.deepEqual(workingPlanningPlaceIds(saved, edits, ["place-a"]), []);
  assert.equal(samePlanningPlaceSelection(["place-a", "place-b"], ["place-b", "place-a", "place-a"]), true);
});

test("updating a full candidate pool retains selected and assigned places", () => {
  const original = Array.from({ length: 40 }, (_, i) => ({ placeId: `old-${i}` }));
  const incoming = Array.from({ length: 40 }, (_, i) => ({ placeId: `new-${i}` }));
  const result = mergePlanningCandidatePool(original, incoming, ["old-2", "old-7"], true);
  assert.equal(result.length, 40);
  assert.deepEqual(result.slice(0, 2).map((item) => item.placeId), ["old-2", "old-7"]);
  assert.equal(result.some((item) => item.placeId === "old-3"), false);
  assert.equal(mergePlanningCandidatePool(original, incoming, [], false).length, 40);
  const protectedPlace = { placeId: "chosen", estimatedMinutes: 180 };
  assert.equal(mergePlanningCandidatePool([protectedPlace], [{ placeId: "chosen", estimatedMinutes: 60 }], ["chosen"], true)[0], protectedPlace);
});
