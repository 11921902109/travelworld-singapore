"use client";

import { useState, type ReactNode, type RefObject } from "react";
import { ArrowRight } from "lucide-react";
import { conflictPresentation, periodLabel, readableMinutes, suggestedPeriodAdjustment, type PlanningScheduleConflict, type ScheduleMoveBatchPreview, type ScheduleMovePreview, type ScheduleMoveRequest } from "@/lib/travel/planning-conflicts";
import type { PlanningTimeOverride } from "@/lib/travel/planning-time-overrides";
import { ScheduleSaveFeedback, type ScheduleSaveFailure } from "./schedule-save-feedback";
import styles from "./planning-journey.module.css";
import layout from "./schedule-conflict-card.module.css";

export type ScheduleConflictActions = {
  onPreviewMove?: (input: ScheduleMoveRequest) => Promise<ScheduleMovePreview | null>;
  onApplyMove?: (input: ScheduleMoveRequest & { previewFingerprint: string }) => Promise<boolean>;
};

type TravelDay = { day: number; date: string };
type MovePeriod = NonNullable<ScheduleMoveRequest["targetPeriod"]>;
type MoveDescription = ScheduleMoveBatchPreview["moves"][number];

function ConflictEvidence({ conflict }: { conflict: PlanningScheduleConflict }) {
  return <><ol className={layout.steps}>
    {conflictPresentation(conflict).steps.map((step) => <li key={step.title}><strong>{step.title}</strong><p>{step.detail}</p></li>)}
  </ol><small>开放为常规信息，出发前请复核特殊日期；预留和交通均为估算。展示取近似值，后台按原始分钟核算，每项只计一次。</small></>;
}

function PreviewDays({ days, conflicts, estimates, nameOf, actions, showUnverified = false }: {
  days: number[];
  conflicts: PlanningScheduleConflict[];
  estimates: ScheduleMovePreview["days"];
  nameOf: (conflict: PlanningScheduleConflict) => string;
  actions?: (conflict: PlanningScheduleConflict) => ReactNode;
  showUnverified?: boolean;
}) {
  return <ul className={layout.previewDays}>
    {days.map((day) => {
      const issues = conflicts.filter((item) => item.day === day);
      const estimate = estimates.find((item) => item.day === day);
      const passed = Boolean(estimate) && issues.length === 0;
      const needsVerification = showUnverified && (!issues.length || issues.every((item) => unverifiedConflict(item.code)));
      const status = passed ? "已通过" : needsVerification ? "待核实" : issues.length ? "仍需调整" : "尚无核算结果";
      return <li key={day}>
        <strong className={passed ? layout.previewPassed : undefined}>Day {day} · {status}</strong>
        {issues.map((item, index) => <div key={`${item.placeId || item.code}-${index}`} className={layout.previewIssue}>
          <p role="alert"><strong>{nameOf(item)}</strong> · {conflictPresentation(item).conclusion}</p>
          {actions?.(item)}
        </div>)}
        {passed && estimate && <p>
          {estimate.date} · {estimate.placeNames.join("、") || "休息／自由日"}；剩余约 {readableMinutes(estimate.freeMinutes)}，预计 {estimate.returnTime} 结束。
        </p>}
      </li>;
    })}
  </ul>;
}

function unverifiedConflict(code: string) {
  return code === "OPENING_HOURS_UNKNOWN" || /(?:GOOGLE|ROUT(?:E|ING)).*(?:UNAVAILABLE|FAILED|UNKNOWN|TIMEOUT|NOT_VERIFIED)/i.test(code);
}

export function ScheduleMovePreviewResults({ preview, originalPlaceName }: { preview: ScheduleMovePreview; originalPlaceName?: string }) {
  const dayNumbers = [...new Set([preview.day, preview.targetDay, ...preview.days.map((day) => day.day),
    ...preview.conflicts.map((item) => item.day)])].sort((a, b) => a - b);
  const periodChange = preview.periodChange;
  return <>
    <h3 className={layout.previewHeading}>本次核算 · {preview.feasible ? "可以确认调整" : "仍需调整"}</h3>
    <p>{preview.feasible ? preview.message : "本次为调整预览，原安排尚未改变。"}</p>
    {periodChange && <p className={layout.requirement}>
      原{periodLabel(periodChange.from)}{periodChange.strength === "hard" ? "固定要求" : "安排"}拟改为{periodLabel(periodChange.to)}。
      {periodChange.evidence && <>原要求：{periodChange.evidence}。</>}只有你确认后才会改变。
    </p>}
    <PreviewDays days={dayNumbers} conflicts={preview.conflicts} estimates={preview.days}
      nameOf={(item) => item.placeName || (item.placeId === preview.placeId ? originalPlaceName : undefined) || "当天安排"} />
  </>;
}

function MoveChoice({ days, placeName, selectedDay, selectedPeriod, busy, unchanged, onChange }: {
  days: TravelDay[];
  placeName: string;
  selectedDay: number;
  selectedPeriod: MovePeriod;
  busy: boolean;
  unchanged?: { day: number; period?: MovePeriod | "flexible" };
  onChange: (day: number, period: MovePeriod) => void;
}) {
  const [day, setDay] = useState(selectedDay);
  const [period, setPeriod] = useState<MovePeriod>(selectedPeriod);
  const unchangedChoice = day === unchanged?.day && period === unchanged.period;
  return <form className={layout.moveChoice} aria-label={`选择${placeName}的日期和时段`} onSubmit={(event) => {
    event.preventDefault();
    if (!busy && !unchangedChoice) onChange(day, period);
  }}>
    <label>日期<select value={day} disabled={busy} onChange={(event) => setDay(Number(event.target.value))}>
      {days.map((item) => <option key={item.day} value={item.day}>Day {item.day} · {item.date.slice(5).replace("-", "/")}</option>)}
    </select></label>
    <label>时段<select value={period} disabled={busy} onChange={(event) => setPeriod(event.target.value === "morning" ? "morning" : "afternoon")}>
      <option value="morning">上午</option><option value="afternoon">下午</option>
    </select></label>
    <button type="submit" className={styles.secondaryAction} disabled={busy || unchangedChoice}>更新待确认调整并核对</button>
  </form>;
}

export function ScheduleMoveBatch({ days, moves, originals, preview, pending, busy, blocked, stale, error, nameOf, onMove, onRemove, onRetry, onApply, onCancel, onReviewBoard, headingRef }: {
  days: TravelDay[];
  moves: MoveDescription[];
  originals: PlanningScheduleConflict[];
  preview: ScheduleMoveBatchPreview | null;
  pending: "preview" | "apply" | null;
  busy: boolean;
  blocked: boolean;
  stale: boolean;
  error: string;
  nameOf: (conflict: PlanningScheduleConflict) => string;
  onMove: (move: ScheduleMoveRequest, conflict?: PlanningScheduleConflict) => void;
  onRemove: (placeId: string) => void;
  onRetry: () => void;
  onApply: (acknowledged: boolean) => void;
  onCancel: () => void;
  onReviewBoard: () => void;
  headingRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const [editing, setEditing] = useState("");
  const [acknowledgedPreview, setAcknowledgedPreview] = useState<ScheduleMoveBatchPreview | null>(null);
  const locked = busy || Boolean(pending) || blocked;
  const acknowledged = Boolean(preview && acknowledgedPreview === preview);
  const needsRetry = preview?.affectedDays.some((day) =>
    (!preview.days.some((item) => item.day === day) && !preview.conflicts.some((item) => item.day === day))
    || preview.conflicts.some((item) => item.day === day && unverifiedConflict(item.code)));
  const status = preview?.feasible ? "可以确认调整" : preview?.conflicts.length && preview.conflicts.every((item) => !unverifiedConflict(item.code)) ? "仍需调整" : "待核实";
  function changeMove(move: ScheduleMoveRequest, conflict?: PlanningScheduleConflict) {
    setEditing("");
    onMove(move, conflict);
  }
  return <section className={`${layout.card} ${layout.advisory}`} aria-label="待确认调整">
    <h3 className={layout.previewHeading} tabIndex={-1} ref={headingRef}>待确认调整</h3>
    <p>以下安排会一起核对，通过后可一次保存。</p>
    {originals.length > 0 && <details><summary>查看原冲突依据</summary>
      {originals.map((conflict, index) => <div key={`${conflict.day}:${conflict.placeId || conflict.code}:${index}`}>
        <p><strong>原冲突 · Day {conflict.day} · {nameOf(conflict)}</strong> · {conflictPresentation(conflict).conclusion}</p>
        <ConflictEvidence conflict={conflict} />
      </div>)}
    </details>}
    <ul className={layout.previewDays}>
      {moves.map((move) => {
        const key = `move:${move.placeId}`;
        const period = move.targetPeriod || move.fromPeriod;
        return <li key={move.placeId}>
          <strong>{move.placeName}</strong>
          <p>Day {move.day} {periodLabel(move.fromPeriod)} → Day {move.targetDay} {periodLabel(period)}</p>
          {move.periodChange?.strength === "hard" && <p className={layout.requirement}>
            原固定要求为{periodLabel(move.periodChange.from)}{move.periodChange.evidence ? `（${move.periodChange.evidence}）` : ""}。本次拟改为{periodLabel(move.periodChange.to)}。
          </p>}
          <div className={layout.actions}>
            <button type="button" className={styles.secondaryAction} disabled={locked} aria-label={`改选${move.placeName}`}
              aria-expanded={editing === key} onClick={() => setEditing(editing === key ? "" : key)}>改选</button>
            <button type="button" className={styles.secondaryAction} disabled={locked} aria-label={`撤销${move.placeName}的调整`}
              onClick={() => { setEditing(""); onRemove(move.placeId); }}>撤销此项</button>
          </div>
          {editing === key && <MoveChoice days={days} placeName={move.placeName} selectedDay={move.targetDay}
            selectedPeriod={period === "flexible" ? "afternoon" : period} busy={locked} onChange={(day, targetPeriod) => {
              changeMove({ day: move.day, placeId: move.placeId, targetDay: day, targetPeriod });
            }} />}
        </li>;
      })}
    </ul>
    {blocked && <p role="status">请先保存或放弃其他未保存的时长或标签编辑，再核对待确认调整。</p>}
    {stale && <p role="status">已保存的行程发生变化。待确认选择已保留，请重新核对。</p>}
    {pending && <p role="status">{pending === "apply" ? "正在确认全部调整…" : "正在核对受影响的日期…"}</p>}
    {error && <p role="alert">{error}</p>}
    {preview && <section className={layout.preview} aria-label="本次调整核算">
      <h4 className={layout.previewHeading}>本次核算 · {status}</h4>
      {preview.feasible && <p>{preview.message}</p>}
      <PreviewDays days={preview.affectedDays} conflicts={preview.conflicts} estimates={preview.days} nameOf={nameOf} showUnverified actions={(issue) => {
        const placeId = issue.placeId;
        if (!placeId) return null;
        const key = `issue:${issue.day}:${placeId}:${issue.code}`;
        const suggested = suggestedPeriodAdjustment(issue);
        const activePeriod = issue.window?.effectivePeriod;
        const placeName = nameOf(issue);
        return <>
          <div className={layout.actions}>
            {suggested && <button type="button" className={styles.secondaryAction} disabled={locked}
              onClick={() => changeMove({ day: issue.day, placeId, targetDay: issue.day, targetPeriod: suggested }, issue)}>
              拟改到 Day {issue.day} {periodLabel(suggested)}并核对
            </button>}
            <button type="button" className={styles.secondaryAction} disabled={locked} aria-label={`为${placeName}选择其他日期和时段`}
              aria-expanded={editing === key} onClick={() => setEditing(editing === key ? "" : key)}>选择其他日期和时段</button>
          </div>
          {editing === key && <MoveChoice days={days} placeName={placeName} selectedDay={issue.day}
            selectedPeriod={suggested || (activePeriod === "morning" ? "morning" : "afternoon")} busy={locked}
            onChange={(day, targetPeriod) => {
              changeMove({ day: issue.day, placeId, targetDay: day, targetPeriod }, issue);
            }} />}
        </>;
      }} />
      {preview.feasible && preview.requiresAcknowledgement && <label className={layout.acknowledge}>
        <input type="checkbox" checked={acknowledged} disabled={locked}
          onChange={(event) => setAcknowledgedPreview(event.target.checked ? preview : null)} />
        我同意按上方的待确认调整修改原固定时段。
      </label>}
    </section>}
    <div className={layout.actions}>
      {preview?.feasible && <button type="button" className={styles.primaryAction} disabled={locked || editing !== "" || preview.requiresAcknowledgement && !acknowledged}
        onClick={() => onApply(acknowledged)}>确认全部调整<ArrowRight size={15} /></button>}
      {(!preview || needsRetry) && <button type="button" className={styles.secondaryAction} disabled={locked}
        onClick={() => { setEditing(""); onRetry(); }}>重新核对待确认调整</button>}
      <button type="button" className={styles.secondaryAction} disabled={busy || Boolean(pending)} onClick={onCancel}>取消全部调整</button>
      <button type="button" className={styles.secondaryAction} disabled={locked} onClick={onReviewBoard}>回分天板选择其他安排</button>
    </div>
  </section>;
}

export function ScheduleConflictCard({ conflict, busy, blockPlanChanges = false, blockDurationEdit = false, onSave, saveFailure, previousResult = Boolean(saveFailure), onDismissSaveFailure, onReviewBoard, onPreviewMove, onApplyMove, onStageMove, travelDays, onDirtyChange }: ScheduleConflictActions & {
  conflict: PlanningScheduleConflict;
  busy: boolean;
  blockPlanChanges?: boolean;
  blockDurationEdit?: boolean;
  onSave: (input: PlanningTimeOverride) => Promise<boolean>;
  saveFailure?: ScheduleSaveFailure;
  previousResult?: boolean;
  onDismissSaveFailure?: () => void;
  onReviewBoard: () => void;
  onStageMove?: (move: ScheduleMoveRequest, conflict: PlanningScheduleConflict) => void;
  travelDays?: TravelDay[];
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [savedHours, setSavedHours] = useState(String((conflict.window?.visitMinutes || 90) / 60));
  const [hours, setHours] = useState(savedHours);
  const [preview, setPreview] = useState<ScheduleMovePreview | null>(null);
  const [localError, setLocalError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [pending, setPending] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const window = conflict.window;
  const locked = busy || pending;
  const durationLocked = locked || blockDurationEdit;
  const planLocked = locked || blockPlanChanges;
  const targetDay = conflict.suggestedDay;
  const suggestedPeriod = suggestedPeriodAdjustment(conflict);
  const presentation = conflictPresentation(conflict);

  async function previewMove(sameDay = false) {
    if (planLocked || (!targetDay && !sameDay) || (sameDay && !suggestedPeriod) || !conflict.placeId) return;
    const input = { day: conflict.day, placeId: conflict.placeId, targetDay: sameDay ? conflict.day : targetDay!, ...(sameDay && suggestedPeriod ? { targetPeriod: suggestedPeriod } : {}) };
    if (onStageMove) { onStageMove(input, conflict); return; }
    if (!onPreviewMove) return;
    setPending(true); setLocalError(""); setPreview(null);
    try { const result = await onPreviewMove(input); setPreview(result); if (!result) setLocalError("调整核对暂未完成，当前安排未改变，请重试。"); }
    catch { setLocalError("移动核对暂未完成，当前安排未改变，请重试。"); }
    finally { setPending(false); }
  }

  return <article className={`${layout.card} ${presentation.advisory ? layout.advisory : ""}`} aria-label={`Day ${conflict.day} ${conflict.placeName || "行程"}时间冲突`}>
    <div className={layout.heading}><strong>{preview ? "原冲突 · " : ""}DAY {conflict.day} · {conflict.placeName || conflict.date}</strong><span>{presentation.title}</span></div>
    <p className={layout.conclusion} role={preview || previousResult ? undefined : presentation.advisory ? "status" : "alert"}>{preview
      ? "这里显示原安排的冲突，本次逐日核算结果见下方。"
      : previousResult ? "上次核算仍待调整，本次结果请查看对应保存操作下方。" : presentation.conclusion}</p>
    <details><summary>{preview ? "查看原冲突依据" : previousResult ? "查看上次核算依据" : "查看本次核算依据"}</summary><ConflictEvidence conflict={conflict} /></details>
    <div className={layout.actions}>
      {suggestedPeriod && conflict.placeId && (onStageMove || onPreviewMove) && <button type="button" className={styles.secondaryAction} disabled={planLocked} onClick={() => previewMove(true)}>核对改到当天{periodLabel(suggestedPeriod)}</button>}
      {targetDay && conflict.placeId && (onStageMove || onPreviewMove) && <button type="button" className={styles.secondaryAction} disabled={planLocked} onClick={() => previewMove(false)}>核对移到后一天（Day {targetDay}）</button>}
      {conflict.placeId && onStageMove && !!travelDays?.length && <button type="button" className={styles.secondaryAction} disabled={planLocked} aria-expanded={choosing}
        onClick={() => setChoosing(!choosing)}>选择其他日期和时段</button>}
      <button type="button" className={styles.secondaryAction} disabled={planLocked} onClick={onReviewBoard}>回分天板选择其他安排</button>
    </div>
    {choosing && conflict.placeId && onStageMove && !!travelDays?.length && <MoveChoice days={travelDays}
      placeName={conflict.placeName || "当前地点"} selectedDay={targetDay ?? conflict.day} selectedPeriod={suggestedPeriod || (window?.effectivePeriod === "morning" ? "morning" : "afternoon")}
      busy={planLocked} unchanged={{ day: conflict.day, period: window?.effectivePeriod }} onChange={(day, targetPeriod) => {
        setChoosing(false);
        onStageMove({ day: conflict.day, placeId: conflict.placeId!, targetDay: day, targetPeriod }, conflict);
      }} />}
    {conflict.placeId && window && <form className={layout.edit} onSubmit={async (event) => {
      event.preventDefault();
      if (durationLocked) return;
      const minutes = Number(hours) * 60;
      onDismissSaveFailure?.();
      setSaveError("");
      if (!Number.isFinite(minutes) || Math.round(minutes) < 15 || Math.round(minutes) > 480) { setSaveError("请输入 0.25–8 小时的有效停留时长。"); return; }
      if (minutes < window.visitMinutes && !globalThis.confirm(`将“${conflict.placeName}”停留从 ${readableMinutes(window.visitMinutes)} 改为 ${readableMinutes(Math.round(minutes))}？缩短后体验可能不完整，将重新核对可行性。`)) return;
      setPending(true); setLocalError(""); setPreview(null);
      try {
        if (await onSave({ day: conflict.day, visitMinutesByPlaceId: { [conflict.placeId!]: Math.round(minutes) } })) {
          setSavedHours(hours);
          onDirtyChange?.(false);
        } else setSaveError("本次安排未保存，已保留你的输入，请重试。");
      }
      catch { setSaveError("本次安排未保存，已保留你的输入，请重试。"); }
      finally { setPending(false); }
    }}>
      <label>调整当前停留（小时）<input type="number" min="0.25" max="8" step="any" required value={hours} disabled={durationLocked}
        onChange={(event) => {
          setHours(event.target.value);
          setSaveError("");
          onDirtyChange?.(event.target.value !== savedHours);
        }} /></label>
      <button className={styles.secondaryAction} disabled={durationLocked} type="submit">保存并重算本日</button>
      {hours !== savedHours && <button type="button" className={styles.secondaryAction} disabled={locked} onClick={() => {
        setHours(savedHours);
        setSaveError("");
        onDismissSaveFailure?.();
        onDirtyChange?.(false);
      }}>放弃未保存的时长</button>}
      <small>即使首次核算失败，也可在此调整；不会自动缩短你的安排。</small>
      {(saveFailure || saveError) && <div className={layout.saveStatus}>{saveFailure ? <ScheduleSaveFeedback failure={saveFailure} /> : <p role="alert">{saveError}</p>}</div>}
    </form>}
    {preview && <section className={layout.preview} aria-label="本次调整核算">
      <ScheduleMovePreviewResults preview={preview} originalPlaceName={conflict.placeName} />
      {preview.feasible && onApplyMove && <button type="button" className={styles.primaryAction} disabled={planLocked} onClick={async () => {
        setPending(true); setLocalError("");
        try { if (await onApplyMove({ day: preview.day, placeId: preview.placeId, targetDay: preview.targetDay, ...(preview.targetPeriod ? { targetPeriod: preview.targetPeriod } : {}), previewFingerprint: preview.fingerprint })) setPreview(null); else setLocalError("调整尚未保存，安排已保留；请重新核对预览后确认。"); }
        catch { setLocalError("移动尚未保存，请重试。"); }
        finally { setPending(false); }
      }}>{preview.day === preview.targetDay && preview.targetPeriod ? `确认改为当天${periodLabel(preview.targetPeriod)}` : `确认移到 Day ${preview.targetDay}`}<ArrowRight size={15} /></button>}
      <button type="button" className={styles.secondaryAction} disabled={locked} onClick={() => setPreview(null)}>取消调整预览</button>
    </section>}
    {localError && <p role="alert">{localError}</p>}
  </article>;
}
