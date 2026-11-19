import type { PlanningDraftV1 } from "./planning-state";

type Assignment = PlanningDraftV1["assignments"][number];
type Dates = { start: string; end: string; days: number };

export function shiftSingaporeDate(date: string, delta: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== date) {
    throw new Error("INVALID_TRAVEL_DATE");
  }
  value.setUTCDate(value.getUTCDate() + delta);
  return value.toISOString().slice(0, 10);
}

/** Keep travel days consecutive; the first day is the only deletion that moves start. */
export function deletePlanningDay(dates: Dates, assignments: Assignment[], deletedDay: number) {
  if (!Number.isInteger(deletedDay) || deletedDay < 1 || deletedDay > dates.days || dates.days < 2 || dates.days > 7) {
    throw new Error("INVALID_DAY_DELETION");
  }
  const nextDates = deletedDay === 1
    ? { start: shiftSingaporeDate(dates.start, 1), end: dates.end, days: dates.days - 1 }
    : { start: dates.start, end: shiftSingaporeDate(dates.end, -1), days: dates.days - 1 };
  const nextAssignments = Array.from({ length: dates.days }, (_, index) => {
    const day = index + 1;
    return assignments.find((item) => item.day === day) ?? { day, orderedCandidateIds: [] };
  }).filter((item) => item.day !== deletedDay).map((item, index) => ({
    ...item, day: index + 1, orderedCandidateIds: [...item.orderedCandidateIds],
    periodByCandidateId: { ...(item.periodByCandidateId || {}) }, status: "provisional" as const,
  }));
  return { dates: nextDates, assignments: nextAssignments };
}
