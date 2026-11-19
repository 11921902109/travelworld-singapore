"use client";

import { useRef, useState, type FormEvent } from "react";
import { ArrowRight, ExternalLink, Hotel, MapPin } from "lucide-react";
import type { StayAdvice } from "@/lib/travel/planning-stays";
import type { ConfirmedAccommodationAnchor, TravelCommerce } from "@/lib/travel/types";
import { normalizeStayArea, staySegmentConfigKey, type StaySegmentConfig } from "@/lib/travel/planning-stay-segments";
import { assessHotelBudget, formatBudgetAmount, hotelBudgetAcknowledgementKey, hotelBudgetGroups } from "@/lib/travel/hotel-budget";
import type { HotelQuoteJob } from "@/lib/travel/planning-hotel-jobs";
import type { HotelVerifiedPlace } from "@/lib/travel/planning-hotel-snapshot";
import { hotelBatchWaiting, hotelQuoteJobMatchesSegment } from "@/lib/travel/planning-hotel-batch";
import { cnyReferenceLabel, foreignBudgetNotice } from "@/lib/travel/cny-price";
import styles from "./planning-journey.module.css";
import feedback from "./stay-stage.module.css";

export type StaySegment = {
  id: string;
  startDay: number;
  area: string;
  budgetPerNight?: { amount: number; currency: "SGD" | "CNY" } | null;
  checkInDate: string;
  checkOutDate: string;
  nights?: number;
  hotelSearchId?: string;
  budgetReviewRequired?: boolean;
  budgetAcknowledgement?: string;
  hotel?: ConfirmedAccommodationAnchor;
  hotelCandidates?: Array<{ placeId: string; name: string; address: string; rating: number | null; commerce: TravelCommerce | null;
    quoteStatus?: "not_requested" | "available" | "unavailable" | "failed"; quoteJobId?: string; verifiedPlace?: HotelVerifiedPlace }>;
};

export type StaySaveResult = {
  saved: true;
  unchanged: boolean;
  segments: StaySegment[];
  changedFields: string[];
  invalidatedHotelSegments: number[];
  budgetReviewSegments: number[];
  message: string;
};

type Props = {
  days: number;
  noOvernight?: boolean;
  boundaryNote?: string;
  initialArea: string;
  advice: StayAdvice | null;
  segments: StaySegment[];
  busy: boolean;
  error?: string;
  affectedDays?: string[];
  onAdvise: () => void;
  onSegments: (segments: StaySegmentConfig[]) => void | Promise<StaySaveResult | null>;
  onSearchHotels: (startDay: number) => void;
  onSelectHotel: (startDay: number, placeId: string, budgetAcknowledged?: boolean) => void | Promise<boolean>;
  quoteJob?: HotelQuoteJob;
  quotePolling?: boolean;
  onQuoteHotels?: (startDay: number, placeIds?: string[]) => void;
  onResumeQuotes?: () => void;
  onConfirm: () => void;
  onReviewBoard: () => void;
};

type SegmentDraft = { startDay: number; area: string; budget: string; currency: "SGD" | "CNY" };
type EditorState = { serverKey: string; drafts: SegmentDraft[]; notice: string; externalConflict: boolean; pendingKey: string | null };

function draftFrom(segments: StaySegment[]): SegmentDraft[] {
  return segments.map((segment) => ({ startDay: segment.startDay, area: segment.area,
    budget: segment.budgetPerNight?.amount ? String(segment.budgetPerNight.amount) : "",
    currency: segment.budgetPerNight?.currency || "CNY" }));
}

function configFrom(segments: SegmentDraft[]): StaySegmentConfig[] {
  return segments.map((segment) => ({ startDay: segment.startDay, area: segment.area.trim(),
    budgetPerNight: segment.budget.trim() ? { amount: Number(segment.budget), currency: segment.currency } : null }));
}

function sameAreaPlan(left: Array<{ startDay: number; area: string }>, right: Array<{ startDay: number; area: string }>) {
  return left.length === right.length && left.every((segment, index) => segment.startDay === right[index].startDay && normalizeStayArea(segment.area) === normalizeStayArea(right[index].area));
}

function stayOptionLabel(id: string) { return id === "same" ? "全程同住" : "中途换一次"; }

function needsBudgetAcknowledgement(segment: StaySegment) {
  const candidate = segment.hotelCandidates?.find((hotel) => hotel.placeId === segment.hotel?.placeId);
  return Boolean(candidate && assessHotelBudget(segment.budgetPerNight, candidate.commerce).status === "over_budget" &&
    segment.budgetAcknowledgement !== hotelBudgetAcknowledgementKey(segment, candidate));
}

function HotelResults({ segment, formIndex, disabled, onSelect }: { segment: StaySegment; formIndex: number; disabled: boolean; onSelect: Props["onSelectHotel"] }) {
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState("");
  const pending = (segment.hotelCandidates || []).filter((hotel) => hotel.quoteStatus === "not_requested");
  const groups = hotelBudgetGroups(segment.budgetPerNight, (segment.hotelCandidates || []).filter((hotel) => hotel.quoteStatus !== "not_requested"));
  const hasBudget = Boolean(segment.budgetPerNight);
  const editField = (field: "budget" | "area") => {
    const target = document.getElementById(`stay-${field}-${formIndex}`);
    target?.focus(); target?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const renderHotel = ({ hotel, assessment }: (typeof groups.primary)[number]) => {
    const selected = hotel.placeId === segment.hotel?.placeId;
    const mustAcknowledge = assessment.status === "over_budget" && segment.budgetAcknowledgement !== hotelBudgetAcknowledgementKey(segment, hotel);
    return <div key={hotel.placeId} className={styles.hotelOption}>
      <div><strong>{hotel.name}</strong><small>{hotel.address}{hotel.rating ? ` · Google ${hotel.rating.toFixed(1)}` : ""}</small><em>{hotel.commerce?.status === "available" ? cnyReferenceLabel(hotel.commerce.price) : hotel.quoteStatus === "failed" ? "本次查询失败，暂无法核实报价，不代表无房" : "本次未匹配到可核实报价"}</em>
        {hasBudget && hotel.quoteStatus !== "not_requested" && <small className={assessment.status === "over_budget" ? feedback.overBudget : assessment.status === "within_budget" ? feedback.withinBudget : feedback.budgetUnknown}>{assessment.message}</small>}
        {hotel.commerce?.bookingUrl && <a href={hotel.commerce.bookingUrl} target="_blank" rel="noreferrer">飞猪详情<ExternalLink size={11} /></a>}
        </div>
      <button type="button" disabled={disabled || selectingId !== null} onClick={async () => {
        if (assessment.status === "over_budget" && !window.confirm(`${hotel.name}：${assessment.message}（预算上限 ${formatBudgetAmount(segment.budgetPerNight!.amount, segment.budgetPerNight!.currency)}／晚）。这是每晚起参考价，最终房型、税费及总价以预订页为准。仍选择这家酒店吗？`)) return;
        setSelectingId(hotel.placeId); setSelectionError("");
        try { if (await onSelect(segment.startDay, hotel.placeId, assessment.status === "over_budget") === false) setSelectionError("本次选择尚未保存，之前有效的酒店选择仍保留，请重试。"); }
        catch { setSelectionError("酒店选择保存失败，请重试。"); }
        finally { setSelectingId(null); }
      }}>{selectingId === hotel.placeId ? "正在保存此选择…" : selected ? mustAcknowledge ? "确认预算选择" : "已选" : "选这家"}</button>
    </div>;
  };
  return <div className={feedback.budgetResults}>
    {hasBudget && <p className={feedback.budgetNote}>每晚预算上限 {formatBudgetAmount(segment.budgetPerNight!.amount, segment.budgetPerNight!.currency)}。仅核对本次有限候选的同币种、每晚起参考价；最终房型、税费与总价请在预订页复核。</p>}
    {hasBudget && !groups.primary.length && !pending.length && <p className={feedback.budgetNotice} role="status">{groups.unknownCount
      ? "本次查询尚未找到可核实参考价符合预算的候选；部分价格未知或币种不同，暂无法核对。可以调整预算或住宿区域，也可查看其他候选。"
      : "本次已查询的酒店中，暂未找到每晚参考价在预算上限内的候选。可以调整预算或住宿区域，也可查看其他价位。"}</p>}
    {hasBudget && !groups.primary.length && !pending.length && <div className={feedback.budgetActions}><button type="button" disabled={disabled} className={styles.secondaryAction} onClick={() => editField("budget")}>调整预算</button><button type="button" disabled={disabled} className={styles.secondaryAction} onClick={() => editField("area")}>更换区域</button></div>}
    {pending.length > 0 && <p className={feedback.budgetNote}>本段尚未完成报价，请重新搜索本段酒店与价格。</p>}
    {groups.primary.length > 0 && <div className={styles.hotelList}>{groups.primary.map(renderHotel)}</div>}
    {groups.alternatives.length > 0 && <>
      <button type="button" className={styles.secondaryAction} aria-expanded={showAlternatives} onClick={() => setShowAlternatives((value) => !value)}>{showAlternatives ? "收起其他候选" : `查看其他价位／待核价候选（${groups.alternatives.length}）`}</button>
      {showAlternatives && <div className={styles.hotelList}>{groups.alternatives.map(renderHotel)}</div>}
    </>}
    {selectionError && <p className={styles.error} role="alert">{selectionError}</p>}
  </div>;
}

function HotelBatchResults({ segment, formIndex, disabled, onSelect, quoteJob, onResumeQuotes, onQuoteHotels, quotePolling }: {
  segment: StaySegment; formIndex: number; disabled: boolean; onSelect: Props["onSelectHotel"]; quoteJob?: HotelQuoteJob;
  onResumeQuotes?: Props["onResumeQuotes"]; onQuoteHotels?: Props["onQuoteHotels"]; quotePolling: boolean;
}) {
  const job = hotelQuoteJobMatchesSegment(quoteJob, segment) ? quoteJob : undefined;
  const waiting = hotelBatchWaiting(job);
  const failedIds = (segment.hotelCandidates || []).filter((hotel) => hotel.quoteStatus === "failed").map((hotel) => hotel.placeId);
  return <>
    {job && <div className={feedback.quoteStatus} role="status"><span>{job.message}</span>{job.status === "timed_out" && onResumeQuotes && <button type="button" disabled={disabled} onClick={onResumeQuotes}>继续读取本次报价</button>}</div>}
    {waiting ? <p className={feedback.budgetNote}>本批酒店与价格处理完成后统一展示；之前已保存的酒店选择仍保留。</p> : <>
      <HotelResults segment={segment} formIndex={formIndex} disabled={disabled} onSelect={onSelect} />
      {Boolean(segment.hotelCandidates?.length && onQuoteHotels && (failedIds.length || job?.status === "failed")) && <button type="button" className={styles.secondaryAction} disabled={disabled || quotePolling} onClick={() => onQuoteHotels?.(segment.startDay, failedIds.length ? failedIds : undefined)}>重试本段报价</button>}
    </>}
  </>;
}

export function StayStage({ days, noOvernight: noOvernightBoundary = false, boundaryNote, initialArea, advice, segments, busy, error, affectedDays = [], onAdvise, onSegments, onSearchHotels, onSelectHotel, onConfirm, onReviewBoard, quoteJob, quotePolling = false, onQuoteHotels, onResumeQuotes }: Props) {
  const serverKey = staySegmentConfigKey(segments);
  const [editor, setEditor] = useState<EditorState>(() => ({ serverKey,
    drafts: segments.length ? draftFrom(segments) : [{ startDay: 1, area: initialArea || "Singapore", budget: "", currency: "CNY" as const }],
    notice: "", externalConflict: false, pendingKey: null }));
  const hotelHeading = useRef<HTMLHeadingElement>(null);
  const settingsHeading = useRef<HTMLHeadingElement>(null);
  const [adopted, setAdopted] = useState<{ optionId: string; configKey: string } | null>(null);
  const [customized, setCustomized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const noOvernight = noOvernightBoundary;
  const maxSegments = Math.min(4, Math.max(1, days));
  if (editor.serverKey !== serverKey) {
    const canSync = staySegmentConfigKey(configFrom(editor.drafts)) === editor.serverKey || editor.pendingKey === serverKey;
    setEditor({ serverKey, drafts: canSync ? draftFrom(segments) : editor.drafts,
      notice: editor.pendingKey === serverKey ? "住宿安排已保存，请继续为每段搜索并选择酒店。" : "",
      externalConflict: !canSync, pendingKey: null });
  }
  const draftSegments = editor.drafts;
  const activeSegments = draftSegments.slice(0, maxSegments);
  const dirty = staySegmentConfigKey(configFrom(activeSegments)) !== serverKey;
  const currencyReview = activeSegments.some((segment) => segment.currency !== "CNY" && Boolean(segment.budget));
  const locked = busy || saving;
  const recommended = advice?.options.find((option) => option.id === advice.recommendationId);
  const adoptedMatches = adopted && !customized && adopted.configKey === staySegmentConfigKey(configFrom(activeSegments));
  const currentOption = segments.length > 0 || adoptedMatches || customized ? advice?.options.find((option) => sameAreaPlan(option.segments, activeSegments)) : undefined;
  const settingsSource = adoptedMatches ? `已采用 · ${stayOptionLabel(adopted.optionId)}`
    : customized || segments.length > 0 && !currentOption ? "已自定义"
      : segments.length > 0 && currentOption ? `当前区域 · ${stayOptionLabel(currentOption.id)}` : "待设置";

  function focusSettings() {
    window.requestAnimationFrame(() => {
      settingsHeading.current?.focus({ preventScroll: true });
      settingsHeading.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    });
  }

  function fieldErrors(segment: SegmentDraft, index: number) {
    return {
      area: segment.area.trim().length < 2 ? `请填写第 ${index + 1} 段住宿区域（至少 2 个字）。` : segment.area.trim().length > 80 ? "区域名称不能超过 80 个字。" : "",
      budget: segment.currency !== "CNY" && segment.budget ? "请重新填写人民币预算，或明确取消本段预算；原外币金额不会自动换算。" : segment.budget.trim() && (!Number.isFinite(Number(segment.budget)) || Number(segment.budget) <= 0 || Number(segment.budget) > 100_000) ? "预算须大于 0 且不超过 100000；也可以留空。" : "",
      day: segment.startDay > days || segment.startDay < 1 || index === 0 && segment.startDay !== 1 || index > 0 && segment.startDay <= activeSegments[index - 1].startDay ? "换住日期须逐段递增，每段至少住宿一晚。" : "",
    };
  }

  function updateSegment(index: number, patch: Partial<SegmentDraft>) {
    setAdopted(null); setCustomized(true);
    setEditor((current) => ({ ...current, drafts: current.drafts.map((segment, position) => position === index ? { ...segment, ...patch } : segment), notice: "" }));
    setFormError("");
  }

  function chooseSegmentCount(count: number) {
    setAdopted(null); setCustomized(true);
    setEditor((current) => ({ ...current, notice: "", drafts: Array.from({ length: count }, (_, index) => ({
      startDay: index + 1,
      area: current.drafts[index]?.area || (index === 0 ? initialArea || "Singapore" : ""),
      budget: current.drafts[index]?.budget || "", currency: current.drafts[index]?.currency || "CNY",
    })) }));
    setFormError("");
  }

  async function saveSegments(input: StaySegmentConfig[], destination: "hotels" | "settings" = "hotels") {
    if (locked) return;
    setEditor((current) => ({ ...current, pendingKey: staySegmentConfigKey(input) }));
    setSaving(true);
    setFormError("");
    try {
      const result = await onSegments(input);
      if (result?.saved) {
        setEditor({ serverKey: staySegmentConfigKey(result.segments), drafts: draftFrom(result.segments),
          notice: result.message, externalConflict: false, pendingKey: null });
        if (destination === "settings") focusSettings();
        else window.requestAnimationFrame(() => { hotelHeading.current?.focus(); hotelHeading.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); });
      } else if (result === null) {
        setEditor((current) => ({ ...current, pendingKey: null }));
        setFormError("本轮尚未保存，请查看下方具体提示后重试。");
      }
    } catch {
      setEditor((current) => ({ ...current, pendingKey: null }));
      setFormError("保存失败，本轮更改未保存；请重试。");
    } finally { setSaving(false); }
  }

  function submitSegments(event: FormEvent) {
    event.preventDefault();
    const invalid = activeSegments.findIndex((segment, index) => Object.values(fieldErrors(segment, index)).some(Boolean));
    if (!activeSegments.length || invalid >= 0) {
      setFormError("住宿安排尚未保存，请先补全标出的字段；每晚预算可以留空。");
      if (invalid >= 0) {
        const errors = fieldErrors(activeSegments[invalid], invalid);
        document.getElementById(`stay-${errors.area ? "area" : errors.day ? "day" : "budget"}-${invalid}`)?.focus();
      }
      return;
    }
    void saveSegments(configFrom(activeSegments));
  }

  function adoptSegments(input: StaySegmentConfig[], optionId: string) {
    if (dirty && customized && !window.confirm("采用此方案会替换上方尚未保存的区域与预算，是否继续？")) return;
    // Choosing an area is not consent to discard a saved budget or reinterpret its currency.
    const preserved = input.map((segment) => ({ ...segment, budgetPerNight: segment.budgetPerNight || segments.find((saved) => saved.startDay === segment.startDay)?.budgetPerNight || null }));
    const drafts = preserved.map((segment) => ({ startDay: segment.startDay, area: segment.area,
      budget: segment.budgetPerNight?.amount ? String(segment.budgetPerNight.amount) : "", currency: segment.budgetPerNight?.currency || "CNY" as const }));
    setCustomized(false);
    setAdopted({ optionId, configKey: staySegmentConfigKey(preserved) });
    setEditor((current) => ({ ...current, drafts, notice: "", externalConflict: false }));
    focusSettings();
    if (drafts.some((segment) => segment.currency !== "CNY" && segment.budget)) {
      setFormError("区域方案已填入，原外币预算仍保留。请重新填写人民币预算，或取消本段预算，再保存住宿安排。");
      return;
    }
    void saveSegments(preserved, "settings");
  }

  return <section className={`${styles.stage} ${feedback.stage}`} aria-label="选择住宿夜段和酒店">
    <div className={styles.stageHeading}><div><small>03 · STAYS</small><h2>决定住哪里、住几晚</h2><p>先比较区域和换住成本，再为每个住宿段选择 Google 验证的酒店。飞猪价格仅作实际查询时的参考，选择酒店不等于预订成功。</p></div><Hotel size={25} /></div>
    {boundaryNote && !noOvernight && <p className={styles.sourceNote}>{boundaryNote}</p>}
    {affectedDays.length > 0 && <div className={styles.warning}><strong>航班可能影响这些安排：</strong>{affectedDays.map((message) => <p key={message}>{message}</p>)}<small>原来的地点分配仍保留；返回分天板后需重新确认航班与住宿。</small><button type="button" className={styles.secondaryAction} disabled={busy} onClick={onReviewBoard}>返回分天板复核</button></div>}
    {!advice && !noOvernight && <button type="button" className={styles.secondaryAction} disabled={busy} onClick={onAdvise}><MapPin size={14} />比较全程同住与分段住宿</button>}
    {noOvernight && <div className={styles.optionCard}><strong>无需过夜住宿</strong><p>{boundaryNote || advice?.basis || "抵达与离境在同一天，无需预订过夜酒店。"}</p><button type="button" className={styles.primaryAction} disabled={busy} onClick={onConfirm}>确认无需酒店，核算当天路线<ArrowRight size={16} /></button></div>}
    {advice && !noOvernight && <section className={feedback.recommendation} aria-label="住宿建议与方案比较">
      <div className={feedback.recommendationHeading}><div><small>住宿建议</small><h3>{recommended ? `建议${stayOptionLabel(recommended.id)}` : "比较住宿安排"}</h3></div><MapPin size={22} aria-hidden="true" /></div>
      {recommended && <><p className={feedback.recommendationReason}>{recommended.advantage}</p><p className={feedback.recommendationMetric}>酒店与景点往返及换住参考 <strong>{recommended.totalEstimatedMinutes} 分钟</strong>，其中换住约 {recommended.estimatedMoveMinutes} 分钟。</p>
        <button type="button" className={styles.secondaryAction} disabled={locked} onClick={() => currentOption?.id === recommended.id ? focusSettings() : adoptSegments(recommended.segments.map((segment) => ({ startDay: segment.startDay, area: segment.area, budgetPerNight: null })), recommended.id)}>{currentOption?.id === recommended.id ? "查看当前住宿设置" : "采用建议并查看设置"}<ArrowRight size={15} /></button></>}
      <details className={feedback.comparison}>
        <summary><strong>比较同住与换住</strong><span>{advice.options.map((option) => `${stayOptionLabel(option.id)} ${option.totalEstimatedMinutes} 分钟`).join(" · ")}</span></summary>
        <div className={`${styles.adviceGrid} ${feedback.comparisonGrid}`}>
      {advice.options.map((option) => <article className={`${styles.optionCard} ${currentOption?.id === option.id ? feedback.currentOption : ""}`} key={option.id}>
        <div className={styles.optionTop}><strong>{stayOptionLabel(option.id)}</strong><span>{currentOption?.id === option.id && segments.length > 0 ? "当前区域安排" : advice.recommendationId === option.id ? "建议" : "比较方案"}</span></div>
        <p>{option.segments.map((segment) => `Day ${segment.startDay} 起 · ${segment.area}`).join(" → ")}</p>
        <small>往返及换住预计 {option.totalEstimatedMinutes} 分钟，其中换住约 {option.estimatedMoveMinutes} 分钟</small>
        <p>{option.advantage}</p><p className={styles.muted}>{option.drawback}</p>
        {option.dailyBasis?.length ? <details className={styles.stayDayBasis}>
          <summary>查看每天的比较依据</summary>
          {option.dailyBasis.map((day) => <p key={day.day}><strong>Day {day.day}</strong>：{day.firstPlace || "未安排地点"} → {day.lastPlace || "未安排地点"}；从 {day.startHotel} 出发约 {day.outboundMinutes} 分钟，返回 {day.endHotel} 约 {day.inboundMinutes} 分钟。</p>)}
        </details> : null}
        <button type="button" className={styles.secondaryAction} disabled={locked} onClick={() => currentOption?.id === option.id ? focusSettings() : adoptSegments(option.segments.map((segment) => ({ startDay: segment.startDay, area: segment.area, budgetPerNight: null })), option.id)}>{currentOption?.id === option.id ? "查看当前设置" : "采用此区域方案"}</button>
      </article>)}
        </div>
        <p className={`${styles.sourceNote} ${feedback.adviceBasis}`}>{advice.basis} 交通数据来自 Google Routes；取舍解释来自 {advice.source.explanation === "Bailian" ? "百炼建议" : "服务端计算"}。</p>
      </details>
    </section>}
    {!noOvernight && <form className={`${styles.formGrid} ${feedback.stayForm}`} onSubmit={submitSegments} noValidate>
      <div className={feedback.settingsHeading}><div><small>当前安排</small><h3 ref={settingsHeading} tabIndex={-1}>设置住宿安排</h3></div><span role="status">{settingsSource}{dirty ? " · 待保存" : segments.length ? " · 已保存" : ""}</span></div>
      <p className={feedback.settingsIntro}>下方展示当前填写的夜段、区域与预算，保存后用于搜索酒店。采用区域建议不会自动选择或预订酒店。</p>
      <label className={feedback.segmentCount}>计划住几段酒店<select disabled={locked} value={Math.min(draftSegments.length, maxSegments)} onChange={(event) => chooseSegmentCount(Number(event.target.value))}>{Array.from({ length: maxSegments }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} 段{index === 0 ? "（全程同住）" : ""}</option>)}</select></label>
      {activeSegments.map((segment, index, active) => {
        const minDay = index === 0 ? 1 : active[index - 1].startDay + 1;
        const maxDay = index === active.length - 1 ? days : active[index + 1].startDay - 1;
        const errors = fieldErrors(segment, index);
        return <div className={`${feedback.segmentDraft} ${index === 0 ? feedback.firstSegment : feedback.laterSegment}`} key={index}>
          <strong>第 {index + 1} 段</strong>
          {index > 0 && <label>从哪天起换住<select id={`stay-day-${index}`} disabled={locked} aria-invalid={Boolean(errors.day)} aria-describedby={errors.day ? `stay-day-error-${index}` : undefined} value={segment.startDay} onChange={(event) => updateSegment(index, { startDay: Number(event.target.value) })}>{Array.from({ length: Math.max(0, maxDay - minDay + 1) }, (_, offset) => minDay + offset).map((day) => <option key={day} value={day}>Day {day} 起</option>)}</select>{errors.day && <small className={feedback.fieldError} id={`stay-day-error-${index}`}>{errors.day}</small>}</label>}
          <label>住宿区域<input id={`stay-area-${index}`} disabled={locked} aria-invalid={Boolean(errors.area)} aria-describedby={errors.area ? `stay-area-error-${index}` : undefined} value={segment.area} onChange={(event) => updateSegment(index, { area: event.target.value })} placeholder="例如 Bugis" required minLength={2} maxLength={80} />{errors.area && <small className={feedback.fieldError} id={`stay-area-error-${index}`}>{errors.area}</small>}</label>
          <label htmlFor={`stay-budget-${index}`}>每晚预算上限（人民币／晚，可选）<span className={feedback.budgetInput}><span aria-hidden="true">¥</span><input id={`stay-budget-${index}`} disabled={locked} aria-invalid={Boolean(errors.budget)} aria-describedby={errors.budget ? `stay-budget-error-${index}` : undefined} type="number" min="0.01" step="0.01" max="100000" value={segment.currency === "CNY" ? segment.budget : ""} onChange={(event) => updateSegment(index, { budget: event.target.value, currency: "CNY" })} placeholder="例如 1200" /></span>{segment.currency !== "CNY" && segment.budget && <small className={feedback.budgetUnknown}>{foreignBudgetNotice({ amount: Number(segment.budget), currency: segment.currency })}<button type="button" disabled={locked} className={feedback.clearBudget} onClick={() => updateSegment(index, { budget: "", currency: "CNY" })}>取消本段预算</button></small>}{errors.budget && <small className={feedback.fieldError} id={`stay-budget-error-${index}`}>{errors.budget}</small>}</label>
        </div>;
      })}
      <p className={styles.sourceNote}>每段至少一晚，最后没有住宿的离境日不能作为新段开始日。保存后，请继续为每段搜索并选择酒店；人民币每晚预算上限可以留空。旧外币预算保留原值，重新填写人民币金额后才用于核对，不自动换汇。</p>
      {editor.externalConflict && <p className={styles.warning}>已保存的住宿安排有更新，上方保留了你的未保存内容。<button type="button" className={styles.secondaryAction} disabled={locked} onClick={() => { setAdopted(null); setCustomized(false); setEditor({ serverKey, drafts: draftFrom(segments), notice: "已重新读取保存的住宿安排。", externalConflict: false, pendingKey: null }); setFormError(""); }}>读取已保存安排</button></p>}
      {formError && <p className={styles.error} role="alert">{formError}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={feedback.saveRow}><button type="submit" className={styles.secondaryAction} disabled={locked}>{saving ? "保存中…" : dirty ? "保存住宿安排" : "再次确认已保存安排"}</button><span>{dirty ? "有未保存的更改" : segments.length ? "当前安排已保存" : "尚未保存"}</span></div>
      {editor.notice && <p className={feedback.savedNotice} role="status">{editor.notice}</p>}
    </form>}
    {!noOvernight && segments.length > 0 && <div className={styles.segmentList}>
      <div className={feedback.hotelHeading}><small>具体酒店</small><h3 ref={hotelHeading} tabIndex={-1}>为每个住宿段选酒店</h3></div>
      {(dirty || currencyReview) && <p className={styles.warning}>{currencyReview ? "请先重新填写人民币预算，或明确取消原外币预算，并保存住宿安排。" : "上方区域或预算有未保存更改；请先保存，再搜索酒店或确认住宿。"}</p>}
      {segments.map((segment, index) => <article className={styles.segment} key={segment.id}>
        <div className={styles.segmentHeading}><div><strong>Day {segment.startDay} 起 · {segment.area}</strong><small>{segment.checkInDate} 入住 · {segment.checkOutDate} 退房 · {segment.nights ?? Math.round((Date.parse(segment.checkOutDate) - Date.parse(segment.checkInDate)) / 86_400_000)} 晚</small></div>{segment.hotel && <span>已选择</span>}</div>
        {segment.budgetReviewRequired && <p className={styles.warning}>本段预算已调整，已选酒店保留；请核对参考报价是否符合新预算。</p>}
        {needsBudgetAcknowledgement(segment) && <p className={styles.warning}>已选酒店的参考价超出当前预算。请展开其他候选，点击该酒店的“确认预算选择”，或调整预算／选择其他酒店。</p>}
        {segment.hotel && <p className={styles.selectedHotel}><Hotel size={14} />{segment.hotel.name} · Google Places 已验证</p>}
        <button type="button" className={styles.secondaryAction} disabled={locked || dirty || currencyReview || quotePolling || hotelQuoteJobMatchesSegment(quoteJob, segment) && hotelBatchWaiting(quoteJob)} onClick={() => onSearchHotels(segment.startDay)}>{segment.hotelCandidates?.length ? "重新搜索本段酒店与价格" : "搜索本段酒店与价格"}</button>
        {segment.hotelCandidates?.length ? <HotelBatchResults segment={segment} formIndex={index} disabled={locked || dirty || currencyReview} onSelect={onSelectHotel} quoteJob={quoteJob} quotePolling={quotePolling} onQuoteHotels={onQuoteHotels} onResumeQuotes={onResumeQuotes} /> : segment.hotelCandidates && <p className={feedback.budgetNotice}>本次未找到可选的 Google 验证酒店，请调整住宿区域后重试；这不代表整个区域没有酒店。</p>}
      </article>)}
      <button type="button" className={styles.primaryAction} disabled={locked || dirty || currencyReview || segments.some((segment) => !segment.hotel?.placeId || needsBudgetAcknowledgement(segment) || hotelQuoteJobMatchesSegment(quoteJob, segment) && hotelBatchWaiting(quoteJob))} onClick={onConfirm}>确认所有住宿段并核算时间<ArrowRight size={16} /></button>
    </div>}
    {error && noOvernight && <p className={styles.error} role="alert">{error}</p>}
    {busy && <p className={styles.status}>正在处理住宿阶段，请稍候…</p>}
  </section>;
}
