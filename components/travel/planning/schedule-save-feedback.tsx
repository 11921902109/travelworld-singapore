import type { ReactNode } from "react";
import { conflictPresentation, minuteClock, readableMinutes, type PlanningScheduleConflict } from "@/lib/travel/planning-conflicts";
import { durationTextInHours } from "@/lib/travel/planning-duration";
import styles from "./schedule-time-editor.module.css";

export type ScheduleSaveFailure = { day: number; message: string; conflicts?: PlanningScheduleConflict[]; blockId?: string };

function shortReason(conflict: PlanningScheduleConflict) {
  const window = conflict.window;
  if (window && conflict.placeName && conflict.code === "arrival_too_late" && window.limitingBoundary !== "planning_day" && window.closingMinute !== null && window.missingMinutes) {
    return `${conflict.placeName}预计 ${minuteClock(window.earliestVisitStart + window.visitMinutes)} 参观结束，比常规闭馆时间 ${minuteClock(window.closingMinute)} 晚约 ${readableMinutes(window.missingMinutes)}。可调整停留时长或核对其他日期。`;
  }
  const reason = conflictPresentation(conflict).conclusion;
  return window && conflict.placeName ? `${conflict.placeName}：${reason}` : reason;
}

export function ScheduleSaveFeedback({ failure, action }: { failure: ScheduleSaveFailure; action?: ReactNode }) {
  const conflicts = failure.conflicts || [];
  const first = conflicts[0];
  return <div className={styles.saveFeedback} data-day-save-feedback={failure.day}>
    <p role="alert"><strong>本次安排未保存：</strong>{first ? shortReason(first) : durationTextInHours(failure.message)} 原有安排不变；已填写的内容仍保留。</p>
    {action}
    {conflicts.length > 0 && <details><summary>查看核算依据</summary>
      {conflicts.map((conflict, index) => {
        const evidence = conflictPresentation(conflict);
        return <div key={`${conflict.code}:${conflict.placeId || index}`}>
          {index > 0 && <p><strong>{conflict.placeName || evidence.title}：</strong>{evidence.conclusion}</p>}
          <dl>{evidence.steps.map((step) => <div key={step.title}><dt>{step.title}</dt><dd>{step.detail}</dd></div>)}</dl>
        </div>;
      })}
    </details>}
  </div>;
}
