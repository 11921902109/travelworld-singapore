"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, RotateCcw, Sparkles } from "lucide-react";
import { getTravelVisitToken } from "@/lib/travel/visit-client";
import type { PlanningHandoffV1 } from "@/lib/travel/planning-state";
import type { FlightSearchResult, FlightSearchJob } from "@/lib/travel/planning-flights";
import { planningEditImpact, pendingReviewLabels, type PlanningReviewItem } from "@/lib/travel/planning-review";
import { hoursLabel } from "@/lib/travel/planning-duration";
import type { StayAdvice } from "@/lib/travel/planning-stays";
import type { SingaporeIntentResponse, SingaporePlanResponse } from "@/lib/travel/types";
import { PlaceDayStage, type DayPeriod, type PlanningDay, type PlanningPlace } from "./place-day-stage";
import { PlaceSelectionStage } from "./place-selection-stage";
import { useWorkingPlaceSelection } from "./use-working-place-selection";
import { useWorkingDayBoard } from "./use-working-day-board";
import { beginPlanningInteraction } from "./planning-client-timing";
import type { BoardAssignment, BoardPlacePreference } from "@/lib/travel/planning-day-board";
import { planningBoardInsertionIndex } from "@/lib/travel/planning-insertion";
import { useFlightSearchJob } from "./use-flight-search-job";
import { useHotelQuoteJob } from "./use-hotel-quote-job";
import { useSceneDiscoveryJob } from "./use-scene-discovery-job";
import type { SceneDiscoveryJob } from "@/lib/travel/planning-scene-jobs";
import type { HotelQuoteJob } from "@/lib/travel/planning-hotel-jobs";
import type { PlanningScheduleConflict, ScheduleMoveBatchPreview } from "@/lib/travel/planning-conflicts";
import type { PlanningAttractionMatch, PlanningAttractionPreview } from "@/lib/travel/planning-attractions";
import { FlightStage } from "./flight-stage";
import { StayStage, type StaySegment, type StaySaveResult } from "./stay-stage";
import { ScheduleStage, type DayEstimate, type FreeTimeDecision, type ScheduleSaveFailure } from "./schedule-stage";
import type { PlanningHelpContext } from "@/lib/travel/planning-help-questions";
import type { PlanningTimeOverride } from "@/lib/travel/planning-time-overrides";
import styles from "./planning-journey.module.css";

type Stage = "places" | "day_allocation" | "flights" | "stays" | "route" | "complete";
type RawCandidate = {
  id: string;
  placeId: string;
  name: string;
  address: string;
  area: string;
  category: string;
  kind: "sight" | "food";
  sceneRole?: "culinary_area" | "restaurant_meal" | "attraction";
  includedMealMinutes?: number;
  durationReason?: string;
  reason: string;
  estimatedMinutes: number;
  recommendedMinutes?: number;
  recommendedDuration?: { minMinutes: number; maxMinutes: number; source: "ai_suggestion" };
  estimateSource?: "bailian" | "user";
  pros: string;
  cons: string;
  source: string;
  sourceNote: string;
  verified: boolean;
  openingHours?: string[];
  googleMapsUri?: string | null;
};
export type PlanningDraft = {
  version: number;
  handoffId: string;
  sourceIntentStateVersion: number;
  stage: Stage;
  candidates: RawCandidate[];
  selectedPlaceIds?: string[];
  selectionReason?: string;
  placesConfirmed?: boolean;
  placeRemovalUndo?: unknown;
  assignments: Array<BoardAssignment & { status?: string }>;
  placeTimePreferences?: Record<string, BoardPlacePreference>;
  boardConfirmed: boolean;
  dayDeletionUndo?: { deletedDay: number; previousIntentJson: string; previousAssignments: Array<{ day: number; orderedCandidateIds: string[]; periodByCandidateId?: Record<string, DayPeriod>; status?: string }> };
  flightQuotes?: FlightSearchResult & { originCity?: string };
  flightSearchJob?: FlightSearchJob;
  flightSelection?: { mode: "quoted" | "manual" | "none"; affectedDays?: string[]; outbound?: { id: string }; inbound?: { id: string }; [key: string]: unknown } | null;
  stayAdvice?: StayAdvice;
  staySegments?: StaySegment[];
  stayConfirmed?: boolean;
  hotelQuoteJob?: HotelQuoteJob;
  sceneDiscoveryJob?: SceneDiscoveryJob;
  dayEstimates?: DayEstimate[];
  scheduleConflicts?: PlanningScheduleConflict[];
  scheduleOverrides?: PlanningTimeOverride[];
  freeTimeDecisions?: FreeTimeDecision[];
  reviewRequired?: string[];
  reviewItems?: PlanningReviewItem[];
  pendingReviews?: Array<{ kind: string; message: string; targetStage: string; day?: number }>;
  staleScheduleDays?: number[];
  scheduleReady?: boolean;
  stageHistory?: Array<{ stage: Stage; version: number; savedAt: string; summary: string[] }>;
  updatedAt: string;
};
type StayBoundary = { nights: number; lastHotelNightDay: number; note: string };
type ApiPayload = { attractionMatches?: PlanningAttractionMatch[]; attractionPreview?: PlanningAttractionPreview; movePreview?: ScheduleMoveBatchPreview; saveResult?: StaySaveResult; draft?: PlanningDraft | null; boundary?: StayBoundary | null; candidates?: RawCandidate[]; candidate?: RawCandidate; matches?: Array<{ placeId: string; name: string; address: string; categoryLabel?: string; kind?: "sight" | "food" }>; handoff?: PlanningHandoffV1; handoffId?: string; intentResult?: SingaporeIntentResponse; sourceIntentStateVersion?: number; planningSessionReady?: boolean; code?: string; error?: string | { code?: string; message?: string }; message?: string };
type StageApiPayload = ApiPayload & { conflicts?: PlanningScheduleConflict[]; capacity?: { message: string }; blockId?: string };
type Props = {
  handoff: PlanningHandoffV1;
  handoffId: string;
  onCompiled: (payload: SingaporePlanResponse) => void;
  onHandoffChange?: (payload: { handoff: PlanningHandoffV1; handoffId: string; intentResult: SingaporeIntentResponse; sourceIntentStateVersion: number; planningSessionReady: boolean }) => void;
  onProgress?: (message: string) => void;
  onHelpContext?: (context: PlanningHelpContext | null, milestones: string[]) => void;
  onEditConditions?: () => void;
  autoStartDiscovery?: boolean;
};

const stages: Array<{ key: Stage; label: string }> = [
  { key: "places", label: "挑地点" }, { key: "day_allocation", label: "分天" },
  { key: "flights", label: "航班" }, { key: "stays", label: "住宿" },
  { key: "route", label: "时间核算" }, { key: "complete", label: "地图" },
];

function errorFrom(payload: ApiPayload | null, fallback: string) {
  return typeof payload?.error === "string" ? payload.error : payload?.error?.message || payload?.message || fallback;
}

function toPlace(candidate: RawCandidate): PlanningPlace {
  return {
    candidateId: candidate.placeId,
    googlePlaceId: candidate.placeId,
    name: candidate.name,
    kind: candidate.kind,
    sceneRole: candidate.sceneRole,
    durationReason: candidate.durationReason,
    category: candidate.category,
    area: candidate.area,
    address: candidate.address,
    openingHours: candidate.openingHours,
    estimatedVisitMinutes: candidate.estimatedMinutes,
    durationSource: candidate.estimateSource === "user" ? "user" : "bailian",
    pros: [candidate.pros],
    cons: [candidate.cons],
    reason: candidate.reason,
    verification: candidate.verified ? "verified" : "unverified",
    factSource: "google_places",
    adviceSource: "bailian",
    fallbackReason: candidate.source === "popular" ? candidate.sourceNote : null,
  };
}

function daysFor(handoff: PlanningHandoffV1, draft: PlanningDraft, workingAssignments = draft.assignments): Array<PlanningDay & { date: string }> {
  return Array.from({ length: handoff.dates.days }, (_, index) => {
    const day = index + 1;
    const date = new Date(`${handoff.dates.start}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + index);
    const assignment = workingAssignments.find((item) => item.day === day);
    return { ...assignment, day, date: date.toISOString().slice(0, 10), orderedCandidateIds: assignment?.orderedCandidateIds || [], periodByCandidateId: assignment?.periodByCandidateId || {}, dayPurpose: assignment?.dayPurpose, status: assignment?.status };
  });
}

export function PlanningJourney({ handoff, handoffId, onCompiled, onHandoffChange, onProgress, onEditConditions, onHelpContext, autoStartDiscovery = false }: Props) {
  const [draft, setDraft] = useState<PlanningDraft | null>(null);
  const [stayBoundary, setStayBoundary] = useState<StayBoundary | null>(null);
  const draftRef = useRef<PlanningDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [error, setError] = useState("");
  const [scheduleFailure, setScheduleFailure] = useState<(ScheduleSaveFailure & { version: number }) | null>(null);
  const [dayHelp, setDayHelp] = useState<Pick<PlanningHelpContext, "day" | "locked" | "hasFailure">>({});
  const setHelpDay = useCallback((day: number, options: { locked: boolean; hasFailure: boolean }) => {
    setDayHelp((previous) => previous.day === day && previous.locked === options.locked && previous.hasFailure === options.hasFailure ? previous : { day, ...options });
  }, []);
  const [searchMatches, setSearchMatches] = useState<PlanningPlace[]>([]);
  const [reviewStage, setReviewStage] = useState<Stage | null>(null);
  const [reviewVersion, setReviewVersion] = useState<number | null>(null);
  const [boardReturnContext, setBoardReturnContext] = useState<{ day: number; anchor?: { nodeId: string; placement: "before" | "after" }; placeId?: string; name?: string; insertionIndex?: number } | null>(null);
  const [reload, setReload] = useState(0);
  const busyRef = useRef(false);
  const lastTurnRef = useRef<{ key: string; turnId: string } | null>(null);
  const autoDiscoveryStartedRef = useRef(false);

  const updateDraft = useCallback((next: PlanningDraft) => {
    const current = draftRef.current;
    if (current?.handoffId === next.handoffId && current.version > next.version) return;
    draftRef.current = next;
    setDraft(next);
    setReviewStage(null);
    setReviewVersion(null);
    if (next.stage !== "stays") setStayBoundary(null);
  }, []);
  const updateFlightDraft = useCallback((next: PlanningDraft) => {
    const current = draftRef.current;
    if (current && (current.handoffId !== next.handoffId || current.version > next.version)) return;
    draftRef.current = next; setDraft(next);
  }, []);
  const flightQuery = useFlightSearchJob(draft, updateFlightDraft, setError);
  const hotelQuery = useHotelQuoteJob(draft, updateFlightDraft, setError);
  const updateSceneDraft = useCallback((next: PlanningDraft) => {
    const previous = draftRef.current;
    updateFlightDraft(next);
    if (next.sceneDiscoveryJob && ["completed", "partial"].includes(next.sceneDiscoveryJob.status)
      && (previous?.sceneDiscoveryJob?.id !== next.sceneDiscoveryJob.id || previous.sceneDiscoveryJob.status !== next.sceneDiscoveryJob.status)) {
      setError("");
      onProgress?.(`已保留 ${next.candidates.length} 处 Google 核实的地点候选，请选择想去的地点。${next.sceneDiscoveryJob.status === "partial" ? "未完成部分可继续读取。" : ""}`);
    }
  }, [updateFlightDraft, onProgress]);
  const sceneQuery = useSceneDiscoveryJob(draft, updateSceneDraft, setError);
  const localSelection = useWorkingPlaceSelection(handoffId, draft);
  const localBoard = useWorkingDayBoard(handoffId, draft, handoff.dates.days);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/travel/singapore/planning/scenes", {
          headers: { "x-travel-visit": await getTravelVisitToken() }, cache: "no-store",
        });
        const payload = await response.json().catch(() => null) as ApiPayload | null;
        if (!response.ok || !payload?.draft) throw new Error(errorFrom(payload, "暂时无法恢复地点与分天安排。"));
        if (active) updateDraft(payload.draft);
        if (payload.draft.stage === "places") return;
        const stagePath = payload.draft.stage === "flights" ? "flights"
          : payload.draft.stage === "stays" ? "stays"
            : payload.draft.stage === "route" || payload.draft.stage === "complete" ? "schedule" : "board";
        const stageResponse = await fetch(`/api/travel/singapore/planning/${stagePath}`, {
          headers: { "x-travel-visit": await getTravelVisitToken() }, cache: "no-store",
        });
        const stagePayload = await stageResponse.json().catch(() => null) as ApiPayload | null;
        if (!stageResponse.ok || !stagePayload?.draft || stagePath === "stays" && !stagePayload.boundary) throw new Error(errorFrom(stagePayload, "暂时无法读取当前规划阶段，请重新读取。"));
        if (active) { updateDraft(stagePayload.draft); if (stagePath === "stays") setStayBoundary(stagePayload.boundary || null); }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "暂时无法恢复地点与分天安排。");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [handoffId, reload, updateDraft]);

  async function postScenes(body: Record<string, unknown>, fallback: string) {
    const response = await fetch("/api/travel/singapore/planning/scenes", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-travel-visit": await getTravelVisitToken() },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null) as ApiPayload | null;
    if (response.status === 409 && payload?.draft) updateDraft(payload.draft);
    if (!response.ok || !payload) throw new Error(errorFrom(payload, fallback));
    return payload;
  }

  async function mutateScenes(body: Record<string, unknown>, fallback: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const current = draftRef.current;
      if (!current) throw new Error("规划状态尚未恢复。请重试读取。");
      const key = JSON.stringify({ version: current.version, ...body });
      const turnId = lastTurnRef.current?.key === key ? lastTurnRef.current.turnId : crypto.randomUUID();
      lastTurnRef.current = { key, turnId };
      const payload = await postScenes({ ...body, expectedVersion: current.version, turnId }, fallback);
      if (!payload.draft) throw new Error("地点查询未返回可保存的规划状态。请重试。");
      updateDraft(payload.draft);
      if (body.action === "confirm") localSelection.clear();
      if (body.action === "generate" && payload.draft.sceneDiscoveryJob) onProgress?.(payload.draft.sceneDiscoveryJob.message);
      if (body.action === "confirm") onProgress?.("已确认想去的地点，现在把它们分配到每天。" );
      lastTurnRef.current = null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!autoStartDiscovery || loading || !draft || draft.stage !== "places" || draft.candidates.length || draft.sceneDiscoveryJob?.id || autoDiscoveryStartedRef.current) return;
    autoDiscoveryStartedRef.current = true;
    void mutateScenes({ action: "generate" }, "地点查询失败，已保留旅行条件，请点击重新查找地点。");
    // Trigger once for an empty restored discovery draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartDiscovery, loading, draft?.stage, draft?.candidates.length, draft?.sceneDiscoveryJob?.id]);

  async function searchPlaces(query: string) {
    if (busyRef.current || searchBusy) return;
    setSearchBusy(true);
    setError("");
    setSearchMatches([]);
    try {
      const payload = await postScenes({ action: "search", query }, "无法查找这个地点，请换个名称重试。");
      setSearchMatches((payload.matches || []).flatMap((match) => match.kind && match.categoryLabel ? [{
        candidateId: match.placeId, googlePlaceId: match.placeId, name: match.name, kind: match.kind,
        category: match.categoryLabel, area: "", address: match.address, verification: "verified" as const,
      }] : []));
      if (!payload.matches?.length) setError("没有找到相符的 Google 地点，请尝试更具体的名称。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "暂时无法搜索地点。");
    } finally {
      setSearchBusy(false);
    }
  }

  async function postBoard(assignments: PlanningDraft["assignments"], confirmed: boolean, restDays?: number[]) {
    if (busyRef.current) return;
    const interaction = beginPlanningInteraction("board:save");
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const current = draftRef.current;
      if (!current) throw new Error("规划状态尚未恢复。请重新读取。");
      const submitted = assignments.map((item) => ({ ...item, dayPurpose: item.orderedCandidateIds.length ? "activities" : restDays?.includes(item.day) ? "rest" : item.dayPurpose }));
      const key = JSON.stringify({ path: "board", version: current.version, assignments: submitted, confirmed });
      const turnId = lastTurnRef.current?.key === key ? lastTurnRef.current.turnId : crypto.randomUUID();
      lastTurnRef.current = { key, turnId };
      const response = await fetch("/api/travel/singapore/planning/board", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-travel-visit": await getTravelVisitToken() },
        body: JSON.stringify({ expectedVersion: current.version, turnId, assignments: submitted, placeTimePreferences: Object.fromEntries(Object.entries(confirmed ? localBoard.preferences : current.placeTimePreferences || {}).filter(([id]) => current.selectedPlaceIds?.includes(id) || current.assignments.some((day) => day.orderedCandidateIds.includes(id)))), confirmed }),
      });
      const payload = await response.json().catch(() => null) as ApiPayload | null;
      interaction.response(response);
      if (response.status === 409 && payload?.draft) updateDraft(payload.draft);
      if (!response.ok || !payload?.draft) throw new Error(errorFrom(payload, "分天安排暂时无法保存，请重试。"));
      updateDraft(payload.draft);
      localBoard.clear();
      lastTurnRef.current = null;
      if (confirmed) onProgress?.("已确认暂定分天安排。下一步可查询航班，首末日的可用时间会根据抵离信息复核。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "分天安排暂时无法保存，请重试。");
    } finally {
      busyRef.current = false;
      setBusy(false);
      interaction.finish();
    }
  }

  async function changeDayCount(action: "delete" | "undo", day?: number) {
    if (busyRef.current) return;
    if (localBoard.conflict) { setError("规划已有更新，请先核对并选择如何保留本地安排。"); return; }
    if (action === "undo" && localBoard.dirty && !window.confirm("撤回删日将恢复删日前的安排，并放弃之后尚未确认的地点调整。是否继续？")) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const current = draftRef.current;
      if (!current) throw new Error("分天安排尚未恢复，请重新读取。" );
      const response = await fetch("/api/travel/singapore/planning/day-count", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-travel-visit": await getTravelVisitToken() },
        body: JSON.stringify({ action, day, ...(action === "delete" ? { workingAssignments: localBoard.assignments, placeTimePreferences: localBoard.preferences } : {}), expectedIntentStateVersion: handoff.sourceIntentStateVersion,
          expectedDraftVersion: current.version, turnId: crypto.randomUUID() }),
      });
      const payload = await response.json().catch(() => null) as ApiPayload | null;
      if (!response.ok || !payload?.handoff || !payload.handoffId || !payload.intentResult ||
          payload.sourceIntentStateVersion === undefined || !payload.draft) {
        throw new Error(errorFrom(payload, "无法调整旅行日期，请重新读取分天安排。"));
      }
      updateDraft(payload.draft);
      localBoard.clear();
      onHandoffChange?.({ handoff: payload.handoff, handoffId: payload.handoffId,
        intentResult: payload.intentResult, sourceIntentStateVersion: payload.sourceIntentStateVersion,
        planningSessionReady: payload.planningSessionReady === true });
      onProgress?.(action === "delete"
        ? `已删除 Day ${day}；旅行日期从 ${handoff.dates.start}–${handoff.dates.end} 调整为 ${payload.handoff.dates.start}–${payload.handoff.dates.end}。被删日地点仍在候选池，可重新安排。`
        : `已撤回删日；旅行日期恢复为 ${payload.handoff.dates.start}–${payload.handoff.dates.end}。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法调整旅行日期，请重新读取分天安排。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function mutateStage(path: "flights" | "stays" | "schedule", action: string, data: Record<string, unknown> = {}) {
    if (busyRef.current) return;
    const interaction = beginPlanningInteraction(`${path}:${action}`);
    busyRef.current = true;
    const localHotelSave = path === "stays" && action === "selectHotel";
    if (!localHotelSave) setBusy(true);
    setError("");
    const updateDay = path === "schedule" && action === "updateDay" ? (data.overrides as PlanningTimeOverride | undefined)?.day : undefined;
    if (path === "flights") setStayBoundary(null);
    try {
      const current = draftRef.current;
      if (!current) throw new Error("规划状态尚未恢复。请重新读取。");
      const key = JSON.stringify({ path, action, version: current.version, ...data });
      const turnId = lastTurnRef.current?.key === key ? lastTurnRef.current.turnId : crypto.randomUUID();
      lastTurnRef.current = { key, turnId };
      const response = await fetch(`/api/travel/singapore/planning/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-travel-visit": await getTravelVisitToken() },
        body: JSON.stringify({ action, ...data, expectedVersion: current.version, turnId }),
      });
      const payload = await response.json().catch(() => null) as StageApiPayload | null;
      interaction.response(response);
      if (response.status === 409 && payload?.draft) updateDraft(payload.draft);
      if (updateDay !== undefined && !response.ok) {
        setScheduleFailure({ day: updateDay, version: draftRef.current?.version ?? current.version, message: payload?.capacity?.message || errorFrom(payload, "本日核算未通过，原安排未改变。"), conflicts: payload?.conflicts, blockId: payload?.blockId });
        return;
      }
      if (!response.ok || !payload?.draft) throw new Error(errorFrom(payload, "本阶段暂时无法更新，请稍后重试。"));
      updateDraft(payload.draft);
      if (path === "schedule" && action === "updateDay") setScheduleFailure(null);
      const progress: Record<string, string> = {
        "flights:select": "已选择航班，抵离时间将纳入后续安排。",
        "flights:manual": "已记录手动填写的航班时间。",
        "flights:skip": "已跳过航班选择，继续比较住宿。",
        "stays:confirm": "已确认住宿安排，开始核算每天的地点、营业时间和交通。",
        "stays:segments": payload.saveResult?.message || "住宿区域与夜段已保存，请继续为每段搜索并选择酒店。",
        "schedule:updateDay": "已保存本日时间设置并重新核算；航班和酒店选择继续保留。",
        "schedule:applyMove": "已一次保存全部确认的地点调整，并更新受影响日期的核算。",
        "schedule:addAttraction": "已按你的确认加入景点，并更新当天的路线与未分配时间。",
        "schedule:confirm": "已确认各日时段和余量，可生成完整地图。",
      };
      if (progress[`${path}:${action}`] && !(path === "stays" && action === "segments" && payload.saveResult?.unchanged)) onProgress?.(progress[`${path}:${action}`] + (path === "schedule" && payload.draft.scheduleConflicts?.length ? "仍有时间冲突，请按本日提示继续调整。" : ""));
      if (path === "stays") setStayBoundary(payload.boundary || null);
      if (path === "flights" && payload.draft.stage === "stays") {
        const stayResponse = await fetch("/api/travel/singapore/planning/stays", {
          headers: { "x-travel-visit": await getTravelVisitToken() }, cache: "no-store",
        });
        const stayPayload = await stayResponse.json().catch(() => null) as ApiPayload | null;
        if (!stayResponse.ok || !stayPayload?.boundary) throw new Error(errorFrom(stayPayload, "航班已保存，但暂时无法读取住宿夜数。请重新读取住宿信息。"));
        setStayBoundary(stayPayload.boundary);
      }
      lastTurnRef.current = null;
      return payload;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "本阶段暂时无法更新，请稍后重试。";
      if (updateDay !== undefined && draftRef.current) setScheduleFailure({ day: updateDay, version: draftRef.current.version, message: "暂时无法读取本日保存结果。你的输入仍在，请稍后核对或重试。" });
      else setError(message);
    } finally {
      busyRef.current = false;
      setBusy(false);
      interaction.finish();
    }
  }

  function assign(candidateId: string, day: number, index?: number, period?: "morning" | "afternoon") {
    const current = draftRef.current;
    if (!current || !current.candidates.some((place) => place.placeId === candidateId) || current.boardConfirmed) return;
    const interaction = beginPlanningInteraction("board:edit");
    let targetIndex = index;
    if (targetIndex === undefined && boardReturnContext?.day === day) {
      const ids = localBoard.assignments.find((item) => item.day === day)?.orderedCandidateIds || [];
      const anchorIndex = ids.indexOf(boardReturnContext.placeId || "");
      if (anchorIndex >= 0) targetIndex = anchorIndex + (boardReturnContext.anchor?.placement === "after" ? 1 : 0);
      else if (boardReturnContext.insertionIndex !== undefined) targetIndex = Math.min(ids.length, boardReturnContext.insertionIndex);
    }
    localBoard.move(candidateId, day, targetIndex, period);
    interaction.finish();
  }

  function remove(candidateId: string) {
    const current = draftRef.current;
    if (!current || current.boardConfirmed) return;
    const interaction = beginPlanningInteraction("board:edit");
    localBoard.move(candidateId, null);
    interaction.finish();
  }

  async function compileMap() {
    if (busyRef.current || draftRef.current?.stage !== "complete") return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const current = draftRef.current;
      if (!current) throw new Error("规划状态尚未恢复。");
      const response = await fetch("/api/travel/singapore/planning/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-travel-visit": await getTravelVisitToken() },
        body: JSON.stringify({ expectedVersion: current.version, turnId: crypto.randomUUID() }),
      });
      const payload = await response.json().catch(() => null) as (SingaporePlanResponse & ApiPayload) | null;
      if (response.status === 409 && payload?.draft) updateDraft(payload.draft);
      if (!response.ok || !payload?.trip?.days?.length || !payload?.meta) throw new Error(errorFrom(payload, "真实地图暂时无法生成，请重试。"));
      onCompiled(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "真实地图暂时无法生成，请重试。");
      busyRef.current = false;
      setBusy(false);
    }
  }

  const stage = draft?.stage || "places";
  const stageIndex = Math.max(0, stages.findIndex((item) => item.key === stage));
  const showBoard = draft && stage === "day_allocation";
  const selectedPlaceIds = draft?.selectedPlaceIds ?? [...new Set(draft?.assignments.flatMap((item) => item.orderedCandidateIds) || [])];
  const reviewSnapshots = draft?.stageHistory?.filter((item) => item.stage === reviewStage) || [];
  const reviewSnapshot = reviewSnapshots.find((item) => item.version === reviewVersion) || reviewSnapshots.at(-1);
  const reviewImpact = draft && reviewStage ? planningEditImpact(draft, reviewStage) : [];
  const pendingReviews = draft ? draft.pendingReviews?.map((item) => item.message) ?? pendingReviewLabels(draft) : [];
  const scheduleReviews = draft?.pendingReviews ?? (draft ? pendingReviewLabels(draft).map((message) => ({
    kind: "legacy", message,
    targetStage: /地点|分天/.test(message) ? "day_allocation" : /航班/.test(message) ? "flights" : /住宿|预算/.test(message) ? "stays" : "route",
  })) : []);

  useEffect(() => {
    if (!onHelpContext || !draft || loading) return;
    const selectedCount = draft.selectedPlaceIds?.length ?? new Set(draft.assignments.flatMap((item) => item.orderedCandidateIds)).size;
    onHelpContext(stage === "complete" ? null : { handoffId, stage, ...(stage === "route" ? dayHelp : {}) }, [
      ...(draft.placesConfirmed ? [`已选 ${selectedCount} 处地点`] : []),
      ...(draft.boardConfirmed ? [`已确认 ${handoff.dates.days} 天的分天安排`] : []),
      ...(draft.flightSelection ? [draft.flightSelection.mode === "none" ? "已确认无需航班" : "已确认航班安排"] : []),
      ...(draft.stayConfirmed ? ["已确认住宿安排"] : []),
      ...(draft.scheduleReady ? ["已核算每日时间"] : []),
    ]);
  }, [onHelpContext, draft, loading, stage, handoffId, handoff.dates.days, dayHelp]);

  function editReviewedStage() {
    if (!draft || !reviewStage) return;
    if (!window.confirm(`是否回到“${stages.find((item) => item.key === reviewStage)?.label}”，从当前有效规划继续编辑并进行后续步骤？${reviewImpact.length ? `\n${reviewImpact.join("；")}。` : ""}`)) return;
    if (reviewStage === "places") void mutateScenes({ action: "reopen" }, "暂时无法返回地点选择。");
    else if (reviewStage === "day_allocation") void postBoard(draft.assignments, false);
    else if (reviewStage === "flights") void mutateStage("flights", "reopen");
    else if (reviewStage === "stays") void mutateStage("stays", "reopen");
    else if (reviewStage === "route") void mutateStage("schedule", "reopen");
  }

  function editDayBoard(context?: { day: number; anchor?: { nodeId: string; placement: "before" | "after" } }, pendingMoves = false) {
    if (!draft) return;
    const impact = planningEditImpact(draft, "day_allocation");
    if (!window.confirm(`是否回到分天，从当前有效规划继续编辑？${pendingMoves ? "\n返回会放弃这份待确认调整。" : ""}${impact.length ? `\n${impact.join("；")}。` : ""}`)) return;
    const stops = draft.dayEstimates?.find((item) => item.day === context?.day)?.scheduledDay?.stops || [];
    const stop = context?.anchor ? stops.find((item) => item.id === context.anchor!.nodeId) : undefined;
    const insertionIndex = context?.anchor ? planningBoardInsertionIndex(stops, draft.assignments.find((item) => item.day === context.day)?.orderedCandidateIds || [], draft.candidates, context.anchor) : undefined;
    setBoardReturnContext(context ? { ...context, insertionIndex, ...(stop ? { placeId: stop.placeId || undefined, name: stop.name } : {}) } : null);
    void postBoard(draft.assignments, false);
  }

  return <div className={styles.journey}>
    <nav className={styles.progressRail} aria-label="旅行规划阶段">
      {stages.map((item, index) => index < stageIndex
        ? <button type="button" key={item.key} className={`${styles.pastStep} ${reviewStage === item.key ? styles.currentStep : ""}`} aria-pressed={reviewStage === item.key} onClick={() => { setReviewStage(item.key); setReviewVersion(null); }}><b><Check size={12} /></b>{item.label}</button>
        : <span key={item.key} className={index === stageIndex && !reviewStage ? styles.currentStep : ""} aria-current={index === stageIndex ? "step" : undefined}><b>{index + 1}</b>{item.label}</span>)}
    </nav>
    {reviewStage && draft && <section className={styles.stage} aria-label={`${stages.find((item) => item.key === reviewStage)?.label}只读回看`}>
      <div className={styles.stageHeading}><div><small>READ ONLY · 已保存版本 {reviewSnapshot?.version || draft.version}</small><h2>回看：{stages.find((item) => item.key === reviewStage)?.label}</h2><p>浏览已确认的规划摘要不会改变正在进行的阶段。</p></div><Check size={22} /></div>
      {reviewSnapshots.length > 1 && <label className={styles.reviewVersion}>历史版本 <select value={reviewSnapshot?.version || ""} onChange={(event) => setReviewVersion(Number(event.target.value))}>{reviewSnapshots.map((item) => <option key={item.version} value={item.version}>版本 {item.version} · {new Date(item.savedAt).toLocaleString("zh-CN")}</option>)}</select></label>}
      {reviewSnapshot ? <div className={styles.reviewList}>{reviewSnapshot.summary.map((line, index) => <p key={`${reviewSnapshot.version}-${index}`}><span>{line}</span></p>)}</div> : <>
        {reviewStage === "places" && <div className={styles.reviewList}>{draft.candidates.filter((item) => selectedPlaceIds.includes(item.placeId)).map((item) => <p key={item.id}><strong>{item.name}</strong><span>{item.area} · {item.category} · 停留约 {hoursLabel(item.estimatedMinutes)}</span></p>)}</div>}
        {reviewStage === "day_allocation" && <div className={styles.reviewList}>{daysFor(handoff, draft).map((day) => <p key={day.day}><strong>Day {day.day} · {day.date}</strong><span>{day.orderedCandidateIds.map((id) => { const item = draft.candidates.find((candidate) => candidate.placeId === id); const period = day.periodByCandidateId?.[id]; return `${item?.name || "已移除地点"}${period === "morning" ? "（上午）" : period === "afternoon" ? "（下午）" : ""}`; }).join("、") || "保留休息／自由日"}</span></p>)}</div>}
        {reviewStage === "flights" && <div className={styles.reviewList}><p><strong>航班安排</strong><span>{draft.flightSelection?.mode === "none" ? "已选择无需航班" : draft.flightSelection?.mode === "manual" ? "已手动填写抵离时间" : draft.flightSelection?.mode === "quoted" ? "已选择查询到的往返航班" : "尚未确认"}</span></p></div>}
        {reviewStage === "stays" && <div className={styles.reviewList}>{draft.staySegments?.length ? draft.staySegments.map((item) => <p key={item.id}><strong>{item.area} · Day {item.startDay} 起</strong><span>{item.hotel?.name || "酒店待选择"} · {item.checkInDate} 至 {item.checkOutDate}</span></p>) : <p><strong>住宿</strong><span>没有过夜住宿安排</span></p>}</div>}
        {reviewStage === "route" && <div className={styles.reviewList}>{draft.dayEstimates?.map((item) => <p key={item.day}><strong>Day {item.day} · {item.date}</strong><span>游玩约 {hoursLabel(item.metrics.visitMinutes)} · 交通约 {hoursLabel(item.metrics.travelMinutes)} · 自由余量约 {hoursLabel(item.metrics.freeMinutes)}</span></p>)}</div>}
      </>}
      <p className={styles.warning}>重新编辑将从当前有效规划的这一步继续。{reviewImpact.length ? reviewImpact.join("；") + "。" : "尚未进行的后续步骤会依次开始。"}历史摘要用于回看，不会自动恢复旧版本。</p>
      <div className={styles.reviewActions}><button type="button" className={styles.secondaryAction} onClick={() => setReviewStage(null)}>返回当前阶段</button><button type="button" className={styles.secondaryAction} disabled={busy} onClick={editReviewedStage}>从此步重新编辑</button></div>
    </section>}
    <div hidden={Boolean(reviewStage)}>
    {loading && <div className={styles.stage}><p className={styles.status}>正在恢复本次访问的规划进度…</p></div>}
    {!loading && !draft && <div className={styles.stage}><p className={styles.error} role="alert">{error || "规划状态暂时不可用。"}</p><button type="button" className={styles.secondaryAction} onClick={() => { setLoading(true); setError(""); setReload((value) => value + 1); }}><RotateCcw size={14} />重新读取</button></div>}
    {!loading && draft?.stage === "places" && <PlaceSelectionStage candidates={draft.candidates.map(toPlace)} selectedPlaceIds={localSelection.selectedIds} selectionReason={draft.selectionReason}
      discoveryJob={sceneQuery.paused && draft.sceneDiscoveryJob ? { ...draft.sceneDiscoveryJob, status: "failed", message: "本次结果读取已中断，原任务仍保留。请继续读取，不会重新发送提示词。", canResume: true } : draft.sceneDiscoveryJob} onResumeDiscovery={sceneQuery.resume}
      busy={busy} searchBusy={searchBusy} error={error || localSelection.notice} unconfirmed={localSelection.dirty} hasUnavailableSelection={Boolean(localSelection.unavailableIds.length)} onDiscardUnavailable={localSelection.discardUnavailable} searchMatches={searchMatches} onSearch={(query) => void searchPlaces(query)}
      onAddMatch={(placeId) => {
        if (draft.candidates.some((item) => item.placeId === placeId)) { localSelection.select(placeId); setSearchMatches([]); return; }
        const replaceUnselected = draft.candidates.length >= 40;
        if (replaceUnselected && !window.confirm("候选已达 40 个。是否替换一个未选、未分天的候选并加入此地点？已选地点将保留。")) return;
        setSearchMatches([]); void mutateScenes({ action: "add", placeId, replaceUnselected, preservePlaceIds: localSelection.selectedIds }, "暂时无法加入此地点。");
      }}
      onToggle={localSelection.toggle}
      onConfirm={() => void mutateScenes({ action: "confirm", selectedPlaceIds: localSelection.selectedIds }, "清单尚未确认，请核对后重试。")}
      onGenerate={() => {
        const replaceUnselected = draft.candidates.length >= 40;
        if (replaceUnselected && !window.confirm("是否更新未选推荐？已选及已分天地点会保留，其余候选可能替换。")) return;
        void mutateScenes({ action: "generate", restart: true, replaceUnselected, preservePlaceIds: localSelection.selectedIds }, "地点查询失败，旅行条件和本地选择仍已保留，请重试。");
      }} />}
    {!loading && showBoard && <>
      <PlaceDayStage
        initialDay={boardReturnContext?.day}
        insertionHint={boardReturnContext ? `来自 Day ${boardReturnContext.day}${boardReturnContext.name ? ` · 希望在“${boardReturnContext.name}”${boardReturnContext.anchor?.placement === "before" ? "之前" : "之后"}加入` : " · 请按希望的位置加入"}；可在分天板调整，确认后重新核对路线与时间。` : undefined}
        candidates={draft.candidates.filter((item) => selectedPlaceIds.includes(item.placeId)).map(toPlace)} days={daysFor(handoff, draft, localBoard.assignments)} busy={busy} confirmed={draft.boardConfirmed}
        error={error} onAssign={assign} onPeriod={localBoard.setPeriod} placeTimePreferences={localBoard.preferences} onRemove={remove} unconfirmed={localBoard.dirty} conflict={localBoard.conflict}
        onKeepLocal={() => { localBoard.acceptLatestVersion(); setError(""); }} onUseLatest={() => { if (!localBoard.dirty || window.confirm("载入服务器安排会放弃本地尚未确认的分天调整，是否继续？")) { localBoard.clear(); setError(""); } }}
        onDeleteDay={(day) => void changeDayCount("delete", day)} onUndoDelete={() => void changeDayCount("undo")} canUndoDelete={Boolean(draft.dayDeletionUndo)}
        onBackToSelection={() => void mutateScenes({ action: "reopen" }, "暂时无法返回地点选择。")}
        onConfirm={(restDays) => void postBoard(localBoard.assignments, true, restDays)} />
    </>}
    {!loading && draft?.stage === "flights" && <FlightStage
      startDate={handoff.dates.start} endDate={handoff.dates.end}
      travelers={handoff.travelers}
      initialOrigin={draft.flightQuotes?.originCity || handoff.originCity || ""}
      quotes={draft.flightQuotes || null} job={draft.flightSearchJob} onResume={flightQuery.resume} busy={busy} error={error}
      selectedOutboundId={draft.flightSelection?.outbound?.id} selectedInboundId={draft.flightSelection?.inbound?.id}
      selection={draft.flightSelection}
      onSearch={(query) => void mutateStage("flights", "search", query)}
      onCancelSearch={() => void mutateStage("flights", "reopen")}
      onSelect={(outboundId, inboundId, timeZones) => void mutateStage("flights", "select", { outboundId, inboundId, ...timeZones })}
      onManual={(values) => void mutateStage("flights", "manual", values)} />}
    {!loading && draft?.stage === "stays" && !stayBoundary && <div className={styles.stage}>
      <p className={styles.error} role="alert">{error || "暂时无法确认住宿夜数；请重新读取后继续。"}</p>
      <button type="button" className={styles.secondaryAction} disabled={busy} onClick={() => { setLoading(true); setError(""); setReload((value) => value + 1); }}><RotateCcw size={14} />重新读取住宿信息</button>
    </div>}
    {!loading && draft?.stage === "stays" && stayBoundary && <StayStage
      days={stayBoundary.lastHotelNightDay}
      noOvernight={stayBoundary.nights === 0}
      boundaryNote={stayBoundary.note}
      initialArea={handoff.accommodationPreference?.areaName || draft.candidates[0]?.area || "Singapore"}
      advice={draft.stayAdvice || null} segments={draft.staySegments || []}
      affectedDays={draft.flightSelection?.affectedDays || []} busy={busy} error={error}
      quoteJob={hotelQuery.job} quotePolling={hotelQuery.polling} onResumeQuotes={hotelQuery.resume}
      onAdvise={() => void mutateStage("stays", "advise")}
      onSegments={async (segments) => (await mutateStage("stays", "segments", { segments }))?.saveResult || null}
      onSearchHotels={(startDay) => void mutateStage("stays", "searchHotels", { startDay })}
      onQuoteHotels={(startDay, placeIds) => void mutateStage("stays", "quoteHotels", { startDay, placeIds })}
      onSelectHotel={async (startDay, placeId, budgetAcknowledged) => Boolean((await mutateStage("stays", "selectHotel", { startDay, placeId, budgetAcknowledged }))?.draft)}
      onConfirm={() => void mutateStage("stays", "confirm")}
      onReviewBoard={editDayBoard} />}
    {!loading && draft?.stage === "route" && <ScheduleStage
      days={daysFor(handoff, draft)}
      draftVersion={draft.version}
      estimates={draft.dayEstimates || []} conflicts={draft.scheduleConflicts || []} decisions={draft.freeTimeDecisions || []} busy={busy} error={error}
      overrides={draft.scheduleOverrides} assignments={draft.assignments} candidates={draft.candidates}
      saveFailure={scheduleFailure?.version === draft.version ? scheduleFailure : undefined}
      onDismissSaveFailure={(day) => setScheduleFailure((current) => current?.day === day ? null : current)}
      flightMode={draft.flightSelection?.mode}
      pendingReviews={scheduleReviews} staleScheduleDays={draft.staleScheduleDays} scheduleReady={draft.scheduleReady}
      onCalculate={() => void mutateStage("schedule", "calculate")}
      onUpdateDay={async (overrides) => Boolean((await mutateStage("schedule", "updateDay", { overrides }))?.draft)}
      onSearchBaggagePlaces={async (query, day) => (await mutateStage("schedule", "searchBaggagePlaces", { query, day }))?.matches || []}
      onSearchAttractions={async (query) => { const payload = await mutateStage("schedule", "searchAttractions", { query }); if (!payload) throw new Error("景点查询暂未完成，原搜索和选择已保留，请重试。"); return payload.attractionMatches || []; }}
      onPreviewAttraction={async (attraction) => (await mutateStage("schedule", "previewAttraction", { attraction }))?.attractionPreview || null}
      onConfirmAttraction={async ({ previewFingerprint, preferenceAcknowledged, ...attraction }) => Boolean((await mutateStage("schedule", "addAttraction", { attraction, previewFingerprint, preferenceAcknowledged }))?.draft)}
      onPreviewMoves={async (moves) => (await mutateStage("schedule", "previewMove", { moves }))?.movePreview || null}
      onApplyMoves={async (moves, previewFingerprint, preferenceAcknowledged) => Boolean((await mutateStage("schedule", "applyMove", { moves, previewFingerprint, preferenceAcknowledged }))?.draft)}
      onDecide={(day, decision) => void mutateStage("schedule", "decideFreeTime", { day, decision })}
      onConfirm={() => void mutateStage("schedule", "confirm")}
      onEditFlights={() => { setReviewStage("flights"); setReviewVersion(null); }}
      onEditConditions={onEditConditions}
      onSelectedDayChange={setHelpDay}
      onReviewStage={(stage) => { if (stages.some((item) => item.key === stage)) { setReviewStage(stage as Stage); setReviewVersion(null); } }}
      onReviewBoard={editDayBoard} />}
    {!loading && draft?.stage === "complete" && <div className={styles.stage}>
      <div className={styles.stageHeading}><div><small>05 · MAP</small><h2>准备查看完整地图</h2><p>已确认真实地点、分天、航班、住宿与每日时间。地图将按这些选择生成。</p></div><Sparkles size={24} /></div>
      {pendingReviews.length ? <p className={styles.warning}>仍需复核：{pendingReviews.join("、")}。</p> : null}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {draft.scheduleReady === false && <button type="button" className={styles.secondaryAction} disabled={busy} onClick={() => { setReviewStage("route"); setReviewVersion(null); }}>前往时间核算复核</button>}
      <button type="button" className={styles.primaryAction} disabled={busy || Boolean(pendingReviews.length) || draft.scheduleReady === false} onClick={() => void compileMap()}>{busy ? "正在生成真实地图…" : "生成并查看真实地图"}<ArrowRight size={16} /></button>
    </div>}
    </div>
  </div>;
}
