import { z } from "zod";
import type { SingaporeIntentResult, SingaporeTravelIntent } from "./singapore-intent";
import { planningReturnConstraint } from "./planning-time-preference";
import type { PlanningTiming } from "./planning-timing";
import { PlanningReviewItemSchema, PlanningPendingReviewSchema } from "./planning-review";
import { planningDraftWithReadiness } from "./planning-readiness";

const nullableText = z.string().trim().max(120).nullable();
const textList = z.array(z.string().trim().min(1).max(120)).max(20);

/** A compact, server-authored handoff. It contains no conversation transcript. */
export const PlanningHandoffSchema = z.object({
  schemaVersion: z.literal(1),
  sourceIntentStateVersion: z.number().int().positive(),
  destination: z.literal("Singapore"),
  dates: z.object({
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    days: z.number().int().min(1).max(7),
  }),
  originCity: nullableText,
  travelers: z.object({
    total: z.number().int().min(1).max(20),
    adults: z.number().int().min(0).max(20).nullable(),
    children: z.number().int().min(0).max(20).nullable(),
    seniors: z.number().int().min(0).max(20).nullable(),
  }),
  dailyWindow: z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/),
    preferredReturn: z.string().regex(/^\d{2}:\d{2}$/),
    latestReturn: z.string().regex(/^\d{2}:\d{2}$/),
    returnConstraint: z.object({ strength: z.enum(["soft", "hard"]), source: z.enum(["user", "legacy"]), evidence: z.string().max(300).optional() }).optional(),
  }),
  pace: z.enum(["relaxed", "balanced", "intensive"]),
  preferences: z.object({
    interests: textList,
    mustVisit: textList,
    allowAutomaticRecommendations: z.boolean(),
    recommendationDeclined: z.boolean().default(false),
    avoid: textList,
    mobilityConstraints: textList,
    dietaryPreferences: textList,
    dietaryScope: z.enum(["all", "individual"]).nullable(),
    preferredTransport: textList,
  }),
  budget: z.object({
    level: z.enum(["budget", "standard", "premium"]).nullable(),
    amount: z.number().positive().nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
    scope: z.enum(["per_person_per_day", "group_per_day", "per_person_total", "group_total"]).nullable(),
    excludesFlights: z.boolean().nullable(),
  }).nullable(),
  accommodationPreference: z.object({ areaName: nullableText, hotelName: nullableText }).nullable(),
  openQuestions: z.array(z.enum(["origin_city", "accommodation", "interests"])).max(3),
  confirmedByUser: z.literal(true),
});

export type PlanningHandoffV1 = z.infer<typeof PlanningHandoffSchema>;

const planningObject = z.record(z.unknown());
export const PlanningDayPeriodSchema = z.enum(["morning", "afternoon", "flexible"]);
const PlanningStageSchema = z.enum(["places", "day_allocation", "flights", "stays", "route", "complete"]);
const PlanningSnapshotSchema = z.object({
  stage: PlanningStageSchema,
  version: z.number().int().nonnegative(),
  savedAt: z.string().datetime(),
  summary: z.array(z.string().trim().min(1).max(300)).max(40),
});
export const PlanningAssignmentSchema = z.object({
  day: z.number().int().min(1).max(7),
  orderedCandidateIds: z.array(z.string().trim().min(1).max(255)).max(100),
  periodByCandidateId: z.record(PlanningDayPeriodSchema).optional(),
  periodConstraintByCandidateId: z.record(z.object({ strength: z.enum(["soft", "hard"]), source: z.enum(["user", "legacy", "suggestion"]), evidence: z.string().max(300).optional() })).optional(),
  status: z.enum(["provisional", "confirmed"]).optional(),
  dayPurpose: z.enum(["activities", "rest"]).optional(),
});
export const PlanningPlaceTimePreferencesSchema = z.record(z.object({ period: z.enum(["morning", "afternoon"]), constraint: z.object({ strength: z.enum(["soft", "hard"]), source: z.enum(["user", "legacy", "suggestion"]), evidence: z.string().max(300).optional() }).optional() }));
export const PlanningDraftSchema = z.object({
  version: z.number().int().min(0),
  handoffId: z.string().uuid(),
  sourceIntentStateVersion: z.number().int().positive(),
  stage: PlanningStageSchema,
  candidates: z.array(planningObject).max(100),
  selectedPlaceIds: z.array(z.string().min(1).max(255)).max(100).optional(),
  placesConfirmed: z.boolean().optional(),
  selectionReason: z.string().max(600).optional(),
  sceneDiscoveryJob: planningObject.optional(),
  placeRemovalUndo: z.object({ candidate: planningObject, selectedPlaceIds: z.array(z.string()).max(100), assignments: z.array(PlanningAssignmentSchema).max(7) }).optional(),
  assignments: z.array(PlanningAssignmentSchema).max(7),
  placeTimePreferences: PlanningPlaceTimePreferencesSchema.optional(),
  boardConfirmed: z.boolean(),
  dayDeletionUndo: z.object({
    deletedDay: z.number().int().min(1).max(7),
    previousIntentJson: z.string().min(1).max(50_000),
    previousAssignments: z.array(PlanningAssignmentSchema).max(7),
  }).optional(),
  flightQuotes: planningObject.optional(),
  flightSearchJob: planningObject.optional(),
  flightSelection: planningObject.nullable().optional(),
  stayAdvice: planningObject.optional(),
  staySegments: z.array(planningObject).max(14).optional(),
  stayConfirmed: z.boolean().optional(),
  hotelQuoteJob: planningObject.optional(),
  dayEstimates: z.array(planningObject).max(7).optional(),
  scheduleConflicts: z.array(planningObject).max(7).optional(),
  lastScheduleOperation: planningObject.optional(),
  scheduleOverrides: z.array(planningObject).max(7).optional(),
  freeTimeDecisions: z.array(planningObject).max(7).optional(),
  reviewRequired: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  reviewItems: z.array(PlanningReviewItemSchema).max(40).optional(),
  // Derived server projections, never accepted as persisted authority.
  pendingReviews: z.array(PlanningPendingReviewSchema).max(100).optional(),
  staleScheduleDays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  scheduleReady: z.boolean().optional(),
  stageHistory: z.array(PlanningSnapshotSchema).max(30).optional(),
  updatedAt: z.string().datetime(),
});
export type PlanningDraftV1 = z.infer<typeof PlanningDraftSchema>;
export type PlanningDraftInput = Omit<PlanningDraftV1, "version" | "updatedAt">;

const PlanningDraftInputSchema = PlanningDraftSchema.omit({ version: true, updatedAt: true, pendingReviews: true, staleScheduleDays: true, scheduleReady: true });
const MAX_DRAFT_BYTES = 200_000;
const DRAFT_TURN_ID_PATTERN = /^[A-Za-z0-9_:-]{8,100}$/;

const stageOrder = PlanningStageSchema.options;
function stageSummary(stage: PlanningDraftV1["stage"], draft: PlanningDraftInput): string[] {
  const hours = (value: unknown) => `${Number(((Number(value) || 0) / 60).toFixed(2))} 小时`;
  const label = (value: unknown) => typeof value === "string" ? value.slice(0, 100)
    : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (stage === "places") return draft.candidates.filter((item) => draft.selectedPlaceIds?.includes(String(item.placeId)) || (!draft.selectedPlaceIds && draft.assignments.some((day) => day.orderedCandidateIds.includes(String(item.placeId))))).slice(0, 30).map((item) => `${label(item.name)} · ${label(item.area)} · ${label(item.category)}`.slice(0, 300));
  if (stage === "day_allocation") return draft.assignments.map((assignment) => {
    const names = assignment.orderedCandidateIds.map((id) => {
      const place = draft.candidates.find((candidate) => candidate.placeId === id);
      const period = assignment.periodByCandidateId?.[id];
      return `${label(place?.name) || id}${period === "morning" ? "（上午）" : period === "afternoon" ? "（下午）" : ""}`;
    });
    return `Day ${assignment.day}：${names.join("、") || "休息／自由日"}`.slice(0, 300);
  });
  if (stage === "flights") {
    const selection = object(draft.flightSelection);
    if (selection.mode === "none") return ["无需航班，按每日行动时段规划"];
    if (selection.mode === "manual") return [`已手动填写：${label(selection.arrivalAt)} 抵达，${label(selection.departureAt)} 离境`];
    const out = object(selection.outbound);
    const back = object(selection.inbound);
    return [`去程 ${label(out.flightNumber)}：${label(out.departureLocal)} 出发、${label(out.arrivalLocal)} 抵达`,
      `返程 ${label(back.flightNumber)}：${label(back.departureLocal)} 出发、${label(back.arrivalLocal)} 抵达`];
  }
  if (stage === "stays") return draft.staySegments?.length
    ? draft.staySegments.map((item) => `Day ${label(item.startDay)} 起 · ${label(item.area)} · ${label(object(item.hotel).name)} · ${label(item.checkInDate)} 至 ${label(item.checkOutDate)}`.slice(0, 300))
    : ["无需过夜住宿"];
  if (stage === "route") return (draft.dayEstimates || []).map((item) => {
    const metrics = object(item.metrics);
    return `Day ${label(item.day)}：游玩 ${hours(metrics.visitMinutes)}，交通 ${hours(metrics.travelMinutes)}，空余 ${hours(metrics.freeMinutes)}`;
  });
  return [];
}

export function createInitialPlanningDraft(
  handoffId: string,
  sourceIntentStateVersion: number,
  previous: PlanningDraftV1 | null = null,
): PlanningDraftV1 {
  return PlanningDraftSchema.parse({
    version: 0,
    handoffId,
    sourceIntentStateVersion,
    stage: "places",
    candidates: previous?.candidates ?? [],
    selectedPlaceIds: previous?.selectedPlaceIds ?? [...new Set(previous?.assignments.flatMap((item) => item.orderedCandidateIds) ?? [])],
    placesConfirmed: false,
    assignments: previous?.assignments.map((assignment) => ({ ...assignment, status: "provisional" })) ?? [],
    boardConfirmed: false,
    placeTimePreferences: previous?.placeTimePreferences,
    ...(previous?.flightSelection ? { flightSelection: previous.flightSelection } : {}),
    ...(previous?.staySegments ? { staySegments: previous.staySegments } : {}),
    reviewRequired: previous ? [...new Set([...(previous.reviewRequired || []), "地点与分天", "航班", "住宿", "路线"])] : [],
    ...(previous?.reviewItems ? { reviewItems: previous.reviewItems.filter((item) => item.status === "pending" && !["board", "flight_arrival", "flight_departure"].includes(item.kind)) } : {}),
    updatedAt: new Date().toISOString(),
  });
}

function parseDraftRow(row: { draft_json: string } | null): PlanningDraftV1 | null {
  return row ? PlanningDraftSchema.parse(JSON.parse(row.draft_json)) : null;
}

async function draftInputHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readPlanningDraft(visitToken: string): Promise<PlanningDraftV1 | null> {
  const { acquireTravelVisit } = await import("./visit-session");
  const controller = new AbortController();
  const lease = await acquireTravelVisit(visitToken, controller.signal);
  try {
    const row = await lease.readPlanningDraftRow();
    const handoff = await lease.readPlanningHandoff();
    const intentState = await lease.readIntentState();
    if (!row || !handoff || row.handoff_id !== handoff.handoff_id ||
        row.source_intent_state_version !== intentState.stateVersion) return null;
    const draft = parseDraftRow(row);
    return draft ? await planningDraftWithReadiness(PlanningHandoffSchema.parse(JSON.parse(handoff.handoff_json)), draft) : null;
  } finally {
    await lease.release();
  }
}

export async function readPlanningHandoff(
  visitToken: string,
): Promise<{ handoff: PlanningHandoffV1; handoffId: string } | null> {
  const { acquireTravelVisit } = await import("./visit-session");
  const controller = new AbortController();
  const lease = await acquireTravelVisit(visitToken, controller.signal);
  try {
    const row = await lease.readPlanningHandoff();
    if (!row) return null;
    const intentState = await lease.readIntentState();
    if (intentState.stateVersion !== row.source_intent_state_version) return null;
    return { handoff: PlanningHandoffSchema.parse(JSON.parse(row.handoff_json)), handoffId: row.handoff_id };
  } finally {
    await lease.release();
  }
}

export async function commitPlanningDraft(
  visitToken: string,
  input: { expectedVersion: number; turnId: string; nextDraft: PlanningDraftInput },
  timing?: PlanningTiming,
): Promise<{ committed: true; draft: PlanningDraftV1 } | { committed: false; draft: PlanningDraftV1 | null }> {
  if (!DRAFT_TURN_ID_PATTERN.test(input.turnId) || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new Error("Invalid planning draft turn metadata.");
  }
  const nextDraft = PlanningDraftInputSchema.parse(input.nextDraft);
  const inputJson = JSON.stringify({ expectedVersion: input.expectedVersion, nextDraft });
  if (new TextEncoder().encode(inputJson).length > MAX_DRAFT_BYTES) throw new Error("Planning draft is too large.");
  const inputHash = await draftInputHash(inputJson);
  const { acquireTravelVisit } = await import("./visit-session");
  const controller = new AbortController();
  const lease = await (timing ? timing.measureAsync("lease_wait", () => acquireTravelVisit(visitToken, controller.signal)) : acquireTravelVisit(visitToken, controller.signal));
  try {
    const priorTurn = await lease.findPlanningDraftTurn(input.turnId);
    if (priorTurn) {
      if (priorTurn.input_hash !== inputHash) throw new Error("Planning draft turn ID was reused for a different input.");
      const restored = PlanningDraftSchema.parse(JSON.parse(priorTurn.response_json));
      const restoredHandoff = await lease.readPlanningHandoff();
      return { committed: true, draft: restoredHandoff && restoredHandoff.handoff_id === restored.handoffId
        ? await planningDraftWithReadiness(PlanningHandoffSchema.parse(JSON.parse(restoredHandoff.handoff_json)), restored) : restored };
    }
    const handoff = await lease.readPlanningHandoff();
    const intentState = await lease.readIntentState();
    if (!handoff || handoff.handoff_id !== nextDraft.handoffId ||
        handoff.source_intent_state_version !== nextDraft.sourceIntentStateVersion ||
        intentState.stateVersion !== nextDraft.sourceIntentStateVersion) {
      throw new Error("Planning draft is based on an outdated or missing intent handoff.");
    }
    const current = await lease.readPlanningDraftRow();
    if (!current || current.version !== input.expectedVersion) {
      const restored = parseDraftRow(current);
      return { committed: false, draft: restored ? await planningDraftWithReadiness(PlanningHandoffSchema.parse(JSON.parse(handoff.handoff_json)), restored) : null };
    }
    const previousDraft = parseDraftRow(current);
    const history = [...(previousDraft?.stageHistory || [])];
    if (previousDraft && stageOrder.indexOf(nextDraft.stage) > stageOrder.indexOf(previousDraft.stage)) {
      history.push({ stage: previousDraft.stage, version: input.expectedVersion + 1,
        savedAt: new Date().toISOString(), summary: stageSummary(previousDraft.stage, nextDraft) });
    }
    const draft = PlanningDraftSchema.parse({
      ...nextDraft,
      stageHistory: history.slice(-30),
      version: input.expectedVersion + 1,
      updatedAt: new Date().toISOString(),
    });
    const commit = await lease.commitPlanningDraftRow({
      turnId: input.turnId,
      inputHash,
      expectedVersion: input.expectedVersion,
      handoffId: nextDraft.handoffId,
      sourceIntentStateVersion: nextDraft.sourceIntentStateVersion,
      draftJson: JSON.stringify(draft),
    });
    const committedDraft = commit.committed ? draft : parseDraftRow(commit.state);
    const projected = committedDraft ? await planningDraftWithReadiness(PlanningHandoffSchema.parse(JSON.parse(handoff.handoff_json)), committedDraft) : null;
    return commit.committed
      ? { committed: true, draft: projected! }
      : { committed: false, draft: projected };
  } finally {
    await lease.release();
  }
}

function validDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function inclusiveDays(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

function minutes(value: string): number {
  const [hours, mins] = value.split(":").map(Number);
  return hours * 60 + mins;
}

function travelerTotal(intent: SingaporeTravelIntent): number {
  return intent.travelers.total ?? (
    (intent.travelers.adults ?? 0) + (intent.travelers.children ?? 0) + (intent.travelers.seniors ?? 0)
  );
}

export function evaluatePlaceDiscoveryReadiness(
  result: SingaporeIntentResult | null,
): { ready: boolean; issues: string[] } {
  if (!result) return { ready: false, issues: ["请先说明出行日期、人数、每日时段和旅行节奏。"] };
  const intent = result.intent;
  const issues: string[] = [];
  if (!validDate(intent.startDate) || !validDate(intent.endDate)) {
    issues.push("请提供准确的开始日期和结束日期（含年份）。");
  } else {
    const days = inclusiveDays(intent.startDate, intent.endDate);
    if (days < 1 || days > 7) issues.push("目前只支持规划 1–7 天（包含开始和结束日期）。");
    else if (intent.durationDays !== days) issues.push("出行天数与开始、结束日期不一致，请先确认日期。");
  }
  const people = travelerTotal(intent);
  if (!Number.isInteger(people) || people < 1 || people > 20) issues.push("请确认同行人数。");
  const latestReturn = intent.latestReturnTime ?? intent.dailyEndTime;
  const preferredReturn = intent.preferredReturnTime ?? latestReturn;
  if (!intent.dailyStartTime || !latestReturn) {
    issues.push("请说明每日出发和最晚返回时间。");
  } else if (minutes(latestReturn) <= minutes(intent.dailyStartTime) ||
             (preferredReturn && (minutes(preferredReturn) <= minutes(intent.dailyStartTime) ||
               minutes(preferredReturn) > minutes(latestReturn)))) {
    issues.push("每日出发、首选返回和最晚返回时间存在冲突，请先确认。");
  }
  if (!intent.pace) issues.push("请选择轻松、平衡或紧凑的旅行节奏。");
  for (const issue of result.issues) {
    if (issue.field?.startsWith("accommodation") || issue.field?.startsWith("budget") ||
        issue.field === "originCity" || issue.code === "ACCOMMODATION_MISSING") continue;
    if (issue.kind === "ambiguity" || issue.kind === "blocking") issues.push(issue.message);
  }
  if (result.pendingCandidates.some((candidate) =>
    !candidate.field.startsWith("accommodation.") &&
    !candidate.field.startsWith("budget") && candidate.field !== "originCity")) {
    issues.push("仍有未确认的旅行条件，请先回答追问。");
  }
  const distinct = [...new Set(issues)];
  return { ready: distinct.length === 0, issues: distinct };
}

export function buildPlanningHandoff(result: SingaporeIntentResult, stateVersion: number, recommendationDeclined = false, slotMeta: Parameters<typeof planningReturnConstraint>[0] = {}): PlanningHandoffV1 {
  const readiness = evaluatePlaceDiscoveryReadiness(result);
  if (!readiness.ready) throw new Error(`Planning handoff is not ready: ${readiness.issues.join("；")}`);
  const intent = result.intent;
  const start = intent.startDate!;
  const end = intent.endDate!;
  const latestReturn = intent.latestReturnTime ?? intent.dailyEndTime!;
  const budgetDetails = intent.budgetDetails;
  const hasBudget = intent.budget !== null || Object.values(budgetDetails).some((value) => value !== null);
  const accommodation = intent.accommodation;
  const openQuestions: PlanningHandoffV1["openQuestions"] = [];
  if (!intent.originCity) openQuestions.push("origin_city");
  if (!accommodation.areaName && !accommodation.hotelName) openQuestions.push("accommodation");
  if (!intent.interests.length && !intent.mustVisit.length) openQuestions.push("interests");
  return PlanningHandoffSchema.parse({
    schemaVersion: 1,
    sourceIntentStateVersion: stateVersion,
    destination: "Singapore",
    dates: { start, end, days: inclusiveDays(start, end) },
    originCity: intent.originCity,
    travelers: { ...intent.travelers, total: travelerTotal(intent) },
    dailyWindow: {
      start: intent.dailyStartTime!,
      preferredReturn: intent.preferredReturnTime ?? latestReturn,
      latestReturn,
      returnConstraint: planningReturnConstraint(slotMeta),
    },
    pace: intent.pace!,
    preferences: {
      interests: intent.interests,
      mustVisit: intent.mustVisit,
      allowAutomaticRecommendations: intent.allowAutomaticRecommendations,
      recommendationDeclined: recommendationDeclined && !intent.allowAutomaticRecommendations,
      avoid: intent.avoid,
      mobilityConstraints: intent.mobilityConstraints,
      dietaryPreferences: intent.dietaryPreferences,
      dietaryScope: intent.dietaryScope,
      preferredTransport: intent.preferredTransport,
    },
    budget: hasBudget ? {
      level: intent.budget,
      amount: budgetDetails.amount,
      currency: budgetDetails.currency,
      scope: budgetDetails.scope,
      excludesFlights: budgetDetails.excludesFlights,
    } : null,
    accommodationPreference: accommodation.areaName || accommodation.hotelName
      ? { areaName: accommodation.areaName, hotelName: accommodation.hotelName }
      : null,
    openQuestions,
    confirmedByUser: true,
  });
}
