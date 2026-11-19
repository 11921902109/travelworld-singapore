import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import { compilePlanningTrip, PlanningScheduleError } from "@/lib/travel/planning-trip";
import { readPlanningDraft, readPlanningHandoff } from "@/lib/travel/planning-state";
import { readTravelVisitToken } from "@/lib/travel/visit-session";
import { planningDraftWithReadiness } from "@/lib/travel/planning-readiness";

export const dynamic = "force-dynamic";

const Request = z.object({ expectedVersion: z.number().int().min(0), turnId: z.string().min(8).max(100) });

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: NextRequest) {
  const blocked = guardSingaporeApi(request, { bucket: "planning-compile", limit: 4, windowMs: 5 * 60_000 });
  if (blocked) return blocked;
  const token = readTravelVisitToken(request);
  if (!token) return json({ error: { code: "VISIT_REQUIRED", message: "请刷新页面后重试。" } }, 400);
  const parsed = Request.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: { code: "INVALID_COMPILE_REQUEST", message: "地图生成请求格式不正确。" } }, 400);
  try {
    const context = await readPlanningHandoff(token);
    const savedDraft = await readPlanningDraft(token);
    if (!context || !savedDraft) return json({ error: { code: "PLANNING_NOT_STARTED", message: "请先完成本次访问的旅行规划。" } }, 409);
    const draft = await planningDraftWithReadiness(context.handoff, savedDraft);
    if (draft.version !== parsed.data.expectedVersion) {
      return json({ error: { code: "PLANNING_VERSION_CONFLICT", message: "规划已更新，请查看最新选择后重试。" }, draft }, 409);
    }
    const pending = draft.pendingReviews || [];
    if (pending.length) {
      return json({ error: { code: "REVIEW_REQUIRED", message: `请先复核：${pending.map((item) => item.message).join("、")}。` }, draft }, 409);
    }
    const { trip, estimates } = await compilePlanningTrip(context.handoff, draft);
    return json({
      trip,
      meta: {
        provider: "google",
        status: "candidate",
        generatedAt: trip.generatedAt,
        attribution: "Google Maps",
        warnings: trip.warnings || [],
        sourceQueries: [],
        assumptions: [
          "地点由用户确认，位置由 Google Places 核实；地面交通按 Google 路线及适用的等候预留核算。",
          "交通、景点停留及航班抵离缓冲为估计，请出发前复核。",
        ],
      },
      estimates,
    });
  } catch (error) {
    if (error instanceof PlanningScheduleError) return json({ error: { code: error.code, message: error.message, day: error.day } }, 422);
    return json({ error: { code: "COMPILE_FAILED", message: "地图暂时无法生成，请稍后重试。" } }, 502);
  }
}
