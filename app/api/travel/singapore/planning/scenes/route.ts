import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import { googleMapsErrorResponse, GoogleMapsServiceError } from "@/lib/travel/google-maps";
import {
  addPlanningScene,
  readCommittedPlanningSceneTurn,
  readPlanningSceneContext,
  searchPlanningScenes,
  PlanningSceneCandidateSchema,
} from "@/lib/travel/planning-scenes";
import { commitPlanningDraft, type PlanningDraftInput, type PlanningDraftV1 } from "@/lib/travel/planning-state";
import { retainSelectedAssignments, samePlanningPlaceSelection, selectedPlanningPlaceIds } from "@/lib/travel/planning-place-selection";
import { readTravelVisitToken } from "@/lib/travel/visit-session";

import { withPlanningTiming, type PlanningTiming } from "@/lib/travel/planning-timing";
import { planningDraftWithReadiness } from "@/lib/travel/planning-readiness";

export const dynamic = "force-dynamic";

const mutationFields = {
  expectedVersion: z.number().int().min(0),
  turnId: z.string().regex(/^[A-Za-z0-9_:-]{8,70}$/),
};
const poolFields = { replaceUnselected: z.boolean().optional(), preservePlaceIds: z.array(z.string().trim().min(8).max(255)).max(40).optional() };
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("generate"), restart: z.boolean().optional(), ...mutationFields, ...poolFields }),
  z.object({ action: z.literal("search"), query: z.string().trim().min(2).max(120) }),
  z.object({ action: z.literal("add"), placeId: z.string().trim().min(8).max(255), ...mutationFields, ...poolFields }),
  z.object({ action: z.literal("duration"), candidateId: z.string().trim().min(8).max(255), minutes: z.number().int().min(30).max(480), ...mutationFields }),
  z.object({ action: z.literal("select"), selectedPlaceIds: z.array(z.string().trim().min(8).max(255)).max(40), ...mutationFields }),
  z.object({ action: z.literal("remove"), placeId: z.string().trim().min(8).max(255), ...mutationFields }),
  z.object({ action: z.literal("undo_remove"), ...mutationFields }),
  z.object({ action: z.literal("confirm"), selectedPlaceIds: z.array(z.string().trim().min(8).max(255)).max(40).optional(), ...mutationFields }),
  z.object({ action: z.literal("reopen"), ...mutationFields }),
]);

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function reviewAfterSceneChange(draft: PlanningDraftV1): string[] {
  return [...new Set([
    ...(draft.reviewRequired ?? []),
    ...(draft.boardConfirmed ? ["地点与分天"] : []),
    ...(draft.flightSelection || draft.flightQuotes ? ["航班"] : []),
    ...(draft.staySegments?.length || draft.stayAdvice ? ["住宿"] : []),
    ...(draft.dayEstimates?.length || draft.freeTimeDecisions?.length ? ["路线"] : []),
  ])];
}

function errorResponse(error: unknown) {
  if (error instanceof GoogleMapsServiceError) {
    const response = googleMapsErrorResponse(error);
    return json(response.body, response.status);
  }
  if (error instanceof z.ZodError) {
    return json({ error: { code: "SCENE_SUGGESTION_INVALID", message: "地点建议的格式暂时不完整，请重试。" } }, 502);
  }
  const message = error instanceof Error ? error.message : "";
  if (message === "SCENE_JOB_VERSION_CONFLICT") return json({ error: { code: "PLANNING_VERSION_CONFLICT", message: "规划已更新，请使用最新内容重试。" } }, 409);
  if (/旅行条件|确认旅行|地点规划阶段|已有更新|outdated|handoff/i.test(message)) {
    return json({ error: { code: "PLANNING_HANDOFF_STALE", message: "旅行条件已有更新，请重新确认后进入地点规划。" } }, 409);
  }
  if (/没有找到|排除条件|不符合当前|不是可安排|关闭自动推荐|必去地点尚未/.test(message)) {
    return json({ error: { code: "SCENE_NOT_ELIGIBLE", message } }, 422);
  }
  return json({ error: { code: "SCENE_SERVICE_UNAVAILABLE", message: "地点建议暂时不可用，请稍后重试；已确认的旅行条件不会丢失。" } }, 503);
}

async function readScenes(request: NextRequest, timing: PlanningTiming) {
  const blocked = guardSingaporeApi(request, { bucket: "singapore-planning-scenes-read", limit: 30, windowMs: 60_000 });
  if (blocked) return blocked;
  const token = readTravelVisitToken(request);
  if (!token) return json({ error: { code: "VISIT_REQUIRED", message: "本次访问未初始化，请刷新页面后重试。" } }, 400);
  try {
    const { handoff, handoffId, draft: storedDraft } = await timing.measureAsync("context_read", () => readPlanningSceneContext(token, request.signal, timing));
    const { readPlanningSceneJob, pollPlanningSceneJob } = await import("@/lib/travel/planning-scene-jobs");
    const url = new URL(request.url);
    const result = url.searchParams.get("poll") === "1"
      ? await pollPlanningSceneJob(token, url.searchParams.get("resume") === "1", timing, { handoff, draft: storedDraft })
      : storedDraft.sceneDiscoveryJob ? await readPlanningSceneJob(token, { handoff, draft: storedDraft }) : { draft: storedDraft, job: null };
    const draft = result.draft;
    const candidates = draft.candidates.flatMap((item) => {
      const parsed = PlanningSceneCandidateSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
    return json({ handoff, handoffId, draft: await planningDraftWithReadiness(handoff, draft), candidates, job: result.job });
  } catch (error) {
    return errorResponse(error);
  }
}

async function writeScenes(request: NextRequest, timing: PlanningTiming) {
  const blocked = guardSingaporeApi(request, {
    bucket: "singapore-planning-scenes-write", limit: 20, windowMs: 60_000, maxBodyBytes: 8_000,
  });
  if (blocked) return blocked;
  const token = readTravelVisitToken(request);
  if (!token) return json({ error: { code: "VISIT_REQUIRED", message: "本次访问未初始化，请刷新页面后重试。" } }, 400);
  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await request.json());
    timing.setAction(body.action);
  } catch {
    return json({ error: { code: "INVALID_SCENE_REQUEST", message: "地点请求格式不正确。" } }, 400);
  }
  try {
    const { handoff, handoffId, draft } = await timing.measureAsync("context_read", () => readPlanningSceneContext(token, request.signal, timing));
    if (body.action === "search") {
      const matches = await searchPlanningScenes(handoff, body.query, timing);
      return json({ matches, attribution: "Google Places", excludesApplied: true });
    }
    if (body.action === "generate") {
      if (draft.stage !== "places") return json({ error: { code: "PLACE_SELECTION_REQUIRED", message: "请先回到挑地点，再调整所选清单。" }, draft }, 409);
      const available = new Set(draft.candidates.map((item) => String(item.placeId)));
      if (body.preservePlaceIds?.some((id) => !available.has(id))) return json({ error: { code: "SCENE_NOT_FOUND", message: "部分候选已有变化，请核对当前选择后重试。" }, draft }, 422);
      const { createPlanningSceneJob } = await import("@/lib/travel/planning-scene-jobs");
      const result = await createPlanningSceneJob(token, draft, handoff, body, timing);
      return json({ ...result, candidates: result.draft.candidates });
    }
    if (draft.version !== body.expectedVersion) {
      if (draft.version === body.expectedVersion + 1) {
        const replay = await readCommittedPlanningSceneTurn(token, body.turnId, request.signal);
        if (replay?.version === draft.version && replay.handoffId === handoffId) {
          const matches = body.action === "reopen" && replay.stage === "places" ||
            body.action === "confirm" && replay.stage === "day_allocation" && replay.placesConfirmed === true && (!body.selectedPlaceIds || samePlanningPlaceSelection(replay.selectedPlaceIds || [], body.selectedPlaceIds)) ||
            body.action === "select" && JSON.stringify(replay.selectedPlaceIds) === JSON.stringify([...new Set(body.selectedPlaceIds)]) ||
            body.action === "remove" && !replay.candidates.some((item) => item.placeId === body.placeId) ||
            body.action === "undo_remove" && replay.stage === "places" && !replay.placeRemovalUndo ||
            body.action === "add" && replay.candidates.some((item) => item.placeId === body.placeId) && replay.selectedPlaceIds?.includes(body.placeId) ||
            body.action === "duration" && replay.candidates.some((item) => (item.id === body.candidateId || item.placeId === body.candidateId) && item.estimatedMinutes === body.minutes && item.estimateSource === "user");
          if (matches) return json({ draft: replay, candidates: replay.candidates, replayed: true });
        }
      }
      return json({ error: { code: "PLANNING_VERSION_CONFLICT", message: "规划已更新，请使用最新内容重试。" }, draft }, 409);
    }
    if (body.action !== "reopen" && body.action !== "duration" && draft.stage !== "places") {
      return json({ error: { code: "PLACE_SELECTION_REQUIRED", message: "请先回到挑地点，再调整所选清单。" }, draft }, 409);
    }
    const selected = selectedPlanningPlaceIds(draft);
    const available = new Set(draft.candidates.map((item) => String(item.placeId)));
    if ("preservePlaceIds" in body && body.preservePlaceIds?.some((id) => !available.has(id))) {
      return json({ error: { code: "SCENE_NOT_FOUND", message: "部分候选已有变化，请核对当前选择后重试。" }, draft }, 422);
    }
    const protectedIds = [...new Set([...( "preservePlaceIds" in body ? body.preservePlaceIds ?? selected : selected), ...draft.assignments.flatMap((item) => item.orderedCandidateIds)])];
    let nextDraft: PlanningDraftInput = { ...draft, handoffId, sourceIntentStateVersion: handoff.sourceIntentStateVersion, placeRemovalUndo: undefined };
    const warnings: string[] = [];
    let changedSelection = false;
    if (body.action === "reopen") {
      nextDraft = { ...nextDraft, stage: "places", selectedPlaceIds: selected, placesConfirmed: false, boardConfirmed: false, flightSearchJob: undefined };
    } else if (body.action === "select") {
      const ids = [...new Set(body.selectedPlaceIds)];
      const allowed = new Set(draft.candidates.map((item) => item.placeId));
      if (ids.some((id) => !allowed.has(id))) return json({ error: { code: "SCENE_NOT_FOUND", message: "所选地点不在当前候选中，请重新选择。" } }, 422);
      changedSelection = JSON.stringify(ids) !== JSON.stringify(selected);
      nextDraft = { ...nextDraft, stage: "places", selectedPlaceIds: ids, placesConfirmed: false,
        assignments: retainSelectedAssignments(draft.assignments, ids) };
    } else if (body.action === "remove") {
      if (!draft.candidates.some((item) => item.placeId === body.placeId)) return json({ error: { code: "SCENE_NOT_FOUND", message: "地点已移除，请重新读取候选。" } }, 422);
      const ids = selected.filter((id) => id !== body.placeId);
      changedSelection = ids.length !== selected.length;
      nextDraft = { ...nextDraft, stage: "places", candidates: draft.candidates.filter((item) => item.placeId !== body.placeId),
        selectedPlaceIds: ids, placesConfirmed: false, assignments: retainSelectedAssignments(draft.assignments, ids),
        placeRemovalUndo: { candidate: draft.candidates.find((item) => item.placeId === body.placeId)!, selectedPlaceIds: selected, assignments: draft.assignments } };
    } else if (body.action === "undo_remove") {
      const snapshot = draft.placeRemovalUndo;
      if (!snapshot) return json({ error: { code: "PLACE_UNDO_UNAVAILABLE", message: "目前没有可撤回的候选移除操作。" } }, 422);
      const candidate = PlanningSceneCandidateSchema.parse(snapshot.candidate);
      changedSelection = JSON.stringify(snapshot.selectedPlaceIds) !== JSON.stringify(selected);
      nextDraft = { ...nextDraft, stage: "places", candidates: [...draft.candidates.filter((item) => item.placeId !== candidate.placeId), candidate],
        selectedPlaceIds: snapshot.selectedPlaceIds, assignments: snapshot.assignments, placesConfirmed: false };
    } else if (body.action === "confirm") {
      const confirmedIds = [...new Set(body.selectedPlaceIds ?? selected)];
      if (!confirmedIds.length) return json({ error: { code: "EMPTY_PLACE_SELECTION", message: "请至少选中一个想去的真实地点。" } }, 422);
      if (confirmedIds.some((id) => !available.has(id))) return json({ error: { code: "SCENE_NOT_FOUND", message: "部分所选地点已失效，请核对清单后重新确认。" }, draft }, 422);
      changedSelection = !samePlanningPlaceSelection(selected, confirmedIds);
      nextDraft = { ...nextDraft, stage: "day_allocation", selectedPlaceIds: confirmedIds, placesConfirmed: true,
        assignments: retainSelectedAssignments(draft.assignments, confirmedIds), boardConfirmed: false };
    } else if (body.action === "duration") {
      if (draft.boardConfirmed || !["places", "day_allocation"].includes(draft.stage)) return json({ error: { code: "DAY_BOARD_CONFIRMED", message: "请在时间核算中调整停留，或返回分天编辑。" } }, 409);
      const found = draft.candidates.some((item) => item.id === body.candidateId || item.placeId === body.candidateId);
      if (!found) return json({ error: { code: "SCENE_NOT_FOUND", message: "地点候选已变化，请重新选择。" } }, 422);
      nextDraft = { ...nextDraft, candidates: draft.candidates.map((item) => item.id === body.candidateId || item.placeId === body.candidateId
        ? { ...item, ...(item.recommendedMinutes === undefined && item.estimateSource !== "user" ? { recommendedMinutes: item.estimatedMinutes } : {}), estimatedMinutes: body.minutes, estimateSource: "user" } : item), selectedPlaceIds: selected,
        flightSearchJob: undefined,
        scheduleOverrides: draft.scheduleOverrides?.map((item) => {
          const values = item.visitMinutesByPlaceId && typeof item.visitMinutesByPlaceId === "object" ? { ...item.visitMinutesByPlaceId as Record<string, number> } : {};
          const changed = draft.candidates.find((candidate) => candidate.id === body.candidateId || candidate.placeId === body.candidateId);
          if (changed) delete values[String(changed.placeId)];
          return { ...item, visitMinutesByPlaceId: values };
        }),
        reviewRequired: [...new Set([...(draft.reviewRequired || []), ...(draft.dayEstimates?.length ? ["路线"] : [])])] };
    } else {
      let candidate = draft.candidates.flatMap((item) => { const parsed = PlanningSceneCandidateSchema.safeParse(item); return parsed.success && parsed.data.placeId === body.placeId ? [parsed.data] : []; })[0];
      let candidates = draft.candidates;
      if (!candidate && candidates.length >= 40) {
        const replaceable = candidates.findLastIndex((item) => !protectedIds.includes(String(item.placeId)));
        if (!body.replaceUnselected || replaceable < 0) return json({ error: { code: "SCENE_LIMIT_REACHED", message: "本次最多保留 40 个候选。请先取消一个尚未分天的选择，再确认替换未选候选。" } }, 422);
        candidates = candidates.filter((_, index) => index !== replaceable);
      }
      candidate ||= await addPlanningScene(handoff, body.placeId, token, body.turnId, timing);
      const ids = [...new Set([...selected.filter((id) => candidates.some((item) => item.placeId === id)), candidate.placeId])];
      changedSelection = !samePlanningPlaceSelection(ids, selected);
      nextDraft = { ...nextDraft, stage: "places", candidates: candidates.some((item) => item.placeId === candidate.placeId) ? candidates : [...candidates, candidate],
        selectedPlaceIds: ids, placesConfirmed: false };
    }
    if (changedSelection) nextDraft = { ...nextDraft, boardConfirmed: false, flightSearchJob: undefined,
      assignments: nextDraft.assignments.map((item) => ({ ...item, status: "provisional" })),
      reviewRequired: reviewAfterSceneChange(draft) };
    const commit = await timing.measureAsync("state_commit", () => commitPlanningDraft(token, {
      expectedVersion: body.expectedVersion,
      turnId: body.turnId,
      nextDraft,
    }, timing));
    if (!commit.committed) {
      return json({ error: { code: "PLANNING_VERSION_CONFLICT", message: "规划已更新，请使用最新内容重试。" }, draft: commit.draft }, 409);
    }
    return json({ draft: commit.draft, candidates: commit.draft.candidates, warnings });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: NextRequest) { return withPlanningTiming("scenes", "read", timing => readScenes(request, timing)); }
export async function POST(request: NextRequest) { return withPlanningTiming("scenes", "request", timing => writeScenes(request, timing)); }
