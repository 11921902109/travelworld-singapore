import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import { initializeTravelPlanningSession } from "@/lib/travel/bailian";
import {
  buildPlanningHandoff,
  createInitialPlanningDraft,
  evaluatePlaceDiscoveryReadiness,
  PlanningDraftSchema,
  PlanningHandoffSchema,
} from "@/lib/travel/planning-state";
import { SingaporeIntentResultSchema } from "@/lib/travel/singapore-intent";
import { acquireTravelVisit, readTravelVisitToken, type TravelVisitLease } from "@/lib/travel/visit-session";
import { reconcileBoardReviews } from "@/lib/travel/planning-review";

export const dynamic = "force-dynamic";

const HandoffRequestSchema = z.object({
  expectedIntentStateVersion: z.number().int().positive(),
  turnId: z.string().trim().regex(/^[A-Za-z0-9_:-]{8,100}$/),
});

function noStore(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
}

function error(message: string, status: number, code: string, extra: Record<string, unknown> = {}) {
  return noStore({ code, error: message, ...extra }, status);
}

async function releaseQuietly(lease: TravelVisitLease | null) {
  try { await lease?.release(); } catch { console.warn("Planning handoff visit lease release unavailable"); }
}

export async function GET(request: NextRequest) {
  const blocked = guardSingaporeApi(request, { bucket: "singapore-planning-handoff-read", limit: 30, windowMs: 60_000 });
  if (blocked) return blocked;
  const visitToken = readTravelVisitToken(request);
  if (!visitToken) return error("本次访问未初始化，请刷新页面后重试。", 400, "VISIT_REQUIRED");
  let lease: TravelVisitLease | null = null;
  try {
    lease = await acquireTravelVisit(visitToken, request.signal);
    const intentState = await lease.readIntentState();
    const row = await lease.readPlanningHandoff();
    if (!row || row.source_intent_state_version !== intentState.stateVersion) {
      return noStore({
        handoff: null, handoffId: null, sourceIntentStateVersion: null,
        planningSessionReady: false,
        ...(row ? { requiresReconfirmation: true } : {}),
      });
    }
    return noStore({
      handoff: PlanningHandoffSchema.parse(JSON.parse(row.handoff_json)),
      handoffId: row.handoff_id,
      sourceIntentStateVersion: row.source_intent_state_version,
      planningSessionReady: Boolean(lease.planningSessionId &&
        lease.planningIntentVersion === row.source_intent_state_version),
    });
  } catch {
    return error("暂时无法读取已确认的旅行条件，请稍后重试。", 503, "PLANNING_HANDOFF_UNAVAILABLE");
  } finally {
    await releaseQuietly(lease);
  }
}

export async function POST(request: NextRequest) {
  const blocked = guardSingaporeApi(request, {
    bucket: "singapore-planning-handoff", limit: 12, windowMs: 60_000, maxBodyBytes: 4_000,
  });
  if (blocked) return blocked;
  const visitToken = readTravelVisitToken(request);
  if (!visitToken) return error("本次访问未初始化，请刷新页面后重试。", 400, "VISIT_REQUIRED");
  let body: unknown;
  try { body = await request.json(); } catch { return error("请求必须是有效的 JSON。", 400, "INVALID_JSON"); }
  const parsed = HandoffRequestSchema.safeParse(body);
  if (!parsed.success) return error("请提供当前条件版本和本次确认标识。", 400, "INVALID_INPUT");
  let lease: TravelVisitLease | null = null;
  try {
    lease = await acquireTravelVisit(visitToken, request.signal);
    const state = await lease.readIntentState();
    if (state.stateVersion !== parsed.data.expectedIntentStateVersion) {
      return error("旅行条件已更新，请确认最新内容后继续。", 409, "STATE_VERSION_CONFLICT", {
        currentIntentStateVersion: state.stateVersion,
        state: state.resultJson ? SingaporeIntentResultSchema.parse(JSON.parse(state.resultJson)) : null,
      });
    }
    const result = state.resultJson
      ? SingaporeIntentResultSchema.parse(JSON.parse(state.resultJson)) : null;
    const readiness = evaluatePlaceDiscoveryReadiness(result);
    if (!readiness.ready || !result) {
      return error("旅行条件尚未达到地点探索阶段，请先回答下列问题。", 422, "PLANNING_NOT_READY", {
        issues: readiness.issues,
      });
    }
    let row = await lease.readPlanningHandoff();
    if (!row || row.source_intent_state_version !== state.stateVersion) {
      const handoffId = crypto.randomUUID();
      const slotMeta = JSON.parse(state.slotMetaJson) as Record<string, { status?: string; source?: string; evidence?: string }>;
      const recommendationDeclined = slotMeta.allowAutomaticRecommendations?.status === "confirmed" &&
        result.intent.allowAutomaticRecommendations === false;
      const handoff = buildPlanningHandoff(result, state.stateVersion, recommendationDeclined, slotMeta);
      const previousDraftRow = await lease.readPlanningDraftRow();
      const previousDraft = previousDraftRow
        ? PlanningDraftSchema.parse(JSON.parse(previousDraftRow.draft_json)) : null;
      const initialDraft = createInitialPlanningDraft(handoffId, state.stateVersion, previousDraft);
      Object.assign(initialDraft, await reconcileBoardReviews(handoff, initialDraft));
      await lease.commitPlanningHandoff({
        handoffId,
        sourceIntentStateVersion: state.stateVersion,
        handoffJson: JSON.stringify(handoff),
        initialDraftJson: JSON.stringify(initialDraft),
      });
      row = await lease.readPlanningHandoff();
      if (!row) throw new Error("Planning handoff was not saved.");
    }
    await releaseQuietly(lease); lease = null;
    const ready = await initializeTravelPlanningSession(visitToken, state.stateVersion);
    if (!ready) {
      return error("规划服务暂时无法启动，已确认的条件已保存，请稍后重试。", 503,
        "PLANNING_SESSION_UNAVAILABLE", { planningSessionReady: false });
    }
    return noStore({
      handoff: PlanningHandoffSchema.parse(JSON.parse(row.handoff_json)),
      handoffId: row.handoff_id,
      sourceIntentStateVersion: row.source_intent_state_version,
      planningSessionReady: true,
    });
  } catch (cause) {
    console.warn("Planning handoff unavailable", { reason: cause instanceof Error ? cause.name : "unknown" });
    return error("暂时无法确认旅行条件，请稍后重试。", 503, "PLANNING_HANDOFF_UNAVAILABLE");
  } finally {
    await releaseQuietly(lease);
  }
}
