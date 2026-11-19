"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowRight, Clock3, Route } from "lucide-react";
import type { NextDayDepartureTransfer, TripDay } from "@/lib/travel/types";
import styles from "./planning-journey.module.css";
import layout from "./schedule-stage.module.css";
import board from "./place-day-stage.module.css";
import { dailyTransportSummary, type DailyTransport, type DailyAdvice, type PlanningFreeWindow } from "@/lib/travel/planning-schedule-policy";
import type { PlanningBaggageSummary } from "@/lib/travel/planning-baggage";
import { durationTextInHours, hoursLabel, type RecommendedDuration } from "@/lib/travel/planning-duration";
import { ScheduleTimeEditor } from "./schedule-time-editor";
import type { PlanningTimeOverride, PlanningLocalBlock } from "@/lib/travel/planning-time-overrides";
import type { AttractionSearchActions } from "./schedule-attraction-search";
import type { PlanningScheduleConflict, ScheduleMoveBatchPreview, ScheduleMoveRequest } from "@/lib/travel/planning-conflicts";
import { ScheduleConflictCard, ScheduleMoveBatch, type ScheduleConflictActions } from "./schedule-conflict-card";
import type { PlanningDayJourney } from "@/lib/travel/planning-trip";
import { ScheduleDayRecovery, type RecoveryPlace } from "./schedule-day-recovery";
import { ScheduleSaveFeedback, type ScheduleSaveFailure } from "./schedule-save-feedback";
import type { BoardAssignment } from "@/lib/travel/planning-day-board";

export type DayEstimate = {
  day: number;
  date: string;
  sceneIds: string[];
  dailyWindow?: { start: string; preferredReturn: string; latestReturn: string; returnConstraint?: { strength: "soft" | "hard"; source: "user" | "legacy"; evidence?: string } };
  effectiveWindow?: { start: string; returnBy: string };
  journey?: PlanningDayJourney;
  scheduledDay?: TripDay;
  overrides?: PlanningTimeOverride;
  scenes?: Array<{
    candidateId: string;
    name: string;
    period: "morning" | "afternoon" | "evening";
    preferredPeriod: "morning" | "afternoon" | "flexible";
    regularOpeningHours: string | null;
    recommendedMinutes?: number;
    recommendedDuration?: RecommendedDuration;
    selectedVisitMinutes?: number;
    durationReason?: string;
    sceneRole?: "culinary_area" | "restaurant_meal" | "attraction";
    includedMealMinutes?: number;
  }>;
  metrics: {
    visitMinutes: number;
    foodMinutes: number;
    mealReserveMinutes: number;
    bufferMinutes: number;
    openingWaitMinutes?: number;
    travelMinutes: number;
    pickupMinutes: number;
    freeMinutes: number;
    overtimeMinutes: number;
    actualReturnTime: string;
    requestedReturnTime: string;
    terminalKind: "hotel" | "airport";
    startTime?: string;
    personalMinutes?: number;
    logisticsMinutes?: number;
    referenceTravelMinutes?: number;
    travelSource?: "google" | "user";
    periodFreeMinutes?: number;
    requestedMealReserveMinutes?: number;
    preferredReturnTime?: string;
    softOverrunMinutes?: number;
  };
  computedAt: string;
  notes: string[];
  inputFingerprint?: string;
  transport?: DailyTransport;
  advice?: DailyAdvice;
  freeWindows?: PlanningFreeWindow[];
  baggage?: PlanningBaggageSummary;
  localBlocks?: PlanningLocalBlock[];
  scheduledLocalBlocks?: Array<PlanningLocalBlock & { startTime: string; endTime: string }>;
  nextDayDepartureTransfer?: NextDayDepartureTransfer;
};

export type FreeTimeDecision = { day: number; decision: "keep" | "add"; source?: "default_policy" | "user"; estimateFingerprint?: string };

export type SchedulePendingReview = { kind: string; message: string; targetStage: string; day?: number };
export type { ScheduleSaveFailure } from "./schedule-save-feedback";

type BoardReturnContext = { day: number; anchor?: { nodeId: string; placement: "before" | "after" } };
type MoveDescription = ScheduleMoveBatchPreview["moves"][number];

type Props = ScheduleConflictActions & AttractionSearchActions & {
  days: Array<{ day: number; date: string }>;
  estimates: DayEstimate[];
  decisions: FreeTimeDecision[];
  busy: boolean;
  error?: string;
  conflicts?: PlanningScheduleConflict[];
  overrides?: PlanningTimeOverride[];
  assignments?: BoardAssignment[];
  candidates?: Array<RecoveryPlace & { id: string }>;
  saveFailure?: ScheduleSaveFailure;
  onDismissSaveFailure?: (day: number) => void;
  flightMode?: "quoted" | "manual" | "none";
  pendingReviews?: SchedulePendingReview[];
  staleScheduleDays?: number[];
  scheduleReady?: boolean;
  draftVersion?: number;
  onCalculate: () => void;
  onDecide: (day: number, decision: "keep" | "add") => void;
  onConfirm: () => void;
  onReviewBoard: (context?: BoardReturnContext, pendingMoves?: boolean) => void;
  onEditFlights?: () => void;
  onEditConditions?: () => void;
  onSelectedDayChange?: (day: number, options: { locked: boolean; hasFailure: boolean }) => void;
  onReviewStage?: (stage: string) => void;
  onUpdateDay: (value: PlanningTimeOverride) => Promise<boolean>;
  onPreviewMoves?: (moves: ScheduleMoveRequest[]) => Promise<ScheduleMoveBatchPreview | null>;
  onApplyMoves?: (moves: ScheduleMoveRequest[], previewFingerprint: string, preferenceAcknowledged: boolean) => Promise<boolean>;
  onSearchBaggagePlaces?: (query: string, day: number) => Promise<Array<{ placeId: string; name: string; address: string }>>;
};

function DailyPanel({ day, status, children, summary }: { day: number; status: string; children: ReactNode; summary: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return <div className={layout.panel}>
    <div className={layout.edit}>{children}</div>
    <details className={layout.summary} aria-label={`Day ${day} 本日总结`} open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className={layout.summaryToggle}><strong>本日总结</strong><span>{status} · {expanded ? "收起明细" : "查看体验、交通与余量"}</span></summary>
      <div className={layout.summaryBody}>{summary}</div>
    </details>
  </div>;
}

function moveRequests(moves: MoveDescription[]): ScheduleMoveRequest[] {
  return moves.map(({ day, placeId, targetDay, targetPeriod }) => ({ day, placeId, targetDay, ...(targetPeriod ? { targetPeriod } : {}) }));
}

export function ScheduleStage({ days, estimates, busy, error, conflicts = [], overrides = [], assignments = [], candidates = [], saveFailure, onDismissSaveFailure, flightMode, pendingReviews = [], staleScheduleDays = [], scheduleReady, draftVersion, onCalculate, onDecide, onConfirm, onReviewBoard, onReviewStage, onEditFlights, onEditConditions, onSelectedDayChange, onUpdateDay, onPreviewMove, onApplyMove, onPreviewMoves, onApplyMoves, onSearchAttractions, onPreviewAttraction, onConfirmAttraction }: Props) {
  const panelId = useId();
  const tabButtons = useRef<Record<string, HTMLButtonElement | null>>({});
  const [selectedDate, setSelectedDate] = useState<string>();
  const [dirtyEdits, setDirtyEdits] = useState(() => new Set<string>());
  const [saveOrigins, setSaveOrigins] = useState<Record<string, string>>({});
  const [moves, setMoves] = useState<MoveDescription[]>([]);
  const [originalMoveConflicts, setOriginalMoveConflicts] = useState<PlanningScheduleConflict[]>([]);
  const [movePreview, setMovePreview] = useState<ScheduleMoveBatchPreview | null>(null);
  const [movePending, setMovePending] = useState<"preview" | "apply" | null>(null);
  const [moveError, setMoveError] = useState("");
  const moveRequestActive = useRef(false);
  const moveHeading = useRef<HTMLHeadingElement>(null);
  const hasMoveDraft = moves.length > 0;
  const staleMovePreview = movePreview !== null && draftVersion !== undefined && movePreview.draftVersion !== draftVersion;
  const currentMovePreview = staleMovePreview ? null : movePreview;
  const affectedMoveDays = new Set(moves.flatMap((move) => [move.day, move.targetDay]));
  const moveBatchEnabled = !!onPreviewMoves && !!onApplyMoves;
  useEffect(() => {
    if (hasMoveDraft) moveHeading.current?.focus();
  }, [hasMoveDraft]);
  const lastDay = days.at(-1)?.day;
  const dayStates = days.map(({ day, date }) => {
    const estimate = estimates.find((item) => item.day === day && item.date === date);
    const needsFlightRefresh = Boolean(
      estimate && flightMode && flightMode !== "none" && (day === 1 || day === lastDay) && !estimate.journey,
    );
    const legacyTravel = estimate?.metrics.travelSource === "user" || estimate?.transport?.source === "user";
    const stale = Boolean(estimate && (!estimate.scheduledDay || estimate.transport?.status !== "complete")) || staleScheduleDays.includes(day) || legacyTravel;
    const dayConflicts = conflicts.filter((item) => item.day === day && item.date === date).map((conflict) => ({
      conflict,
      key: `conflict:${date}:${conflict.placeId || conflict.code}:${conflict.draftVersion}`,
    }));
    const timeEditKey = `time:${date}`;
    const failure = saveFailure?.day === day ? saveFailure : undefined;
    const saved = overrides.find((item) => item.day === day);
    const recovery = ((!estimate || needsFlightRefresh) && Boolean(dayConflicts.length || failure || saved))
      || Boolean(stale && saved && dayConflicts.length);
    const dirty = Boolean(((estimate && !needsFlightRefresh) || recovery) && dirtyEdits.has(timeEditKey));
    const unsaved = dirty || dayConflicts.some(({ key }) => dirtyEdits.has(key));
    let status = "已核算";
    if (unsaved) status = "待保存";
    else if (dayConflicts.length || failure) status = "有冲突";
    else if (!estimate || needsFlightRefresh || stale) status = "待核算";
    else if (estimate.metrics.overtimeMinutes > 0) status = "超过截止";
    return {
      day, date, estimate, needsFlightRefresh, stale, legacyTravel, dayConflicts, failure, saved, recovery, timeEditKey, dirty, unsaved, status,
    };
  });
  // Inputs for dates removed from the plan have unmounted. Drop their dirty flags too.
  const currentEditKeys = new Set(dayStates.flatMap(({ estimate, needsFlightRefresh, recovery, timeEditKey, dayConflicts }) => [
    ...(estimate && !needsFlightRefresh || recovery ? [timeEditKey] : []),
    ...dayConflicts.map(({ key }) => key),
  ]));
  if ([...dirtyEdits].some((key) => !currentEditKeys.has(key))) {
    setDirtyEdits(new Set([...dirtyEdits].filter((key) => currentEditKeys.has(key))));
  }
  const activeDay = dayStates.find(({ date }) => date === selectedDate)
    || dayStates.find(({ dayConflicts, failure }) => dayConflicts.length > 0 || failure)
    || dayStates.find(({ estimate, needsFlightRefresh }) => !estimate || needsFlightRefresh)
    || dayStates[0];
  const activeDayNumber = activeDay?.day;
  const activeDayLocked = Boolean(activeDay?.estimate?.journey || (flightMode && flightMode !== "none" && (activeDayNumber === 1 || activeDayNumber === lastDay)));
  const activeDayHasFailure = Boolean(activeDay && (activeDay.failure || activeDay.dayConflicts.length || (activeDay.estimate?.metrics.overtimeMinutes ?? 0) > 0));
  useEffect(() => {
    if (activeDayNumber !== undefined) onSelectedDayChange?.(activeDayNumber, { locked: activeDayLocked, hasFailure: activeDayHasFailure });
  }, [activeDayNumber, activeDayLocked, activeDayHasFailure, onSelectedDayChange]);
  const unsaved = dayStates.some((item) => item.unsaved);
  const hasResults = dayStates.some(({ estimate }) => Boolean(estimate));
  const pendingDays = dayStates.filter(({ estimate, needsFlightRefresh, stale }) => !estimate || needsFlightRefresh || stale);
  const staleEstimateDays = dayStates.filter(({ estimate, needsFlightRefresh, stale, dayConflicts, failure }) => !estimate || needsFlightRefresh || stale || dayConflicts.length || failure).map(({ day }) => day);
  const overtime = dayStates.filter(({ estimate }) => (estimate?.metrics.overtimeMinutes || 0) > 0);
  const readyDays = dayStates.filter((item) => item.status === "已核算").length;
  const nextDay = dayStates[dayStates.findIndex(({ date }) => date === activeDay?.date) + 1];
  const canConfirm = scheduleReady !== false && !busy && !unsaved && !hasMoveDraft && !pendingDays.length && !overtime.length && !conflicts.length && !pendingReviews.length && readyDays === days.length;

  function candidateFor(placeId?: string) {
    return candidates.find((candidate) => candidate.id === placeId || candidate.placeId === placeId);
  }

  function conflictName(conflict: PlanningScheduleConflict) {
    return conflict.placeName || candidateFor(conflict.placeId)?.name || moves.find((move) => move.placeId === conflict.placeId)?.placeName || "当天安排";
  }

  async function checkMoveDraft(nextMoves: MoveDescription[]) {
    if (!onPreviewMoves || moveRequestActive.current || busy || unsaved) return;
    if (nextMoves.length && !hasMoveDraft) setOriginalMoveConflicts(conflicts);
    setMoves(nextMoves);
    setMovePreview(null);
    setMoveError("");
    if (!nextMoves.length) return;
    moveRequestActive.current = true;
    setMovePending("preview");
    try {
      const result = await onPreviewMoves(moveRequests(nextMoves));
      if (result) {
        setMoves(result.moves);
        setMovePreview(result);
      } else setMoveError("暂时无法核对，待确认调整已保留。请重试。");
    } catch {
      setMoveError("暂时无法核对，待确认调整已保留。请重试。");
    } finally {
      moveRequestActive.current = false;
      setMovePending(null);
    }
  }

  function stageMove(input: ScheduleMoveRequest, conflict?: PlanningScheduleConflict) {
    const candidate = candidateFor(input.placeId);
    const placeId = candidate?.placeId || input.placeId;
    const existing = moves.find((item) => item.placeId === placeId);
    const source = assignments.find((assignment) => assignment.orderedCandidateIds.some((id) => id === placeId || id === candidate?.id));
    const sourceId = source?.orderedCandidateIds.find((id) => id === placeId || id === candidate?.id);
    const day = existing?.day ?? source?.day ?? input.day;
    const fromPeriod = existing?.fromPeriod || (sourceId ? source?.periodByCandidateId?.[sourceId] : undefined) || conflict?.window?.effectivePeriod || "flexible";
    const targetPeriod = input.targetPeriod === fromPeriod ? undefined : input.targetPeriod;
    if (day === input.targetDay && !targetPeriod) {
      if (existing) void checkMoveDraft(moves.filter((item) => item !== existing));
      else setMoveError("这个地点已在所选日期和时段，请另选。");
      return;
    }
    const next: MoveDescription = {
      day, placeId, targetDay: input.targetDay,
      ...(targetPeriod ? { targetPeriod } : {}),
      fromPeriod, placeName: existing?.placeName || conflict?.placeName || candidate?.name || "待调整地点",
    };
    void checkMoveDraft(existing ? moves.map((item) => item === existing ? next : item) : [...moves, next]);
  }

  async function applyMoveDraft(acknowledged: boolean) {
    if (!onApplyMoves || moveRequestActive.current || busy || unsaved || !currentMovePreview?.feasible ||
      currentMovePreview.requiresAcknowledgement && !acknowledged) return;
    moveRequestActive.current = true;
    setMovePending("apply");
    setMoveError("");
    try {
      if (await onApplyMoves(moveRequests(moves), currentMovePreview.fingerprint, acknowledged)) {
        setMoves([]);
      } else setMoveError("未能保存全部调整，待确认选择已保留。请重新核对。");
    } catch {
      setMoveError("未能保存全部调整，待确认选择已保留。请重新核对。");
    } finally {
      setMovePreview(null);
      moveRequestActive.current = false;
      setMovePending(null);
    }
  }

  function cancelMoveDraft() {
    if (moveRequestActive.current) return;
    setMoves([]);
    setMovePreview(null);
    setMoveError("");
    if (activeDay) tabButtons.current[activeDay.date]?.focus();
  }

  function reviewBoard(context?: BoardReturnContext) {
    onReviewBoard(context, hasMoveDraft || undefined);
  }

  function selectDate(date: string) {
    setSelectedDate(date);
    tabButtons.current[date]?.focus();
  }

  function openReview(item: SchedulePendingReview) {
    if (item.day && item.targetStage === "route") {
      const date = days.find((value) => value.day === item.day)?.date;
      if (date) selectDate(date);
    } else if (item.targetStage === "day_allocation" || item.targetStage === "places") reviewBoard();
    else if (item.targetStage === "flights") onEditFlights?.();
    else if (item.targetStage === "conditions") onEditConditions?.();
    else onReviewStage?.(item.targetStage);
  }

  function markDirty(key: string, date: string, dirty: boolean) {
    if (dirty) setSelectedDate(date);
    setDirtyEdits((current) => {
      const next = new Set(current);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function navigateDays(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number;
    switch (event.key) {
      case "ArrowLeft": nextIndex = (index + dayStates.length - 1) % dayStates.length; break;
      case "ArrowRight": nextIndex = (index + 1) % dayStates.length; break;
      case "Home": nextIndex = 0; break;
      case "End": nextIndex = dayStates.length - 1; break;
      default: return;
    }
    event.preventDefault();
    const nextDate = dayStates[nextIndex].date;
    setSelectedDate(nextDate);
    tabButtons.current[nextDate]?.focus();
  }

  function recheckDay(day: number, date: string) {
    setSelectedDate(date);
    void saveDay(date, "recheck", { day });
  }

  function saveDay(date: string, origin: string, value: PlanningTimeOverride) {
    setSaveOrigins((current) => ({ ...current, [date]: origin }));
    return onUpdateDay(value);
  }

  function markTimeDirty(day: number, key: string, date: string, dirty: boolean) {
    markDirty(key, date, dirty);
    if (!dirty) onDismissSaveFailure?.(day);
  }

  return <section className={styles.stage} aria-label="每日路线与时间核算">
    <div className={styles.stageHeading}><div><small>04 · ROUTE & TIME</small><h2>按天核对行程时间</h2><p>选择日期后调整当天的上午和下午安排，保存后核对本日总结。</p></div>
      <Route size={25} />
    </div>
    <nav className={board.dayNav} role="tablist" aria-label="选择要核对的旅行日">
      {dayStates.map((item, index) => (
        <button key={item.date} type="button" role="tab" id={`${panelId}-tab-${item.date}`}
          aria-selected={item.date === activeDay?.date} aria-controls={`${panelId}-day-${item.date}`}
          tabIndex={item.date === activeDay?.date ? 0 : -1}
          ref={(button) => { tabButtons.current[item.date] = button; }}
          onClick={() => setSelectedDate(item.date)} onKeyDown={(event) => navigateDays(event, index)}>
          <span>DAY {String(item.day).padStart(2, "0")}</span>
          <strong>{item.date.slice(5).replace("-", "/")}</strong>
          <small>{item.status}</small>
        </button>
      ))}
    </nav>
    {hasMoveDraft && <ScheduleMoveBatch days={days} moves={moves}
      originals={originalMoveConflicts.filter((conflict) => affectedMoveDays.has(conflict.day))}
      preview={currentMovePreview} pending={movePending} busy={busy} blocked={unsaved} stale={staleMovePreview} error={moveError}
      nameOf={conflictName} onMove={stageMove} onRemove={(placeId) => void checkMoveDraft(moves.filter((item) => item.placeId !== placeId))}
      onRetry={() => void checkMoveDraft(moves)} onApply={(acknowledged) => void applyMoveDraft(acknowledged)}
      onCancel={cancelMoveDraft} onReviewBoard={() => reviewBoard()} headingRef={moveHeading} />}
    {!hasMoveDraft && moveError && <p className={styles.error} role="alert">{moveError}</p>}
    {dayStates.map(({ day, date, estimate, needsFlightRefresh, stale, legacyTravel, dayConflicts, failure, saved, recovery, timeEditKey, dirty }) => {
      const departureTransfer = day === lastDay ? estimate?.nextDayDepartureTransfer : undefined;
      const metrics = estimate?.metrics;
      const terminalText = metrics?.terminalKind === "airport" ? "到达机场" : "返店";
      const failureOrigin = saveOrigins[date];
      const conflictOwnsFailure = failureOrigin && dayConflicts.some(({ key }) => key === failureOrigin);
      const recheckFailure = stale && !recovery && failureOrigin === "recheck" ? failure : undefined;
      const editorFailure = conflictOwnsFailure || recheckFailure ? undefined : failure;
      const dismissFailure = onDismissSaveFailure ? () => onDismissSaveFailure(day) : undefined;
      const recoveryPlaces = recovery ? (assignments.find((assignment) => assignment.day === day)?.orderedCandidateIds || [])
        .flatMap((id) => candidates.find((candidate) => candidate.id === id || candidate.placeId === id) || []) : [];
      return <div key={date} id={`${panelId}-day-${date}`} role="tabpanel"
        aria-labelledby={`${panelId}-tab-${date}`} hidden={date !== activeDay?.date}>
        <div className={styles.scheduleList}>
          {!affectedMoveDays.has(day) && dayConflicts.map(({ conflict, key }) => (
            <ScheduleConflictCard key={key} conflict={conflict} busy={busy || Boolean(movePending)} blockPlanChanges={unsaved}
              blockDurationEdit={hasMoveDraft}
              onSave={(value) => saveDay(date, key, value)} saveFailure={failureOrigin === key ? failure : undefined} previousResult={Boolean(failure)}
              onReviewBoard={reviewBoard} onStageMove={moveBatchEnabled ? stageMove : undefined} travelDays={days} onPreviewMove={onPreviewMove} onApplyMove={onApplyMove}
              onDismissSaveFailure={dismissFailure}
              onDirtyChange={(isDirty) => markDirty(key, date, isDirty)} />
          ))}
          {recovery && (!estimate || needsFlightRefresh) && <div className={layout.panel}>
            <ScheduleDayRecovery day={day} saved={saved} places={recoveryPlaces} busy={busy || hasMoveDraft}
              onSave={(value) => saveDay(date, "editor", value)} saveFailure={editorFailure} onDismissSaveFailure={dismissFailure}
              onDirtyChange={(isDirty) => markTimeDirty(day, timeEditKey, date, isDirty)} />
          </div>}
          {!estimate && !dayConflicts.length && !recovery && <article className={layout.day}>
            <div className={layout.dayHeading}><strong>DAY {String(day).padStart(2, "0")} · {date}</strong><small>待核算</small></div>
            <div className={layout.refreshFlight}><p>核对当天的地点开放时间、交通和余量后，即可调整安排。</p>
              <button type="button" className={styles.secondaryAction} disabled={busy || hasMoveDraft} onClick={() => recheckDay(day, date)}>核对本日开放时间与交通余量</button>
            </div>
          </article>}
          {estimate && needsFlightRefresh && !recovery && <article className={layout.day}>
            <div className={layout.dayHeading}><strong>DAY {String(day).padStart(2, "0")} · {date}</strong><small>旧核算需按当前航班更新</small></div>
            <div className={layout.refreshFlight}><p>旧结果尚未包含完整航旅时间轴，请按当前已保存的航班、住宿与活动重新核算，再调整本日活动。原有选择仍保留。</p>
              <button type="button" className={styles.secondaryAction} disabled={busy || hasMoveDraft} onClick={() => recheckDay(day, date)}>按当前航班重新核算本日</button>
            </div>
          </article>}
          {estimate && metrics && !needsFlightRefresh && <article className={layout.day}>
            <div className={layout.dayHeading}><div><strong>DAY {String(estimate.day).padStart(2, "0")} · {estimate.date}</strong><small>{estimate.sceneIds.length} 个已选地点</small></div><span className={metrics.overtimeMinutes > 0 ? styles.overtime : ""}>{dirty ? "待保存" : metrics.overtimeMinutes > 0 ? "待调整" : failure || stale || dayConflicts.length ? "上次核算供参考" : `预计可在截止前${terminalText}`}</span></div>
            {dirty && <p className={layout.pending} role="status">本日有未保存修改。时间轴和总结仍以上次核算为参考；保存后更新。</p>}
            {busy && <p className={layout.pending} role="status">正在处理，核算完成后更新结果。</p>}
            {stale && <div className={layout.pending}><p>{legacyTravel ? "旧结果含手动交通总时长；请按 Google 路线重新核算本日。" : "当前安排已有变化，原结果需重新核算。"}</p><button type="button" className={styles.secondaryAction} disabled={busy || unsaved || hasMoveDraft} onClick={() => recheckDay(day, date)}>重新核算本日</button>{recheckFailure && <ScheduleSaveFeedback failure={recheckFailure} />}</div>}
            {Boolean(metrics.softOverrunMinutes) && !metrics.overtimeMinutes && <p className={layout.pending}>预计比希望结束时间晚约 {hoursLabel(metrics.softOverrunMinutes || 0)}，可调整地点停留或安排。</p>}
            <DailyPanel day={estimate.day} status={dirty ? "待保存" : metrics.overtimeMinutes > 0 || failure || dayConflicts.length ? "待调整" : stale ? "待核算" : busy ? "核算中" : "已核算"} summary={<>
              <div className={layout.summaryHeading}><h3>核算明细</h3><span>{dirty || stale || failure || dayConflicts.length ? "上次核算结果" : metrics.overtimeMinutes > 0 ? "当前安排待调整" : estimate.overrides ? "设置已保存 · 当前核算" : "初始核算结果"}</span></div>
              <dl className={layout.metrics}>
                <div><dt>已选地点与体验</dt><dd>约 {hoursLabel(metrics.visitMinutes + metrics.foodMinutes)}</dd></div>
                <div><dt>用户安排的吃饭与其他活动</dt><dd>约 {hoursLabel((estimate.localBlocks || []).reduce((sum, block) => sum + block.durationMinutes, 0))}</dd></div>
                <div><dt>当地地面交通</dt><dd>{legacyTravel ? "待重新核算" : dailyTransportSummary(estimate.transport)}</dd><details className={layout.transportDetails}><summary>路段范围与来源</summary><small>{!legacyTravel && estimate.transport?.airportMinutes ? `包含本日机场接驳、酒店及地点之间的适用路段，其中机场接驳约 ${hoursLabel(estimate.transport.airportMinutes)}，已计入上述总量。` : estimate.transport?.includesHotelReturn ? "包含酒店出发、地点之间及返回当晚酒店的完整地面路线；换住日返回新酒店。" : "包含适用的地面路段，具体起终点见本日时间轴。"}</small><small>{legacyTravel ? `上次核算采用手动时长约 ${hoursLabel(metrics.travelMinutes)}，仅供参考。` : "采用 Google 路线参考；实际交通请以出行时情况为准。"}{!legacyTravel && metrics.pickupMinutes > 0 ? `其中接车预留约 ${hoursLabel(metrics.pickupMinutes)}，是行程附加估算，独立于 Google 路线数据。` : ""}所有地面路段仅计一次，航班另列。</small></details></div>
                {estimate.journey && <div className={layout.transportLedger}><dt>航旅交通总量</dt><dd>{legacyTravel ? "待重新核算" : estimate.journey.totalTransportMinutes === null ? "待补充航班时刻或时区" : `约 ${hoursLabel(estimate.journey.totalTransportMinutes)}`}</dd><small>航班行程 {estimate.journey.flightMinutes === null ? "待补充" : hoursLabel(estimate.journey.flightMinutes)} ＋ 地面交通 {legacyTravel ? "待重新核算" : hoursLabel(estimate.journey.groundMinutes)}{!legacyTravel && estimate.journey.nextDayGroundMinutes > 0 ? `（含次日机场接驳 ${hoursLabel(estimate.journey.nextDayGroundMinutes)}）` : ""}。</small><small>{estimate.journey.airportProcessMinutes > 0 ? `入境与行李另预留约 ${hoursLabel(estimate.journey.airportProcessMinutes)}；` : ""}机场办理／候机建议预留约 {hoursLabel(estimate.journey.airportPreparationMinutes)}，独立于交通合计，不重复扣当地余量。</small></div>}
                {Boolean(metrics.openingWaitMinutes) && <div><dt>场馆开放前等待</dt><dd>约 {hoursLabel(metrics.openingWaitMinutes || 0)}</dd><small>按实际开放窗口核对，只计一次。</small></div>}
              </dl>
              {metrics.overtimeMinutes > 0 && <div className={layout.balance}><small>预计超出</small><strong>约 {hoursLabel(metrics.overtimeMinutes)}</strong></div>}
              <p className={layout.note}><Clock3 size={13} />{metrics.terminalKind === "airport" ? `到达机场截止 ${metrics.requestedReturnTime}，最后景点还需提前留出赴机场交通` : estimate.dailyWindow?.returnConstraint?.strength === "soft" ? `希望约 ${metrics.preferredReturnTime || estimate.dailyWindow.latestReturn} 结束；当天可达性边界 ${metrics.requestedReturnTime}` : `返店截止 ${metrics.requestedReturnTime}`}。</p>
              {dirty || stale || busy || failure || dayConflicts.length > 0 || metrics.overtimeMinutes > 0 ? <p className={layout.pending} role="status">{busy ? "正在核算，完成后更新节奏建议。" : "保存并核算本日后更新节奏建议；上次余量不作为当前加点依据。"}</p> : estimate.advice?.version === 2 ? <div className={layout.advice}><strong>本日节奏建议</strong><p>{estimate.advice.summary}</p><p>{estimate.advice.adjustment.reason}</p><small>基于当前核算的规则建议；保留你的自由安排，不自动添加地点。</small></div> : <p className={layout.note}>本日节奏建议已更新，请重新核算本日后查看。</p>}
              {!dirty && !stale && !busy && !failure && !dayConflicts.length && !metrics.overtimeMinutes && estimate.advice?.version === 2 && estimate.advice.canSuggestAddition === true && <div className={layout.decision}>
                <p>自由时间在本日安排中统一分配，未分配部分默认保留。</p>
                <span>使用上方工具区选择分天板或搜索景点。</span>
              </div>}
              <p className={layout.note}>时长为近似显示，合计按原始精度核算。常规开放信息请出发前复核。</p>
              {Boolean(estimate.notes?.length) && <div className={layout.notes}><small>核算说明</small>{estimate.notes.map((note) => <p key={note}>{durationTextInHours(note)}</p>)}</div>}
            </>}>
              {recovery ? <ScheduleDayRecovery day={day} saved={saved} places={recoveryPlaces} busy={busy || hasMoveDraft}
                onSave={(value) => saveDay(date, "editor", value)} saveFailure={editorFailure} onDismissSaveFailure={dismissFailure}
                onDirtyChange={(isDirty) => markTimeDirty(day, timeEditKey, date, isDirty)} />
                : <ScheduleTimeEditor estimate={estimate} estimates={estimates} days={days} staleEstimateDays={staleEstimateDays} estimateStale={stale || Boolean(failure || dayConflicts.length)} busy={busy || hasMoveDraft} blockPlanChanges={unsaved}
                  onSave={(value) => saveDay(date, "editor", value)} saveFailure={editorFailure} onDismissSaveFailure={dismissFailure}
                  onReviewBoard={reviewBoard} onSearchAttractions={onSearchAttractions} onPreviewAttraction={onPreviewAttraction} onConfirmAttraction={onConfirmAttraction}
                  onEditFlights={onEditFlights} onDirtyChange={(_, isDirty) => markTimeDirty(day, timeEditKey, date, isDirty)} />}
            </DailyPanel>
          </article>}
          {departureTransfer && <article className={styles.scheduleDay} aria-label="次日离境机场交通">
            <div className={styles.segmentHeading}><div><strong>次日离境 · {departureTransfer.date}</strong><small>单独安排的酒店 → 机场交通</small></div><span>航班 {departureTransfer.departureAt.slice(11)}</span></div>
            <p>从 {departureTransfer.fromHotel.name} 前往 {departureTransfer.toAirport.name}。预计 {departureTransfer.leaveHotelAt.replace("T", " ")} 离店，{departureTransfer.arriveAirportAt.replace("T", " ")} 抵达机场。</p>
            <div className={styles.metricGrid}><div><small>机场交通</small><strong>约 {hoursLabel(departureTransfer.leg.minutes)}</strong></div><div><small>路程</small><strong>{departureTransfer.leg.distance}</strong></div><div><small>值机与安检预留</small><strong>约 {hoursLabel(departureTransfer.airportLeadMinutes)}</strong></div></div>
            <p className={styles.sourceNote}>{durationTextInHours(departureTransfer.note)}</p>
          </article>}
        </div>
      </div>;
    })}
    {hasResults && <>
      <p className={styles.sourceNote}>上午／下午为建议时段。纯时间调整保留航班和酒店；营业窗口、机场边界和最晚返店仍需满足。</p>
      <section className={layout.readiness} aria-label="全程核算进度">
        <strong>全程已核算 {readyDays}/{days.length} 天</strong>
        {dayStates.filter((item) => item.status !== "已核算").map((item) => <button type="button" key={item.date} onClick={() => selectDate(item.date)}>Day {item.day} · {item.status}</button>)}
        {pendingReviews.map((item, index) => <div key={`${item.kind}:${item.day || "all"}:${index}`}><span>{item.message}</span><button type="button" disabled={busy} onClick={() => openReview(item)}>前往核对</button></div>)}
      </section>
      {nextDay ? <><button type="button" className={styles.primaryAction} disabled={busy} onClick={() => selectDate(nextDay.date)}>查看下一天 · Day {nextDay.day}<ArrowRight size={16} /></button>{unsaved && <p className={layout.note}>尚未保存的输入会保留；切换日期不会自动提交，全程确认前需要保存并核算。</p>}</> : <button type="button" className={styles.primaryAction} disabled={!canConfirm} onClick={onConfirm}>确认全程并准备地图<ArrowRight size={16} /></button>}
    </>}
    {conflicts.length > 0 && <p className={styles.warning}>请先打开有冲突的旅行日，解决冲突后再确认全程。</p>}
    {unsaved && <p className={styles.warning}>{dayStates.filter((item) => item.unsaved).map(({ day }) => `Day ${day}`).join("、")} 的修改尚未保存。请返回对应日期保存或放弃。</p>}
    {overtime.length > 0 && <p className={styles.warning}>{overtime.map(({ day }) => `Day ${day}`).join("、")} 需要先解决超时。</p>}
    <button type="button" className={styles.secondaryAction} disabled={busy || unsaved || hasMoveDraft} onClick={onCalculate}>{hasResults ? "重新核对当前全部行程" : "核对全部旅行日的开放时间与交通余量"}</button>
    <button type="button" className={styles.secondaryAction} disabled={busy || unsaved || Boolean(movePending)} onClick={() => reviewBoard()}>返回分天板调整地点</button>
    {error && <p className={styles.error} role="alert">{durationTextInHours(error)}</p>}
  </section>;
}
