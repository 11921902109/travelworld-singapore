import type { PlanningAgentTaskStep } from "./bailian";
import { GoogleMapsServiceError, type SingaporePlace } from "./google-maps";
import type { PlanningHandoffV1 } from "./planning-state";
import {
  assessmentPrompt, parsePlanningSceneAssessments, parsePlanningSceneSuggestions, popularPlanningScenes,
  suggestionPrompt, toCandidate, verifiedPlanningSuggestion, type PlanningSceneCandidate, suggestionSchema,
} from "./planning-scenes";
import type { z } from "zod";

export type SceneDiscoveryStatus = "queued" | "running" | "completed" | "partial" | "failed" | "timed_out" | "superseded";
export type SceneAgentProgress = {
  turnId: string; stage: string; submitted: boolean | "unknown";
  waitingSince?: number; code?: string; reason?: string; retryable?: boolean;
};
export type SceneDiscoveryState = {
  phase: "suggestions" | "repair_suggestions" | "verify" | "popular_search" | "assess" | "repair_assess" | "complete";
  lookups: Array<{ suggestion: z.infer<typeof suggestionSchema>; status: "pending" | "failed" | "verified" | "rejected" }>;
  candidates: PlanningSceneCandidate[];
  popularPlaces: SingaporePlace[];
  warnings: string[];
  publishedIds: string[];
  lastFailure?: { code: string; message: string };
  agentProgress?: SceneAgentProgress;
};
export type SceneDiscoveryDependencies = {
  agent: (message: string, turnId: string) => Promise<PlanningAgentTaskStep>;
  search: (query: string, maxResults: number) => Promise<SingaporePlace[]>;
};
export type SceneDiscoveryAdvance = { state: SceneDiscoveryState; status: SceneDiscoveryStatus; errorCode: string | null };

export const initialSceneDiscoveryState = (): SceneDiscoveryState => ({
  phase: "suggestions", lookups: [], candidates: [], popularPlaces: [], warnings: [], publishedIds: [],
});
const result = (state: SceneDiscoveryState, status: SceneDiscoveryStatus = "running", errorCode: string | null = null): SceneDiscoveryAdvance => ({ state, status, errorCode });
const uniqueCandidates = (values: PlanningSceneCandidate[]) => [...new Map(values.map((item) => [item.placeId, item])).values()];
const lookupFailure = (error: unknown) => error instanceof GoogleMapsServiceError
  ? { code: error.code, message: error.message }
  : { code: "GOOGLE_LOOKUP_UNAVAILABLE", message: "Google 地点核实暂时未完成，请稍后继续读取。" };

export const SCENE_RESPONSE_WAIT_MS = 120_000;
/** A submitted turn gets its own result budget; errors must never look like healthy model work. */
function checkpointAgentStep(state: SceneDiscoveryState, step: PlanningAgentTaskStep, turnId: string): SceneDiscoveryAdvance | null {
  const previous = state.agentProgress?.turnId === turnId ? state.agentProgress : undefined;
  const submitted = "submitted" in step ? step.submitted as boolean | "unknown" : step.status === "completed" ? true : previous?.submitted ?? false;
  const stage = "stage" in step && typeof step.stage === "string" ? step.stage : step.status === "completed" ? "completed" : submitted === true ? "remote_wait" : "preparing";
  const waitingSince = submitted === true || submitted === "unknown" ? previous?.waitingSince ?? Date.now() : undefined;
  state.agentProgress = { turnId, stage, submitted, ...(waitingSince !== undefined ? { waitingSince } : {}),
    ...("code" in step && typeof step.code === "string" ? { code: step.code } : {}),
    ...("reason" in step ? { reason: step.reason } : {}),
    ...("retryable" in step && typeof step.retryable === "boolean" ? { retryable: step.retryable } : {}) };
  if (step.status === "completed") return null;
  if (step.status === "failed") return result(state, step.reason === "stale_handoff" ? "superseded" : state.candidates.length ? "partial" : "failed", step.reason);
  if ("retryableCode" in step && String(step.retryableCode) === "network") {
    state.agentProgress.reason = submitted === true ? "read_failed" : "submission_failed";
    return result(state, state.candidates.length ? "partial" : "failed", state.agentProgress.reason);
  }
  if (waitingSince !== undefined && Date.now() - waitingSince >= SCENE_RESPONSE_WAIT_MS)
    return result(state, "timed_out", "response_wait_timeout");
  return result(state, step.status, "retryableCode" in step ? step.retryableCode : null);
}

/** One bounded phase. Model turns and every successful lookup survive the next request. */
export async function advanceSceneDiscovery(saved: SceneDiscoveryState, handoff: PlanningHandoffV1, id: string, deps: SceneDiscoveryDependencies): Promise<SceneDiscoveryAdvance> {
  const state = structuredClone(saved);
  const allowAutomatic = !handoff.preferences.recommendationDeclined;
  const desired = Math.min(18, Math.max(handoff.dates.days * 2, 4));
  if (state.phase === "complete") return result(state, "completed");
  if (!allowAutomatic && !handoff.preferences.mustVisit.length) return result(state, "failed", "no_eligible_places");
  if (state.phase === "suggestions" || state.phase === "repair_suggestions") {
    const repair = state.phase === "repair_suggestions";
    const message = repair
      ? `上一轮地点建议未通过 JSON 字段校验。请根据同一旅行条件重新整理，只返回 suggestions 数组，每项包含具体 query、kind、area、reason、estimatedMinutes（30–480整数）、pros、cons。不要调用工具。\n原旅行条件和要求：${suggestionPrompt(handoff)}`
      : suggestionPrompt(handoff);
    const turnId = `${id}:${repair ? "repair" : "suggest"}`;
    const step = await deps.agent(message, turnId);
    const checkpoint = checkpointAgentStep(state, step, turnId);
    if (checkpoint) return checkpoint;
    if (step.status !== "completed") return result(state, "failed", "agent_unavailable");
    const suggestions = parsePlanningSceneSuggestions(step.text);
    if (!suggestions) {
      if (repair) return result(state, "failed", "invalid_suggestions");
      state.phase = "repair_suggestions";
      return result(state);
    }
    state.lookups = suggestions.map((suggestion) => ({ suggestion, status: "pending" }));
    state.phase = "verify";
    return result(state);
  }
  if (state.phase === "verify") {
    const pending = state.lookups.filter((item) => item.status === "pending").slice(0, 3);
    await Promise.all(pending.map(async (item) => {
      try {
        const places = await deps.search(item.suggestion.query, 3);
        const candidate = places.map((place) => verifiedPlanningSuggestion(place, item.suggestion, handoff)).find(Boolean);
        item.status = candidate ? "verified" : "rejected";
        if (candidate) state.candidates.push(candidate);
      } catch (error) { item.status = "failed"; state.lastFailure = lookupFailure(error); }
    }));
    state.candidates = uniqueCandidates(state.candidates);
    if (state.lookups.some((item) => item.status === "pending")) return result(state);
    if (state.lookups.some((item) => item.status === "failed")) return result(state, "partial", "google_verification");
    if (allowAutomatic && state.candidates.length < desired) { state.phase = "popular_search"; return result(state); }
    state.phase = "complete";
    return result(state, state.candidates.length ? "completed" : "failed", state.candidates.length ? null : "no_eligible_places");
  }
  if (state.phase === "popular_search") {
    try {
      state.popularPlaces = popularPlanningScenes(await deps.search("popular attractions landmarks gardens Singapore", 20), state.candidates, handoff);
      state.phase = state.popularPlaces.length ? "assess" : "complete";
      return result(state, state.phase === "complete" ? state.candidates.length ? "completed" : "failed" : "running", state.phase === "complete" && !state.candidates.length ? "no_eligible_places" : null);
    } catch (error) { state.lastFailure = lookupFailure(error); return result(state, state.candidates.length ? "partial" : "failed", "google_verification"); }
  }
  const repair = state.phase === "repair_assess";
  const message = repair
    ? `上一轮说明未通过 JSON 字段校验，请只返回完整 assessments 数组，不要调用工具。\n${assessmentPrompt(handoff, state.popularPlaces)}`
    : assessmentPrompt(handoff, state.popularPlaces);
  const turnId = `${id}:${repair ? "assess_repair" : "assess"}`;
  const step = await deps.agent(message, turnId);
  const checkpoint = checkpointAgentStep(state, step, turnId);
  if (checkpoint) return checkpoint;
  if (step.status !== "completed") return result(state, "failed", "agent_unavailable");
  const descriptions = parsePlanningSceneAssessments(step.text);
  if (!descriptions) {
    if (repair) return result(state, state.candidates.length ? "partial" : "failed", "invalid_assessments");
    state.phase = "repair_assess";
    return result(state);
  }
  for (const place of state.popularPlaces) {
    const description = descriptions.find((item) => item.placeId === place.placeId);
    if (description) state.candidates.push(toCandidate(place, { ...description, query: place.name }, "popular"));
  }
  state.candidates = uniqueCandidates(state.candidates).slice(0, Math.max(desired, saved.candidates.length));
  state.warnings = [...new Set([...state.warnings, "偏好候选不足，已补入经 Google 核实的热门地点。"] )];
  state.phase = "complete";
  return result(state, state.candidates.length ? "completed" : "failed", state.candidates.length ? null : "no_eligible_places");
}

/** Resume missing work only. Successful lookups and completed model turns stay intact. */
export function resumeSceneDiscovery(state: SceneDiscoveryState): SceneDiscoveryState {
  return { ...state, lastFailure: undefined,
    ...(state.agentProgress ? { agentProgress: { ...state.agentProgress, ...(state.agentProgress.waitingSince !== undefined ? { waitingSince: Date.now() } : {}) } } : {}),
    lookups: state.lookups.map((item) => item.status === "failed" ? { ...item, status: "pending" } : item) };
}
