import { z } from "zod";
import type { PlanningDraftV1, PlanningHandoffV1 } from "./planning-state";
import { planningBoardConfirmationIssues, selectedPlanningPlaceIds } from "./planning-place-selection";

type Stage = "places" | "day_allocation" | "flights" | "stays" | "route" | "complete";
type Draft = { boardConfirmed: boolean; flightSearchJob?: Record<string, unknown>; flightQuotes?: unknown; flightSelection?: unknown; stayAdvice?: unknown; staySegments?: unknown[]; stayConfirmed?: boolean; dayEstimates?: unknown[] };
const order: Stage[] = ["places", "day_allocation", "flights", "stays", "route", "complete"];
export function planningEditImpact(draft: Draft, stage: Stage): string[] {
  const index = order.indexOf(stage);
  const result: string[] = [];
  if (index < 1 && draft.boardConfirmed) result.push("已保存的分天需复核");
  if (index < 2) {
    if (["queued", "running"].includes(String(draft.flightSearchJob?.status))) result.push("进行中的航班查询将停止应用到更新后的安排");
    if (draft.flightSelection) result.push("已有航班安排保留为待复核");
    else if (draft.flightQuotes) result.push("已有航班查询结果需复核");
  }
  if (index < 3 && (draft.stayAdvice || draft.staySegments?.length || draft.stayConfirmed)) result.push("已有住宿安排需复核");
  if (index < 4 && draft.dayEstimates?.length) result.push("已有时间核算需重新计算");
  return result;
}

function canonicalReviewSource(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalReviewSource);
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalReviewSource(item)])) : value;
}
async function reviewFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalReviewSource(value)));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const PlanningReviewItemSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(["board", "flight_arrival", "flight_departure", "stay", "budget", "opening", "route"]),
  day: z.number().int().min(1).max(7),
  sourceFingerprint: z.string().min(8).max(100),
  status: z.enum(["pending", "resolved"]),
  resolvedInputFingerprint: z.string().max(100).optional(),
  lastConfirmedFingerprint: z.string().max(100).optional(),
});
export type PlanningReviewItem = z.infer<typeof PlanningReviewItemSchema>;

export const PlanningPendingReviewSchema = z.object({
  kind: z.string().min(1).max(80), message: z.string().min(1).max(300),
  targetStage: z.enum(["places", "day_allocation", "flights", "stays", "route"]),
  day: z.number().int().min(1).max(7).optional(),
});
export type PlanningPendingReview = z.infer<typeof PlanningPendingReviewSchema>;

/** This identity ignores display text and draft version, but binds confirmed conditions and the whole board. */
export async function planningBoardSourceFingerprint(handoff: PlanningHandoffV1, draft: PlanningDraftV1): Promise<string> {
  const selected = selectedPlanningPlaceIds(draft).sort();
  return reviewFingerprint({
    kind: "board", handoffId: draft.handoffId, sourceIntentStateVersion: draft.sourceIntentStateVersion,
    dates: handoff.dates, dailyWindow: handoff.dailyWindow, pace: handoff.pace,
    preferences: handoff.preferences, travelers: handoff.travelers,
    selected,
    // The order inside a day matters; the order of the day records does not.
    assignments: [...draft.assignments].sort((a, b) => a.day - b.day).map((item) => ({
      day: item.day, ids: item.orderedCandidateIds, periods: item.periodByCandidateId || {},
      constraints: item.periodConstraintByCandidateId || {}, purpose: item.dayPurpose || "activities",
    })),
    placeTimePreferences: draft.placeTimePreferences || {},
    candidates: selected.map((id) => {
      const item = draft.candidates.find((candidate) => candidate.placeId === id);
      return { placeId: id, verified: item?.verified, location: item?.location, kind: item?.kind, estimatedMinutes: item?.estimatedMinutes };
    }),
  });
}

/** Recheck the same invariants as a board confirmation before migrating any old notice. */
export function planningBoardIsValid(handoff: PlanningHandoffV1, draft: PlanningDraftV1): boolean {
  const selected = selectedPlanningPlaceIds(draft);
  const allowed = new Set(selected);
  const assigned = draft.assignments.flatMap((item) => item.orderedCandidateIds);
  if (!draft.boardConfirmed || draft.placesConfirmed === false || !selected.length ||
      handoff.sourceIntentStateVersion !== draft.sourceIntentStateVersion ||
      draft.assignments.length !== handoff.dates.days || new Set(draft.assignments.map((item) => item.day)).size !== handoff.dates.days ||
      draft.assignments.some((item) => item.day < 1 || item.day > handoff.dates.days) ||
      new Set(assigned).size !== assigned.length || assigned.some((id) => !allowed.has(id)) ||
      draft.selectedPlaceIds?.some((id) => !allowed.has(id)) ||
      Object.keys(draft.placeTimePreferences || {}).some((id) => !allowed.has(id))) return false;
  if (selected.some((id) => {
    const candidate = draft.candidates.find((item) => item.placeId === id);
    const location = record(candidate?.location);
    return candidate?.verified !== true || !Number.isFinite(location.lat) || !Number.isFinite(location.lng);
  })) return false;
  if (draft.assignments.some((item) => [...Object.keys(item.periodByCandidateId || {}), ...Object.keys(item.periodConstraintByCandidateId || {})].some((id) => !item.orderedCandidateIds.includes(id)))) return false;
  const issues = planningBoardConfirmationIssues(selected, draft.assignments, handoff.dates.days);
  // Pre-selection-board records allowed unspecified periods. New records always
  // carry these selection fields and must pass the explicit AM/PM requirement.
  const legacyFlexiblePeriods = draft.placesConfirmed === undefined && draft.selectedPlaceIds === undefined &&
    !Object.keys(draft.placeTimePreferences || {}).length && draft.assignments.every((item) => !item.periodByCandidateId && !item.periodConstraintByCandidateId);
  return !issues.unassignedPlaceIds.length && !issues.unconfirmedEmptyDays.length &&
    (legacyFlexiblePeriods || !issues.unresolvedPeriodPlaceIds.length);
}

/** Only a validated explicit confirmation or a validated legacy confirmation can resolve this review. */
export async function reconcileBoardReviews(handoff: PlanningHandoffV1, draft: PlanningDraftV1, confirmedByUser = false) {
  const fingerprint = await planningBoardSourceFingerprint(handoff, draft);
  const previous = draft.reviewItems?.find((item) => item.kind === "board");
  const valid = planningBoardIsValid(handoff, draft);
  const resolved = valid && (confirmedByUser || !previous ||
    previous.status === "resolved" && previous.sourceFingerprint === fingerprint && previous.resolvedInputFingerprint === fingerprint);
  const lastConfirmed = resolved ? fingerprint : previous?.lastConfirmedFingerprint || previous?.resolvedInputFingerprint;
  const board: PlanningReviewItem = {
    id: "board", kind: "board", day: 1, sourceFingerprint: fingerprint, status: resolved ? "resolved" : "pending",
    ...(resolved ? { resolvedInputFingerprint: fingerprint } : {}),
    ...(lastConfirmed ? { lastConfirmedFingerprint: lastConfirmed } : {}),
  };
  return {
    reviewItems: [...(draft.reviewItems || []).filter((item) => item.kind !== "board"), board],
    reviewRequired: (draft.reviewRequired || []).filter((text) => resolved ? text !== "地点与分天" : true),
  };
}

// Match only text generated by our previous flight endpoint, never arbitrary notices.
const LEGACY_FLIGHT_REVIEWS = new Set([
  "Day 1 抵达后还需预留约 2 小时入境、行李与交通；请复核当天地点。",
  "最后一天需提前至少 3 小时结束游览并前往机场；请复核当天地点。",
]);
const isFlightReview = (item: PlanningReviewItem) => item.kind === "flight_arrival" || item.kind === "flight_departure";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

async function flightItems(handoff: PlanningHandoffV1, draft: PlanningDraftV1, selection: Record<string, unknown>): Promise<PlanningReviewItem[]> {
  if (!selection.mode || selection.mode === "none") return [];
  const journey = record(selection.journey);
  return Promise.all((["flight_arrival", "flight_departure"] as const).map(async (kind) => {
    const arrival = kind === "flight_arrival";
    const day = arrival ? 1 : handoff.dates.days;
    const id = `${kind}:day-${day}`;
    const sourceFingerprint = await reviewFingerprint({
      kind, day, handoffId: draft.handoffId,
      date: arrival ? handoff.dates.start : handoff.dates.end,
      mode: selection.mode,
      flight: arrival ? selection.outbound : selection.inbound,
      journey: arrival ? journey.outbound : journey.inbound,
      local: arrival ? selection.arrivalAt : selection.departureAt,
      airport: arrival ? [selection.arrivalAirportPlaceId, selection.arrivalAirportName] : [selection.departureAirportPlaceId, selection.departureAirportName],
    });
    const previous = draft.reviewItems?.find((item) => item.id === id && item.sourceFingerprint === sourceFingerprint);
    return previous || { id, kind, day, sourceFingerprint, status: "pending" as const };
  }));
}

/** Flight notices are informational; only their typed, current reviews can block. */
export async function refreshFlightReviews(handoff: PlanningHandoffV1, draft: PlanningDraftV1, selection: Record<string, unknown>) {
  return {
    reviewItems: [...(draft.reviewItems || []).filter((item) => !isFlightReview(item)), ...await flightItems(handoff, draft, selection)],
    reviewRequired: (draft.reviewRequired || []).filter((text) => text !== "航班" && !LEGACY_FLIGHT_REVIEWS.has(text)),
  };
}

/** Resolve only a current, successfully recalculated day, preserving unrelated blockers. */
export async function reconcileFlightReviews(
  handoff: PlanningHandoffV1,
  draft: PlanningDraftV1,
  currentDayFingerprint: (day: number) => Promise<string>,
) {
  const selection = record(draft.flightSelection);
  const current = await refreshFlightReviews(handoff, draft, selection);
  // A generic "航班" review means the upstream selection itself needs confirmation.
  if ((draft.reviewRequired || []).includes("航班")) current.reviewRequired.push("航班");
  current.reviewItems = await Promise.all(current.reviewItems.map(async (item) => {
    if (!isFlightReview(item)) return item;
    const estimate = draft.dayEstimates?.find((value) => value.day === item.day);
    const metrics = record(estimate?.metrics);
    const transport = record(estimate?.transport);
    const hasConflict = draft.scheduleConflicts?.some((conflict) => conflict.day === item.day);
    const fingerprint = await currentDayFingerprint(item.day);
    const valid = !hasConflict && Boolean(estimate?.scheduledDay) && transport.status === "complete"
      && metrics.overtimeMinutes === 0 && estimate?.inputFingerprint === fingerprint;
    return valid ? { ...item, status: "resolved" as const, resolvedInputFingerprint: fingerprint }
      : { ...item, status: "pending" as const, resolvedInputFingerprint: undefined };
  }));
  return current;
}

export function pendingReviewLabels(draft: Pick<PlanningDraftV1, "reviewRequired" | "reviewItems">): string[] {
  return [...new Set([...(draft.reviewRequired || []).filter((text) => text !== "路线"), ...(draft.reviewItems || []).filter((item) => item.status === "pending").map((item) =>
    item.kind === "board" ? "地点与分天" : `Day ${item.day} ${item.kind === "flight_arrival" ? "抵达后安排" : item.kind === "flight_departure" ? "离境前安排" : item.kind === "budget" ? "预算" : item.kind === "stay" ? "住宿" : item.kind === "opening" ? "开放时间" : "路线"}待核对`)])];
}
