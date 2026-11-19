"use client";

import { useId, useRef, useState, type DragEvent, type FormEvent } from "react";
import { GripVertical } from "lucide-react";
import { PlanningTimeOverrideSchema, singleEndPlanningWindow, type PlanningTimeOverride, type PlanningLocalBlock } from "@/lib/travel/planning-time-overrides";
import { hoursInput, hoursLabel, hoursToMinutes, outsideRecommendedDuration, sameVisitPlaceIds } from "@/lib/travel/planning-duration";
import { buildPlanningDayTimelineGroups, planningTimelineClock, type PlanningTimelineScene } from "@/lib/travel/planning-day-timeline";
import { previewPlanningCapacity } from "@/lib/travel/planning-capacity";
import { readableMinutes } from "@/lib/travel/planning-conflicts";
import { ScheduleAttractionSearch, type AttractionSearchActions } from "./schedule-attraction-search";
import type { DayEstimate } from "./schedule-stage";
import { ScheduleSaveFeedback, type ScheduleSaveFailure } from "./schedule-save-feedback";
import styles from "./schedule-time-editor.module.css";

type Anchor = { nodeId: string; placement: "before" | "after" };
type BlockForm = { id?: string; kind: PlanningLocalBlock["kind"]; title: string; details: string; minutes: string; position: string };
type EditorProps = AttractionSearchActions & {
  estimate: DayEstimate; estimateStale?: boolean; busy: boolean;
  days?: Array<{ day: number; date: string }>; estimates?: DayEstimate[]; blockPlanChanges?: boolean;
  staleEstimateDays?: number[];
  onSave: (value: PlanningTimeOverride) => Promise<boolean>; onDirtyChange: (day: number, dirty: boolean) => void;
  onEditFlights?: () => void;
  saveFailure?: ScheduleSaveFailure;
  onDismissSaveFailure?: () => void;
  onReviewBoard?: (context?: { day: number; anchor?: Anchor }) => void;
  onSearchBaggagePlaces?: (query: string, day: number) => Promise<Array<{ placeId: string; name: string; address: string }>>;
};
const kindLabel = { meal: "吃饭", rest: "休息", custom: "自定义" } as const;
function originalValues(estimate: DayEstimate) {
  return { visits: Object.fromEntries((estimate.scenes || []).map((scene) => [scene.candidateId, scene.selectedVisitMinutes ?? estimate.overrides?.visitMinutesByPlaceId?.[scene.candidateId] ?? scene.recommendedMinutes ?? 90])),
    includedMeals: Object.fromEntries((estimate.scenes || []).filter((scene) => scene.sceneRole === "culinary_area").map((scene) => [scene.candidateId, estimate.overrides?.includedMealMinutesByPlaceId?.[scene.candidateId] ?? scene.includedMealMinutes ?? 0])) };
}
function editorValues(estimate: DayEstimate) {
  const original = originalValues(estimate);
  return { window: estimate.dailyWindow || { start: estimate.metrics.startTime || "09:30", preferredReturn: estimate.metrics.requestedReturnTime, latestReturn: estimate.metrics.requestedReturnTime },
    visits: Object.fromEntries(Object.entries(original.visits).map(([id, value]) => [id, hoursInput(value)])),
    includedMeals: Object.fromEntries(Object.entries(original.includedMeals).map(([id, value]) => [id, hoursInput(value)])),
    blocks: estimate.localBlocks || estimate.overrides?.localBlocks || [] };
}
function adviceDuration(scene: Pick<PlanningTimelineScene, "recommendedDuration" | "recommendedMinutes">) {
  return scene.recommendedDuration ? `${hoursInput(scene.recommendedDuration.minMinutes)}–${hoursLabel(scene.recommendedDuration.maxMinutes)}` : scene.recommendedMinutes !== undefined ? `约 ${hoursLabel(scene.recommendedMinutes)}` : "建议时长待补充";
}
const positionKey = (anchor?: Anchor) => anchor ? `${anchor.placement}:${anchor.nodeId}` : "";
const anchorFromKey = (key: string): Anchor => { const [placement, ...id] = key.split(":"); return { nodeId: id.join(":"), placement: placement as Anchor["placement"] }; };

export function ScheduleTimeEditor({ estimate, estimateStale = false, busy, days, estimates, staleEstimateDays, blockPlanChanges = false, onSave, onDirtyChange, onEditFlights, saveFailure, onDismissSaveFailure, onReviewBoard, onSearchAttractions, onPreviewAttraction, onConfirmAttraction }: EditorProps) {
  const editorRef = useRef<HTMLFormElement>(null);
  const timeButtonRef = useRef<HTMLButtonElement>(null);
  const timeEditorId = useId();
  const [values, setValues] = useState(() => editorValues(estimate));
  const [original, setOriginal] = useState(() => originalValues(estimate));
  const [edited, setEdited] = useState<Record<string, boolean>>({});
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [timeOpen, setTimeOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(Boolean(estimate.overrides));
  const [outside, setOutside] = useState<{ value: PlanningTimeOverride; names: string[] } | null>(null);
  const [baselineEstimate, setBaselineEstimate] = useState(estimate);
  const [blockForm, setBlockForm] = useState<BlockForm | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedPosition, setSelectedPosition] = useState("");
  const [capacityNotice, setCapacityNotice] = useState("");
  const structureChanged = dirty && !sameVisitPlaceIds(Object.keys(values.visits), (estimate.scenes || []).map((scene) => scene.candidateId));
  const newerResult = (dirty || Boolean(blockForm)) && baselineEstimate !== estimate;
  const fixedTimes = Boolean(estimate.journey);
  const flightDay = estimate.journey?.kind;
  const canEditStart = flightDay !== "arrival" && flightDay !== "arrival_departure";
  const canEditEnd = flightDay !== "departure" && flightDay !== "arrival_departure";
  const canEditWindow = canEditStart || canEditEnd;
  const editingWindow = canEditWindow && Boolean(edited.window);
  const groups = buildPlanningDayTimelineGroups({ ...estimate, localBlocks: values.blocks, ...(dirty ? { scheduledLocalBlocks: [] } : {}) });
  const stops = (estimate.scheduledDay?.stops || []).filter((stop) => stop.kind !== "buffer");
  const positions = stops.flatMap((stop, index) => {
    const airport = /机场|airport/i.test(`${stop.categoryLabel || ""} ${stop.name}`) && stop.kind === "other";
    const choices: Array<{ key: string; text: string }> = [];
    if (!stop.id.endsWith("-airport-arrival") && !(airport && index === 0)) choices.push({ key: positionKey({ nodeId: stop.id, placement: "before" }), text: `在 ${stop.name} 之前` });
    if (!stop.id.endsWith("-airport-departure") && !(airport && index === stops.length - 1)) choices.push({ key: positionKey({ nodeId: stop.id, placement: "after" }), text: `在 ${stop.name} 之后` });
    return choices;
  });
  const localDirty = dirty || Boolean(blockForm);
  const visitMinutes = (id: string) => hoursToMinutes(values.visits[id] || "", original.visits[id], Boolean(edited[`visit:${id}`]));

  if (!localDirty && baselineEstimate !== estimate) {
    setBaselineEstimate(estimate); setValues(editorValues(estimate)); setOriginal(originalValues(estimate)); setEdited({});
  }
  function markDirty(key: string, preserveCapacityNotice = false) { setEdited((current) => ({ ...current, [key]: true })); setDirty(true); setConfirmed(false); setError(""); setSaveError(""); if (!preserveCapacityNotice) setCapacityNotice(""); onDirtyChange(estimate.day, true); }
  function currentProposal(blocks = values.blocks): PlanningTimeOverride {
    return { day: estimate.day,
      ...(!fixedTimes || editingWindow ? { dailyWindow: values.window } : {}),
      visitMinutesByPlaceId: { ...estimate.overrides?.visitMinutesByPlaceId, ...Object.fromEntries(Object.keys(values.visits).map((id) => [id, visitMinutes(id)])) },
      localBlocks: blocks };
  }
  function capacityAllows(proposed: PlanningTimeOverride) {
    // The server recalculates the effective flight bounds when a time preference changes.
    const assessment = previewPlanningCapacity(estimate, proposed, { stale: estimateStale || newerResult || structureChanged || (fixedTimes && editingWindow) });
    setCapacityNotice(assessment.status === "soft_overrun" ? assessment.message : "");
    if (assessment.status === "hard_exceeded") { setError(assessment.message); return false; }
    return true;
  }
  function openBlock(kind: PlanningLocalBlock["kind"], position = "", block?: PlanningLocalBlock) {
    setSearchOpen(false); setError(""); setSelectedPosition(position || positionKey(block?.anchor));
    setBlockForm({ ...(block ? { id: block.id } : {}), kind, title: block?.title || (kind === "custom" ? "" : kindLabel[kind]), details: block?.details || "", minutes: String(block?.durationMinutes || (kind === "meal" ? 45 : 30)), position: position || positionKey(block?.anchor) });
    onDirtyChange(estimate.day, true);
  }
  function closeBlockForm() { setBlockForm(null); setError(""); onDirtyChange(estimate.day, dirty); }
  function commitBlock() {
    if (!blockForm || busy) return;
    const duration = Number(blockForm.minutes);
    if (!blockForm.title.trim() || !positions.some((item) => item.key === blockForm.position) || !Number.isInteger(duration) || duration <= 0 || duration > 480) { setError("请填写标题、1–480 分钟的时长，并选择当前行程中的放置位置。"); return; }
    const previous = values.blocks.find((block) => block.id === blockForm.id);
    const block: PlanningLocalBlock = { id: previous?.id || `local-${crypto.randomUUID()}`, day: estimate.day, kind: blockForm.kind, title: blockForm.title.trim(), ...(blockForm.details.trim() ? { details: blockForm.details.trim() } : {}), durationMinutes: duration, anchor: anchorFromKey(blockForm.position), source: previous?.source || "user" };
    const nextBlocks = previous ? values.blocks.map((item) => item.id === block.id ? block : item) : [...values.blocks, block];
    if (!capacityAllows(currentProposal(nextBlocks))) return;
    setValues((current) => ({ ...current, blocks: nextBlocks }));
    setSelectedPosition(blockForm.position); setBlockForm(null); markDirty("localBlocks", true);
  }
  function beginDrag(event: DragEvent, key: string) { if (busy || blockForm) { event.preventDefault(); return; } event.dataTransfer.setData("application/x-travel-arrangement", key); event.dataTransfer.effectAllowed = key.startsWith("new:") ? "copy" : "move"; setDragging(key); }
  function drop(event: DragEvent, position: string) {
    event.preventDefault(); const key = event.dataTransfer.getData("application/x-travel-arrangement") || dragging; setDragging(null);
    if (!key || busy || !positions.some((item) => item.key === position)) return;
    if (key.startsWith("new:")) { const kind = key.slice(4) as PlanningLocalBlock["kind"]; if (kind in kindLabel) openBlock(kind, position); return; }
    const id = key.replace(/^move:/, "");
    if (!values.blocks.some((block) => block.id === id)) return;
    setValues((current) => ({ ...current, blocks: current.blocks.map((block) => block.id === id ? { ...block, anchor: anchorFromKey(position) } : block) }));
    setSelectedPosition(position); markDirty("localBlocks");
  }
  function dropZone(anchor: Anchor) {
    const key = positionKey(anchor);
    if (!dragging || !positions.some((item) => item.key === key)) return null;
    return <li className={styles.dropZone} key={`drop:${key}`} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = dragging.startsWith("new:") ? "copy" : "move"; }} onDrop={(event) => drop(event, key)}>放在这里 · {positions.find((item) => item.key === key)?.text}</li>;
  }
  function renderBlock(block: PlanningLocalBlock, time?: string) {
    return <article className={styles.localBlock} aria-label={`${kindLabel[block.kind]}安排：${block.title}`}>
      <button type="button" className={styles.dragHandle} draggable={!busy && !blockForm} aria-label={`拖动${block.title}`} onDragStart={(event) => beginDrag(event, `move:${block.id}`)} onDragEnd={() => setDragging(null)}><GripVertical size={17} aria-hidden="true" /></button>
      <div><strong>{block.title}</strong><small>{kindLabel[block.kind]} · {hoursLabel(block.durationMinutes)}{time && !localDirty ? ` · 预计 ${time}` : !block.anchor ? " · 待放置" : ""}</small>{block.details && <p>{block.details}</p>}</div>
      <div className={styles.blockActions}><button type="button" disabled={busy} onClick={() => openBlock(block.kind, "", block)}>编辑／移动</button><button type="button" disabled={busy || Boolean(blockForm)} onClick={() => { setValues((current) => ({ ...current, blocks: current.blocks.filter((item) => item.id !== block.id) })); markDirty("localBlocks"); }}>删除</button></div>
    </article>;
  }
  function discardChanges() {
    if (!window.confirm("是否放弃本日尚未确认的修改，并采用最新核算结果？已保存的机票和酒店仍保留。")) return;
    setValues(editorValues(estimate)); setOriginal(originalValues(estimate)); setBaselineEstimate(estimate); setEdited({}); setDirty(false); setBlockForm(null); setTimeOpen(false); setOutside(null); setError(""); setSaveError(""); setCapacityNotice(""); setConfirmed(Boolean(estimate.overrides)); onDirtyChange(estimate.day, false);
  }
  function cancelTimeEdit() {
    if (edited.window) {
      const next = { ...edited };
      delete next.window;
      const otherChanges = Object.values(next).some(Boolean);
      setValues((current) => ({ ...current, window: editorValues(baselineEstimate).window }));
      setEdited(next);
      setDirty(otherChanges);
      if (!otherChanges) setConfirmed(Boolean(baselineEstimate.overrides));
      setError("");
      setSaveError("");
      setCapacityNotice("");
      onDismissSaveFailure?.();
      onDirtyChange(estimate.day, otherChanges || Boolean(blockForm));
    }
    setTimeOpen(false);
    timeButtonRef.current?.focus();
  }
  async function save(value: PlanningTimeOverride) {
    setOutside(null);
    if (structureChanged) { setError("本日地点清单已变更，请先采用最新结果。未确认输入仍保留。"); return; }
    if (!capacityAllows(currentProposal())) return;
    setSaveError("");
    try {
      if (await onSave(value)) { setDirty(false); onDirtyChange(estimate.day, false); setError(""); setConfirmed(true); }
      else setSaveError("本次安排未保存，请重试；你的输入已保留。");
    } catch {
      setSaveError("本次安排未保存，请稍后重试；你的输入已保留。");
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    onDismissSaveFailure?.();
    setSaveError("");
    if (blockForm) { setError("请先完成当前标签，或取消标签编辑，再保存本日。"); return; }
    if (structureChanged) { setError("地点清单已变更，请采用最新结果后再调整。你的输入已保留。"); return; }
    const visitChanges = Object.fromEntries(Object.keys(values.visits).filter((id) => edited[`visit:${id}`]).map((id) => [id, visitMinutes(id)]));
    const includedChanges = Object.fromEntries(Object.keys(values.includedMeals).filter((id) => edited[`includedMeal:${id}`]).map((id) => [id, hoursToMinutes(values.includedMeals[id], original.includedMeals[id], true)]));
    if (Object.keys(values.includedMeals).some((id) => (includedChanges[id] ?? original.includedMeals[id]) > visitMinutes(id))) { setError("已含用餐不能超过该地点的停留时长。"); return; }
    const result = PlanningTimeOverrideSchema.safeParse({ day: estimate.day,
      ...(editingWindow ? { dailyWindow: values.window } : {}),
      ...(Object.keys(visitChanges).length ? { visitMinutesByPlaceId: { ...estimate.overrides?.visitMinutesByPlaceId, ...visitChanges } } : {}),
      ...(Object.keys(includedChanges).length ? { includedMealMinutesByPlaceId: { ...estimate.overrides?.includedMealMinutesByPlaceId, ...includedChanges } } : {}),
      ...(edited.localBlocks ? { localBlocks: values.blocks } : {}),
    });
    if (!result.success) { setError(result.error.issues[0]?.message || "请检查时长及时间偏好。"); return; }
    if (!capacityAllows(currentProposal())) return;
    const names = (estimate.scenes || []).filter((scene) => edited[`visit:${scene.candidateId}`] && outsideRecommendedDuration(visitMinutes(scene.candidateId), scene.recommendedDuration)).map((scene) => scene.name);
    if (names.length) { setOutside({ value: result.data, names }); return; }
    await save(result.data);
  }

  const failureBlock = saveFailure?.blockId && values.blocks.find((block) => block.id === saveFailure.blockId);
  const originalTravelIsManual = estimate.metrics.travelSource === "user" || estimate.transport?.source === "user";
  return <form ref={editorRef} tabIndex={-1} className={styles.editor} onSubmit={submit} aria-label={`Day ${estimate.day} 时间设置`}>
    <fieldset disabled={busy}><legend>本日安排</legend>
      {newerResult && <p className={styles.conflict} role="alert">{structureChanged ? "地点清单已有更新，请先采用最新结果。未确认输入仍保留。" : "已有新的核算结果；本地未确认输入仍保留，请核对后保存。"}</p>}
      <section className={styles.tools} aria-label="添加本日安排">
        <div className={styles.toolHeading}><strong>拖动添加</strong><small>也可点击标签选择位置</small></div>
        <div className={styles.toolButtons}>{(["meal", "rest", "custom"] as const).map((kind) => <button type="button" key={kind} draggable={!busy && !blockForm && positions.length > 0} disabled={Boolean(blockForm) || !positions.length} onDragStart={(event) => beginDrag(event, `new:${kind}`)} onDragEnd={() => setDragging(null)} onClick={() => openBlock(kind)}><GripVertical size={15} aria-hidden="true" />{kindLabel[kind]}</button>)}<details className={styles.addSight}><summary>增加景点</summary><div><button type="button" disabled={localDirty || blockPlanChanges || !onReviewBoard} onClick={() => onReviewBoard?.({ day: estimate.day, ...(selectedPosition ? { anchor: anchorFromKey(selectedPosition) } : {}) })}>返回分天板</button><button type="button" disabled={localDirty || blockPlanChanges || !onSearchAttractions} onClick={() => setSearchOpen(true)}>搜索景点并加入</button></div></details></div>
        {(localDirty || blockPlanChanges) && <small>请先保存未确认安排，再增加景点。</small>}
        {!positions.length && <p className={styles.note}>本日路线尚待核实；先保存核算后，再把标签放到真实节点前后。</p>}
      </section>
      {blockForm && <section className={styles.blockForm} aria-label={blockForm.id ? "编辑安排标签" : "添加安排标签"}>
        <h4>{blockForm.id ? "编辑" : "添加"}{kindLabel[blockForm.kind]}</h4>
        <div className={styles.blockFields}><label>标题<input data-arrangement-title value={blockForm.title} maxLength={80} onChange={(event) => setBlockForm({ ...blockForm, title: event.target.value })} /></label><label>时长（分钟）<input data-arrangement-duration type="number" min="1" max="480" step="1" value={blockForm.minutes} onChange={(event) => setBlockForm({ ...blockForm, minutes: event.target.value })} /></label></div>
        <label>详情（可选）<textarea maxLength={500} rows={2} value={blockForm.details} onChange={(event) => setBlockForm({ ...blockForm, details: event.target.value })} /></label>
        <label>放置位置<select value={blockForm.position} onChange={(event) => setBlockForm({ ...blockForm, position: event.target.value })}><option value="">请选择本日节点前后</option>{positions.map((item) => <option key={item.key} value={item.key}>{item.text}</option>)}</select></label>
        <div className={styles.inlineActions}><button type="button" onClick={commitBlock}>应用到本日安排</button><button type="button" className={styles.textAction} onClick={closeBlockForm}>取消标签编辑</button></div>
        <small>标题不会自动变成景点或取行李路线；需要真实景点请使用“增加景点”。</small>
        {error && <p className={styles.saveFeedback} role="alert"><strong>本次{kindLabel[blockForm.kind]}未应用：</strong>{error}</p>}
      </section>}
      {searchOpen && <ScheduleAttractionSearch day={estimate.day} days={days || [{ day: estimate.day, date: estimate.date }]} estimates={estimates || [estimate]} initialAnchor={selectedPosition ? anchorFromKey(selectedPosition) : undefined} estimateStale={estimateStale} staleEstimateDays={staleEstimateDays} busy={busy} blocked={localDirty || blockPlanChanges} onClose={() => setSearchOpen(false)} onSearchAttractions={onSearchAttractions} onPreviewAttraction={onPreviewAttraction} onConfirmAttraction={onConfirmAttraction} />}
      <section className={styles.journey} aria-label={fixedTimes ? "本日固定航旅与活动时间轴" : "本日行程时间轴"}>
        <div className={styles.sectionHeading}><strong>本日时间轴</strong><div className={styles.journeyActions}>
          {fixedTimes && onEditFlights && <button type="button" onClick={onEditFlights}>修改机票</button>}
          <button ref={timeButtonRef} type="button" aria-expanded={timeOpen} aria-controls={timeEditorId} onClick={() => setTimeOpen(!timeOpen)}>时间修改</button>
        </div></div>
        <section id={timeEditorId} className={styles.timePreferences} aria-label={`Day ${estimate.day} 时间修改`} hidden={!timeOpen}>
          {fixedTimes && <><strong>本日时段受航班约束</strong><p className={styles.note}>
            {flightDay === "arrival" ? "当地出发由抵达时刻和机场预留核算，可修改结束时间。"
              : flightDay === "departure" ? "可修改当地出发时间，结束须符合返程航班和机场预留。"
              : "当地出发和结束均按抵离航班与机场预留核算。"}要修改航班，请使用「修改机票」。
          </p>
            {estimate.effectiveWindow && <p className={styles.note}>当地可安排参考范围：{estimate.effectiveWindow.start}–{estimate.effectiveWindow.returnBy}。</p>}</>}
          {canEditWindow && <><div className={styles.window}>
              {canEditStart && <label>出发时间<input type="time" required value={values.window.start} onInvalid={() => setTimeOpen(true)} onChange={(event) => { setValues({ ...values, window: { ...values.window, start: event.target.value } }); markDirty("window"); }} /></label>}
              {canEditEnd && <>
                <label>结束时间<input type="time" required value={values.window.latestReturn} onInvalid={() => setTimeOpen(true)} onChange={(event) => { setValues({ ...values, window: singleEndPlanningWindow(values.window, event.target.value) }); markDirty("window"); }} /></label>
                <label>结束时间要求<select value={values.window.returnConstraint?.strength || "hard"} onChange={(event) => { setValues({ ...values, window: { ...values.window, returnConstraint: { strength: event.target.value as "soft" | "hard", source: "user", evidence: "用户在本日时间修改中选择" } } }); markDirty("window"); }}><option value="hard">必须不晚于结束时间</option><option value="soft">希望结束，可适当延后</option></select></label>
              </>}
            </div>
            {canEditEnd && values.window.preferredReturn !== values.window.latestReturn && <p className={styles.note}>原记录希望 {values.window.preferredReturn}、最晚 {values.window.latestReturn}，当前分别保留；修改结束时间后才合并为新的要求。</p>}
            <p className={styles.note}>点击「保存并核算本日」才更新当天安排。</p></>}
          <button type="button" className={styles.textAction} onClick={cancelTimeEdit}>{canEditWindow ? "取消时间修改" : "收起说明"}</button>
        </section>
        {groups.map((group) => <section className={styles.timelineGroup} key={group.id} aria-label={group.label}>
          <div className={styles.groupHeading}><h4>{group.label}</h4>{group.estimatedEnd && !localDirty && !estimateStale && <small>预计约 {planningTimelineClock(group.estimatedEnd)} 结束</small>}</div>
          <ol>{group.nodes.flatMap((node) => {
            if (node.kind === "flight") return [<li key={node.id} className={styles.flightNode}><strong>{node.milestone.label}</strong><p><time>{node.milestone.localDateTime ? node.milestone.localDateTime.replace("T", " ") : "时刻待补充"}</time><small>{node.milestone.airportName || "机场待补充"} · {node.milestone.timeZone ? `${node.milestone.timeZone} 当地时间` : "时区待补充"}</small></p></li>];
            if (node.kind === "travel") return [<li key={node.id} className={styles.travelNode}><div><strong>交通</strong><span>{originalTravelIsManual ? "待重新核算" : node.leg ? `约 ${hoursLabel(node.leg.minutes)}` : "交通待核实"}</span></div><small>{node.from} → {node.to}</small>{!node.leg && <small>缺少路段依据，不能按零耗时处理</small>}</li>];
            if (node.kind === "block") return [<li key={node.id} className={styles.blockNode}>{renderBlock(node.block, !estimateStale && node.startTime && node.endTime ? `${node.startTime}–${node.endTime}` : undefined)}</li>];
            const scene = node.scene; const stop = node.stop;
            const before = stop ? dropZone({ nodeId: stop.id, placement: "before" }) : null;
            const after = stop ? dropZone({ nodeId: stop.id, placement: "after" }) : null;
            return [before, <li key={node.id} className={scene ? styles.activityNode : styles.placeNode}>
              {scene ? <>
                <label className={styles.scene}><span><b>{scene.name}</b><time className={styles.arrivalTime}>{localDirty ? "保存并核算后更新到达时间" : estimateStale ? "到达时间待重新核算" : stop?.time ? `预计约 ${planningTimelineClock(stop.time)} 到达` : "到达时间待核算"}</time><small>开放：{scene.regularOpeningHours || "待核实"}</small><small>建议：{adviceDuration(scene)}</small></span><span><input type="number" required min="0.25" max="8" step="any" aria-label={`${scene.name}停留小时`} value={values.visits[scene.candidateId] || ""} onChange={(event) => { setValues({ ...values, visits: { ...values.visits, [scene.candidateId]: event.target.value } }); markDirty(`visit:${scene.candidateId}`); }} /><span>小时</span></span></label>
                {scene.durationReason && <small className={styles.durationReason}>{scene.durationReason}</small>}
                {scene.sceneRole === "culinary_area" && <details className={styles.includedMeal}><summary>此体验已含用餐</summary><label>已含用餐（小时）<input type="number" min="0" max="4" step="any" aria-label={`${scene.name}已含用餐小时`} value={values.includedMeals[scene.candidateId] ?? "0"} onChange={(event) => { setValues({ ...values, includedMeals: { ...values.includedMeals, [scene.candidateId]: event.target.value } }); markDirty(`includedMeal:${scene.candidateId}`); }} /></label><small>包含在地点停留内，只计一次。</small></details>}
              </> : <><strong>{node.displayName || stop?.name || node.milestone?.airportName || node.label}</strong><p><time>{localDirty ? "保存并核算后更新时间" : estimateStale ? "时刻待重新核算" : stop?.time ? `预计约 ${planningTimelineClock(stop.time)}${node.timingKind === "airport_process" ? "" : node.timingKind === "departure" ? " 出发" : " 到达"}` : "时刻待核算"}</time>{node.timingNote && <small>{node.timingNote}</small>}</p></>}
            </li>, after];
          })}</ol>
        </section>)}
        {!estimate.scenes?.length && <p className={styles.note}>本日未选景点，可保留空白或添加自己的安排。</p>}
        <details className={styles.timeBasis}><summary>查看时间依据与来源</summary>
          {estimate.effectiveWindow && <p>当地可安排参考范围 {estimate.effectiveWindow.start}–{estimate.effectiveWindow.returnBy}，依据已确认机票和时间偏好核算；交通另计。</p>}
          {estimate.journey && <p>{estimate.journey.airportProcessMinutes > 0 ? `抵达后入境及取行李估算约 ${hoursLabel(estimate.journey.airportProcessMinutes)}，已在当地起算前处理。` : ""}酒店办理、寄存及取物不自动扣时；需要时自行添加标签。</p>}
          {estimate.journey?.milestones.filter((item) => item.id.endsWith("departure")).map((flight) => <p key={flight.id}>建议至少提前 3 小时到达机场办理手续{flight.airportReminderAt ? `（建议 ${flight.airportReminderAt.replace("T", " ")} 前到达）` : ""}，以所乘航班要求为准；赴机场交通另计。</p>)}
          <p>路线采用 Google 参考；开放信息请出发前复核。航班为已确认时刻，地面过程为预计。</p>
        </details>
      </section>
      <section className={styles.freeAllocation} aria-label="尚未分配时间"><div className={styles.freeHeading}><strong>尚未分配</strong><span>{estimateStale ? "待重新核算" : localDirty ? "待保存并核算" : `约 ${hoursLabel(estimate.metrics.freeMinutes)}`}</span></div><p className={styles.note}>扣除必要交通和已安排活动后，剩余可由你自由安排的时间。可以添加吃饭、休息或自定义，也可以保留空白。</p></section>
      <div className={styles.confirmRow}><button type="submit" disabled={busy || structureChanged || Boolean(blockForm) || (!estimateStale && !dirty && confirmed)}>{busy ? "正在核算本日…" : "保存并核算本日"}</button><small>{estimateStale ? "请按当前安排重新核算" : localDirty ? "保存后更新本日总结" : estimate.metrics.overtimeMinutes > 0 ? "待调整" : confirmed ? "本日设置已保存" : "无修改可直接查看下一天"}</small>{localDirty && <button className={styles.discard} type="button" disabled={busy} onClick={discardChanges}>放弃未确认更改，采用最新结果</button>}</div>
      {capacityNotice && !error && !saveFailure && !saveError && <p className={styles.draftNotice} role="status">{capacityNotice}</p>}
      {!blockForm && (error ? <p className={styles.saveFeedback} role="alert">{error}</p> : saveFailure ?
        <ScheduleSaveFeedback failure={saveFailure} action={failureBlock ? <button type="button" className={styles.textAction} onClick={() => {
          openBlock(failureBlock.kind, "", failureBlock);
          requestAnimationFrame(() => editorRef.current?.querySelector<HTMLInputElement>("[data-arrangement-duration]")?.focus());
        }}>编辑{kindLabel[failureBlock.kind]}</button> : !localDirty && onDismissSaveFailure ? <button type="button" className={styles.textAction} onClick={onDismissSaveFailure}>关闭本次提示</button> : undefined} />
        : saveError ? <p className={styles.saveFeedback} role="alert">{saveError}</p>
        : estimate.metrics.overtimeMinutes > 0 && <p className={styles.saveFeedback} role="alert">上次核算预计超过{estimate.metrics.terminalKind === "airport" ? "到达机场" : "返店"}截止约 {readableMinutes(estimate.metrics.overtimeMinutes)}。剩余时间为零，请先调整本日安排。</p>)}
    </fieldset>
    {outside && <div className={styles.confirmBackdrop}><section className={styles.confirmDialog} role="dialog" aria-modal="true" aria-labelledby={`duration-confirm-${estimate.day}`} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); setOutside(null); }
      if (event.key === "Tab") { const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"); const first = buttons[0], last = buttons[buttons.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
    }}><h3 id={`duration-confirm-${estimate.day}`}>停留时长超出常见建议</h3><p>{outside.names.join("、")}的选择超出建议范围，是否仍采用并核对本日可行性？</p><p className={styles.note}>建议范围保持原值，营业与返店边界仍须满足。</p><div><button type="button" autoFocus onClick={() => setOutside(null)}>返回调整</button><button type="button" disabled={busy || structureChanged} onClick={() => void save(outside.value)}>仍采用并确认</button></div></section></div>}
  </form>;
}
