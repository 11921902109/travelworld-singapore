import assert from "node:assert/strict";
import test from "node:test";
import { deletePlanningDay } from "../lib/travel/planning-day-change.ts";

const dates = { start: "2026-12-20", end: "2026-12-23", days: 4 };
const assignments = [1, 2, 3, 4].map((day) => ({
  day, orderedCandidateIds: [`place-${day}`], periodByCandidateId: { [`place-${day}`]: day % 2 ? "morning" : "afternoon" },
}));

test("deleting the first day moves the start date and reindexes later places", () => {
  const next = deletePlanningDay(dates, assignments, 1);
  assert.deepEqual(next.dates, { start: "2026-12-21", end: "2026-12-23", days: 3 });
  assert.deepEqual(next.assignments.map((item) => [item.day, item.orderedCandidateIds[0]]),
    [[1, "place-2"], [2, "place-3"], [3, "place-4"]]);
  assert.equal(next.assignments[0].periodByCandidateId["place-2"], "afternoon");
});

test("deleting a middle day shortens the end date and moves later places forward", () => {
  const next = deletePlanningDay(dates, assignments, 2);
  assert.deepEqual(next.dates, { start: "2026-12-20", end: "2026-12-22", days: 3 });
  assert.deepEqual(next.assignments.map((item) => [item.day, item.orderedCandidateIds[0]]),
    [[1, "place-1"], [2, "place-3"], [3, "place-4"]]);
});

test("deleting the last day preserves earlier assignments", () => {
  const next = deletePlanningDay(dates, assignments, 4);
  assert.deepEqual(next.dates, { start: "2026-12-20", end: "2026-12-22", days: 3 });
  assert.deepEqual(next.assignments.map((item) => item.orderedCandidateIds[0]),
    ["place-1", "place-2", "place-3"]);
});

test("cannot delete the only remaining travel day", () => {
  assert.throws(() => deletePlanningDay({ start: "2026-12-20", end: "2026-12-20", days: 1 }, assignments.slice(0, 1), 1),
    /INVALID_DAY_DELETION/);
});
