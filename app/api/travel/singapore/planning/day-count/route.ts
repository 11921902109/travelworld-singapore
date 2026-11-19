import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import { initializeTravelPlanningSession } from "@/lib/travel/bailian";
import { updateIntentSlotMeta, type IntentSlotMeta } from "@/lib/travel/intent-slot-meta";
import { deletePlanningDay } from "@/lib/travel/planning-day-change";
import {
  buildPlanningHandoff, PlanningDraftSchema, PlanningHandoffSchema, PlanningAssignmentSchema, PlanningPlaceTimePreferencesSchema,
} from "@/lib/travel/planning-state";
import { SingaporeIntentResultSchema, type SingaporeIntentResult } from "@/lib/travel/singapore-intent";
import { acquireTravelVisit, readTravelVisitToken, type TravelVisitLease } from "@/lib/travel/visit-session";

export const dynamic = "force-dynamic";

const Input = z.object({
  action: z.enum(["delete", "undo"]),
  day: z.number().int().min(1).max(7).optional(),
  workingAssignments: z.array(PlanningAssignmentSchema).max(7).optional(),
  placeTimePreferences: PlanningPlaceTimePreferencesSchema.optional(),
  expectedIntentStateVersion: z.number().int().positive(),
  expectedDraftVersion: z.number().int().min(0),
  turnId: z.string().regex(/^[A-Za-z0-9_:-]{8,100}$/),
});

function json(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function hash(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function changedResult(current: SingaporeIntentResult, start: string, end: string, days: number, outline: SingaporeIntentResult["outline"], reply: string) {
  return SingaporeIntentResultSchema.parse({
    ...current,
    intent: { ...current.intent, startDate: start, endDate: end, durationDays: days },
    outline,
    acceptedChanges: [
      { field: "startDate", op: "set", evidenceText: "用户在分天板调整旅行日期" },
      { field: "endDate", op: "set", evidenceText: "用户在分天板调整旅行日期" },
      { field: "durationDays", op: "set", evidenceText: "用户在分天板调整旅行天数" },
    ],
    reply,
  });
}

export async function POST(request: NextRequest) {
  const blocked = guardSingaporeApi(request, { bucket: "singapore-planning-day-count", limit: 10, windowMs: 60_000, maxBodyBytes: 96_000 });
  if (blocked) return blocked;
  const token = readTravelVisitToken(request);
  if (!token) return json({ error: { code: "VISIT_REQUIRED", message: "本次访问未初始化，请刷新后重试。" } }, 400);
  const parsed = Input.safeParse(await request.json().catch(() => null));
  if (!parsed.success || parsed.data.action === "delete" && !parsed.data.day) {
    return json({ error: { code: "INVALID_DAY_CHANGE", message: "请指定要删除的旅行日。" } }, 400);
  }
  const body = parsed.data;
  const inputHash = await hash(body);
  let lease: TravelVisitLease | null = null;
  try {
    lease = await acquireTravelVisit(token, request.signal);
    const prior = await lease.findIntentTurn(body.turnId);
    if (prior) {
      if (prior.input_hash !== inputHash) return json({ error: { code: "TURN_REUSED", message: "请求标识已用于另一项操作。" } }, 409);
      const state = await lease.readIntentState();
      const handoffRow = await lease.readPlanningHandoff();
      const draftRow = await lease.readPlanningDraftRow();
      if (prior.state_version !== state.stateVersion || !handoffRow || !draftRow ||
          handoffRow.source_intent_state_version !== state.stateVersion || draftRow.source_intent_state_version !== state.stateVersion) {
        return json({ error: { code: "DAY_CHANGE_STALE", message: "旅行条件已有后续修改，请重新读取。" } }, 409);
      }
      await lease.release(); lease = null;
      const ready = await initializeTravelPlanningSession(token, state.stateVersion);
      return json({
        handoff: PlanningHandoffSchema.parse(JSON.parse(handoffRow.handoff_json)), handoffId: handoffRow.handoff_id,
        draft: PlanningDraftSchema.parse(JSON.parse(draftRow.draft_json)),
        intentResult: SingaporeIntentResultSchema.parse(JSON.parse(state.resultJson || "null")),
        sourceIntentStateVersion: state.stateVersion, planningSessionReady: ready, replayed: true,
      });
    }

    const [state, handoffRow, draftRow] = await Promise.all([
      lease.readIntentState(), lease.readPlanningHandoff(), lease.readPlanningDraftRow(),
    ]);
    if (!handoffRow || !draftRow || !state.resultJson ||
        state.stateVersion !== body.expectedIntentStateVersion || draftRow.version !== body.expectedDraftVersion ||
        handoffRow.source_intent_state_version !== state.stateVersion || draftRow.source_intent_state_version !== state.stateVersion ||
        draftRow.handoff_id !== handoffRow.handoff_id) {
      return json({ error: { code: "DAY_CHANGE_STALE", message: "旅行条件或分天板已有更新，请重新读取后重试。" } }, 409);
    }
    const current = SingaporeIntentResultSchema.parse(JSON.parse(state.resultJson));
    const handoff = PlanningHandoffSchema.parse(JSON.parse(handoffRow.handoff_json));
    const draft = PlanningDraftSchema.parse(JSON.parse(draftRow.draft_json));
    if (!(["places", "day_allocation"] as string[]).includes(draft.stage) || draft.boardConfirmed ||
        draft.flightSelection || draft.flightQuotes || draft.staySegments?.length || draft.dayEstimates?.length) {
      return json({ error: { code: "DAY_CHANGE_AFTER_CONFIRMATION", message: "已进入后续规划阶段，请先回到分天编辑并复核航班、住宿与路线。" } }, 422);
    }
    if (body.action === "undo" && !draft.dayDeletionUndo) {
      return json({ error: { code: "DAY_UNDO_UNAVAILABLE", message: "目前没有可撤回的删日操作。" } }, 422);
    }

    let nextResult: SingaporeIntentResult;
    let nextAssignments: typeof draft.assignments;
    let undoSnapshot: typeof draft.dayDeletionUndo;
    if (body.action === "delete") {
      const removedDay = body.day!;
      if (handoff.dates.days <= 1) return json({ error: { code: "LAST_DAY_REQUIRED", message: "旅行至少保留一天。" } }, 422);
      const working = body.workingAssignments || draft.assignments;
      const selected = new Set(draft.selectedPlaceIds ?? draft.assignments.flatMap((item) => item.orderedCandidateIds));
      if (Object.keys(body.placeTimePreferences || {}).some((id) => !selected.has(id))) return json({ error: { code: "INVALID_PLACE_TIME_PREFERENCE", message: "时段要求包含未选择的地点，请重新核对。" } }, 422);
      const days = new Set<number>(); const ids = new Set<string>();
      for (const assignment of working) {
        if (assignment.day > handoff.dates.days || days.has(assignment.day) || assignment.orderedCandidateIds.some((id) => !selected.has(id) || ids.has(id)) ||
          [...Object.keys(assignment.periodByCandidateId || {}), ...Object.keys(assignment.periodConstraintByCandidateId || {})].some((id) => !assignment.orderedCandidateIds.includes(id))) {
          return json({ error: { code: "INVALID_WORKING_BOARD", message: "本地分天安排包含重复、失效地点或超出范围的日期，请核对后重试。" } }, 422);
        }
        days.add(assignment.day);
        for (const id of assignment.orderedCandidateIds) { if (ids.has(id)) return json({ error: { code: "DUPLICATE_SCENE", message: "同一地点不能重复分天。" } }, 422); ids.add(id); }
      }
      const changed = deletePlanningDay(handoff.dates, working, removedDay);
      const outline = current.outline.filter((item) => item.day !== removedDay)
        .map((item) => ({ ...item, day: item.day > removedDay ? item.day - 1 : item.day }));
      nextResult = changedResult(current, changed.dates.start, changed.dates.end, changed.dates.days, outline,
        `已删除 Day ${removedDay}。旅行日期调整为 ${changed.dates.start} 至 ${changed.dates.end}，共 ${changed.dates.days} 天；其余旅行偏好保持不变。`);
      nextAssignments = changed.assignments;
      undoSnapshot = { deletedDay: removedDay, previousIntentJson: state.resultJson, previousAssignments: working };
    } else {
      const snapshot = draft.dayDeletionUndo!;
      const previous = SingaporeIntentResultSchema.parse(JSON.parse(snapshot.previousIntentJson));
      nextResult = changedResult(current, previous.intent.startDate!, previous.intent.endDate!, previous.intent.durationDays!, previous.outline,
        `已撤回删除 Day ${snapshot.deletedDay}。旅行日期恢复为 ${previous.intent.startDate} 至 ${previous.intent.endDate}。`);
      nextAssignments = snapshot.previousAssignments;
      undoSnapshot = undefined;
    }

    const nextIntentVersion = state.stateVersion + 1;
    const nextHandoffId = crypto.randomUUID();
    const previousMeta = JSON.parse(state.slotMetaJson) as IntentSlotMeta;
    const nextMeta = updateIntentSlotMeta({
      previous: previousMeta, before: current.intent, result: nextResult, turnId: body.turnId,
      source: "code", message: nextResult.reply,
    });
    const recommendationDeclined = nextMeta.allowAutomaticRecommendations?.status === "confirmed" &&
      nextResult.intent.allowAutomaticRecommendations === false;
    const nextHandoff = buildPlanningHandoff(nextResult, nextIntentVersion, recommendationDeclined, nextMeta);
    const nextDraft = PlanningDraftSchema.parse({
      version: 0, handoffId: nextHandoffId, sourceIntentStateVersion: nextIntentVersion,
      stage: "day_allocation", candidates: draft.candidates, assignments: nextAssignments,
      placeTimePreferences: body.placeTimePreferences ?? draft.placeTimePreferences,
      selectedPlaceIds: draft.selectedPlaceIds ?? [...new Set(draft.assignments.flatMap((item) => item.orderedCandidateIds))],
      placesConfirmed: true, selectionReason: draft.selectionReason,
      boardConfirmed: false, ...(undoSnapshot ? { dayDeletionUndo: undoSnapshot } : {}),
      updatedAt: new Date().toISOString(),
    });
    await lease.commitPlanningDayChange({
      turnId: body.turnId, inputHash, expectedIntentStateVersion: state.stateVersion,
      expectedDraftVersion: draft.version, expectedHandoffId: handoffRow.handoff_id,
      resultJson: JSON.stringify(nextResult), slotMetaJson: JSON.stringify(nextMeta),
      handoffId: nextHandoffId, handoffJson: JSON.stringify(nextHandoff), draftJson: JSON.stringify(nextDraft),
    });
    await lease.release(); lease = null;
    const ready = await initializeTravelPlanningSession(token, nextIntentVersion);
    return json({
      handoff: nextHandoff, handoffId: nextHandoffId, draft: nextDraft,
      intentResult: nextResult, sourceIntentStateVersion: nextIntentVersion, planningSessionReady: ready,
    });
  } catch (cause) {
    console.warn("Planning day change failed", { reason: cause instanceof Error ? cause.name : "unknown" });
    return json({ error: { code: "DAY_CHANGE_UNAVAILABLE", message: "暂时无法调整旅行日期，本轮未保存；请稍后重试。" } }, 503);
  } finally {
    try { await lease?.release(); } catch { console.warn("Planning day change lease release failed"); }
  }
}
