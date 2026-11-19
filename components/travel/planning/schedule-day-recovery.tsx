"use client";

import { useRef, useState } from "react";
import { effectivePlanningLocalBlocks, type PlanningTimeOverride } from "@/lib/travel/planning-time-overrides";
import { ScheduleSaveFeedback, type ScheduleSaveFailure } from "./schedule-save-feedback";
import styles from "./planning-journey.module.css";
import editor from "./schedule-time-editor.module.css";

export type RecoveryPlace = { placeId: string; name: string; estimatedMinutes: number };

export function ScheduleDayRecovery({ day, saved, places, busy, saveFailure, onDismissSaveFailure, onSave, onDirtyChange }: {
  day: number;
  saved?: PlanningTimeOverride;
  places: RecoveryPlace[];
  busy: boolean;
  saveFailure?: ScheduleSaveFailure;
  onDismissSaveFailure?: () => void;
  onSave: (value: PlanningTimeOverride) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const blockInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [changes, setChanges] = useState<{ blockHours: Record<string, string>; removed: string[]; visitHours: Record<string, string> }>({ blockHours: {}, removed: [], visitHours: {} });
  const [error, setError] = useState("");
  const blocks = effectivePlanningLocalBlocks(saved, { departure: false });
  const dirty = Boolean(Object.keys(changes.blockHours).length || changes.removed.length || Object.keys(changes.visitHours).length);
  const [saveError, setSaveError] = useState("");
  const focusBlock = saveFailure?.blockId;
  const matchedBlock = focusBlock && !changes.removed.includes(focusBlock) ? blocks.find(({ id }) => id === focusBlock) : undefined;

  function update(next: typeof changes) {
    setChanges(next);
    setError("");
    setSaveError("");
    onDirtyChange(Boolean(Object.keys(next.blockHours).length || next.removed.length || Object.keys(next.visitHours).length));
  }

  return <form className={`${editor.editor} ${editor.blockForm}`} onSubmit={async (event) => {
    event.preventDefault();
    setError("");
    setSaveError("");
    const toMinutes = (hours: string, minimum: number) => {
      const minutes = Math.round(Number(hours) * 60);
      return hours.trim() && Number.isFinite(minutes) && minutes >= minimum && minutes <= 480 ? minutes : null;
    };
    const input: PlanningTimeOverride = { day };
    if (changes.removed.length || Object.keys(changes.blockHours).length) {
      input.localBlocks = [];
      for (const block of blocks.filter(({ id }) => !changes.removed.includes(id))) {
        const duration = changes.blockHours[block.id] === undefined ? block.durationMinutes : toMinutes(changes.blockHours[block.id], 1);
        if (duration === null) { setError(`请为“${block.title}”输入 1 分钟至 8 小时的时长。`); return; }
        input.localBlocks.push({ ...block, durationMinutes: duration });
      }
    }
    for (const place of places) {
      const hours = changes.visitHours[place.placeId];
      if (hours === undefined) continue;
      const minutes = toMinutes(hours, 15);
      if (minutes === null) { setError(`请为“${place.name}”输入 0.25–8 小时的停留时长。`); return; }
      (input.visitMinutesByPlaceId ||= {})[place.placeId] = minutes;
    }
    try {
      if (await onSave(input)) { update({ blockHours: {}, removed: [], visitHours: {} }); return; }
    } catch {
      setSaveError("暂时无法重新核算。你的输入已保留，请稍后重试。");
      return;
    }
    setSaveError("本次安排未保存。你的输入已保留，请重试。");
  }}>
    <h4>修改本日安排</h4>
    <p className={editor.note}>暂无可用的核算时间轴。这里可以先调整已保存的标签和地点停留，保存后重新核对本日，不改动机票或住宿。</p>
    {blocks.map((block) => {
      const removed = changes.removed.includes(block.id);
      return <div className={editor.blockFields} key={block.id}>
        <label>{block.title}{block.details && <small>{block.details}</small>}
          <input type="number" min="0.016" max="8" step="any" required disabled={busy || removed}
            ref={(element) => { blockInputs.current[block.id] = element; }}
            value={changes.blockHours[block.id] ?? String(block.durationMinutes / 60)}
            aria-label={`${block.title}时长（小时）`}
            onChange={(event) => update({ ...changes, blockHours: { ...changes.blockHours, [block.id]: event.target.value } })} />
        </label>
        <button type="button" className={editor.textAction} disabled={busy}
          onClick={() => update({ ...changes, removed: removed ? changes.removed.filter((id) => id !== block.id) : [...changes.removed, block.id] })}>
          {removed ? "撤销移除" : "移除安排"}
        </button>
      </div>;
    })}
    {places.map((place) => <label key={place.placeId}>{place.name} · 停留（小时）
      <input type="number" min="0.25" max="8" step="any" required disabled={busy}
        value={changes.visitHours[place.placeId] ?? String((saved?.visitMinutesByPlaceId?.[place.placeId] ?? place.estimatedMinutes) / 60)}
        onChange={(event) => update({ ...changes, visitHours: { ...changes.visitHours, [place.placeId]: event.target.value } })} />
    </label>)}
    <div className={editor.inlineActions}>
      <button type="submit" className={styles.primaryAction} disabled={busy}>{dirty ? "保存并核算本日" : "重新核算本日"}</button>
      {dirty && <button type="button" className={editor.discard} disabled={busy} onClick={() => update({ blockHours: {}, removed: [], visitHours: {} })}>放弃未保存修改</button>}
    </div>
    {error ? <p className={editor.saveFeedback} role="alert">{error}</p> : saveFailure ?
      <ScheduleSaveFeedback failure={saveFailure} action={matchedBlock ? <button type="button" className={editor.textAction} disabled={busy} onClick={() => blockInputs.current[matchedBlock.id]?.focus()}>定位{matchedBlock.title}</button>
        : !dirty && onDismissSaveFailure ? <button type="button" className={editor.textAction} disabled={busy} onClick={onDismissSaveFailure}>关闭本次提示</button> : undefined} />
      : saveError && <p className={editor.saveFeedback} role="alert">{saveError}</p>}
  </form>;
}
