"use client";

/* Native anchors deliberately bypass the deployed Vinext client router. */
/* eslint-disable @next/next/no-html-link-for-pages */

import { useMemo, useState, type FormEvent } from "react";
import {
  ArrowLeft, Bike, BusFront, Check, CheckCircle2, ChevronDown, CircleAlert,
  Clock3, Download, ExternalLink, Footprints, Hotel, LockKeyhole, MoreHorizontal,
  Route, Save, Send, Share2, Sparkles, TrainFront,
} from "lucide-react";
import { GoogleSingaporeMap, type GoogleSingaporeMapPoint } from "@/components/travel/google-singapore-map";
import { SingaporeMap } from "@/components/travel/singapore-map";
import { TravelLogo } from "@/components/travel/travel-logo";
import { describeSingaporePlace } from "@/lib/travel/place-description";
import { liveTripStorageKey, type StoredLiveTrip } from "@/lib/travel/trip-storage";
import type { DemoTrip, RouteLeg, SingaporeRevisionResponse, SingaporeTravelIntent, TravelCommerce, TravelMode, TripDay, TripStop } from "@/lib/travel/types";

const modeMeta: Record<TravelMode, { label: string; icon: typeof Footprints }> = {
  walk: { label: "步行", icon: Footprints },
  transit: { label: "公共交通", icon: TrainFront },
  taxi: { label: "出租车", icon: BusFront },
  drive: { label: "驾车", icon: BusFront },
  bicycle: { label: "骑行", icon: Bike },
};

function legAfter(day: TripDay, stopId: string): RouteLeg | undefined {
  return day.legs.find((leg) => leg.to === stopId);
}

function decodeGooglePolyline(encoded: string): GoogleSingaporeMapPoint[] {
  const points: GoogleSingaporeMapPoint[] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= encoded.length);
    latitude += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= encoded.length);
    longitude += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ lat: latitude / 1e5, lng: longitude / 1e5 });
  }
  return points;
}

type TripWorkspaceClientProps = {
  trip: DemoTrip;
  storedTrip?: StoredLiveTrip;
};

type ChangeSummary = {
  title: string;
  detail: string;
};

type HotelCandidate = {
  placeId: string;
  name: string;
  address: string;
  location: { lat: number; lng: number };
  rating: number | null;
  userRatingCount: number | null;
  googleMapsUri: string | null;
};

type ReanchorResponse = {
  trip: DemoTrip;
  reply: string;
};

function revisionError(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return "这次修改没有完成，请稍后重试。";
  const error = payload.error;
  if (!error || typeof error !== "object" || !("message" in error) || typeof error.message !== "string") {
    return "这次修改没有完成，请稍后重试。";
  }
  return error.message;
}

function accommodationQuoteLabel(quote: TravelCommerce | undefined, loading: boolean, error: string) {
  if (loading && !quote) return "飞猪价格查询中…";
  if (quote?.status === "available" && quote.price) {
    return `${quote.price.display}${quote.price.unit ? ` · ${quote.price.unit}` : ""}`;
  }
  if (quote?.status === "needs_details") return quote.note || "补充日期与同行人数后可查询价格";
  if (quote?.status === "unavailable") return quote.note || "飞猪暂未返回可靠报价";
  return error || "飞猪价格暂未返回";
}

function accommodationQuoteClass(quote: TravelCommerce | undefined, loading: boolean) {
  if (loading && !quote) return "is-loading";
  return `is-${quote?.status || "unavailable"}`;
}

export function TripWorkspaceClient({ trip, storedTrip }: TripWorkspaceClientProps) {
  const [workingTrip, setWorkingTrip] = useState(trip);
  const [liveContext, setLiveContext] = useState(storedTrip);
  const isLive = workingTrip.source === "live";
  const [selectedDayId, setSelectedDayId] = useState(trip.days[0].id);
  const [selectedStopId, setSelectedStopId] = useState(trip.days[0].stops[1]?.id || trip.days[0].stops[0].id);
  const [composer, setComposer] = useState("");
  const [recalculating, setRecalculating] = useState(false);
  const [reanchoringAccommodation, setReanchoringAccommodation] = useState(false);
  const [relaxedDayTwo, setRelaxedDayTwo] = useState(false);
  const [notice, setNotice] = useState("");
  const [lastChange, setLastChange] = useState<ChangeSummary | null>(null);
  const [accommodationEditorOpen, setAccommodationEditorOpen] = useState(false);
  const [accommodationStartDayId, setAccommodationStartDayId] = useState(trip.days[0].id);
  const [accommodationQuery, setAccommodationQuery] = useState(trip.hotel);
  const [hotelCandidates, setHotelCandidates] = useState<HotelCandidate[]>([]);
  const [searchingAccommodation, setSearchingAccommodation] = useState(false);
  const [accommodationQuotes, setAccommodationQuotes] = useState<Record<string, TravelCommerce>>({});
  const [accommodationQuotesLoading, setAccommodationQuotesLoading] = useState(false);
  const [accommodationQuotesError, setAccommodationQuotesError] = useState("");
  const [detailStopId, setDetailStopId] = useState<string | null>(null);
  const [poiCommerceLoading, setPoiCommerceLoading] = useState<Record<string, boolean>>({});

  const selectedDay = useMemo(() => {
    const original = workingTrip.days.find((day) => day.id === selectedDayId) || workingTrip.days[0];
    if (isLive || !relaxedDayTwo || original.id !== "day-2") return original;
    const stops = original.stops
      .filter((stop) => stop.id !== "artscience")
      .map((stop) => stop.id === "clarke-quay" ? { ...stop, time: "16:30", endTime: "18:30", duration: "2 小时", note: "下午留出两小时自由时间后再到河岸散步" } : stop);
    const legs = [
      original.legs[0],
      original.legs[1],
      { from: "maxwell", to: "clarke-quay", mode: "transit" as const, minutes: 16, distance: "2.4 km" },
    ];
    return { ...original, stops, legs, summary: "3 个地点 · 交通 48 分钟 · 自由时间 2 小时" };
  }, [isLive, relaxedDayTwo, selectedDayId, workingTrip.days]);

  const mapMarkers = useMemo(() => selectedDay.stops.map((stop, index) => ({
    id: stop.id,
    title: stop.name,
    lat: stop.lat ?? stop.location?.lat,
    lng: stop.lng ?? stop.location?.lng,
    placeId: stop.placeId,
    label: stop.kind === "hotel" ? "H" : index,
    kind: stop.kind === "hotel" ? "hotel" as const : stop.kind === "food" ? "food" as const : stop.kind === "buffer" ? "activity" as const : "attraction" as const,
    color: selectedDay.color,
  })), [selectedDay]);

  const routePoints = useMemo(() => selectedDay.legs.flatMap((leg) => (
    leg.encodedPolyline ? decodeGooglePolyline(leg.encodedPolyline) : []
  )), [selectedDay.legs]);

  const detailStop = useMemo(() => workingTrip.days
    .flatMap((day) => day.stops)
    .find((stop) => stop.id === detailStopId) || null, [detailStopId, workingTrip.days]);
  const detailCommerce = detailStop?.commerce;
  const detailCommerceLoading = detailStop ? Boolean(poiCommerceLoading[detailStop.id]) : false;

  function applyStopCommerce(stopId: string, commerce: TravelCommerce) {
    setWorkingTrip((current) => ({
      ...current,
      days: current.days.map((day) => ({
        ...day,
        stops: day.stops.map((stop) => stop.id === stopId ? { ...stop, commerce } : stop),
      })),
    }));
  }

  async function loadPoiCommerce(stop: TripStop) {
    if (!isLive || stop.kind === "hotel" || stop.kind === "food" || stop.kind === "buffer" || !stop.placeId || poiCommerceLoading[stop.id]) return;
    setPoiCommerceLoading((current) => ({ ...current, [stop.id]: true }));
    try {
      const response = await fetch("/api/travel/singapore/poi-commerce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ placeId: stop.placeId }),
      });
      const payload = await response.json().catch(() => null) as { commerce?: TravelCommerce } | null;
      if (payload?.commerce) {
        applyStopCommerce(stop.id, payload.commerce);
      } else {
        applyStopCommerce(stop.id, {
          provider: "fliggy",
          kind: "poi",
          status: "unavailable",
          note: "暂未取得该地点可展示的飞猪价格。",
          updatedAt: new Date().toISOString(),
        });
      }
    } catch {
      applyStopCommerce(stop.id, {
        provider: "fliggy",
        kind: "poi",
        status: "unavailable",
        note: "暂时无法查询该地点的飞猪价格。",
        updatedAt: new Date().toISOString(),
      });
    } finally {
      setPoiCommerceLoading((current) => ({ ...current, [stop.id]: false }));
    }
  }

  function openPlaceDetails(stop: TripStop) {
    setSelectedStopId(stop.id);
    setDetailStopId(stop.id);
    if (stop.kind !== "food" && !stop.commerce) void loadPoiCommerce(stop);
  }

  function selectDay(day: TripDay) {
    setSelectedDayId(day.id);
    setSelectedStopId(day.stops.find((stop) => stop.kind !== "hotel")?.id || day.stops[0].id);
    setNotice("");
    setLastChange(null);
  }

  function openAccommodationEditor() {
    if (!isLive || recalculating) return;
    const selectedNightHotel = workingTrip.days.find((day) => day.id === selectedDayId)?.stops.at(-1)?.name.replace(/^返回\s+/, "");
    setAccommodationQuery(selectedNightHotel || workingTrip.hotel);
    setAccommodationStartDayId(selectedDayId);
    setHotelCandidates([]);
    setAccommodationQuotes({});
    setAccommodationQuotesError("");
    setAccommodationEditorOpen(true);
    setNotice(`从 ${selectedDayId.replace("day-", "Day ")} 起设置新住宿；换酒店当天会从上一晚酒店出发，并在新酒店结束。`);
  }

  async function searchAccommodation(event: FormEvent) {
    event.preventDefault();
    const query = accommodationQuery.trim();
    if (!query || searchingAccommodation || reanchoringAccommodation) return;
    setSearchingAccommodation(true);
    setNotice("");
    try {
      const response = await fetch("/api/travel/singapore/places", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          maxResults: 5,
          includedType: "lodging",
          strictTypeFiltering: true,
          languageCode: "zh-CN",
        }),
      });
      const payload = await response.json().catch(() => null) as { places?: HotelCandidate[] } | null;
      if (!response.ok) {
        setNotice(revisionError(payload));
        return;
      }
      const candidates = Array.isArray(payload?.places) ? payload.places : [];
      setHotelCandidates(candidates);
      setAccommodationQuotes({});
      setAccommodationQuotesError("");
      if (!candidates.length) setNotice("没有找到 Google Places 识别的住宿，请换一个酒店名称或区域再试。 ");
      if (candidates.length) void loadAccommodationQuotes(candidates);
    } catch {
      setNotice("暂时无法查询酒店候选，当前行程没有变化。");
    } finally {
      setSearchingAccommodation(false);
    }
  }

  async function loadAccommodationQuotes(candidates: HotelCandidate[]) {
    const intent = liveContext?.intent;
    if (!intent) {
      setAccommodationQuotesError("缺少本次旅行条件，暂时无法查询飞猪价格。");
      return;
    }
    setAccommodationQuotesLoading(true);
    setAccommodationQuotesError("");
    try {
      const response = await fetch("/api/travel/singapore/hotel-quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent, candidates: candidates.slice(0, 5).map((candidate) => ({ placeId: candidate.placeId })) }),
      });
      const payload = await response.json().catch(() => null) as { quotes?: Array<{ placeId?: string; commerce?: TravelCommerce }> } | null;
      if (!response.ok) {
        const message = revisionError(payload);
        setAccommodationQuotesError(message);
        setAccommodationQuotes(Object.fromEntries(candidates.map((candidate) => [candidate.placeId, {
          provider: "fliggy" as const,
          kind: "hotel" as const,
          status: "unavailable" as const,
          note: "飞猪报价服务暂未返回可靠价格。",
          updatedAt: new Date().toISOString(),
        }])));
        return;
      }
      const returned = Object.fromEntries(
        (payload?.quotes || [])
          .filter((quote) => quote.placeId && quote.commerce)
          .map((quote) => [quote.placeId as string, quote.commerce as TravelCommerce]),
      ) as Record<string, TravelCommerce>;
      setAccommodationQuotes(Object.fromEntries(candidates.map((candidate) => [candidate.placeId, returned[candidate.placeId] || {
        provider: "fliggy" as const,
        kind: "hotel" as const,
        status: "unavailable" as const,
        note: "飞猪暂未返回该酒店的可靠报价。",
        updatedAt: new Date().toISOString(),
      }])));
    } catch {
      setAccommodationQuotesError("暂时无法查询飞猪价格，酒店地点仍可选择。");
      setAccommodationQuotes(Object.fromEntries(candidates.map((candidate) => [candidate.placeId, {
        provider: "fliggy" as const,
        kind: "hotel" as const,
        status: "unavailable" as const,
        note: "飞猪价格查询暂时不可用。",
        updatedAt: new Date().toISOString(),
      }])));
    } finally {
      setAccommodationQuotesLoading(false);
    }
  }

  function applyAccommodationCommerce(tripValue: DemoTrip, placeId: string, commerce?: TravelCommerce) {
    if (!commerce) return tripValue;
    return {
      ...tripValue,
      days: tripValue.days.map((day) => ({
        ...day,
        stops: day.stops.map((stop) => stop.kind === "hotel" && stop.placeId === placeId ? { ...stop, commerce } : stop),
      })),
    };
  }

  async function reanchorAccommodation(candidate: HotelCandidate) {
    if (!isLive || recalculating) return;
    const currentIntent = liveContext?.intent;
    const changesWholeTrip = accommodationStartDayId === "day-1" && (workingTrip.accommodationSegments?.length || 1) === 1;
    const nextIntent: SingaporeTravelIntent = changesWholeTrip ? {
      ...(currentIntent || {}),
      accommodation: {
        ...(currentIntent?.accommodation || {}),
        hotelName: candidate.name,
        googlePlaceId: candidate.placeId,
      },
    } : (currentIntent || {});
    setRecalculating(true);
    setReanchoringAccommodation(true);
    setNotice("");
    setLastChange(null);
    try {
      const response = await fetch("/api/travel/singapore/reanchor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trip: workingTrip, placeId: candidate.placeId, startDayId: accommodationStartDayId, intent: nextIntent }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setNotice(revisionError(payload));
        return;
      }
      const result = payload as ReanchorResponse;
      const updatedTrip = applyAccommodationCommerce(result.trip, candidate.placeId, accommodationQuotes[candidate.placeId]);
      setWorkingTrip(updatedTrip);
      const selected = updatedTrip.days.find((day) => day.id === selectedDayId) || updatedTrip.days[0];
      setSelectedDayId(selected.id);
      setSelectedStopId(selected.stops.find((stop) => stop.kind !== "hotel")?.id || selected.stops[0]?.id || "");
      setAccommodationEditorOpen(false);
      setHotelCandidates([]);
      setNotice(result.reply);
      setLastChange({
        title: accommodationStartDayId === "day-1" ? "已更新住宿安排" : `已从 ${accommodationStartDayId.replace("day-", "Day ")} 设置新住宿`,
        detail: "受影响日期的出发、返回、路线与时间已重新计算",
      });
      if (liveContext) {
        const updated: StoredLiveTrip = {
          ...liveContext,
          trip: updatedTrip,
          intent: nextIntent,
          savedAt: new Date().toISOString(),
        };
        setLiveContext(updated);
        window.localStorage.setItem(liveTripStorageKey(updatedTrip.id), JSON.stringify(updated));
      }
    } catch {
      setNotice("暂时无法重新计算住宿锚点，原行程没有变化。");
    } finally {
      setRecalculating(false);
      setReanchoringAccommodation(false);
    }
  }

  async function submitChange(event: FormEvent) {
    event.preventDefault();
    const value = composer.trim();
    if (!value || recalculating) return;
    if (isLive) {
      if (/(?:更换|换|改成|改).{0,12}(?:酒店|住宿)|(?:酒店|住宿).{0,12}(?:更换|换|改成|改)/.test(value)) {
        setComposer("");
        openAccommodationEditor();
        return;
      }
      setRecalculating(true);
      setNotice("");
      setLastChange(null);
      try {
        const response = await fetch("/api/travel/singapore/revise", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: value,
            selectedDayId,
            trip: workingTrip,
            intent: liveContext?.intent || {},
          }),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          setNotice(revisionError(payload));
          return;
        }
        const result = payload as SingaporeRevisionResponse;
        setWorkingTrip(result.trip);
        setSelectedDayId(result.changedDayId);
        const changedDay = result.trip.days.find((day) => day.id === result.changedDayId);
        setSelectedStopId(result.selectedStopId || changedDay?.stops.find((stop) => stop.kind !== "hotel")?.id || changedDay?.stops[0]?.id || "");
        setComposer("");
        setNotice(result.reply);
        setLastChange({ title: "已应用局部修改", detail: `${changedDay?.label || "当天"}的地点、路线与时间已重新计算` });
        if (liveContext) {
          const updated: StoredLiveTrip = { ...liveContext, trip: result.trip, savedAt: new Date().toISOString() };
          setLiveContext(updated);
          window.localStorage.setItem(liveTripStorageKey(result.trip.id), JSON.stringify(updated));
        }
      } catch {
        setNotice("暂时无法连接行程修改服务，原行程没有变化。");
      } finally {
        setRecalculating(false);
      }
      return;
    }
    setRecalculating(true);
    setNotice("");
    if (value.includes("第二") || value.includes("下午") || value.includes("轻松")) {
      setSelectedDayId("day-2");
      setSelectedStopId("clarke-quay");
    }
    window.setTimeout(() => {
      setRelaxedDayTwo(true);
      setRecalculating(false);
      setComposer("");
      setNotice("已移出艺术科学博物馆，并为第二天下午留出 2 小时自由时间。受影响的 3 段时间已重新计算。");
      setLastChange({ title: "已应用：下午轻松一点", detail: "移出 1 个地点，新增 2 小时自由时间" });
    }, 760);
  }

  function saveTrip() {
    const savedAt = new Date().toISOString();
    window.localStorage.setItem(`travelworld:workspace:${workingTrip.id}`, JSON.stringify({ selectedDayId, relaxedDayTwo, savedAt }));
    if (isLive && liveContext) {
      const updated: StoredLiveTrip = { ...liveContext, trip: workingTrip, savedAt };
      setLiveContext(updated);
      window.localStorage.setItem(liveTripStorageKey(workingTrip.id), JSON.stringify(updated));
    }
    setNotice(isLive ? "真实候选行程已保存在这台设备的浏览器中。" : "行程样例已保存到这台设备。");
  }

  async function shareTrip() {
    if (isLive) {
      setNotice("第一版真实行程仅保存在当前设备，跨设备分享将在持久化版本开放。");
      return;
    }
    try {
      await navigator.clipboard.writeText(window.location.href);
      setNotice("分享链接已复制；酒店精确位置默认不会出现在公开分享中。");
    } catch {
      setNotice("当前浏览器无法自动复制，请直接复制地址栏链接。");
    }
  }

  return (
    <main className="tw-workspace">
      <header className="tw-workspace-header">
        <div className="tw-workspace-brand">
          <a href="/travel" className="tw-icon-button" aria-label="返回 travelworld"><ArrowLeft size={18} /></a>
          <TravelLogo compact />
          <span className="tw-workspace-divider" />
          <div><small>{workingTrip.destination} · {workingTrip.timezone} · {isLive ? "GOOGLE LIVE" : "DEMO"}</small><h1>{workingTrip.title}</h1></div>
        </div>
        <div className="tw-workspace-status"><span><i />{isLive ? "真实候选" : "样例"}</span><b>{workingTrip.dateRange}</b></div>
        <div className="tw-workspace-actions">
          <button type="button" aria-label="保存行程" onClick={saveTrip}><Save size={16} /><span>保存</span></button>
          <button type="button" aria-label="分享行程" onClick={shareTrip}><Share2 size={16} /><span>分享</span></button>
          <button type="button" aria-label="导出行程" onClick={() => setNotice("导出功能将在接入真实行程数据后开放。")}><Download size={16} /><span>导出</span></button>
          <button type="button" aria-label="更多选项"><MoreHorizontal size={18} /></button>
        </div>
      </header>

      <aside className="tw-days-panel" aria-label="旅行日期">
        <div className="tw-days-summary">
          <p>YOUR TRIP</p><strong>{workingTrip.dateRange}</strong><span><Hotel size={14} />{workingTrip.hotel}</span>
        </div>
        <div className="tw-day-tabs" role="tablist" aria-label="选择日期">
          {workingTrip.days.map((day) => (
            <button
              type="button"
              role="tab"
              key={day.id}
              aria-selected={selectedDay.id === day.id}
              className="tw-day-tab"
              style={{ "--day-color": day.color } as React.CSSProperties}
              onClick={() => selectDay(day)}
            >
              <span><b>{day.label}</b><small>{day.weekday}</small></span>
              <strong>{day.date}</strong>
              <em>{day.theme}</em>
            </button>
          ))}
        </div>
        <div className="tw-trip-vitals">
          <p>行程条件</p>
          <span><Clock3 size={15} /><b>{workingTrip.pace}</b><small>旅行节奏</small></span>
          <span><Route size={15} /><b>公共交通</b><small>主要方式</small></span>
          <span><LockKeyhole size={15} /><b>{workingTrip.accommodationMode === "area" ? "区域参考点" : "酒店已保护"}</b><small>{workingTrip.accommodationMode === "area" ? "酒店确定后可重规划" : "分享隐私"}</small></span>
        </div>
      </aside>

      <section className="tw-workspace-map">
        {isLive ? (
          <div className="tw-live-map-shell">
            <GoogleSingaporeMap
              markers={mapMarkers}
              route={routePoints}
              selectedMarkerId={selectedStopId}
              onMarkerSelect={setSelectedStopId}
              routeColor={selectedDay.color}
              className="tw-live-google-map"
              ariaLabel={`${selectedDay.label} Google 新加坡真实路线地图`}
            />
            <div className="tw-map-caption"><span className="tw-live-dot" /><div><strong>Google Maps · 真实地点</strong><small>路线为候选结果，出发前请复核实时交通与营业状态</small></div></div>
          </div>
        ) : <SingaporeMap day={selectedDay} selectedStopId={selectedStopId} onSelectStop={setSelectedStopId} />}
        {recalculating && <div className="tw-map-recalculating" role="status"><span className="tw-spinner" /><div><strong>{reanchoringAccommodation ? "正在重算全程住宿路线" : "正在重算受影响的路线"}</strong><small>{reanchoringAccommodation ? "更新每天的出发、返回与时间" : "保留酒店与已锁定地点"}</small></div></div>}
      </section>

      <aside className="tw-timeline-panel" aria-label={`${selectedDay.label} 时间轴`}>
        <div className="tw-timeline-head">
          <div><p>{selectedDay.label.toUpperCase()} · {selectedDay.date}</p><h2>{selectedDay.theme}</h2></div>
          <div className="tw-timeline-actions">
            {isLive && <button type="button" className="tw-change-accommodation-trigger" onClick={openAccommodationEditor} disabled={recalculating}><Hotel size={14} /><span>更换住宿</span></button>}
            <button type="button" aria-label="切换视图"><span>时间轴</span><ChevronDown size={15} /></button>
          </div>
        </div>
        <p className="tw-timeline-summary">{selectedDay.summary}</p>

        {isLive && accommodationEditorOpen && (
          <section className="tw-accommodation-drawer" aria-label="设置分段住宿">
            <div className="tw-accommodation-drawer-head"><div><small>STAY SEGMENT</small><strong>设置分段住宿</strong></div><button type="button" onClick={() => setAccommodationEditorOpen(false)} aria-label="关闭住宿设置">×</button></div>
            <p>从指定日期开始入住新酒店，直到下一次换酒店。换酒店当天会从上一晚酒店出发，并在新酒店结束。</p>
            <label className="tw-accommodation-day-select" htmlFor="accommodation-start-day">
              <span>新住宿从</span>
              <select id="accommodation-start-day" value={accommodationStartDayId} onChange={(event) => setAccommodationStartDayId(event.target.value)} disabled={searchingAccommodation || reanchoringAccommodation}>
                {workingTrip.days.map((day) => <option key={day.id} value={day.id}>{day.label} · {day.date}</option>)}
              </select>
              <span>开始</span>
            </label>
            {workingTrip.accommodationSegments && workingTrip.accommodationSegments.length > 1 && (
              <small className="tw-accommodation-segments">当前住宿段：{workingTrip.accommodationSegments.map((segment) => `${segment.startDayId.replace("day-", "Day ")} ${segment.anchor.name}`).join(" · ")}</small>
            )}
            <form onSubmit={searchAccommodation} className="tw-accommodation-search">
              <label htmlFor="accommodation-query" className="tw-sr-only">搜索酒店</label>
              <input id="accommodation-query" value={accommodationQuery} onChange={(event) => setAccommodationQuery(event.target.value)} placeholder="输入酒店名称或区域，例如 Bugis" disabled={searchingAccommodation || reanchoringAccommodation} />
              <button type="submit" disabled={!accommodationQuery.trim() || searchingAccommodation || reanchoringAccommodation}>{searchingAccommodation ? <span className="tw-spinner" /> : "搜索"}</button>
            </form>
            {accommodationQuotesLoading && <small className="tw-accommodation-segments">正在用一个临时会话依次查询最多 5 家酒店的飞猪价格…</small>}
            {accommodationQuotesError && <small className="tw-accommodation-quote-warning">{accommodationQuotesError}</small>}
            {hotelCandidates.length > 0 && <div className="tw-accommodation-results">
              {hotelCandidates.map((candidate) => <article className="tw-accommodation-result" key={candidate.placeId}>
                <div><strong>{candidate.name}</strong><small>{candidate.address}</small><em>{candidate.rating ? `Google ${candidate.rating.toFixed(1)}${candidate.userRatingCount ? ` · ${candidate.userRatingCount} 条评价` : ""}` : "Google Places 已验证"}</em><em className={`tw-hotel-quote ${accommodationQuoteClass(accommodationQuotes[candidate.placeId], accommodationQuotesLoading)}`}>{accommodationQuoteLabel(accommodationQuotes[candidate.placeId], accommodationQuotesLoading, accommodationQuotesError)}</em>{accommodationQuotes[candidate.placeId]?.bookingUrl && <a className="tw-hotel-booking" href={accommodationQuotes[candidate.placeId].bookingUrl} target="_blank" rel="noreferrer">预订详情<ExternalLink size={11} /></a>}</div>
                <button type="button" onClick={() => void reanchorAccommodation(candidate)} disabled={reanchoringAccommodation || recalculating}>{reanchoringAccommodation ? "重算中" : `设为 ${accommodationStartDayId.replace("day-", "Day ")} 起住宿`}</button>
              </article>)}
            </div>}
          </section>
        )}

        {isLive && workingTrip.warnings?.length ? <div className="tw-live-warning"><CircleAlert size={15} /><span>{workingTrip.warnings[0]}{workingTrip.warnings.length > 1 ? `（另有 ${workingTrip.warnings.length - 1} 项提示）` : ""}</span></div> : null}

        {notice && <div className="tw-workspace-notice" role="status"><Check size={16} /><span>{notice}</span><button type="button" aria-label="关闭通知" onClick={() => setNotice("")}>×</button></div>}

        {lastChange && (
          <div className="tw-change-summary"><Sparkles size={16} /><div><strong>{lastChange.title}</strong><small>{lastChange.detail}</small></div></div>
        )}

        {detailStop && (
          <section className="tw-place-detail-drawer" aria-label={`${detailStop.name} 详情`}>
            <div className="tw-place-detail-head">
              <div><small>GOOGLE PLACE · 地点详情</small><strong>{detailStop.name}</strong></div>
              <button type="button" onClick={() => setDetailStopId(null)} aria-label="关闭地点详情">×</button>
            </div>
            <div className="tw-place-detail-meta">
              <span>{detailStop.categoryLabel || describeSingaporePlace(detailStop, selectedDay.theme).categoryLabel}</span>
              {detailStop.rating ? <span>Google {detailStop.rating.toFixed(1)}{detailStop.userRatingCount ? ` · ${detailStop.userRatingCount} 条评价` : ""}</span> : <span>Google Places 已验证</span>}
            </div>
            <p>{detailStop.description || describeSingaporePlace(detailStop, selectedDay.theme).description}</p>
            <small className="tw-place-detail-address">{detailStop.address || detailStop.area}</small>
            {detailStop.openingHours?.length ? <small className="tw-place-detail-hours">营业信息：{detailStop.openingHours[0]}</small> : null}
            <div className="tw-place-detail-commerce">
              <b>{detailStop.kind === "food" ? "餐厅信息" : "飞猪价格参考"}</b>
              {detailStop.kind === "food" ? <span>FlyAI 当前不覆盖餐厅及餐饮套餐；这里仅展示 Google Places 的地点与营业信息。</span>
                : detailStop.kind === "buffer" ? <span>这是为准时返店保留的自由时间，不作为收费景点查询。</span>
                : detailCommerceLoading ? <span><i className="tw-spinner" />正在查询价格与预订信息…</span>
                  : detailCommerce?.status === "available" ? <span>{detailCommerce.price ? `${detailCommerce.price.display}${detailCommerce.price.unit ? ` · ${detailCommerce.price.unit}` : ""}` : "已找到可用预订信息"}</span>
                    : detailCommerce ? <span>{detailCommerce.note || "暂无可展示价格"}</span>
                      : <span>打开详情后查询可展示的门票、体验或套餐价格。</span>}
            </div>
            <div className="tw-place-detail-actions">
              {detailStop.googleMapsUri && <a href={detailStop.googleMapsUri} target="_blank" rel="noreferrer">Google Maps<ExternalLink size={12} /></a>}
              {detailCommerce?.bookingUrl && <a href={detailCommerce.bookingUrl} target="_blank" rel="noreferrer">飞猪查看详情<ExternalLink size={12} /></a>}
            </div>
          </section>
        )}

        <ol className="tw-itinerary-list">
          {selectedDay.stops.map((stop, index) => {
            const leg = legAfter(selectedDay, stop.id);
            const mode = leg ? modeMeta[leg.mode] : null;
            const ModeIcon = mode?.icon;
            const descriptor = describeSingaporePlace(stop, selectedDay.theme);
            const categoryLabel = stop.categoryLabel || descriptor.categoryLabel;
            const description = stop.description || descriptor.description;
            const commerce = stop.commerce;
            const commerceLink = commerce?.bookingUrl?.startsWith("https://") ? commerce.bookingUrl : undefined;
            const commerceLabel = commerce?.status === "available"
              ? commerce.kind === "hotel" ? "飞猪 · 酒店价格参考" : "飞猪 · 门票与玩乐参考"
              : commerce?.status === "needs_details" ? "飞猪 · 待补充查询条件" : "飞猪 · 暂无可用报价";
            return (
              <li key={stop.id}>
                {index > 0 && leg && <div className="tw-leg"><span>{ModeIcon && <ModeIcon size={14} />}{mode?.label} {leg.minutes} min</span><small>{leg.distance}</small></div>}
                <div
                  className={`tw-itinerary-item ${selectedStopId === stop.id ? "is-selected" : ""} ${stop.warning ? "has-warning" : ""}`}
                  style={{ "--item-color": selectedDay.color } as React.CSSProperties}
                >
                  <button
                    type="button"
                    className="tw-itinerary-select"
                    onClick={() => setSelectedStopId(stop.id)}
                    aria-pressed={selectedStopId === stop.id}
                  >
                    <time><b>{stop.time}</b><small>{stop.endTime}</small></time>
                    <span className="tw-item-dot">{stop.kind === "hotel" ? <Hotel size={14} /> : index}</span>
                    <span className="tw-item-copy"><span className="tw-item-name"><strong>{stop.name}</strong><i>{categoryLabel}</i></span><small>{stop.area} · {stop.duration}</small><em title={stop.note}>{description}</em>{stop.warning && <mark><CircleAlert size={13} />{stop.warning}</mark>}</span>
                    <span className={`tw-item-state ${stop.warning ? "is-warning" : ""}`} title={stop.warning ? "待确认" : "地点已验证"}>{stop.warning ? <Clock3 size={15} /> : <CheckCircle2 size={15} />}</span>
                  </button>
                  <div className="tw-stop-actions">
                    <button type="button" onClick={() => openPlaceDetails(stop)}>查看详情<ExternalLink size={11} /></button>
                    {stop.kind !== "buffer" && stop.kind !== "food" && (
                      <small>
                        {poiCommerceLoading[stop.id]
                          ? "飞猪价格查询中…"
                          : commerce?.status === "available" && commerce.price
                            ? `${commerce.price.display}${commerce.price.unit ? ` · ${commerce.price.unit}` : ""}`
                            : commerce?.status === "unavailable"
                              ? "飞猪暂无价格"
                              : "价格：查看详情"}
                      </small>
                    )}
                  </div>
                  {commerce && (
                    <div className={`tw-commerce-offer is-${commerce.status}`}>
                      <span className="tw-commerce-copy">
                        <b>{commerceLabel}</b>
                        {(commerce.matchedName || commerce.note) && <small title={commerce.note}>{commerce.matchedName || commerce.note}</small>}
                      </span>
                      {commerce.price && <span className="tw-commerce-price"><strong>{commerce.price.display}</strong>{commerce.price.unit && <small>{commerce.price.unit}</small>}</span>}
                      {commerceLink && <a href={commerceLink} target="_blank" rel="noreferrer" aria-label={`在飞猪查看 ${stop.name}`}><span>查看详情</span><ExternalLink size={12} /></a>}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </aside>

      <form className="tw-workspace-composer" onSubmit={submitChange}>
        <div className="tw-composer-identity"><Sparkles size={16} /><span><strong>{isLive ? "Singapore Intelligence v1.7" : "继续修改行程"}</strong><small>同日多项修改统一重算；自由时间只补充非餐饮景点</small></span></div>
        <label htmlFor="workspace-message" className="tw-sr-only">用自然语言修改行程</label>
        <input id="workspace-message" value={composer} onChange={(event) => setComposer(event.target.value)} placeholder={isLive ? "试试：把 Day 1 的自由活动安排成具体活动；或同时替换两个地点" : "试试：把第二天下午改轻松一点"} />
        <button type="submit" aria-label="应用修改" disabled={!composer.trim() || recalculating}>{recalculating ? <span className="tw-spinner" /> : <Send size={16} />}<span>应用修改</span></button>
      </form>
    </main>
  );
}
