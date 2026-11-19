export type BoardAssignment = {
  day: number;
  orderedCandidateIds: string[];
  periodByCandidateId?: Record<string, "morning" | "afternoon" | "flexible">;
  periodConstraintByCandidateId?: Record<string, { strength: "soft" | "hard"; source: "user" | "legacy" | "suggestion"; evidence?: string }>;
  dayPurpose?: "activities" | "rest";
};
export type BoardPlacePreference = { period: "morning" | "afternoon"; constraint?: { strength: "soft" | "hard"; source: "user" | "legacy" | "suggestion"; evidence?: string } };
export function boardPlacePreferences(assignments: BoardAssignment[], previous: Record<string, BoardPlacePreference> = {}): Record<string, BoardPlacePreference> {
  const result = { ...previous };
  for (const item of assignments) for (const id of item.orderedCandidateIds) {
    const period = item.periodByCandidateId?.[id];
    if (period === "morning" || period === "afternoon") result[id] = { period, constraint: item.periodConstraintByCandidateId?.[id] || { strength: "hard", source: "legacy" } };
  }
  return result;
}

export function boardSignature(assignments: BoardAssignment[]): string {
  return JSON.stringify([...assignments].sort((a, b) => a.day - b.day).map((item) => ({
    day: item.day, ids: item.orderedCandidateIds,
    periods: Object.entries(item.periodByCandidateId || {}).sort(([a], [b]) => a.localeCompare(b)),
    constraints: Object.entries(item.periodConstraintByCandidateId || {}).sort(([a], [b]) => a.localeCompare(b)),
    purpose: item.orderedCandidateIds.length ? "activities" : item.dayPurpose || "activities",
  })));
}

/** Move once across the whole board; untouched rest days and explicit constraints survive. */
export function moveBoardPlace(assignments: BoardAssignment[], days: number, id: string, destinationDay: number | null, index?: number, retained: Record<string, BoardPlacePreference> = {}, selectedPeriod?: "morning" | "afternoon"): BoardAssignment[] {
  const source = assignments.find((item) => item.orderedCandidateIds.includes(id));
  const previousPeriod = source?.periodByCandidateId?.[id] || retained[id]?.period;
  const previousConstraint = source?.periodConstraintByCandidateId?.[id] || retained[id]?.constraint;
  const period = selectedPeriod || previousPeriod;
  const constraint: BoardPlacePreference["constraint"] = selectedPeriod && selectedPeriod !== previousPeriod
    ? { strength: previousConstraint?.strength || (previousPeriod && previousPeriod !== "flexible" ? "hard" : "soft"), source: "user" as const,
      evidence: `用户${previousConstraint?.strength === "hard" ? "确认修改固定时段并" : ""}安排在${selectedPeriod === "morning" ? "上午" : "下午"}` }
    : previousConstraint || (selectedPeriod ? { strength: previousPeriod && previousPeriod !== "flexible" ? "hard" as const : "soft" as const, source: "user" as const, evidence: `用户安排在${selectedPeriod === "morning" ? "上午" : "下午"}` } : undefined);
  const next = Array.from({ length: days }, (_, i) => {
    const old = assignments.find((item) => item.day === i + 1);
    const periods = { ...old?.periodByCandidateId }; delete periods[id];
    const constraints = { ...old?.periodConstraintByCandidateId }; delete constraints[id];
    return { ...old, day: i + 1, orderedCandidateIds: (old?.orderedCandidateIds || []).filter((value) => value !== id),
      periodByCandidateId: periods, periodConstraintByCandidateId: constraints };
  });
  const target = next.find((item) => item.day === destinationDay);
  if (target) {
    target.orderedCandidateIds.splice(index === undefined ? target.orderedCandidateIds.length : Math.max(0, Math.min(index, target.orderedCandidateIds.length)), 0, id);
    if (period) target.periodByCandidateId[id] = period;
    if (constraint) target.periodConstraintByCandidateId[id] = constraint;
    target.dayPurpose = "activities";
  }
  return next;
}
