"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { ArrowLeft, ArrowRight, Check, Clock3, GripVertical, MapPin, MoreHorizontal, RotateCcw, ShieldCheck, X } from "lucide-react";
import { getTravelVisitToken } from "@/lib/travel/visit-client";
import { regularOpeningHoursLabel } from "@/lib/travel/planning-hours";
import { hoursLabel } from "@/lib/travel/planning-duration";
import type { TravelCommerce } from "@/lib/travel/types";
import type { BoardAssignment, BoardPlacePreference } from "@/lib/travel/planning-day-board";
import styles from "./planning-journey.module.css";
import board from "./place-day-stage.module.css";

export type PlanningPlace = {
  candidateId: string; googlePlaceId?: string | null; name: string; kind: "sight" | "food";
  sceneRole?: "culinary_area" | "restaurant_meal" | "attraction";
  category: string; area: string; address?: string | null; openingHours?: string[];
  estimatedVisitMinutes?: number | null; durationSource?: "bailian" | "user";
  durationReason?: string; pros?: string[]; cons?: string[]; reason?: string;
  verification?: string; factSource?: string; adviceSource?: string; fallbackReason?: string | null;
  booking?: { display?: string; url?: string; note?: string } | null;
};
export type DayPeriod = "morning" | "afternoon" | "flexible";
export type PlanningDay = BoardAssignment & { date?: string; status?: string; warnings?: string[] };
type Props = {
  initialDay?: number; insertionHint?: string;
  candidates: PlanningPlace[]; days: PlanningDay[]; busy: boolean; confirmed: boolean; error?: string;
  unconfirmed?: boolean; conflict?: boolean; onKeepLocal?: () => void; onUseLatest?: () => void;
  onAssign: (candidateId: string, day: number, index?: number, period?: "morning" | "afternoon") => void;
  placeTimePreferences?: Record<string, BoardPlacePreference>;
  onPeriod?: (candidateId: string, day: number, period: DayPeriod, strength: "soft" | "hard") => void;
  onRemove: (candidateId: string, day: number) => void;
  onDeleteDay: (day: number) => void; onUndoDelete: () => void; canUndoDelete: boolean;
  onConfirm: (explicitRestDays: number[]) => void; onBackToSelection?: () => void;
};
function startDrag(event: DragEvent, id: string) { event.dataTransfer.setData("text/plain", id); event.dataTransfer.effectAllowed = "move"; }

export function PlaceDayStage({ candidates, days, busy, confirmed, error, unconfirmed, conflict, onKeepLocal, onUseLatest,
  onAssign, placeTimePreferences = {}, onRemove, onDeleteDay, onUndoDelete, canUndoDelete, onConfirm, onBackToSelection, initialDay, insertionHint }: Props) {
  const [selectedDay, setSelectedDay] = useState(initialDay && days.some((item) => item.day === initialDay) ? initialDay : days[0]?.day || 1);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [skipDelete, setSkipDelete] = useState(false);
  const [restDays, setRestDays] = useState<number[] | null>(null);
  const [pendingPeriod, setPendingPeriod] = useState<{ id: string; day: number; index?: number; period: "morning" | "afternoon"; previous: "morning" | "afternoon" } | null>(null);
  const [validation, setValidation] = useState("");
  const [quotes, setQuotes] = useState<Record<string, { commerce?: TravelCommerce | null; error?: string }>>({});
  const [quoteLoading, setQuoteLoading] = useState<string | null>(null);
  const modal = useRef<HTMLDialogElement>(null);
  const activeDay = days.find((day) => day.day === selectedDay) || days[0];
  const byId = new Map(candidates.map((item) => [item.candidateId, item]));
  const assigned = new Set(days.flatMap((day) => day.orderedCandidateIds));
  const periodFor = (id: string) => days.find((day) => day.orderedCandidateIds.includes(id))?.periodByCandidateId?.[id];
  const pending = candidates.filter((place) => !assigned.has(place.candidateId) || !["morning", "afternoon"].includes(periodFor(place.candidateId) || ""));
  const currentPlaces = activeDay?.orderedCandidateIds.map((id) => byId.get(id)).filter((place): place is PlanningPlace => Boolean(place)) || [];
  const invalidIds = [...assigned].filter((id) => !byId.has(id));
  const total = currentPlaces.reduce((sum, place) => sum + (place.estimatedVisitMinutes || 0), 0);

  useEffect(() => {
    if (pendingDelete !== null || restDays || pendingPeriod) { if (!modal.current?.open) modal.current?.showModal(); }
    else modal.current?.close();
  }, [pendingDelete, restDays, pendingPeriod]);
  function chooseDay(day: number) {
    if (movingId && !busy && !confirmed && !conflict) { onAssign(movingId, day); setMovingId(null); }
    setSelectedDay(day); setValidation("");
  }
  function assignToPeriod(id: string, day: number, period: "morning" | "afternoon", index?: number) {
    if (busy || confirmed || conflict) return;
    const source = days.find((item) => item.orderedCandidateIds.includes(id));
    const previous = source?.periodByCandidateId?.[id] || placeTimePreferences[id]?.period;
    const restriction = source?.periodConstraintByCandidateId?.[id] || placeTimePreferences[id]?.constraint;
    if ((previous === "morning" || previous === "afternoon") && previous !== period && restriction?.strength !== "soft") {
      setPendingPeriod({ id, day, period, index, previous }); return;
    }
    onAssign(id, day, index, period); setValidation("");
  }
  function dropOnDay(event: DragEvent, day: number) {
    event.preventDefault(); const id = event.dataTransfer.getData("text/plain");
    if (!byId.has(id) || busy || confirmed || conflict) return;
    setSelectedDay(day);
    if (periodFor(id) === "morning" || periodFor(id) === "afternoon") onAssign(id, day);
    else setValidation(`请把“${byId.get(id)?.name}”加入 Day ${day} 的上午或下午。`);
  }
  function requestDelete(day: number) {
    if (busy || confirmed || days.length < 2 || conflict) return;
    try { if (sessionStorage.getItem("tw-planning-skip-day-delete-dialog") === "1") { onDeleteDay(day); return; } } catch { /* Optional preference. */ }
    setPendingDelete(day);
  }
  function confirmBoard() {
    if (conflict) { setValidation("规划已有更新，请先核对并选择如何保留安排。"); return; }
    if (invalidIds.length) { setValidation("本地安排含已取消选择的地点，请载入服务器安排或返回挑地点恢复选择。"); return; }
    if (pending.length) { setValidation(`请为${pending.map((place) => `“${place.name}”`).join("、")}选择旅行日及上午或下午，再确认分天。`); return; }
    const empty = days.filter((day) => !day.orderedCandidateIds.length);
    if (empty.some((day) => day.dayPurpose !== "rest")) setRestDays(empty.map((day) => day.day));
    else onConfirm(empty.map((day) => day.day));
  }
  async function queryPrice(place: PlanningPlace) {
    if (place.kind === "food" || place.sceneRole === "culinary_area" || !place.googlePlaceId || quoteLoading) return;
    const date = days.find((day) => day.orderedCandidateIds.includes(place.candidateId))?.date || activeDay?.date;
    if (!date) return;
    const key = `${place.candidateId}:${date}`; setQuoteLoading(key);
    try {
      const response = await fetch("/api/travel/singapore/poi-commerce", { method: "POST", headers: { "Content-Type": "application/json", "x-travel-visit": await getTravelVisitToken() }, body: JSON.stringify({ placeId: place.googlePlaceId, visitDate: date }) });
      const result = await response.json().catch(() => null) as { error?: string; commerce?: TravelCommerce | null } | null;
      if (!response.ok || !result) throw new Error(typeof result?.error === "string" ? result.error : "暂时无法查询门票或预订信息。");
      setQuotes((value) => ({ ...value, [key]: { commerce: result.commerce || null } }));
    } catch (cause) { setQuotes((value) => ({ ...value, [key]: { error: cause instanceof Error ? cause.message : "暂时无法查询预订信息。" } })); }
    finally { setQuoteLoading(null); }
  }
  function details(place: PlanningPlace) {
    if (expanded !== place.candidateId) return null;
    const date = days.find((day) => day.orderedCandidateIds.includes(place.candidateId))?.date || activeDay?.date || "";
    const key = `${place.candidateId}:${date}`; const quote = quotes[key];
    const dining = place.kind === "food" || place.sceneRole === "culinary_area";
    return <div className={board.details}><p><b>地址</b>{place.address || "新加坡"}</p><p><b>Google 常规开放</b>{regularOpeningHoursLabel(place.openingHours || [], date) || "待核实；特殊营业请出发前复核"}</p>
      <p><b>{place.durationSource === "user" ? "你的安排" : "建议停留"}</b>{hoursLabel(place.estimatedVisitMinutes || 0)}</p>
      {place.durationReason && <p>{place.durationReason}</p>}{place.pros?.length ? <p><b>优点</b>{place.pros.join("；")}</p> : null}{place.cons?.length ? <p><b>留意</b>{place.cons.join("；")}</p> : null}
      {dining ? <p>美食区域及餐厅展示真实地点信息，不查询飞猪餐饮商品。</p> : <div className={board.commerce}><p>{quote?.error || quote?.commerce?.price?.display || quote?.commerce?.note || "门票与预订信息按需查询。"}</p>
        {quote?.commerce?.bookingUrl && <a href={quote.commerce.bookingUrl} target="_blank" rel="noreferrer">飞猪查看详情 ↗</a>}
        <button type="button" disabled={Boolean(quoteLoading) || !place.googlePlaceId} onClick={() => void queryPrice(place)}>{quoteLoading === key ? "查询中…" : `${quote ? "重新查询" : "查询"} ${date} 价格`}</button></div>}
    </div>;
  }
  function periodStops(period: "morning" | "afternoon") {
    const label = period === "morning" ? "上午" : "下午";
    const places = currentPlaces.filter((place) => activeDay?.periodByCandidateId?.[place.candidateId] === period);
    const drop = (event: DragEvent, index?: number) => { event.preventDefault(); event.stopPropagation(); const id = event.dataTransfer.getData("text/plain"); if (activeDay && byId.has(id)) assignToPeriod(id, activeDay.day, period, index); };
    return <section className={board.periodZone} aria-label={`Day ${activeDay?.day} ${label}`} onDragOver={(event) => { if (!busy && !confirmed && !conflict) event.preventDefault(); }} onDrop={(event) => drop(event)}>
      <div className={board.periodHeading}><h4>{label}</h4><small>{places.length} 处 · {hoursLabel(places.reduce((sum, place) => sum + (place.estimatedVisitMinutes || 0), 0))}</small></div>
      <p className={board.periodHelp}>{period === "morning" ? "上午开始的安排；完整游玩可适当跨中午。" : "下午至本日结束的安排，夜景也放在这里。"}</p>
      <ol className={board.stops}>
        {places.map((place, index) => {
          const position = activeDay!.orderedCandidateIds.indexOf(place.candidateId);
          const restriction = activeDay?.periodConstraintByCandidateId?.[place.candidateId] || placeTimePreferences[place.candidateId]?.constraint;
          return <li key={place.candidateId} draggable={!busy && !confirmed && !conflict} onDragStart={(event) => startDrag(event, place.candidateId)} onDragOver={(event) => { if (!busy && !confirmed && !conflict) event.preventDefault(); }} onDrop={(event) => drop(event, position)}>
            <div className={board.stopTop}><span className={board.number}>{index + 1}</span><div className={board.stopName}><strong>{place.name}</strong><small>{place.area || place.category} · {hoursLabel(place.estimatedVisitMinutes || 0)}</small></div>{!confirmed && <><GripVertical size={15} className={board.grip} aria-hidden="true" /><details className={board.menu}><summary aria-label={`${place.name} 更多操作`}><MoreHorizontal size={18} /></summary><div>
              <button type="button" disabled={busy || conflict || index === 0} onClick={() => onAssign(place.candidateId, activeDay!.day, activeDay!.orderedCandidateIds.indexOf(places[index - 1].candidateId))}>上移</button>
              <button type="button" disabled={busy || conflict || index === places.length - 1} onClick={() => onAssign(place.candidateId, activeDay!.day, activeDay!.orderedCandidateIds.indexOf(places[index + 1].candidateId))}>下移</button>
              <button type="button" disabled={busy || conflict} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setMovingId(place.candidateId); }}>移到其他日期</button>
              <button type="button" disabled={busy || conflict} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); assignToPeriod(place.candidateId, activeDay!.day, period === "morning" ? "afternoon" : "morning"); }}>移到{period === "morning" ? "下午" : "上午"}</button>
            </div></details><button className={board.remove} type="button" disabled={busy || conflict} aria-label={`将 ${place.name} 移回待安排`} onClick={() => onRemove(place.candidateId, activeDay!.day)}><X size={16} /></button></>}</div>
            {restriction?.strength !== "soft" && <small className={board.legacyPeriod}>固定时段：{label}{restriction?.evidence ? ` · ${restriction.evidence}` : " · 已保留原要求"}</small>}
            <button type="button" className={board.info} aria-expanded={expanded === place.candidateId} onClick={() => setExpanded(expanded === place.candidateId ? null : place.candidateId)}>查看信息</button>{details(place)}</li>;
        })}
      </ol>{!places.length && <p className={board.periodEmpty}>{confirmed ? "本时段暂无地点。" : `从待安排地点加入${label}，也可拖动地点到这里。`}</p>}
    </section>;
  }
  return <section className={`${styles.stage} ${board.stage}`} aria-label="已选地点的分天安排">
    {insertionHint && <p className={styles.sourceNote} role="status">{insertionHint}</p>}
    <div className={styles.stageHeading}><div><small>02 · PLAN YOUR DAYS</small><h2>一天一天，安排你想去的地方</h2><p>先选一天，再把地点加入上午或下午。每个地点都需选择时段，交通与开放窗口稍后核对。</p></div><span className={styles.sourceBadge}><ShieldCheck size={15} />Google 地点</span></div>
    <nav className={board.dayNav} aria-label={movingId ? "选择地点要移入的旅行日" : "选择要编辑的旅行日"}>{days.map((day) => <button key={day.day} type="button" aria-pressed={activeDay?.day === day.day} disabled={busy && Boolean(movingId)} onClick={() => chooseDay(day.day)}
      onDragOver={(event) => { if (!busy && !confirmed && !conflict) event.preventDefault(); }} onDrop={(event) => dropOnDay(event, day.day)}>
      <span>{movingId ? "移到 " : ""}DAY {String(day.day).padStart(2, "0")}</span><strong>{day.date?.slice(5).replace("-", "/") || `第 ${day.day} 天`}</strong><small>{day.orderedCandidateIds.length} 处{day.dayPurpose === "rest" ? " · 休息日" : ""}</small></button>)}</nav>
    {movingId && <p className={board.notice} role="status">将“{byId.get(movingId)?.name}”移到哪一天？选择上方 Day。<button type="button" onClick={() => setMovingId(null)}>取消移动</button></p>}
    {conflict && <div className={board.conflict} role="alert"><p>服务器规划已有更新，本地安排已保留。请核对后选择：</p><button type="button" disabled={busy} onClick={onKeepLocal}>以最新版本保留我的安排</button><button type="button" disabled={busy} onClick={onUseLatest}>载入服务器安排</button></div>}
    <div className={board.columns}><div className={board.pool}><div className={board.panelHeading}><h3>待安排地点</h3><span>{pending.length} 处</span></div>
      {pending.length === 0 && <div className={board.empty}><Check size={24} /><p>已选地点都已安排。</p><small>可从当前日移出，再加入其他日期。</small></div>}
      {pending.map((place) => <article key={place.candidateId} className={board.candidate} draggable={!busy && !confirmed && !conflict} onDragStart={(event) => startDrag(event, place.candidateId)}><span className={board.category}>{place.category}</span><h4>{place.name}</h4><p className={board.area}><MapPin size={13} />{place.area || place.address || "新加坡"}</p>{assigned.has(place.candidateId) && <p className={board.unresolved}>原 Day {days.find((day) => day.orderedCandidateIds.includes(place.candidateId))?.day} 尚未选择上午或下午，请补充安排。</p>}{place.reason && <p>{place.reason}</p>}
        <button type="button" className={board.poolInfo} aria-expanded={expanded === place.candidateId} onClick={() => setExpanded(expanded === place.candidateId ? null : place.candidateId)}>查看信息</button>{!confirmed && <div className={board.addPeriods}><span>加入 Day {activeDay?.day}</span><button type="button" disabled={busy || conflict || !activeDay} aria-label={`将 ${place.name} 加入 Day ${activeDay?.day} 上午`} onClick={() => activeDay && assignToPeriod(place.candidateId, activeDay.day, "morning")}>上午<ArrowRight size={13} /></button><button type="button" disabled={busy || conflict || !activeDay} aria-label={`将 ${place.name} 加入 Day ${activeDay?.day} 下午`} onClick={() => activeDay && assignToPeriod(place.candidateId, activeDay.day, "afternoon")}>下午<ArrowRight size={13} /></button></div>}{details(place)}</article>)}
    </div><div className={board.current}><div className={board.panelHeading}><div><small>{activeDay?.date}</small><h3>Day {activeDay?.day} · 当前安排</h3></div>{!confirmed && activeDay && days.length > 1 && <details className={board.menu}><summary aria-label={`Day ${activeDay.day} 更多操作`}><MoreHorizontal size={20} /></summary><div><button type="button" disabled={busy || conflict} onClick={() => requestDelete(activeDay.day)}>删除此旅行日</button></div></details>}</div>
      <p className={board.summary}><Clock3 size={14} />计划停留 {hoursLabel(total)}<span>交通稍后核算</span></p>{activeDay?.warnings?.map((warning) => <p className={styles.warning} key={warning}>{warning}</p>)}
      <div className={board.periods}>{periodStops("morning")}{periodStops("afternoon")}</div>{!currentPlaces.length && activeDay?.dayPurpose === "rest" && <p className={board.periodHelp}>这天保留为休息／自由日，无需选择时段。</p>}
    </div></div>
    {invalidIds.length > 0 && <p className={styles.error} role="alert">{invalidIds.length} 个本地地点已不在已选清单中。<button type="button" onClick={onUseLatest}>载入服务器安排</button></p>}{(error || validation) && <p className={styles.error} role="alert">{error || validation}</p>}
    {!confirmed && <div className={board.footer}><p role="status">{unconfirmed ? "尚未确认 · 本次访问已暂存" : "选择目标日后即可加入地点"}</p><div>{onBackToSelection && <button type="button" disabled={busy} className={styles.secondaryAction} onClick={onBackToSelection}><ArrowLeft size={14} />返回挑地点</button>}{canUndoDelete && <button type="button" disabled={busy} className={styles.secondaryAction} onClick={onUndoDelete}><RotateCcw size={14} />撤回删日</button>}<button type="button" className={styles.primaryAction} disabled={busy || !assigned.size || conflict || Boolean(invalidIds.length)} onClick={confirmBoard}>{busy ? "正在保存安排…" : "确认分天并继续"}<ArrowRight size={16} /></button></div></div>}
    {confirmed && <p className={styles.confirmed}><Check size={16} />分天安排已确认。</p>}
    <dialog ref={modal} className={board.dialog} onCancel={() => { setPendingDelete(null); setRestDays(null); setPendingPeriod(null); }}>
      {pendingPeriod && <><h3>修改“{byId.get(pendingPeriod.id)?.name}”的固定时段？</h3><p>已保留的要求是{pendingPeriod.previous === "morning" ? "上午" : "下午"}。这次会明确改为 Day {pendingPeriod.day} 的{pendingPeriod.period === "morning" ? "上午" : "下午"}；后续将重新核对开放、交通和航班时间。</p><div><button type="button" autoFocus onClick={() => setPendingPeriod(null)}>保留原要求</button><button type="button" disabled={busy || conflict} onClick={() => { onAssign(pendingPeriod.id, pendingPeriod.day, pendingPeriod.index, pendingPeriod.period); setPendingPeriod(null); setValidation(""); }}>确认修改时段</button></div></>}
      {restDays ? <><h3>将空白日保留为休息／自由日？</h3><p>{restDays.map((day) => `Day ${day}（${days.find((item) => item.day === day)?.date}）`).join("、")}尚未安排地点，确认后保留为自由日。</p><div><button type="button" autoFocus onClick={() => setRestDays(null)}>返回安排</button><button type="button" disabled={busy} onClick={() => { onConfirm(restDays); setRestDays(null); }}>确认并继续</button></div></> : pendingDelete !== null ? <><h3>删除 Day {pendingDelete} 的旅行日期？</h3><p>旅行日期将从 {days[0]?.date}–{days.at(-1)?.date}（{days.length} 天）变为 {pendingDelete === 1 ? days[1]?.date : days[0]?.date}–{pendingDelete === 1 ? days.at(-1)?.date : days.at(-2)?.date}（{days.length - 1} 天）。</p><p>本地安排会随日期一起保存。被删日地点返回待安排，后续日期重新编号；预计住宿夜数从 {days.length - 1} 晚变为 {days.length - 2} 晚，实际夜数待航班确认。保存后仍可撤回删日。</p><label><input type="checkbox" checked={skipDelete} onChange={(event) => setSkipDelete(event.target.checked)} />本次访问不再弹出删日确认</label><div><button type="button" autoFocus onClick={() => setPendingDelete(null)}>取消</button><button type="button" disabled={busy} onClick={() => { try { if (skipDelete) sessionStorage.setItem("tw-planning-skip-day-delete-dialog", "1"); } catch { /* Optional preference. */ } onDeleteDay(pendingDelete); setPendingDelete(null); }}>确认删除</button></div></> : null}
    </dialog>
  </section>;
}
