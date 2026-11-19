"use client";

/* Native anchors deliberately bypass the deployed Vinext client router. */
/* eslint-disable @next/next/no-html-link-for-pages */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import {
  ArrowLeft, Bike, BusFront, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert,
  Clock3, Download, ExternalLink, Footprints, Hotel, LockKeyhole, MoreHorizontal,
  Route, Save, Send, Share2, Sparkles, TrainFront,
} from "lucide-react";
import { GoogleSingaporeMap, type GoogleSingaporeMapPoint } from "@/components/travel/google-singapore-map";
import { SingaporeMap } from "@/components/travel/singapore-map";
import { ShareTripDialog } from "@/components/travel/share-trip-dialog";
import { TravelLogo } from "@/components/travel/travel-logo";
import { TripPlaceAdvice, TripPlaceCardContent, tripStopPeriodLabel } from "@/components/travel/trip-place-card";
import { describeSingaporePlace } from "@/lib/travel/place-description";
import { cnyPriceLabel, cnyReferenceLabel } from "@/lib/travel/cny-price";
import { regularOpeningHoursLabel } from "@/lib/travel/planning-hours";
import { hotelMapQuotePresentation } from "@/lib/travel/planning-map-hotel-commerce";
import { liveTripStorageKey, type StoredLiveTrip } from "@/lib/travel/trip-storage";
import { getTravelVisitToken } from "@/lib/travel/visit-client";
import type { DemoTrip, RouteLeg, SingaporeTravelIntent, TravelCommerce, TravelMode, TripDay, TripStop } from "@/lib/travel/types";

type GooglePlaceMatch = { placeId: string; name: string; address: string; types: string[]; primaryType: string | null; rating: number | null };

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
  if (quote?.status === "available") {
    return cnyReferenceLabel(quote.price);
  }
  if (quote?.status === "needs_details") return quote.note || "补充日期与同行人数后可查询价格";
  if (quote?.status === "unavailable") return quote.note || "飞猪暂未返回可靠报价";
  return error || "飞猪价格暂未返回";
}

function accommodationQuoteClass(quote: TravelCommerce | undefined, loading: boolean) {
  if (loading && !quote) return "is-loading";
  return `is-${quote?.status || "unavailable"}`;
}

const WORKSPACE_LAYOUT_KEY = "travelworld:workspace-layout:v1";
const DEFAULT_LEFT_WIDTH = 240;
const DEFAULT_RIGHT_WIDTH = 400;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function escapeHtml(value: string | number | null | undefined) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] || character);
}

function exportedTripHtml(trip: DemoTrip) {
  const daySections = trip.days.map((day) => `
    <section class="day"><h2>${escapeHtml(day.label)} · ${escapeHtml(day.date)} <small>${escapeHtml(day.theme)}</small></h2>
      <p>${escapeHtml(day.summary)}</p>${day.overtimeAcceptance ? `<p>已确认超时 ${escapeHtml(day.overtimeAcceptance.minutes)} 分钟：预计 ${escapeHtml(day.overtimeAcceptance.estimatedArrival)} 到达，原截止时间 ${escapeHtml(day.overtimeAcceptance.deadline)}。</p>` : ""}<ol>${day.stops.map((stop) => `
        <li><b>${escapeHtml(tripStopPeriodLabel(stop.time, stop.kind, day.stops[0]?.id === stop.id, day.stops.at(-1)?.id === stop.id))}<small>估算 ${escapeHtml(stop.time)}${stop.endTime && stop.endTime !== stop.time ? `–${escapeHtml(stop.endTime)}` : ""}</small></b>
          <span><strong>${escapeHtml(stop.name)}</strong><small>${escapeHtml(stop.categoryLabel || stop.kind)} · ${escapeHtml(stop.address || stop.area)} · 停留约 ${escapeHtml(stop.duration)}</small>${stop.commerce?.status === "available" && stop.commerce.price ? `<small>飞猪参考：${escapeHtml(cnyReferenceLabel(stop.commerce.price))} · 查询时间 ${escapeHtml(stop.commerce.updatedAt)}</small>` : ""}</span></li>`).join("")}</ol>
      <p class="route">交通：${day.legs.map((leg) => `${escapeHtml(leg.timeSource === "user" ? "你的总时长设置分摊" : modeMeta[leg.mode]?.label || leg.mode)} ${escapeHtml(leg.minutes)} 分钟${leg.distance ? ` · ${escapeHtml(leg.distance)}` : ""}`).join(" ｜ ")}</p>
    </section>`).join("");
  const departureSection = trip.departureTransfer ? `<section class="day"><h2>次日离境 · ${escapeHtml(trip.departureTransfer.date)}</h2><p>从 ${escapeHtml(trip.departureTransfer.fromHotel.name)} 前往 ${escapeHtml(trip.departureTransfer.toAirport.name)}。${escapeHtml(trip.departureTransfer.leaveHotelAt.replace("T", " "))} 离店，${escapeHtml(trip.departureTransfer.arriveAirportAt.replace("T", " "))} 到达机场；航班 ${escapeHtml(trip.departureTransfer.departureAt.replace("T", " "))}。Google 路程与叫车等候预计 ${escapeHtml(trip.departureTransfer.leg.minutes)} 分钟；实际值机、路况请复核。</p></section>` : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(trip.title)} · Travelworld</title><style>
    body{font:15px/1.65 system-ui,sans-serif;color:#172823;max-width:850px;margin:3rem auto;padding:0 1.5rem;background:#fffdf8}h1{font-size:2rem;margin-bottom:.2rem}h2{font-size:1.25rem;border-bottom:1px solid #d9d4c8;padding-bottom:.4rem}h2 small{font-weight:400;color:#62716b;margin-left:.5rem}.meta,.route,small{color:#586c64}.day{break-inside:avoid-page;margin:2rem 0}ol{list-style:none;padding:0}li{display:grid;grid-template-columns:7rem 1fr;gap:1rem;border-bottom:1px solid #e6e2d8;padding:.7rem 0}li span{display:grid}li strong{font-size:1rem}footer{margin-top:2rem;font-size:.8rem;color:#63716b}@media print{body{margin:0;max-width:none;padding:0}.day{break-inside:avoid-page}}
    </style></head><body><header><h1>${escapeHtml(trip.title)}</h1><p class="meta">${escapeHtml(trip.destination)} · ${escapeHtml(trip.dateRange)} · 住宿：${escapeHtml(trip.hotel)}</p></header>${daySections}${departureSection}<footer>由 Travelworld 导出于 ${escapeHtml(new Date().toLocaleString("zh-CN"))}。地点、营业和交通以出行时的实时信息为准；价格以实际预订页面为准。浏览器打开后可打印或另存为 PDF。</footer></body></html>`;
}

export function TripWorkspaceClient({ trip, storedTrip }: TripWorkspaceClientProps) {
  const workspaceRef = useRef<HTMLElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const resizeSideRef = useRef<"left" | "right" | null>(null);
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
  const [tripToShare, setTripToShare] = useState<DemoTrip | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [leftWidth, setLeftWidth] = useState(DEFAULT_LEFT_WIDTH);
  const [rightWidth, setRightWidth] = useState(DEFAULT_RIGHT_WIDTH);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [layoutReady, setLayoutReady] = useState(false);
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
  const [pointEditorOpen, setPointEditorOpen] = useState(false);
  const [pointName, setPointName] = useState("");
  const [pointLatitude, setPointLatitude] = useState("");
  const [pointLongitude, setPointLongitude] = useState("");
  const [pointCategory, setPointCategory] = useState<"sight" | "food" | "transport" | "custom">("sight");
  const [pointVisitMinutes, setPointVisitMinutes] = useState(60);
  const [placeQuery, setPlaceQuery] = useState("");
  const [placeMatches, setPlaceMatches] = useState<GooglePlaceMatch[]>([]);
  const [searchingPlace, setSearchingPlace] = useState(false);
  const [placeSearchError, setPlaceSearchError] = useState("");
  const [undoSnapshot, setUndoSnapshot] = useState<{ trip: DemoTrip; dayId: string } | null>(null);
  const [pendingOvertime, setPendingOvertime] = useState<{ trip: DemoTrip; dayId: string; reply: string; minutes: number } | null>(null);
  const [qaAnswer, setQaAnswer] = useState("");

  useEffect(() => {
    if (!isLive) return;
    void getTravelVisitToken().then((visitToken) => fetch("/api/travel/visit", {
      method: "POST",
      headers: { "x-travel-visit": visitToken },
    })).catch(() => {
      // The next Agent request can retry initialization for this visit.
    });
  }, [isLive]);

  useEffect(() => {
    let saved: Record<string, unknown> | null = null;
    try {
      saved = JSON.parse(window.localStorage.getItem(WORKSPACE_LAYOUT_KEY) || "null") as Record<string, unknown> | null;
    } catch {
      // A blocked or malformed browser preference must not affect the itinerary.
    }
    const frame = window.requestAnimationFrame(() => {
      if (saved) {
        if (typeof saved.leftWidth === "number") setLeftWidth(clamp(saved.leftWidth, 160, 400));
        if (typeof saved.rightWidth === "number") setRightWidth(clamp(saved.rightWidth, 280, 640));
        setLeftCollapsed(saved.leftCollapsed === true);
        setRightCollapsed(saved.rightCollapsed === true);
      }
      setLayoutReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!layoutReady) return;
    try {
      window.localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify({ leftWidth, rightWidth, leftCollapsed, rightCollapsed }));
    } catch {
      // Layout still works for the current visit when storage is unavailable.
    }
  }, [layoutReady, leftWidth, rightWidth, leftCollapsed, rightCollapsed]);

  useEffect(() => {
    const keepMapReadable = () => {
      if (window.innerWidth < 1200) return;
      const available = workspaceRef.current?.clientWidth || window.innerWidth;
      setLeftWidth((width) => clamp(width, 160, available - (rightCollapsed ? 48 : rightWidth) - 420));
      setRightWidth((width) => clamp(width, 280, available - (leftCollapsed ? 48 : leftWidth) - 420));
    };
    window.addEventListener("resize", keepMapReadable);
    keepMapReadable();
    return () => window.removeEventListener("resize", keepMapReadable);
  }, [leftWidth, rightWidth, leftCollapsed, rightCollapsed]);

  useEffect(() => {
    if (!moreOpen) return;
    const closeOnOutside = (event: globalThis.PointerEvent) => {
      if (!moreMenuRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [moreOpen]);

  function resizeTo(side: "left" | "right", pointerX: number) {
    const bounds = workspaceRef.current?.getBoundingClientRect();
    if (!bounds) return;
    if (side === "left") setLeftWidth(clamp(pointerX - bounds.left, 160, Math.min(400, bounds.width - rightWidth - 420)));
    else setRightWidth(clamp(bounds.right - pointerX, 280, Math.min(640, bounds.width - leftWidth - 420)));
  }

  function startResize(side: "left" | "right", event: PointerEvent<HTMLDivElement>) {
    if (window.innerWidth < 1200) return;
    resizeSideRef.current = side;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function moveResize(event: PointerEvent<HTMLDivElement>) {
    if (resizeSideRef.current) resizeTo(resizeSideRef.current, event.clientX);
  }

  function stopResize() {
    resizeSideRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  function keyboardResize(side: "left" | "right", event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = (event.key === "ArrowRight" ? 24 : -24) * (side === "left" ? 1 : -1);
    const available = workspaceRef.current?.clientWidth || window.innerWidth;
    if (side === "left") setLeftWidth((width) => clamp(width + delta, 160, Math.min(400, available - rightWidth - 420)));
    else setRightWidth((width) => clamp(width + delta, 280, Math.min(640, available - leftWidth - 420)));
  }

  function resetWorkspaceLayout() {
    setLeftWidth(DEFAULT_LEFT_WIDTH);
    setRightWidth(DEFAULT_RIGHT_WIDTH);
    setLeftCollapsed(false);
    setRightCollapsed(false);
    setMoreOpen(false);
    setNotice("已恢复地图与行程面板的默认布局。");
  }

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

  const selectedDayOvertime = useMemo(() => {
    const last = selectedDay.stops.at(-1)?.time;
    if (!last || !selectedDay.returnBy || !/^\d{2,3}:\d{2}$/.test(last) || !/^\d{2,3}:\d{2}$/.test(selectedDay.returnBy)) return 0;
    const [hour, minute] = last.split(":").map(Number);
    const [deadlineHour, deadlineMinute] = selectedDay.returnBy.split(":").map(Number);
    return Math.max(0, hour * 60 + minute - deadlineHour * 60 - deadlineMinute);
  }, [selectedDay]);
  const lastHotelNightDay = workingTrip.days.length - (workingTrip.days.at(-1)?.terminalKind === "airport" ? 1 : 0);
  const selectedTerminalLabel = selectedDay.terminalKind === "airport" ? "到达机场" : "返回酒店";
  const selectedDepartureTransfer = selectedDay.id === workingTrip.days.at(-1)?.id ? workingTrip.departureTransfer : undefined;

  const mapMarkers = useMemo(() => [...selectedDay.stops.map((stop, index) => ({
    id: stop.id,
    title: stop.name,
    lat: stop.lat ?? stop.location?.lat,
    lng: stop.lng ?? stop.location?.lng,
    placeId: stop.placeId,
    label: stop.kind === "hotel" ? "H" : stop.kind === "other" && /机场|airport/i.test(stop.categoryLabel || "") ? "✈" : index,
    kind: stop.kind === "hotel" ? "hotel" as const : stop.kind === "food" ? "food" as const : stop.kind === "other" && /机场|airport|交通/i.test(stop.categoryLabel || "") ? "transport" as const : stop.kind === "other" || stop.kind === "buffer" ? "activity" as const : "attraction" as const,
    color: selectedDay.color,
  })), ...(selectedDepartureTransfer ? [{
    id: "next-day-departure-airport", title: `${selectedDepartureTransfer.date} · ${selectedDepartureTransfer.toAirport.name}`,
    lat: selectedDepartureTransfer.toAirport.location.lat, lng: selectedDepartureTransfer.toAirport.location.lng,
    placeId: selectedDepartureTransfer.toAirport.placeId, label: "✈", kind: "transport" as const,
    color: selectedDay.color,
  }] : [])], [selectedDay, selectedDepartureTransfer]);

  const previewPoint = useMemo(() => {
    if (!pointEditorOpen || !pointLatitude || !pointLongitude) return null;
    const lat = Number(pointLatitude);
    const lng = Number(pointLongitude);
    return Number.isFinite(lat) && Number.isFinite(lng) && lat >= 1.1496 && lat <= 1.4784 && lng >= 103.594 && lng <= 104.106 ? { lat, lng } : null;
  }, [pointEditorOpen, pointLatitude, pointLongitude]);
  const visibleMapMarkers = useMemo(() => previewPoint ? [...mapMarkers, {
    id: "draft-manual-point", title: "待添加的手动坐标", lat: previewPoint.lat, lng: previewPoint.lng,
    label: "+", kind: "activity" as const, color: "#0f705c",
  }] : mapMarkers, [mapMarkers, previewPoint]);

  function pickMapPoint(point: GoogleSingaporeMapPoint) {
    if (!pointEditorOpen) return;
    if (point.lat < 1.1496 || point.lat > 1.4784 || point.lng < 103.594 || point.lng > 104.106) {
      setNotice("这个位置超出目前的新加坡路线服务范围，请选择市内坐标。");
      return;
    }
    setPointLatitude(point.lat.toFixed(6));
    setPointLongitude(point.lng.toFixed(6));
    setRightCollapsed(false);
    setNotice("已从地图选取坐标。请填写名称、类别与停留时间后添加。");
  }

  const routePoints = useMemo(() => [...selectedDay.legs.flatMap((leg) => (
    leg.encodedPolyline ? decodeGooglePolyline(leg.encodedPolyline) : []
  )), ...(selectedDepartureTransfer?.leg.encodedPolyline ? decodeGooglePolyline(selectedDepartureTransfer.leg.encodedPolyline) : [])], [selectedDay.legs, selectedDepartureTransfer]);

  const detailStop = useMemo(() => workingTrip.days
    .flatMap((day) => day.stops)
    .find((stop) => stop.id === detailStopId) || null, [detailStopId, workingTrip.days]);
  const detailCommerce = detailStop?.commerce;
  const detailHotelQuote = detailStop?.kind === "hotel" ? hotelMapQuotePresentation(detailStop) : null;
  const detailBookingUrl = detailHotelQuote ? (detailStop?.verified ? detailHotelQuote.bookingUrl : undefined) : detailCommerce?.bookingUrl;
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
    if (!isLive || stop.kind === "hotel" || stop.kind === "food" || stop.sceneRole === "culinary_area" || stop.kind === "other" || stop.kind === "buffer" || !stop.placeId || poiCommerceLoading[stop.id]) return;
    setPoiCommerceLoading((current) => ({ ...current, [stop.id]: true }));
    try {
      const response = await fetch("/api/travel/singapore/poi-commerce", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-travel-visit": await getTravelVisitToken() },
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
    if (stop.verified && stop.kind === "sight" && !stop.commerce) void loadPoiCommerce(stop);
  }

  function applyEditedTrip(next: DemoTrip, reply: string, dayId = selectedDayId) {
    setWorkingTrip(next);
    const changedDay = next.days.find((day) => day.id === dayId) || next.days[0];
    setSelectedDayId(changedDay.id);
    setSelectedStopId(changedDay.stops.find((stop) => stop.kind !== "hotel")?.id || changedDay.stops[0].id);
    setDetailStopId(null);
    setNotice(reply);
    setLastChange({ title: "地图已更新", detail: `${changedDay.label} 的地点、路线和时间已重新计算` });
    if (liveContext) {
      const updated: StoredLiveTrip = { ...liveContext, trip: next, savedAt: new Date().toISOString() };
      setLiveContext(updated);
      try { window.localStorage.setItem(liveTripStorageKey(next.id), JSON.stringify(updated)); } catch { /* The visible itinerary remains usable. */ }
    }
  }

  async function editMap(action: Record<string, unknown>) {
    if (!isLive || recalculating || pendingOvertime) return;
    setRecalculating(true);
    setNotice("");
    setLastChange(null);
    try {
      const response = await fetch("/api/travel/singapore/map-edit", {
        method: "POST", headers: { "Content-Type": "application/json", "x-travel-visit": await getTravelVisitToken() },
        body: JSON.stringify({ trip: workingTrip, dayId: selectedDayId, action }),
      });
      const payload = await response.json().catch(() => null) as { trip?: DemoTrip; reply?: string; requiresConfirmation?: boolean; metrics?: { overtimeMinutes: number }; error?: { message?: string } } | null;
      if (!response.ok || !payload?.trip) throw new Error(payload?.error?.message || "路线没有重新计算，原行程保持不变。");
      if (payload.requiresConfirmation) {
        setPendingOvertime({ trip: payload.trip, dayId: selectedDayId, reply: payload.reply || "行程超过了终点截止时间。", minutes: payload.metrics?.overtimeMinutes || 0 });
        setRightCollapsed(false);
      } else {
        setUndoSnapshot({ trip: workingTrip, dayId: selectedDayId });
        applyEditedTrip(payload.trip, payload.reply || "路线已重新计算。");
        if (action.type === "add" || action.type === "addPlace") { setPointEditorOpen(false); setPointName(""); setPointLatitude(""); setPointLongitude(""); setPlaceMatches([]); setPlaceQuery(""); }
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "地图编辑失败，原行程保持不变。");
    } finally {
      setRecalculating(false);
    }
  }

  function addManualPoint(event: FormEvent) {
    event.preventDefault();
    const lat = Number(pointLatitude);
    const lng = Number(pointLongitude);
    if (!pointName.trim() || !Number.isFinite(lat) || !Number.isFinite(lng)) { setNotice("请输入地点名称及有效的纬度、经度。"); return; }
    void editMap({ type: "add", name: pointName.trim(), category: pointCategory, location: { lat, lng }, visitMinutes: pointVisitMinutes });
  }

  async function searchGooglePlace() {
    const query = placeQuery.trim();
    if (!query || searchingPlace) return;
    setSearchingPlace(true);
    setPlaceSearchError("");
    setPlaceMatches([]);
    try {
      const response = await fetch("/api/travel/singapore/places", {
        method: "POST", headers: { "Content-Type": "application/json", "x-travel-visit": await getTravelVisitToken() },
        body: JSON.stringify({ query, maxResults: 6, languageCode: "zh-CN" }),
      });
      const payload = await response.json().catch(() => null) as { places?: GooglePlaceMatch[]; error?: { message?: string } } | null;
      if (!response.ok) throw new Error(payload?.error?.message || "Google Places 暂时无法搜索地点。");
      const matches = (payload?.places || []).filter((place) => !/(?:^|\s)(?:hotel|lodging|motel|hostel|airport|hospital|train_station|bus_station)(?:\s|$)/i.test([place.primaryType, ...(place.types || [])].filter(Boolean).join(" ")));
      setPlaceMatches(matches);
      if (!matches.length) setPlaceSearchError("没有找到可加入行程的活动或餐饮地点，请换一个具体名称。");
    } catch (error) {
      setPlaceSearchError(error instanceof Error ? error.message : "Google Places 暂时无法搜索地点。");
    } finally {
      setSearchingPlace(false);
    }
  }

  function undoLastMapEdit() {
    if (!undoSnapshot || recalculating || pendingOvertime) return;
    applyEditedTrip(undoSnapshot.trip, "已撤销上一次地图修改，并恢复此前的地点、路线和时间。", undoSnapshot.dayId);
    setUndoSnapshot(null);
  }

  function selectDay(day: TripDay) {
    setSelectedDayId(day.id);
    setSelectedStopId(day.stops.find((stop) => stop.kind !== "hotel")?.id || day.stops[0].id);
    setNotice("");
    setLastChange(null);
  }

  function openAccommodationEditor() {
    if (!isLive || recalculating || lastHotelNightDay < 1) return;
    const targetDayNumber = Math.min(Number(selectedDayId.replace("day-", "")), lastHotelNightDay);
    const targetDayId = `day-${targetDayNumber}`;
    const selectedNightHotel = workingTrip.days.find((day) => day.id === targetDayId)?.stops.at(-1)?.name.replace(/^返回\s+/, "");
    setAccommodationQuery(selectedNightHotel || workingTrip.hotel);
    setAccommodationStartDayId(targetDayId);
    setHotelCandidates([]);
    setAccommodationQuotes({});
    setAccommodationQuotesError("");
    setAccommodationEditorOpen(true);
    setNotice(`从 ${targetDayId.replace("day-", "Day ")} 起设置新住宿；抵达日保留机场起点，其余换住日从上一晚酒店出发。`);
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
        headers: { "Content-Type": "application/json", "x-travel-visit": await getTravelVisitToken() },
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
      setUndoSnapshot(null);
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
      setRecalculating(true);
      setNotice("");
      setQaAnswer("");
      try {
        const response = await fetch("/api/travel/singapore/trip-qa", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-travel-visit": await getTravelVisitToken() },
          body: JSON.stringify({ question: value, dayId: selectedDayId, trip: workingTrip }),
        });
        const payload = await response.json().catch(() => null) as { answer?: string; error?: { message?: string } } | null;
        if (!response.ok || !payload?.answer) throw new Error(payload?.error?.message || "暂时无法回答，请稍后重试。");
        setComposer("");
        setQaAnswer(payload.answer);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "答疑暂时不可用，请稍后重试。");
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
    try {
      const savedAt = new Date().toISOString();
      window.localStorage.setItem(`travelworld:workspace:${workingTrip.id}`, JSON.stringify({ selectedDayId, relaxedDayTwo, savedAt }));
      if (isLive && liveContext) {
        const updated: StoredLiveTrip = { ...liveContext, trip: workingTrip, savedAt };
        setLiveContext(updated);
        window.localStorage.setItem(liveTripStorageKey(workingTrip.id), JSON.stringify(updated));
      }
      setNotice(isLive ? "行程已保存到此设备，刷新页面后仍可恢复。" : "行程样例已保存到此设备。");
    } catch {
      setNotice("浏览器未允许保存本地数据；请检查存储空间或浏览器设置。");
    }
  }

  function shareTrip() {
    setTripToShare(workingTrip);
  }

  function exportTrip() {
    try {
      const file = new Blob([exportedTripHtml(workingTrip)], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(file);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `travelworld-${workingTrip.id.replace(/[^a-zA-Z0-9_-]/g, "-")}.html`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setNotice("已导出可打印的行程文件。打开文件后可打印或另存为 PDF。");
    } catch {
      setNotice("导出失败，请稍后重试。");
    }
  }

  return (
    <main
      ref={workspaceRef}
      className="tw-workspace"
      data-left-collapsed={leftCollapsed}
      data-right-collapsed={rightCollapsed}
      style={{ "--tw-left-column": leftCollapsed ? "3rem" : `${leftWidth}px`, "--tw-right-column": rightCollapsed ? "3rem" : `${rightWidth}px` } as CSSProperties}
    >
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
          <button type="button" aria-label="导出行程" onClick={exportTrip}><Download size={16} /><span>导出</span></button>
          <div className="tw-more-wrap" ref={moreMenuRef}>
            <button type="button" aria-label="更多选项" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}><MoreHorizontal size={18} /></button>
            {moreOpen && <div className="tw-more-menu" role="menu" aria-label="行程其他操作">
              <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); shareTrip(); }}>预览并分享行程</button>
              <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); exportTrip(); }}>导出可打印行程</button>
              <button type="button" role="menuitem" onClick={resetWorkspaceLayout}>恢复默认布局</button>
              <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); setNotice("地点来自 Google Places，路线由 Google Routes 计算；酒店与景点报价按需查询飞猪。餐厅不查询飞猪。"); }}>查看数据来源</button>
            </div>}
          </div>
        </div>
      </header>

      {notice && <div className="tw-workspace-feedback" role="status" aria-live="polite"><Sparkles size={16} /><div><span>{notice}</span></div><button type="button" aria-label="关闭通知" onClick={() => setNotice("")}>×</button></div>}
      {tripToShare && <ShareTripDialog trip={tripToShare} onClose={() => setTripToShare(null)} />}

      <aside className="tw-days-panel" aria-label="旅行日期">
        <div className="tw-panel-resizer tw-panel-resizer-left" role="separator" aria-label="调整日期面板宽度" aria-orientation="vertical" aria-valuemin={160} aria-valuemax={400} aria-valuenow={leftWidth} tabIndex={0} onPointerDown={(event) => startResize("left", event)} onPointerMove={moveResize} onPointerUp={stopResize} onPointerCancel={stopResize} onKeyDown={(event) => keyboardResize("left", event)} />
        <button type="button" className="tw-panel-reopen tw-panel-reopen-left" aria-label="展开日期面板" title="展开日期面板" onClick={() => setLeftCollapsed(false)}><ChevronRight size={18} /></button>
        <div className="tw-days-summary">
          <div className="tw-days-summary-heading"><p>YOUR TRIP</p><button type="button" aria-label="收起日期面板" title="收起日期面板" onClick={() => setLeftCollapsed(true)}><ChevronLeft size={16} /></button></div><strong>{workingTrip.dateRange}</strong><span><Hotel size={14} />{workingTrip.hotel}</span>
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
          <span><Route size={15} /><b>{isLive ? "逐段选择" : "公共交通"}</b><small>交通方式</small></span>
          <span><LockKeyhole size={15} /><b>{workingTrip.accommodationMode === "area" ? "区域参考点" : "酒店已保护"}</b><small>{workingTrip.accommodationMode === "area" ? "酒店确定后可重规划" : "分享隐私"}</small></span>
        </div>
      </aside>

      <section className="tw-workspace-map">
        {isLive ? (
          <div className="tw-live-map-shell">
            <GoogleSingaporeMap
              markers={visibleMapMarkers}
              route={routePoints}
              selectedMarkerId={selectedStopId}
              onMarkerSelect={setSelectedStopId}
              onMapClick={pointEditorOpen ? pickMapPoint : undefined}
              panToSelected={!pointEditorOpen}
              routeColor={selectedDay.color}
              className="tw-live-google-map"
              ariaLabel={`${selectedDay.label} Google 新加坡真实路线地图`}
            />
            {pointEditorOpen && <div className="tw-map-pick-hint" role="status">点击地图选取坐标 <span>或在右侧手动输入</span></div>}
            <div className="tw-map-caption"><span className="tw-live-dot" /><div><strong>Google Maps · 逐段路线</strong><small>{selectedDepartureTransfer ? "末段另含次日酒店至机场接驳；出发前复核航班与路况" : "手动坐标会明确标注未验证；出发前请复核交通与营业状态"}</small></div></div>
          </div>
        ) : <SingaporeMap day={selectedDay} selectedStopId={selectedStopId} onSelectStop={setSelectedStopId} />}
        {recalculating && <div className="tw-map-recalculating" role="status"><span className="tw-spinner" /><div><strong>{reanchoringAccommodation ? "正在重算全程住宿路线" : "正在处理请求"}</strong><small>{reanchoringAccommodation ? "更新每天的出发、返回与时间" : "地图修改按 Google Routes 重算；答疑不会改变行程"}</small></div></div>}
      </section>

      <aside className="tw-timeline-panel" aria-label={`${selectedDay.label} 本日地点`}>
        <div className="tw-panel-resizer tw-panel-resizer-right" role="separator" aria-label="调整行程面板宽度" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={640} aria-valuenow={rightWidth} tabIndex={0} onPointerDown={(event) => startResize("right", event)} onPointerMove={moveResize} onPointerUp={stopResize} onPointerCancel={stopResize} onKeyDown={(event) => keyboardResize("right", event)} />
        <button type="button" className="tw-panel-reopen tw-panel-reopen-right" aria-label="展开行程面板" title="展开行程面板" onClick={() => setRightCollapsed(false)}><ChevronLeft size={18} /></button>
        <div className="tw-timeline-head">
          <div><p>{selectedDay.label.toUpperCase()} · {selectedDay.date} · {selectedDay.theme}</p><h2>本日地点</h2></div>
          <div className="tw-timeline-actions">
            <button type="button" className="tw-panel-collapse-right" aria-label="收起行程面板" title="收起行程面板" onClick={() => setRightCollapsed(true)}><ChevronRight size={16} /></button>
            {isLive && lastHotelNightDay > 0 && <button type="button" className="tw-change-accommodation-trigger" onClick={openAccommodationEditor} disabled={recalculating}><Hotel size={14} /><span>更换住宿</span></button>}
            {isLive && <button type="button" className="tw-change-accommodation-trigger" onClick={() => setPointEditorOpen((open) => !open)} disabled={recalculating}><span>＋ 添加地点</span></button>}
            {isLive && undoSnapshot && <button type="button" className="tw-change-accommodation-trigger" onClick={undoLastMapEdit} disabled={recalculating || Boolean(pendingOvertime)}>撤销上次修改</button>}
          </div>
        </div>
        <p className="tw-timeline-summary">{selectedDay.summary}</p>
        {selectedDepartureTransfer && <section className="tw-next-day-transfer" aria-label="次日离境机场接驳">
          <strong>次日离境 · {selectedDepartureTransfer.date}</strong>
          <p>{selectedDepartureTransfer.fromHotel.name} → {selectedDepartureTransfer.toAirport.name}</p>
          <small>{selectedDepartureTransfer.leaveHotelAt.replace("T", " ")} 离店 · {selectedDepartureTransfer.arriveAirportAt.replace("T", " ")} 到机场 · 航班 {selectedDepartureTransfer.departureAt.slice(11)}</small>
          <small>Google 驾车路线与叫车等候约 {selectedDepartureTransfer.leg.minutes} 分钟；机场提前 {selectedDepartureTransfer.airportLeadMinutes} 分钟到达。</small>
        </section>}
        {isLive && selectedDayOvertime > 0 && <div className={selectedDay.overtimeAcceptance ? "tw-map-overtime-confirm is-accepted" : "tw-map-overtime-confirm"} role="status"><strong><CircleAlert size={17} />{selectedDay.overtimeAcceptance ? "已确认超时" : "当天预计超时"} {selectedDayOvertime} 分钟</strong><p>当前路线预计 {selectedDay.stops.at(-1)?.time} {selectedTerminalLabel}，晚于截止时刻 {selectedDay.returnBy}。{selectedDay.overtimeAcceptance ? "你已明确选择保留这一安排；再次编辑路线后需要重新确认。" : "可移除地点或改选交通方式重算。"}</p></div>}

        {isLive && pointEditorOpen && <form className="tw-map-point-editor" onSubmit={addManualPoint}>
          <strong>添加地点</strong>
          <p>先搜索 Google 验证的真实地点；也可点击地图或手动填写坐标。每次添加都会重新计算当天路线。</p>
          <div className="tw-map-place-search"><label>搜索地点<input value={placeQuery} onChange={(event) => { setPlaceQuery(event.target.value); setPlaceMatches([]); setPlaceSearchError(""); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void searchGooglePlace(); } }} placeholder="例如：新加坡国家美术馆" /></label><button type="button" disabled={searchingPlace || !placeQuery.trim()} onClick={() => void searchGooglePlace()}>{searchingPlace ? "搜索中…" : "搜索"}</button></div>
          <label>预计停留（分钟）<input required type="number" min={15} max={480} value={pointVisitMinutes} onChange={(event) => setPointVisitMinutes(Number(event.target.value))} /></label>
          {placeSearchError && <p role="status">{placeSearchError}</p>}
          {placeMatches.length > 0 && <div className="tw-map-place-results" aria-label="Google Places 搜索结果">{placeMatches.map((place) => <div key={place.placeId}><span><strong>{place.name}</strong><small>{place.address}{place.rating != null ? ` · Google ${place.rating.toFixed(1)}` : ""}</small></span><button type="button" disabled={recalculating} onClick={() => void editMap({ type: "addPlace", placeId: place.placeId, visitMinutes: pointVisitMinutes })}>加入当天</button></div>)}</div>}
          <hr /><strong>手动坐标</strong><p>手动地点不会标为 Google 已验证；请自行核对地点身份与营业信息。</p>
          <label>地点名称<input required maxLength={80} value={pointName} onChange={(event) => setPointName(event.target.value)} placeholder="例如：海滨观景台" /></label>
          <label>类别<select value={pointCategory} onChange={(event) => setPointCategory(event.target.value as "sight" | "food" | "transport" | "custom")}><option value="sight">景点与体验</option><option value="food">餐饮</option><option value="transport">交通节点</option><option value="custom">自定义地点</option></select></label>
          <div className="tw-map-point-coordinates"><label>纬度<input required type="number" step="any" value={pointLatitude} onChange={(event) => setPointLatitude(event.target.value)} placeholder="1.283" /></label><label>经度<input required type="number" step="any" value={pointLongitude} onChange={(event) => setPointLongitude(event.target.value)} placeholder="103.86" /></label></div>
          <button type="submit" disabled={recalculating || !pointName.trim()}>添加并重算路线</button>
        </form>}

        {isLive && qaAnswer && <div className="tw-trip-qa-answer" role="status"><strong>旅行答疑</strong><p>{qaAnswer}</p><button type="button" onClick={() => setQaAnswer("")}>收起</button></div>}

        {pendingOvertime && <div className="tw-map-overtime-confirm" role="alert">
          <strong><CircleAlert size={17} />超出终点截止时间 {pendingOvertime.minutes} 分钟</strong>
          <p>{pendingOvertime.reply}</p>
          <div><button type="button" onClick={() => setPendingOvertime(null)}>返回调整</button><button type="button" onClick={() => {
            const pending = pendingOvertime;
            const acceptedAt = new Date().toISOString();
            const acceptedTrip: DemoTrip = { ...pending.trip, days: pending.trip.days.map((day) => day.id === pending.dayId ? { ...day, overtimeAcceptance: { minutes: pending.minutes, acceptedAt, deadline: day.returnBy || "", estimatedArrival: day.stops.at(-1)?.time || "" } } : day) };
            setUndoSnapshot({ trip: workingTrip, dayId: pending.dayId });
            applyEditedTrip(acceptedTrip, `${pending.reply} 已按你的确认保留。`, pending.dayId);
            setPendingOvertime(null); setPointEditorOpen(false); setPlaceMatches([]); setPlaceQuery("");
          }}>仍然保留此安排</button></div>
        </div>}

        {isLive && accommodationEditorOpen && (
          <section className="tw-accommodation-drawer" aria-label="设置分段住宿">
            <div className="tw-accommodation-drawer-head"><div><small>STAY SEGMENT</small><strong>设置分段住宿</strong></div><button type="button" onClick={() => setAccommodationEditorOpen(false)} aria-label="关闭住宿设置">×</button></div>
            <p>从指定日期开始入住新酒店，直到下一次换酒店。抵达日保留机场起点；其他换住日从上一晚酒店出发。</p>
            <label className="tw-accommodation-day-select" htmlFor="accommodation-start-day">
              <span>新住宿从</span>
              <select id="accommodation-start-day" value={accommodationStartDayId} onChange={(event) => setAccommodationStartDayId(event.target.value)} disabled={searchingAccommodation || reanchoringAccommodation}>
                {workingTrip.days.slice(0, lastHotelNightDay).map((day) => <option key={day.id} value={day.id}>{day.label} · {day.date}</option>)}
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
              {detailStop.verified ? detailStop.rating ? <span>Google {detailStop.rating.toFixed(1)}{detailStop.userRatingCount ? ` · ${detailStop.userRatingCount} 条评价` : ""}</span> : <span>Google Places 已验证</span> : <span>手动坐标 · 未验证</span>}
            </div>
            <p>{detailStop.description || describeSingaporePlace(detailStop, selectedDay.theme).description}</p>
            <small className="tw-place-detail-address">{detailStop.address || detailStop.area}</small>
            {detailStop.openingHours?.length ? <small className="tw-place-detail-hours">营业信息：{detailStop.openingHours[0]}</small> : null}
            <TripPlaceAdvice advice={detailStop.aiAdvice} />
            <div className="tw-place-detail-commerce">
              <b>{detailStop.sceneRole === "culinary_area" ? "美食区域信息" : detailStop.kind === "food" ? "餐厅信息" : "飞猪价格参考"}</b>
              {!detailStop.verified ? <span>手动地点未经过 Google Places 验证，不提供商品报价。</span>
                : detailHotelQuote ? <>
                  {detailHotelQuote.dates && <small>住宿段：{detailHotelQuote.dates}</small>}
                  {detailHotelQuote.price && <span>{detailHotelQuote.price}</span>}
                  {detailHotelQuote.message && <span>{detailHotelQuote.message}</span>}
                </>
                : (detailStop.kind === "food" || detailStop.sceneRole === "culinary_area") ? <span>FlyAI 当前不覆盖餐厅及餐饮套餐；这里仅展示 Google Places 的地点与营业信息。</span>
                : detailStop.kind === "other" ? <span>交通锚点仅展示地点详情；航班与交通费用请按各自的预订信息核对。</span>
                : detailStop.kind === "buffer" ? <span>这是为准时返店保留的自由时间，不作为收费景点查询。</span>
                : detailCommerceLoading ? <span><i className="tw-spinner" />正在查询价格与预订信息…</span>
                  : detailCommerce?.status === "available" ? <span>{cnyReferenceLabel(detailCommerce.price)}</span>
                    : detailCommerce ? <span>{detailCommerce.note || "暂无可展示价格"}</span>
                      : <span>打开详情后查询可展示的门票、体验或套餐价格。</span>}
            </div>
            <div className="tw-place-detail-actions">
              {detailStop.googleMapsUri && <a href={detailStop.googleMapsUri} target="_blank" rel="noreferrer">Google Maps<ExternalLink size={12} /></a>}
              {detailBookingUrl && <a href={detailBookingUrl} target="_blank" rel="noreferrer">飞猪查看详情<ExternalLink size={12} /></a>}
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
            const openingLabel = stop.openingHours?.length
              ? regularOpeningHoursLabel(stop.openingHoursInfo?.weekdayDescriptions || stop.openingHours, selectedDay.date)
              : null;
            const commerce = stop.commerce;
            const hotelQuote = stop.kind === "hotel" ? hotelMapQuotePresentation(stop) : null;
            const commerceLink = hotelQuote ? (stop.verified ? hotelQuote.bookingUrl : undefined) : commerce?.bookingUrl?.startsWith("https://") ? commerce.bookingUrl : undefined;
            const commerceLabel = commerce?.status === "available"
              ? commerce.kind === "hotel" ? "飞猪 · 酒店价格参考" : "飞猪 · 门票与玩乐参考"
              : commerce?.status === "needs_details" ? "飞猪 · 待补充查询条件" : "飞猪 · 暂无可用报价";
            return (
              <li key={stop.id}>
                {index > 0 && leg && <div className="tw-leg"><span>{ModeIcon && <ModeIcon size={14} />}{leg.timeSource === "user" ? "交通 · 你的设置" : mode?.label} {leg.minutes} min</span><small>{leg.distance}</small>{isLive && <label className="tw-leg-mode"><span className="tw-sr-only">从上一地点到 {stop.name} 的交通方式</span><select aria-label={`到 ${stop.name} 的交通方式`} value={leg.mode === "taxi" || leg.mode === "transit" || leg.mode === "walk" ? leg.mode : "taxi"} disabled={recalculating || Boolean(pendingOvertime)} onChange={(event) => void editMap({ type: "mode", fromId: leg.from, toId: leg.to, mode: event.target.value })}><option value="taxi">打车</option><option value="transit">公共交通</option><option value="walk">步行</option></select></label>}</div>}
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
                    <span className="tw-item-dot">{stop.kind === "hotel" ? <Hotel size={14} /> : index}</span>
                    <TripPlaceCardContent
                      name={stop.name} categoryLabel={categoryLabel}
                      period={tripStopPeriodLabel(stop.time, stop.kind, index === 0, index === selectedDay.stops.length - 1)}
                      area={stop.area} duration={stop.duration}
                      openingLabel={stop.openingHours?.length ? `Google 常规开放：${openingLabel || "请在详情中核对当日信息"}` : undefined}
                      description={description} descriptionTitle={stop.note}
                      warning={stop.warning} aiAdvice={stop.aiAdvice}
                    />
                    <span className={`tw-item-state ${stop.warning || !stop.verified ? "is-warning" : ""}`} title={!stop.verified ? "手动坐标，地点未验证" : stop.warning ? "待确认" : "地点已验证"}>{stop.warning || !stop.verified ? <Clock3 size={15} /> : <CheckCircle2 size={15} />}</span>
                  </button>
                  <div className="tw-stop-actions">
                    <button type="button" onClick={() => openPlaceDetails(stop)}>查看详情<ExternalLink size={11} /></button>
                    {isLive && stop.kind !== "hotel" && index > 0 && index < selectedDay.stops.length - 1 && <button type="button" disabled={recalculating || Boolean(pendingOvertime)} onClick={() => void editMap({ type: "remove", stopId: stop.id })}>移除地点</button>}
                    {isLive && stop.kind !== "hotel" && index > 1 && index < selectedDay.stops.length - 1 && selectedDay.stops[index - 1].kind !== "hotel" && <button type="button" disabled={recalculating || Boolean(pendingOvertime)} onClick={() => void editMap({ type: "move", stopId: stop.id, direction: "up" })} aria-label={`将 ${stop.name} 前移`}>↑ 前移</button>}
                    {isLive && stop.kind !== "hotel" && index > 0 && index < selectedDay.stops.length - 2 && selectedDay.stops[index + 1].kind !== "hotel" && <button type="button" disabled={recalculating || Boolean(pendingOvertime)} onClick={() => void editMap({ type: "move", stopId: stop.id, direction: "down" })} aria-label={`将 ${stop.name} 后移`}>↓ 后移</button>}
                    {stop.verified && stop.kind !== "buffer" && stop.kind !== "food" && stop.sceneRole !== "culinary_area" && stop.kind !== "other" && (
                      <small>
                        {hotelQuote ? hotelQuote.price || (hotelQuote.bookingUrl ? "飞猪详情可查看" : stop.hotelQuote?.status === "not_requested" ? "飞猪报价未查" : "暂无飞猪参考价")
                          : poiCommerceLoading[stop.id]
                          ? "飞猪价格查询中…"
                          : commerce?.status === "available"
                            ? cnyReferenceLabel(commerce.price)
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
                      {commerce.status === "available" && <span className="tw-commerce-price"><strong>{cnyPriceLabel(commerce.price) || cnyReferenceLabel(commerce.price)}</strong>{cnyPriceLabel(commerce.price) && commerce.price?.unit && <small>{commerce.price.unit}</small>}</span>}
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
        <div className="tw-composer-identity"><Sparkles size={16} /><span><strong>{isLive ? "旅行答疑" : "继续修改行程"}</strong><small>{isLive ? "提问不会修改地点或时间" : "样例交互"}</small></span></div>
        <label htmlFor="workspace-message" className="tw-sr-only">{isLive ? "询问旅行问题" : "用自然语言修改行程"}</label>
        <input id="workspace-message" value={composer} onChange={(event) => setComposer(event.target.value)} placeholder={isLive ? "例如：酒店前台要提供什么资料？目前可确认的预算是多少？" : "试试：把第二天下午改轻松一点"} />
        <button type="submit" aria-label={isLive ? "发送问题" : "应用修改"} disabled={!composer.trim() || recalculating}>{recalculating ? <span className="tw-spinner" /> : <Send size={16} />}<span>{isLive ? "询问" : "应用修改"}</span></button>
      </form>
    </main>
  );
}
