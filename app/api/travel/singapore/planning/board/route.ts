import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import {
  PlanningSceneCandidateSchema,
  readCommittedPlanningSceneTurn,
  readPlanningSceneContext,
} from "@/lib/travel/planning-scenes";
import { commitPlanningDraft, PlanningAssignmentSchema, PlanningPlaceTimePreferencesSchema, type PlanningDraftInput } from "@/lib/travel/planning-state";
import { planningBoardConfirmationIssues, selectedPlanningPlaceIds } from "@/lib/travel/planning-place-selection";
import { readTravelVisitToken } from "@/lib/travel/visit-session";
import { withPlanningTiming, type PlanningTiming } from "@/lib/travel/planning-timing";
import { planningBoardSourceFingerprint, reconcileBoardReviews } from "@/lib/travel/planning-review";
import { planningDraftWithReadiness } from "@/lib/travel/planning-readiness";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  expectedVersion: z.number().int().min(0),
  turnId: z.string().regex(/^[A-Za-z0-9_:-]{8,70}$/),
  assignments: z.array(PlanningAssignmentSchema.extend({ orderedCandidateIds: z.array(z.string().trim().min(8).max(255)).max(40) })).max(7),
  confirmed: z.boolean(),
  placeTimePreferences: PlanningPlaceTimePreferencesSchema.optional(),
});

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function readBoard(request: NextRequest, timing: PlanningTiming) {
  const blocked = guardSingaporeApi(request, { bucket: "singapore-planning-board-read", limit: 30, windowMs: 60_000 });
  if (blocked) return blocked;
  const token = readTravelVisitToken(request);
  if (!token) return json({ error: { code: "VISIT_REQUIRED", message: "本次访问未初始化，请刷新页面后重试。" } }, 400);
  try {
    const { handoff, draft } = await timing.measureAsync("context_read", () => readPlanningSceneContext(token, request.signal, timing));
    timing.annotate({ version: draft.version });
    return json({
      draft: await planningDraftWithReadiness(handoff, draft),
      days: handoff.dates.days,
      assignments: draft.assignments,
      boardConfirmed: draft.boardConfirmed,
    });
  } catch {
    return json({ error: { code: "PLANNING_HANDOFF_STALE", message: "旅行条件尚未确认或已更新，请重新进入地点规划。" } }, 409);
  }
}

async function writeBoard(request: NextRequest, timing: PlanningTiming) {
  const blocked = guardSingaporeApi(request, {
    bucket: "singapore-planning-board-write", limit: 20, windowMs: 60_000, maxBodyBytes: 96_000,
  });
  if (blocked) return blocked;
  const token = readTravelVisitToken(request);
  if (!token) return json({ error: { code: "VISIT_REQUIRED", message: "本次访问未初始化，请刷新页面后重试。" } }, 400);
  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await request.json());
    timing.setAction(body.confirmed ? "confirm" : "save");
  } catch {
    return json({ error: { code: "INVALID_BOARD_REQUEST", message: "分天安排格式不正确。" } }, 400);
  }
  try {
    const { handoff, handoffId, draft } = await timing.measureAsync("context_read", () => readPlanningSceneContext(token, request.signal, timing));
    timing.annotate({ version: draft.version });
    if (draft.version !== body.expectedVersion) {
      if (draft.version === body.expectedVersion + 1) {
        const replay = await readCommittedPlanningSceneTurn(token, body.turnId, request.signal);
        const sameAssignments = replay && Array.from({ length: handoff.dates.days }, (_, index) => index + 1).every((day) => {
          const saved = replay.assignments.find((item) => item.day === day);
          const requested = body.assignments.find((item) => item.day === day);
          return JSON.stringify(saved?.orderedCandidateIds ?? []) === JSON.stringify(requested?.orderedCandidateIds ?? []) &&
            JSON.stringify(saved?.periodByCandidateId ?? {}) === JSON.stringify(requested?.periodByCandidateId ?? {}) &&
            JSON.stringify(saved?.periodConstraintByCandidateId ?? {}) === JSON.stringify(requested?.periodConstraintByCandidateId ?? {}) &&
            (saved?.dayPurpose || "activities") === (requested?.dayPurpose || "activities");
        });
        if (replay?.version === draft.version && replay.handoffId === handoffId &&
            new Set(body.assignments.map((item) => item.day)).size === body.assignments.length &&
            replay.boardConfirmed === body.confirmed && sameAssignments &&
            (!body.placeTimePreferences || JSON.stringify(replay.placeTimePreferences || {}) === JSON.stringify(body.placeTimePreferences))) {
          return json({ draft: await planningDraftWithReadiness(handoff, replay), assignments: replay.assignments, boardConfirmed: replay.boardConfirmed, replayed: true });
        }
      }
      return json({ error: { code: "PLANNING_VERSION_CONFLICT", message: "规划已更新，请使用最新内容重试。" }, draft: await planningDraftWithReadiness(handoff, draft) }, 409);
    }
    if (handoff.dates.days < 1 || handoff.dates.days > 7) {
      return json({ error: { code: "INVALID_TRIP_DAYS", message: "目前只支持规划 1–7 天。" } }, 422);
    }
    if (draft.stage === "places" || draft.selectedPlaceIds !== undefined && !draft.placesConfirmed) {
      return json({ error: { code: "PLACE_SELECTION_REQUIRED", message: "请先确认想去的地点，再进入分天安排。" }, draft }, 409);
    }
    const selected = selectedPlanningPlaceIds(draft);
    const selectedSet = new Set(selected);
    if (Object.keys(body.placeTimePreferences || {}).some((id) => !selectedSet.has(id))) return json({ error: { code: "INVALID_PLACE_TIME_PREFERENCE", message: "时段要求包含未选择的地点，请重新核对。" } }, 422);
    const allowed = new Set(draft.candidates.flatMap((item) => {
      const parsed = PlanningSceneCandidateSchema.safeParse(item);
      return parsed.success && selectedSet.has(parsed.data.placeId) ? [parsed.data.placeId] : [];
    }));
    const submittedDays = new Set<number>();
    const submittedPlaces = new Set<string>();
    for (const assignment of body.assignments) {
      if (assignment.day > handoff.dates.days || submittedDays.has(assignment.day)) {
        return json({ error: { code: "INVALID_DAY_ASSIGNMENT", message: "分天安排中存在超出日期或重复的旅行日。" } }, 422);
      }
      submittedDays.add(assignment.day);
      if ([...Object.keys(assignment.periodByCandidateId || {}), ...Object.keys(assignment.periodConstraintByCandidateId || {})].some((id) => !assignment.orderedCandidateIds.includes(id))) {
        return json({ error: { code: "INVALID_DAY_PERIOD", message: "上午／下午偏好包含不在本日的地点。" } }, 422);
      }
      for (const placeId of assignment.orderedCandidateIds) {
        if (!allowed.has(placeId)) {
          return json({ error: { code: "UNVERIFIED_SCENE", message: "分天安排包含尚未加入并经 Google 验证的地点。" } }, 422);
        }
        if (submittedPlaces.has(placeId)) {
          return json({ error: { code: "DUPLICATE_SCENE", message: "同一地点不能重复分配到多天；如需再次到访，请单独添加。" } }, 422);
        }
        submittedPlaces.add(placeId);
      }
    }
    if (body.confirmed && submittedPlaces.size === 0) {
      return json({ error: { code: "EMPTY_SCENE_BOARD", message: "请至少选择一个真实地点后再确认。" } }, 422);
    }
    const assignments = Array.from({ length: handoff.dates.days }, (_, index) => ({
      day: index + 1,
      orderedCandidateIds: body.assignments.find((item) => item.day === index + 1)?.orderedCandidateIds ?? [],
      periodByCandidateId: body.assignments.find((item) => item.day === index + 1)?.periodByCandidateId ?? {},
      periodConstraintByCandidateId: body.assignments.find((item) => item.day === index + 1)?.periodConstraintByCandidateId,
      dayPurpose: body.assignments.find((item) => item.day === index + 1)?.orderedCandidateIds.length
        ? "activities" as const : body.assignments.find((item) => item.day === index + 1)?.dayPurpose || "activities" as const,
      status: body.confirmed ? "confirmed" as const : "provisional" as const,
    }));
    const emptyDays = assignments.filter((item) => item.orderedCandidateIds.length === 0).map((item) => item.day);
    if (body.confirmed) {
      const issues = planningBoardConfirmationIssues(selected, assignments, handoff.dates.days);
      if (issues.unassignedPlaceIds.length) return json({ error: { code: "UNASSIGNED_SELECTED_PLACES", message: "还有已选地点没有分配到旅行日，请安排后继续，或返回挑地点取消选择。" }, unassignedPlaceIds: issues.unassignedPlaceIds }, 422);
      if (issues.unresolvedPeriodPlaceIds.length) {
        const names = issues.unresolvedPeriodPlaceIds.map((id) => String(draft.candidates.find((item) => item.placeId === id)?.name || id));
        return json({ error: { code: "DAY_PERIOD_REQUIRED", message: `请为${names.join("、")}选择上午或下午，再确认分天。` }, days: issues.unresolvedPeriodDays, placeIds: issues.unresolvedPeriodPlaceIds }, 422);
      }
      if (issues.unconfirmedEmptyDays.length) return json({ error: { code: "EMPTY_DAYS_UNCONFIRMED", message: `请确认 Day ${issues.unconfirmedEmptyDays.join("、Day ")} 是否为休息／自由日。` }, days: issues.unconfirmedEmptyDays,
        emptyDays: issues.unconfirmedEmptyDays.map((day) => { const date = new Date(`${handoff.dates.start}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + day - 1); return { day, date: date.toISOString().slice(0, 10) }; }) }, 422);
    }
    const candidateBoard = { ...draft, assignments, placeTimePreferences: body.placeTimePreferences ?? draft.placeTimePreferences,
      selectedPlaceIds: selected, placesConfirmed: true, boardConfirmed: body.confirmed };
    const fingerprint = await planningBoardSourceFingerprint(handoff, candidateBoard);
    const previousReview = draft.reviewItems?.find((item) => item.kind === "board");
    const confirmedFingerprint = previousReview?.lastConfirmedFingerprint || previousReview?.resolvedInputFingerprint;
    const boardChanged = fingerprint !== (confirmedFingerprint || await planningBoardSourceFingerprint(handoff, draft));
    const affectedReview = [
      draft.flightSelection || draft.flightQuotes ? "航班" : null,
      draft.staySegments?.length || draft.stayAdvice ? "住宿" : null,
      draft.dayEstimates?.length || draft.freeTimeDecisions?.length ? "路线" : null,
    ].filter((item): item is string => Boolean(item));
    const reviewRequired = boardChanged
      ? [...new Set([...(draft.reviewRequired ?? []), ...affectedReview])]
      : draft.reviewRequired;
    // Re-entering and confirming an unchanged board repairs old notices without
    // invalidating already valid flight, hotel or time results.
    const resumedStage = (reviewRequired || []).includes("航班") ? "flights" : draft.flightSelection
      ? draft.stayConfirmed && !(reviewRequired || []).some((item) => ["航班", "住宿", "住宿预算"].includes(item)) ? "route" : "stays"
      : "flights";
    const nextDraft: PlanningDraftInput = {
      ...draft,
      handoffId,
      sourceIntentStateVersion: handoff.sourceIntentStateVersion,
      stage: body.confirmed ? (boardChanged ? "flights" : ["places", "day_allocation"].includes(draft.stage) ? resumedStage : draft.stage) : "day_allocation",
      candidates: draft.candidates,
      selectedPlaceIds: selected,
      placesConfirmed: true,
      placeRemovalUndo: undefined,
      assignments,
      placeTimePreferences: body.placeTimePreferences ?? draft.placeTimePreferences,
      boardConfirmed: body.confirmed,
      flightSearchJob: boardChanged ? undefined : draft.flightSearchJob,
      // Undo restores the pre-deletion board. Retire it after a subsequent
      // board edit so the user cannot accidentally lose newer assignments.
      dayDeletionUndo: draft.dayDeletionUndo && !boardChanged && !body.confirmed ? draft.dayDeletionUndo : undefined,
      flightQuotes: draft.flightQuotes,
      flightSelection: draft.flightSelection,
      stayAdvice: draft.stayAdvice,
      staySegments: draft.staySegments,
      dayEstimates: draft.dayEstimates,
      scheduleConflicts: boardChanged ? [] : draft.scheduleConflicts,
      lastScheduleOperation: boardChanged ? undefined : draft.lastScheduleOperation,
      freeTimeDecisions: draft.freeTimeDecisions,
      reviewRequired,
    };
    Object.assign(nextDraft, await reconcileBoardReviews(handoff, { ...nextDraft, version: draft.version, updatedAt: draft.updatedAt }, body.confirmed));
    const commit = await timing.measureAsync("state_commit", () => commitPlanningDraft(token, {
      expectedVersion: body.expectedVersion,
      turnId: body.turnId,
      nextDraft,
    }, timing));
    if (!commit.committed) {
      return json({ error: { code: "PLANNING_VERSION_CONFLICT", message: "规划已更新，请使用最新内容重试。" }, draft: commit.draft }, 409);
    }
    return json({
      draft: await planningDraftWithReadiness(handoff, commit.draft),
      assignments: commit.draft.assignments,
      boardConfirmed: commit.draft.boardConfirmed,
      restDays: emptyDays.filter((day) => commit.draft.assignments.find((item) => item.day === day)?.dayPurpose === "rest"),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/outdated|handoff|旅行条件|规划阶段|已有更新/i.test(message)) {
      return json({ error: { code: "PLANNING_HANDOFF_STALE", message: "旅行条件已有更新，请重新确认后安排景点。" } }, 409);
    }
    return json({ error: { code: "BOARD_SAVE_FAILED", message: "暂时无法保存分天安排，请重试。" } }, 503);
  }
}

export async function GET(request: NextRequest) { return withPlanningTiming("board", "read", (timing) => readBoard(request, timing)); }
export async function POST(request: NextRequest) { return withPlanningTiming("board", "request", (timing) => writeBoard(request, timing)); }
