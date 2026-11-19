"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight, Clock3, ExternalLink, Plane, Search } from "lucide-react";
import type { FlightOffer, FlightSearchDirection, FlightSearchJob, FlightSearchResult } from "@/lib/travel/planning-flights";
import { flightSearchLinkGroups } from "@/lib/travel/planning-flight-links";
import { cnyPriceLabel, CNY_PRICE_UNVERIFIED } from "@/lib/travel/cny-price";
import { deriveFlightJourney, normalizeFlightTimeZone, validateFlightJourney, type FlightJourney, type ManualFlightInput, type FlightTimeZoneConfirmation } from "@/lib/travel/planning-flight-journey";
import styles from "./planning-journey.module.css";
import flightStyles from "./flight-stage.module.css";

type Props = {
  startDate: string;
  endDate: string;
  initialOrigin: string;
  travelers: { total: number; adults: number | null; children: number | null; seniors: number | null };
  quotes: FlightSearchResult | null;
  job?: FlightSearchJob | null;
  busy: boolean;
  error?: string;
  selectedOutboundId?: string;
  selectedInboundId?: string;
  selection?: { mode: "quoted" | "manual" | "none"; [key: string]: unknown } | null;
  onSearch: (query: { direction?: FlightSearchDirection; originCity: string; arrivalBefore?: string; departureAfter?: string; outboundDepartureDate: string; inboundDepartureDate: string; includePreviousEvening: boolean; includeNextDayReturn: boolean }) => void;
  onResume?: () => void;
  onCancelSearch?: () => void;
  onSelect: (outboundId: string, inboundId: string, timeZones: FlightTimeZoneConfirmation) => void;
  onManual: (values: ManualFlightInput) => void;
};

function Offer({ offer, checked, onChange }: { offer: FlightOffer; checked: boolean; onChange: () => void }) {
  const priceBasis = offer.priceBasis === "per_person" ? "单人参考" : offer.priceBasis === "total" ? "同行人总价参考" : "参考价（人数口径待核实）";
  const price = cnyPriceLabel(offer.price);
  return <label className={`${styles.offer} ${checked ? styles.offerSelected : ""}`}>
    <input type="radio" checked={checked} onChange={onChange} name={`flight-${offer.direction}`} />
    <span><strong>{offer.airline} {offer.flightNumber}</strong><small>{offer.origin} → {offer.destination}</small><time>出发 {offer.departureLocal.replace("T", " ")} → 抵达 {offer.arrivalLocal.replace("T", " ")}</time><small>以上均为当地时间；{offer.direction === "outbound" ? "去程按出发日查询，须在旅行首日抵达。" : "返程按离开新加坡的出发日查询。"}</small>{offer.baggageAllowance && <small>行李：{offer.baggageAllowance}</small>}{offer.fareConditions && <small>票价条件：{offer.fareConditions}</small>}</span>
    <span className={styles.offerPrice}>{price ? `${priceBasis} ${price}` : CNY_PRICE_UNVERIFIED}{offer.bookingUrl && <a href={offer.bookingUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>预订详情<ExternalLink size={11} /></a>}</span>
  </label>;
}

const queryStatusLabels = {
  available: "返回可用候选",
  empty: "查询无可用候选",
  failed: "百炼报告接口失败",
  filtered: "返回候选未通过日期等校验",
  unknown: "未报告逐日状态",
} as const;

const rejectedLabels = {
  invalid_time: "时间格式无效",
  outside_query_dates: "出发日不在查询范围",
  wrong_arrival_date: "去程未在旅行首日抵达",
  missing_identity: "航班或机场信息缺失",
  no_price_or_booking_link: "缺少价格和可用预订链接",
} as const;

function offsetDate(date: string, count: number) { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + count); return value.toISOString().slice(0, 10); }

type ManualFlightFields = Omit<ManualFlightInput, "airportsConfirmed">;

function initialManualFields(journey: FlightJourney, hasSavedSelection: boolean, startDate: string, endDate: string): ManualFlightFields {
  if (hasSavedSelection) {
    const { outbound, inbound } = journey;
    return {
      outboundDepartureAt: outbound.departure.localDateTime || "",
      arrivalAt: outbound.arrival.localDateTime || "",
      departureAt: inbound.departure.localDateTime || "",
      inboundArrivalAt: inbound.arrival.localDateTime || "",
      outboundAirportQuery: outbound.departure.airport?.name || "",
      arrivalAirportQuery: outbound.arrival.airport?.name || "",
      departureAirportQuery: inbound.departure.airport?.name || "",
      inboundAirportQuery: inbound.arrival.airport?.name || "",
      outboundTimeZone: outbound.departure.timeZone || "",
      inboundTimeZone: inbound.arrival.timeZone || "",
    };
  }

  const shanghai = "上海浦东国际机场 PVG";
  const singapore = "新加坡樟宜机场 SIN";
  return {
    outboundDepartureAt: `${startDate}T07:00`,
    arrivalAt: `${startDate}T12:30`,
    departureAt: `${endDate}T20:00`,
    inboundArrivalAt: `${offsetDate(endDate, 1)}T01:30`,
    outboundAirportQuery: shanghai,
    arrivalAirportQuery: singapore,
    departureAirportQuery: singapore,
    inboundAirportQuery: shanghai,
    outboundTimeZone: "Asia/Shanghai",
    inboundTimeZone: "Asia/Shanghai",
  };
}

export function FlightStage({ startDate, endDate, initialOrigin, travelers, quotes, job, busy, error, selectedOutboundId = "", selectedInboundId = "", selection, onSearch, onResume, onCancelSearch, onSelect, onManual }: Props) {
  const savedJourney = deriveFlightJourney(selection);
  const [origin, setOrigin] = useState(quotes?.searchQuery?.originCity || initialOrigin);
  const [arrivalBefore, setArrivalBefore] = useState(quotes?.preferences?.arrivalBefore || "");
  const [departureAfter, setDepartureAfter] = useState(quotes?.preferences?.departureAfter || "");
  const [outboundDepartureDate, setOutboundDepartureDate] = useState(quotes?.searchQuery?.outboundDates.at(-1) || startDate);
  const [inboundDepartureDate, setInboundDepartureDate] = useState(quotes?.searchQuery?.inboundDates[0] || endDate);
  const [includePreviousEvening, setIncludePreviousEvening] = useState((quotes?.searchQuery?.outboundDates.length || 0) > 1);
  const [includeNextDayReturn, setIncludeNextDayReturn] = useState((quotes?.searchQuery?.inboundDates.length || 0) > 1);
  const [outboundId, setOutboundId] = useState(selectedOutboundId);
  const [inboundId, setInboundId] = useState(selectedInboundId);
  const [manualEdits, setManualEdits] = useState<Partial<ManualFlightFields>>({});
  const travelDates = `${startDate}/${endDate}`;
  const [originalTravelDates] = useState(travelDates);
  const [confirmedTravelDates, setConfirmedTravelDates] = useState(
    selection?.mode === "manual" && validateFlightJourney(savedJourney).valid ? travelDates : null,
  );
  const [queryOutboundTimeZone, setQueryOutboundTimeZone] = useState(savedJourney.outbound.departure.timeZone || "");
  const [queryInboundTimeZone, setQueryInboundTimeZone] = useState(savedJourney.inbound.arrival.timeZone || "");
  const [queryTimeZonesConfirmed, setQueryTimeZonesConfirmed] = useState(selection?.mode === "quoted" && validateFlightJourney(savedJourney).valid);
  const [mode, setMode] = useState<"search" | "manual">(selection?.mode === "quoted" || (!selection && Boolean(job)) ? "search" : "manual");
  const manualFields = {
    ...initialManualFields(savedJourney, Boolean(selection), startDate, endDate),
    ...manualEdits,
  };
  const {
    outboundDepartureAt, arrivalAt, departureAt, inboundArrivalAt,
    outboundAirportQuery, arrivalAirportQuery, departureAirportQuery, inboundAirportQuery,
    outboundTimeZone, inboundTimeZone,
  } = manualFields;
  const airportsConfirmed = confirmedTravelDates === travelDates;
  const manualJourney: FlightJourney = {
    source: "user", outbound: { source: "user", departure: { localDateTime: outboundDepartureAt || null, timeZone: normalizeFlightTimeZone(outboundTimeZone), airport: outboundAirportQuery.trim() ? { name: outboundAirportQuery.trim() } : null }, arrival: { localDateTime: arrivalAt || null, timeZone: "Asia/Singapore", airport: arrivalAirportQuery.trim() ? { name: arrivalAirportQuery.trim() } : null } },
    inbound: { source: "user", departure: { localDateTime: departureAt || null, timeZone: "Asia/Singapore", airport: departureAirportQuery.trim() ? { name: departureAirportQuery.trim() } : null }, arrival: { localDateTime: inboundArrivalAt || null, timeZone: normalizeFlightTimeZone(inboundTimeZone), airport: inboundAirportQuery.trim() ? { name: inboundAirportQuery.trim() } : null } },
  };
  const manualValidation = validateFlightJourney(manualJourney);
  const departureDate = departureAt.slice(0, 10);
  const manualDatesConflict = Boolean(
    (arrivalAt && arrivalAt.slice(0, 10) !== startDate) ||
    (departureAt && departureDate !== endDate && departureDate !== offsetDate(endDate, 1)),
  );
  const selectedQueryJourney = deriveFlightJourney({ mode: "quoted", outbound: quotes?.outbound.find((offer) => offer.id === outboundId), inbound: quotes?.inbound.find((offer) => offer.id === inboundId) });
  selectedQueryJourney.outbound.departure.timeZone = normalizeFlightTimeZone(queryOutboundTimeZone);
  selectedQueryJourney.inbound.arrival.timeZone = normalizeFlightTimeZone(queryInboundTimeZone);
  const queryValidation = validateFlightJourney(selectedQueryJourney);
  const queryRunning = job?.status === "queued" || job?.status === "running";
  const queryUnsettled = queryRunning || job?.status === "timed_out";
  const savedQuery = quotes?.searchQuery;
  const formOutboundDates = [...new Set([outboundDepartureDate, ...(includePreviousEvening ? [offsetDate(startDate, -1)] : [])])].sort();
  const formInboundDates = [...new Set([inboundDepartureDate, ...(includeNextDayReturn ? [offsetDate(endDate, 1)] : [])])].sort();
  const retryMatchesForm = Boolean(savedQuery && origin.trim() === savedQuery.originCity &&
    (arrivalBefore || null) === savedQuery.preferences.arrivalBefore && (departureAfter || null) === savedQuery.preferences.departureAfter &&
    JSON.stringify(formOutboundDates) === JSON.stringify(savedQuery.outboundDates) && JSON.stringify(formInboundDates) === JSON.stringify(savedQuery.inboundDates));

  function retryDirection(direction: "outbound" | "inbound") {
    const query = quotes?.searchQuery;
    if (!query || !quotes?.contextFingerprint || busy || queryUnsettled || !retryMatchesForm) return;
    if (direction === "outbound") setOutboundId(""); else setInboundId("");
    onSearch({ direction, originCity: query.originCity,
      outboundDepartureDate: query.outboundDates.at(-1) || startDate, inboundDepartureDate: query.inboundDates[0] || endDate,
      includePreviousEvening: query.outboundDates.length > 1, includeNextDayReturn: query.inboundDates.length > 1,
      ...(query.preferences.arrivalBefore ? { arrivalBefore: query.preferences.arrivalBefore } : {}),
      ...(query.preferences.departureAfter ? { departureAfter: query.preferences.departureAfter } : {}) });
  }

  function directionSummary(direction: "outbound" | "inbound") {
    const name = direction === "outbound" ? "去程" : "返程";
    return quotes?.[direction].length ? `${name}已返回` : quotes?.queryOutcomes?.some((item) => item.direction === direction && item.status === "failed") ? `${name}查询失败` : `${name}暂无可用候选`;
  }

  function directionResult(direction: "outbound" | "inbound") {
    const name = direction === "outbound" ? "去程" : "返程";
    const outcomes = quotes?.queryOutcomes?.filter((item) => item.direction === direction) || [];
    const failed = outcomes.some((item) => item.status === "failed") || job?.status === "failed" && (job.direction === direction || job.direction === "both");
    const dates = [...new Set(outcomes.map((item) => item.departureDate))].join("、") || (direction === "outbound" ? startDate : endDate);
    return <div className={flightStyles.missing}>
      <p>{queryUnsettled ? `${name}查询尚未结束，请继续读取本次结果。` : failed ? `${dates} ${name}查询失败，暂时无法判断可订航班。` : `${dates} ${name}本次没有通过校验的候选。`}{Boolean(quotes?.[direction === "outbound" ? "inbound" : "outbound"].length) && "已保留另一方向的结果与选择。"}</p>
      {quotes?.searchQuery && quotes.contextFingerprint ? <><button type="button" className={styles.secondaryAction} disabled={busy || queryUnsettled || !retryMatchesForm} onClick={() => retryDirection(direction)}>仅重试{name}</button>{!retryMatchesForm && <small>上方条件已有修改，请点击“查询”重新检索往返航班；单向重试沿用上次完整条件。</small>}</>
        : <small>旧查询缺少完整条件，请使用上方查询重新检索往返航班。</small>}
      <button type="button" className={styles.secondaryAction} disabled={busy} onClick={() => setMode("manual")}>手动填写已订航班</button>
    </div>;
  }

  function searchLinks(direction: "outbound" | "inbound") {
    const groups = flightSearchLinkGroups(quotes?.searchLinks, direction);
    if (!groups.length) return null;
    const hasOffers = Boolean(quotes?.[direction].length);
    const count = groups.reduce((sum, group) => sum + group.links.length, 0);
    return <details key={`${direction}-${hasOffers}`} className={flightStyles.lookupLinks} open={!hasOffers}>
      <summary>{hasOffers ? "更多飞猪查看入口" : "飞猪查看入口"} · {count}</summary>
      <p>{hasOffers ? "以下是额外的查看入口。" : "暂未取得可用于核算的具体航班，可前往飞猪查看。"}这些链接不能直接选为已确认航班；价格、日期和库存以预订页为准。</p>
      {groups.map((group) => <div className={flightStyles.lookupGroup} key={group.date || "unknown"}>
        <strong>{group.date ? `${group.date} 出发` : "出发日期待核实"}</strong>
        <ul>{group.links.map((item, index) => <li key={item.url}><a href={item.url} target="_blank" rel="noreferrer">前往飞猪查看{group.links.length > 1 ? ` ${index + 1}` : ""}<ExternalLink size={12} /></a></li>)}</ul>
      </div>)}
      <small>选定并预订后，可用“已订，填写时刻”录入实际航班。</small>
    </details>;
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    if (origin.trim() && !busy && !queryUnsettled) {
      setOutboundId("");
      setInboundId("");
      onSearch({ direction: "both", originCity: origin.trim(), outboundDepartureDate, inboundDepartureDate, includePreviousEvening, includeNextDayReturn,
        ...(arrivalBefore ? { arrivalBefore } : {}), ...(departureAfter ? { departureAfter } : {}) });
    }
  }
  function submitManual(event: FormEvent) {
    event.preventDefault();
    if (manualValidation.valid && !manualDatesConflict && airportsConfirmed && !busy) {
      onManual({ outboundDepartureAt, arrivalAt, departureAt, inboundArrivalAt,
        outboundAirportQuery: outboundAirportQuery.trim(), arrivalAirportQuery: arrivalAirportQuery.trim(), departureAirportQuery: departureAirportQuery.trim(), inboundAirportQuery: inboundAirportQuery.trim(),
        outboundTimeZone: normalizeFlightTimeZone(outboundTimeZone)!, inboundTimeZone: normalizeFlightTimeZone(inboundTimeZone)!, airportsConfirmed: true });
    }
  }

  function manualChange(field: keyof ManualFlightFields, value: string) {
    setManualEdits((current) => ({ ...current, [field]: value }));
    setConfirmedTravelDates(null);
  }

  return <section className={`${styles.stage} ${flightStyles.stage}`} aria-label="确认往返航班">
    <div className={styles.stageHeading}><div><small>02 · FLIGHTS</small><h2>确认往返航班，回看首末日</h2><p>按机票填写往返四个当地时刻，形成首末日的固定航旅时间轴；也可以查询航班参考。</p></div><Plane size={25} /></div>
    <div className={styles.choiceTabs} role="tablist" aria-label="航班信息来源">
      <button type="button" role="tab" aria-selected={mode === "manual"} onClick={() => setMode("manual")}>已订，填写时刻</button>
      <button type="button" role="tab" aria-selected={mode === "search"} onClick={() => setMode("search")}>查询航班参考</button>
    </div>
    {mode === "search" && <>
      <p className={flightStyles.queryNotice}><strong>国际航班查询提示</strong>：当前国际航班方向因飞猪 API Skill 暂不支持，可能无法返回相关结果或存在 Bug，相关工作人员已知悉。请根据已订机票手动填写时刻继续规划；查询结果仅供参考。</p>
      <form className={styles.flightSearchForm} onSubmit={submitSearch}><fieldset className={flightStyles.searchFields} disabled={busy || queryUnsettled}>
        <div className={styles.searchRow}><Search size={16} /><label className={styles.srOnly} htmlFor="flight-origin">出发城市或机场</label><input id="flight-origin" value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="例如：北京首都机场" /><button type="submit" disabled={busy || job?.status === "queued" || job?.status === "running" || !origin.trim()}>查询</button></div>
        <div className={flightStyles.dates}>
          <label>去程出发日期<input type="date" min={offsetDate(startDate, -1)} max={startDate} value={outboundDepartureDate} onChange={(event) => setOutboundDepartureDate(event.target.value)} required /></label>
          <label>返程出发日期<input type="date" min={endDate} max={offsetDate(endDate, 1)} value={inboundDepartureDate} onChange={(event) => setInboundDepartureDate(event.target.value)} required /></label>
          <label className={flightStyles.check}><input type="checkbox" checked={includePreviousEvening} onChange={(event) => setIncludePreviousEvening(event.target.checked)} />同时看看旅行首日前一晚出发</label>
          <label className={flightStyles.check}><input type="checkbox" checked={includeNextDayReturn} onChange={(event) => setIncludeNextDayReturn(event.target.checked)} />接受旅行末日次日返程</label>
        </div>
        <p className={styles.sourceNote}>默认只查指定的两个出发日；相邻日期仅按你的选择加入。去程需在 {startDate} 抵达新加坡，首末日可用时间及住宿夜数将按所选航班复核。</p>
        <div className={styles.flightPreferences}>
          <span>查询旅客：{travelers.total} 人{travelers.adults !== null ? ` · 成人 ${travelers.adults}` : ""}{travelers.children ? ` · 儿童 ${travelers.children}` : ""}{travelers.seniors ? ` · 长者 ${travelers.seniors}` : ""}</span>
          <label>首日希望几点前抵达<input type="time" value={arrivalBefore} onChange={(event) => setArrivalBefore(event.target.value)} /></label>
          <label>末日希望几点后离境<input type="time" value={departureAfter} onChange={(event) => setDepartureAfter(event.target.value)} /></label>
        </div>
      </fieldset></form>
      {job && <div className={job.status === "failed" || job.status === "timed_out" ? styles.warning : styles.status} role="status" aria-live="polite"><p>{job.status === "completed" && quotes ? `${directionSummary("outbound")}，${directionSummary("inbound")}。` : job.message}</p>{job.status === "timed_out" && onResume && <button type="button" className={styles.secondaryAction} disabled={busy} onClick={onResume}>继续读取同一次查询</button>}{(job.status === "queued" || job.status === "running" || job.status === "timed_out") && <><small>刷新后仍可恢复本次查询；无需重复提交。你也可以填写已订航班。</small>{onCancelSearch && <button type="button" className={styles.secondaryAction} disabled={busy} onClick={onCancelSearch}>更换查询条件</button>}</>}</div>}
      {quotes && <>
        <p className={styles.sourceNote}>百炼经 FlyAI 报告的航班候选 · 最近查询更新 {quotes.queriedAt ? new Date(quotes.queriedAt).toLocaleString("zh-CN") : "查询时间未知"}。按 {quotes.travelers?.total || travelers.total} 人的条件检索；价格口径逐条标注，未明确时不推算总价。下面的逐日查询状态由百炼报告，本站尚未独立核对供应商原始结果；航班时刻、票价、余位、行李和退改签条件请在预订页复核。</p>
        {quotes.queryOutcomes?.length ? <div className={styles.flightQueryStatuses} aria-label="按出发日期的查询状态">
          {quotes.queryOutcomes.map((item) => <span key={`${item.direction}-${item.departureDate}`} className={item.status === "failed" ? styles.flightQueryFailed : ""}>
            {item.direction === "outbound" ? "去程" : "返程"} · {item.departureDate} <b>出发</b>：{queryStatusLabels[item.status]}
            {item.acceptedCount > 0 ? ` ${item.acceptedCount} 条` : ""}{item.rejectedCount > 0 ? ` · 过滤 ${item.rejectedCount} 条` : ""}{item.errorCode ? `（${item.errorCode}）` : ""}{item.reportedErrorMessage ? ` · 百炼报告：${item.reportedErrorMessage}` : ""}
          </span>)}
        </div> : null}
        {quotes.rejected?.length ? <p className={styles.flightFilterNote}>候选筛选：{quotes.rejected.map((item) => `${item.direction === "outbound" ? "去程" : "返程"}${item.departureDate ? ` ${item.departureDate} 出发` : ""} ${rejectedLabels[item.reason]} ${item.count} 条`).join("；")}。</p> : null}
        {quotes.status === "unavailable" && <p className={styles.warning}>{quotes.failureReason === "agent_unavailable" ? "航班智能服务暂时未返回结果。" : quotes.failureReason === "invalid_response" ? "航班服务返回的数据格式不完整，未保存任何候选。" : quotes.queryOutcomes?.some((item) => item.status === "failed") ? "本次部分或全部查询失败，尚不能判断对应日期是否有票。" : quotes.searchLinks?.length ? "已取得飞猪查看入口，尚无可用于核算的具体航班。" : "本次没有通过校验的航班候选。"} 可稍后再查，或手动填入已订时刻。</p>}
        {quotes.status === "available" && (!quotes.outbound.length || !quotes.inbound.length) && <p className={styles.warning}>本轮尚未取得一组往返候选。已保留成功方向；可在缺少结果的一侧单独重试，或填写已订航班。</p>}
        <div className={`${styles.flightColumns} ${flightStyles.columns}`}>
          <div><h3>去程 · 首日抵达 {startDate}</h3>{quotes.outbound.length ? quotes.outbound.map((offer) => <Offer key={offer.id} offer={offer} checked={outboundId === offer.id} onChange={() => { setOutboundId(offer.id); setQueryOutboundTimeZone(offer.departureTimeZone || ""); setQueryTimeZonesConfirmed(false); }} />) : directionResult("outbound")}{searchLinks("outbound")}</div>
          <div><h3>返程 · 按所选出发日期</h3>{quotes.inbound.length ? quotes.inbound.map((offer) => <Offer key={offer.id} offer={offer} checked={inboundId === offer.id} onChange={() => { setInboundId(offer.id); setQueryInboundTimeZone(offer.arrivalTimeZone || ""); setQueryTimeZonesConfirmed(false); }} />) : directionResult("inbound")}{searchLinks("inbound")}</div>
        </div>
        {outboundId && inboundId && <div className={`${styles.formGrid} ${flightStyles.zoneConfirmation}`}>
          <p className={styles.sourceNote}>请确认去程出发机场与返程到达机场的当地时区。新加坡两端固定为 Asia/Singapore；未知时区不按机场名称猜测。时刻沿用所选候选，仍请在机票或预订页复核。</p>
          <label>去程出发机场时区<input value={queryOutboundTimeZone} list="flight-time-zones" placeholder="例如 Asia/Shanghai" onChange={(event) => { setQueryOutboundTimeZone(event.target.value); setQueryTimeZonesConfirmed(false); }} required /></label>
          <label>返程到达机场时区<input value={queryInboundTimeZone} list="flight-time-zones" placeholder="例如 Asia/Shanghai" onChange={(event) => { setQueryInboundTimeZone(event.target.value); setQueryTimeZonesConfirmed(false); }} required /></label>
          <label className={flightStyles.confirmCheck}><input type="checkbox" checked={queryTimeZonesConfirmed} onChange={(event) => setQueryTimeZonesConfirmed(event.target.checked)} />我已确认两端机场及当地时区</label>
          {!queryValidation.valid && <p className={styles.sourceNote}>{queryValidation.message}</p>}
        </div>}
        <button type="button" className={styles.primaryAction} disabled={busy || queryUnsettled || !queryValidation.valid || !queryTimeZonesConfirmed} onClick={() => onSelect(outboundId, inboundId, { outboundTimeZone: normalizeFlightTimeZone(queryOutboundTimeZone)!, inboundTimeZone: normalizeFlightTimeZone(queryInboundTimeZone)!, timeZonesConfirmed: true })}>确认这组航班<ArrowRight size={16} /></button>
      </>}
    </>}
    {mode === "manual" && <form className={styles.formGrid} onSubmit={submitManual}>
      {!selection && <p className={flightStyles.incomplete}>已按旅行日期填入示例，请按机票修改后确认。</p>}
      {selection && !validateFlightJourney(savedJourney).valid && <p className={flightStyles.incomplete}>原航班信息已保留。请补齐往返四个时刻、机场及当地时区；缺失内容尚未计为完整航旅。</p>}
      {originalTravelDates !== travelDates && (selection || Object.keys(manualEdits).length > 0) && <p className={flightStyles.incomplete} role="status">旅行日期已变更。已保留你填写或保存的航班信息，请重新核对。</p>}
      <fieldset className={flightStyles.manualLeg}><legend>去程 · 抵达新加坡</legend><div className={flightStyles.manualEndpoints}>
        <div><label>起飞机场<input value={outboundAirportQuery} onChange={(event) => manualChange("outboundAirportQuery", event.target.value)} placeholder="填写机票上的具体机场" minLength={3} required /></label>
          <label>起飞当地日期与时间<input type="datetime-local" value={outboundDepartureAt} onChange={(event) => manualChange("outboundDepartureAt", event.target.value)} required /></label>
          <label>起飞机场当地时区<input value={outboundTimeZone} list="flight-time-zones" placeholder="例如 Asia/Shanghai" onChange={(event) => manualChange("outboundTimeZone", event.target.value)} required /></label></div>
        <div><label>抵达机场（新加坡）<input value={arrivalAirportQuery} onChange={(event) => manualChange("arrivalAirportQuery", event.target.value)} placeholder="例如 新加坡樟宜机场" minLength={3} required /></label>
          <label>抵达新加坡的当地日期与时间<input type="datetime-local" value={arrivalAt} onChange={(event) => manualChange("arrivalAt", event.target.value)} required /></label><p className={flightStyles.fixedZone}>当地时区 · Asia/Singapore</p></div>
      </div></fieldset>
      <fieldset className={flightStyles.manualLeg}><legend>返程 · 离开新加坡并到达</legend><div className={flightStyles.manualEndpoints}>
        <div><label>离境机场（新加坡）<input value={departureAirportQuery} onChange={(event) => manualChange("departureAirportQuery", event.target.value)} placeholder="例如 新加坡樟宜机场" minLength={3} required /></label>
          <label>离开新加坡的当地日期与时间<input type="datetime-local" value={departureAt} onChange={(event) => manualChange("departureAt", event.target.value)} required /></label><p className={flightStyles.fixedZone}>当地时区 · Asia/Singapore</p></div>
        <div><label>返程到达机场<input value={inboundAirportQuery} onChange={(event) => manualChange("inboundAirportQuery", event.target.value)} placeholder="填写机票上的具体机场" minLength={3} required /></label>
          <label>返程到达的当地日期与时间<input type="datetime-local" value={inboundArrivalAt} onChange={(event) => manualChange("inboundArrivalAt", event.target.value)} required /></label>
          <label>到达机场当地时区<input value={inboundTimeZone} list="flight-time-zones" placeholder="例如 Asia/Shanghai" onChange={(event) => manualChange("inboundTimeZone", event.target.value)} required /></label></div>
      </div></fieldset>
      <p className={styles.sourceNote}><Clock3 size={13} />请按机票确认四个当地时刻与机场，跨日航班须填写对应日期。新加坡两端机场由 Google Places 核验，其他机场与当地 IANA 时区由你确认。</p>
      {outboundDepartureAt && arrivalAt && departureAt && inboundArrivalAt && !manualValidation.valid && <p className={styles.sourceNote}>{manualValidation.message}</p>}
      {manualDatesConflict && <p className={styles.sourceNote} role="status">去程须在旅行首日抵达新加坡，返程须在旅行末日或次日离境。请核对机票与旅行日期。</p>}
      <label className={flightStyles.confirmCheck}><input type="checkbox" checked={airportsConfirmed} onChange={(event) => setConfirmedTravelDates(event.target.checked ? travelDates : null)} required />我已按机票确认四个时刻、具体机场及当地时区</label>
      <button type="submit" className={styles.primaryAction} disabled={busy || !manualValidation.valid || manualDatesConflict || !airportsConfirmed}>核验新加坡机场并保存已订时刻<ArrowRight size={16} /></button>
    </form>}
    <datalist id="flight-time-zones">{["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Tokyo", "Asia/Seoul", "Asia/Bangkok", "Asia/Dubai", "Europe/London", "Europe/Paris", "America/Los_Angeles", "America/New_York", "Australia/Sydney", "Pacific/Auckland"].map((zone) => <option value={zone} key={zone} />)}</datalist>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {busy && <p className={styles.status}>正在处理航班阶段，请稍候…</p>}
  </section>;
}
