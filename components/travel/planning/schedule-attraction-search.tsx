"use client";

import { useState } from "react";
import type { PlanningAttractionInput, PlanningAttractionMatch, PlanningAttractionPreview } from "@/lib/travel/planning-attractions";
import { hoursLabel } from "@/lib/travel/planning-duration";
import { assessPlanningCapacity } from "@/lib/travel/planning-capacity";
import type { DayEstimate } from "./schedule-stage";
import styles from "./schedule-time-editor.module.css";

export type AttractionSearchActions = {
  onSearchAttractions?: (query: string) => Promise<PlanningAttractionMatch[]>;
  onPreviewAttraction?: (input: PlanningAttractionInput) => Promise<PlanningAttractionPreview | null>;
  onConfirmAttraction?: (input: PlanningAttractionInput & { previewFingerprint: string; preferenceAcknowledged?: boolean }) => Promise<boolean>;
};

/** Advisory only: changing a place can also change travel, so preview remains authoritative. */
export function attractionCapacityAdvisory(estimate: DayEstimate | undefined, addedMinutes: number, stale = false): string {
  if (stale || !estimate?.effectiveWindow || !estimate.scenes || estimate.scenes.some(scene => !Number.isFinite(scene.selectedVisitMinutes))) return "当前可安排余量待核算；请核对加入后的实际路线，不把旧余额当作可用时间。";
  if (!Number.isFinite(addedMinutes) || addedMinutes < 15 || addedMinutes > 480) return "";
  const result = assessPlanningCapacity({ day: estimate.day, startTime: estimate.effectiveWindow.start, hardEndTime: estimate.effectiveWindow.returnBy,
    preferredEndTime: estimate.dailyWindow?.latestReturn,
    visitMinutes: estimate.scenes.reduce((sum, scene) => sum + scene.selectedVisitMinutes!, addedMinutes),
    localBlockMinutes: (estimate.localBlocks || []).reduce((sum, block) => sum + block.durationMinutes, 0) });
  return result.status === "hard_exceeded" ? `初步容量提醒：${result.message} 是否加入仍以实际新增或减少的交通、开放及位置核对结果为准。` : "加入前将重新核对停留、实际交通及开放；尚未分配时间仅供初步参考。";
}

export function ScheduleAttractionSearch({ day, days, estimates, initialAnchor, estimateStale = false, staleEstimateDays = [], busy, blocked, onClose, onSearchAttractions, onPreviewAttraction, onConfirmAttraction }: AttractionSearchActions & {
  day: number; days: Array<{ day: number; date: string }>; estimates: DayEstimate[];
  initialAnchor?: { nodeId: string; placement: "before" | "after" };
  estimateStale?: boolean;
  staleEstimateDays?: number[];
  busy: boolean; blocked: boolean; onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<PlanningAttractionMatch[]>([]);
  const [selected, setSelected] = useState<PlanningAttractionMatch | null>(null);
  const [targetDay, setTargetDay] = useState(day);
  const [period, setPeriod] = useState<"morning" | "afternoon">("afternoon");
  const [position, setPosition] = useState(() => {
    const initial = estimates.find((item) => item.day === day);
    const ids = new Set(initial?.scenes?.map((scene) => scene.candidateId) || []);
    const exists = initial?.scheduledDay?.stops.some((stop) => stop.id === initialAnchor?.nodeId && ids.has(stop.placeId || stop.id));
    return initialAnchor && exists ? `${initialAnchor.placement}:${initialAnchor.nodeId}` : "";
  });
  const [minutes, setMinutes] = useState("90");
  const [preview, setPreview] = useState<PlanningAttractionPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const estimate = estimates.find((item) => item.day === targetDay && days.some((date) => date.day === targetDay && date.date === item.date));
  const scenes = new Set(estimate?.scenes?.map((scene) => scene.candidateId) || []);
  const stops = estimate?.scheduledDay?.stops.filter((stop) => scenes.has(stop.placeId || stop.id)) || [];
  const locked = busy || pending || blocked;
  const invalidate = () => { setPreview(null); setAcknowledged(false); setMessage(""); };

  function input(): PlanningAttractionInput | null {
    const duration = Number(minutes);
    if (!selected || !Number.isInteger(duration) || duration < 15 || duration > 480 || !position) {
      setMessage("请选择景点、目标位置，并填写 15–480 分钟的停留时长。"); return null;
    }
    const [placement, ...nodeId] = position.split(":");
    return { day: targetDay, placeId: selected.placeId, minutes: duration, period,
      ...(position === "day-start" ? {} : { anchor: { nodeId: nodeId.join(":"), placement: placement as "before" | "after" } }) };
  }

  async function search() {
    if (locked || !onSearchAttractions) return;
    if (query.trim().length < 2) { setMessage("请输入至少两个字的景点名称。"); return; }
    setPending(true); setMessage(""); invalidate();
    try {
      const result = await onSearchAttractions(query.trim());
      setMatches(result); setSelected(null);
      if (!result.length) setMessage("没有找到符合范围的景点，请尝试更完整的名称。此处不添加餐厅。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "暂时无法搜索，你的输入已保留。"); }
    finally { setPending(false); }
  }

  async function check() {
    if (locked || !onPreviewAttraction) return;
    const request = input(); if (!request) return;
    setPending(true); setMessage(""); setPreview(null); setAcknowledged(false);
    try {
      const result = await onPreviewAttraction(request);
      if (result) setPreview(result);
      else setMessage("未能完成本日核对，请查看提示后重试；选择已保留。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "核对失败，请稍后重试；选择已保留。"); }
    finally { setPending(false); }
  }

  async function confirm() {
    if (locked || !onConfirmAttraction || !preview?.feasible || preview.requiresAcknowledgement && !acknowledged) return;
    const request = input(); if (!request) return;
    setPending(true); setMessage("");
    try {
      if (await onConfirmAttraction({ ...request, previewFingerprint: preview.fingerprint, preferenceAcknowledged: acknowledged })) onClose();
      else { setPreview(null); setMessage("尚未加入，请查看最新提示并重新核对；输入与选择已保留。"); }
    } catch (error) { setPreview(null); setMessage(error instanceof Error ? error.message : "加入失败，原行程与搜索选择已保留。"); }
    finally { setPending(false); }
  }

  return <section className={styles.attractionSearch} aria-label="搜索景点并加入">
    <div className={styles.sectionHeading}><h4>搜索景点并加入</h4><button type="button" className={styles.textAction} disabled={pending} onClick={onClose}>收起搜索</button></div>
    <p className={styles.note}>先核实真实景点，再核对所选日期的开放、交通和时间。确认前不会改变行程。</p>
    {blocked && <p className={styles.draftNotice} role="status">请先保存各日尚未确认的安排，再核对新景点。</p>}
    <div className={styles.searchRow}><label>景点名称<input type="search" maxLength={120} value={query} disabled={locked} onChange={(event) => { setQuery(event.target.value); invalidate(); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void search(); } }} placeholder="例如：新加坡国家美术馆" /></label><button type="button" disabled={locked || !onSearchAttractions} onClick={() => void search()}>{pending ? "正在处理…" : "搜索景点"}</button></div>
    {matches.length > 0 && <ul className={styles.searchMatches}>{matches.map((match) => <li key={match.placeId}><button type="button" disabled={locked} aria-pressed={selected?.placeId === match.placeId} onClick={() => { setSelected(match); invalidate(); }}><strong>{match.name}</strong><span>{match.address}</span><small>{match.categoryLabel} · {match.openingHours?.length ? match.openingHours.join("；") : "营业信息待核实"}</small></button></li>)}</ul>}
    {selected && <div className={styles.searchSelection}>
      <strong>已选：{selected.name}</strong>
      <div className={styles.searchFields}>
        <label>目标日期<select disabled={locked} value={targetDay} onChange={(event) => { setTargetDay(Number(event.target.value)); setPosition(""); invalidate(); }}>{days.map((item) => <option key={item.day} value={item.day}>Day {item.day} · {item.date}</option>)}</select></label>
        <label>游览时段<select disabled={locked} value={period} onChange={(event) => { setPeriod(event.target.value as "morning" | "afternoon"); invalidate(); }}><option value="morning">上午</option><option value="afternoon">下午</option></select></label>
        <label>停留时长（分钟）<input type="number" min="15" max="480" step="1" disabled={locked} value={minutes} onChange={(event) => { setMinutes(event.target.value); invalidate(); }} /></label>
      </div>
      <label>插入位置<select disabled={locked} value={position} onChange={(event) => { setPosition(event.target.value); invalidate(); }}><option value="">请选择位置</option>{stops.length ? stops.flatMap((stop) => [<option key={`${stop.id}:before`} value={`before:${stop.id}`}>在 {stop.name} 之前</option>, <option key={`${stop.id}:after`} value={`after:${stop.id}`}>在 {stop.name} 之后</option>]) : <option value="day-start">作为所选时段的第一个景点</option>}</select></label>
      <p className={styles.draftNotice} role="status">{attractionCapacityAdvisory(estimate, Number(minutes), (targetDay === day && estimateStale) || staleEstimateDays.includes(targetDay))}</p>
      <button type="button" disabled={locked || !onPreviewAttraction} onClick={() => void check()}>核对加入后的安排</button>
    </div>}
    {preview && <section className={styles.attractionPreview} aria-label="景点加入核对结果">
      <h4>{preview.feasible ? "请确认这次加入" : "当前安排存在冲突"}</h4><p>{preview.message}</p>
      <ul>{preview.checks.map((item, index) => <li key={`${index}:${item.message}`} data-status={item.status}>{item.message}</li>)}</ul>
      <p>Day {preview.day} · 停留 {hoursLabel(preview.minutes)} · 加入后交通约 {hoursLabel(preview.newTravelMinutes)} · 尚未分配约 {hoursLabel(preview.freeMinutes)}</p>
      {preview.overtimeMinutes > 0 && <p className={styles.error}>预计超出约 {hoursLabel(preview.overtimeMinutes)}</p>}
      {preview.requiresAcknowledgement && <label className={styles.acknowledgement}><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={locked} />我已了解上述偏好提醒，仍希望加入这个景点。</label>}
      <button type="button" disabled={locked || !preview.feasible || preview.requiresAcknowledgement && !acknowledged} onClick={() => void confirm()}>确认加入景点</button>
    </section>}
    {message && <p className={styles.error} role="status">{message}</p>}
  </section>;
}
