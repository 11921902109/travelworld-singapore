type Place = { placeId?: unknown };
type Assignment = {
  day: number;
  orderedCandidateIds: string[];
  periodByCandidateId?: Record<string, "morning" | "afternoon" | "flexible">;
  periodConstraintByCandidateId?: Record<string, { strength: "soft" | "hard"; source: "user" | "legacy" | "suggestion"; evidence?: string }>;
  dayPurpose?: "activities" | "rest";
};

export type LocalPlaceSelection = { added: string[]; removed: string[] };

/** Keep local changes when a search or a version-conflict response refreshes the pool. */
export function workingPlanningPlaceIds(saved: string[], edits: LocalPlaceSelection, available: string[]): string[] {
  const allowed = new Set(available);
  const removed = new Set(edits.removed);
  return [...new Set([...saved, ...edits.added])].filter((id) => allowed.has(id) && !removed.has(id));
}

export function toggleLocalPlanningPlace(saved: string[], edits: LocalPlaceSelection, id: string): LocalPlaceSelection {
  const selected = new Set([...saved, ...edits.added].filter((value) => !edits.removed.includes(value)));
  return selected.has(id)
    ? { added: edits.added.filter((value) => value !== id), removed: [...new Set([...edits.removed, id])] }
    : { added: [...new Set([...edits.added, id])], removed: edits.removed.filter((value) => value !== id) };
}

export function samePlanningPlaceSelection(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Replacement may evict only unselected, unassigned candidates. */
export function mergePlanningCandidatePool<T extends { placeId?: unknown }>(current: T[], incoming: T[], protectedIds: string[], replaceUnselected = false, limit = 40): T[] {
  const protectedSet = new Set(protectedIds);
  const retained = replaceUnselected ? current.filter((item) => protectedSet.has(String(item.placeId))) : current;
  const pool = new Map(retained.map((item) => [String(item.placeId), item]));
  incoming.forEach((item) => {
    const id = String(item.placeId);
    if (pool.has(id) && protectedSet.has(id)) return;
    if (pool.has(id) || pool.size < limit) pool.set(id, item);
  });
  return [...pool.values()];
}

/** Older drafts restore only actually assigned places, never the entire pool. */
export function selectedPlanningPlaceIds(draft: { candidates: Place[]; selectedPlaceIds?: string[]; assignments: Assignment[] }): string[] {
  const allowed = new Set(draft.candidates.flatMap((item) => typeof item.placeId === "string" ? [item.placeId] : []));
  const selected = draft.selectedPlaceIds ?? draft.assignments.flatMap((item) => item.orderedCandidateIds);
  return [...new Set(selected)].filter((id) => allowed.has(id));
}

export function retainSelectedAssignments<T extends Assignment>(assignments: T[], selectedPlaceIds: string[]): T[] {
  const selected = new Set(selectedPlaceIds);
  return assignments.map((assignment) => {
    const ids = assignment.orderedCandidateIds.filter((id) => selected.has(id));
    const periods = Object.fromEntries(Object.entries(assignment.periodByCandidateId || {}).filter(([id]) => ids.includes(id)));
    const constraints = Object.fromEntries(Object.entries(assignment.periodConstraintByCandidateId || {}).filter(([id]) => ids.includes(id)));
    return { ...assignment, orderedCandidateIds: ids, periodByCandidateId: periods,
      ...(assignment.periodConstraintByCandidateId ? { periodConstraintByCandidateId: constraints } : {}),
      dayPurpose: ids.length ? "activities" : assignment.dayPurpose === "rest" ? "rest" : "activities" };
  });
}

export function planningBoardConfirmationIssues(selectedPlaceIds: string[], assignments: Assignment[], days: number) {
  const assigned = new Set(assignments.flatMap((item) => item.orderedCandidateIds));
  const unassignedPlaceIds = selectedPlaceIds.filter((id) => !assigned.has(id));
  const unconfirmedEmptyDays = Array.from({ length: days }, (_, index) => index + 1).filter((day) => {
    const assignment = assignments.find((item) => item.day === day);
    return !assignment?.orderedCandidateIds.length && assignment?.dayPurpose !== "rest";
  });
  const unresolvedPeriodDays = assignments.filter((assignment) => assignment.orderedCandidateIds.some((id) =>
    assignment.periodByCandidateId?.[id] !== "morning" && assignment.periodByCandidateId?.[id] !== "afternoon")).map((assignment) => assignment.day);
  const unresolvedPeriodPlaceIds = assignments.flatMap((assignment) => assignment.orderedCandidateIds.filter((id) =>
    assignment.periodByCandidateId?.[id] !== "morning" && assignment.periodByCandidateId?.[id] !== "afternoon"));
  return { unassignedPlaceIds, unconfirmedEmptyDays, unresolvedPeriodDays, unresolvedPeriodPlaceIds };
}
