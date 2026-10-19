import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import {
  computeSingaporeRoute,
  getSingaporePlaceDetails,
  GoogleMapsServiceError,
  googleMapsErrorResponse,
  SINGAPORE_BOUNDS,
  type GoogleRouteMode,
  type SingaporePlace,
  type SingaporeRoute,
} from "@/lib/travel/google-maps";
import { describeSingaporePlace } from "@/lib/travel/place-description";
import type {
  AccommodationSegment,
  ConfirmedAccommodationAnchor,
  DemoTrip,
  RouteLeg,
  TravelMode,
  TripDay,
  TripStop,
} from "@/lib/travel/types";

export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 180_000;

const RequestSchema = z.object({
  placeId: z.string().trim().regex(/^[A-Za-z0-9_-]{8,255}$/),
  startDayId: z.string().trim().regex(/^day-[1-7]$/).nullable().optional(),
  trip: z.unknown(),
  intent: z.unknown().optional(),
});

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function text(value: unknown, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function finite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function inSingapore(stop: Partial<TripStop>) {
  const lat = finite(stop.lat ?? stop.location?.lat);
  const lng = finite(stop.lng ?? stop.location?.lng);
  return lat !== null && lng !== null &&
    lat >= SINGAPORE_BOUNDS.south && lat <= SINGAPORE_BOUNDS.north &&
    lng >= SINGAPORE_BOUNDS.west && lng <= SINGAPORE_BOUNDS.east;
}

function isValidTrip(value: unknown): value is DemoTrip {
  if (!value || typeof value !== "object") return false;
  const trip = value as Partial<DemoTrip>;
  if (!/^singapore-\d{4}-\d{2}-\d{2}-[A-Za-z0-9_-]{4,32}$/.test(text(trip.id, 90))) return false;
  if (trip.destination !== "新加坡" || trip.source !== "live") return false;
  if (!Array.isArray(trip.days) || trip.days.length < 1 || trip.days.length > 7) return false;
  return trip.days.every((day, index) => {
    if (!day || day.id !== `day-${index + 1}` || !Array.isArray(day.stops) || !Array.isArray(day.legs)) return false;
    if (day.stops.length < 3 || day.stops.length > 9 || day.legs.length > 8) return false;
    if (day.stops[0]?.kind !== "hotel" || day.stops.at(-1)?.kind !== "hotel") return false;
    return day.stops.every((stop) => Boolean(text(stop.id, 120) && text(stop.name, 180) && inSingapore(stop)));
  });
}

function isLodging(place: SingaporePlace) {
  return place.types.some((type) => /^(?:lodging|hotel|motel|hostel|resort_hotel|bed_and_breakfast)$/.test(type));
}

function clockMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function validClock(value: string, fallback: string) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
}

function formatClock(totalMinutes: number) {
  const safe = Math.max(0, totalMinutes);
  return `${String(Math.floor(safe / 60) % 24).padStart(2, "0")}:${String(Math.round(safe % 60)).padStart(2, "0")}`;
}

function durationLabel(minutes: number) {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分` : `${hours} 小时`;
}

function projectedPoint(place: SingaporePlace) {
  const x = 10 + ((place.location.lng - SINGAPORE_BOUNDS.west) / (SINGAPORE_BOUNDS.east - SINGAPORE_BOUNDS.west)) * 80;
  const y = 18 + ((SINGAPORE_BOUNDS.north - place.location.lat) / (SINGAPORE_BOUNDS.north - SINGAPORE_BOUNDS.south)) * 64;
  return { x: Math.round(Math.min(94, Math.max(6, x)) * 10) / 10, y: Math.round(Math.min(90, Math.max(10, y)) * 10) / 10 };
}

function coordinates(stop: TripStop) {
  return { lat: Number(stop.lat ?? stop.location?.lat), lng: Number(stop.lng ?? stop.location?.lng) };
}

function haversine(left: TripStop, right: TripStop) {
  const a = coordinates(left);
  const b = coordinates(right);
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function googleMode(mode?: TravelMode): GoogleRouteMode {
  if (mode === "walk" || mode === "bicycle" || mode === "drive") return mode;
  if (mode === "taxi") return "drive";
  return "transit";
}

function compatibleMode(mode: GoogleRouteMode): TravelMode {
  if (mode === "drive") return "taxi";
  if (mode === "bicycle") return "bicycle";
  return mode;
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>) {
  const output = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return output;
}

function visitMinutes(stop: TripStop) {
  const start = validClock(stop.time, "00:00") === "00:00" ? 0 : clockMinutes(stop.time);
  const end = validClock(stop.endTime, "00:00") === "00:00" ? 0 : clockMinutes(stop.endTime);
  const stated = end - start;
  if (stated >= 20 && stated <= 300) return stated;
  return stop.kind === "food" ? 75 : 90;
}

function minimumVisit(stop: TripStop) {
  const category = stop.categoryLabel || describeSingaporePlace(stop).categoryLabel;
  if (/甜品|咖啡|商店/.test(category)) return 30;
  if (/餐厅|餐饮/.test(category)) return 45;
  return 60;
}

function fitDurations(stops: TripStop[], availableMinutes: number) {
  const durations = stops.map(visitMinutes);
  const minimums = stops.map(minimumVisit);
  if (minimums.reduce((sum, value) => sum + value, 0) > availableMinutes) return null;
  while (durations.reduce((sum, value) => sum + value, 0) > availableMinutes) {
    let index = -1;
    let margin = 0;
    durations.forEach((duration, candidateIndex) => {
      const candidateMargin = duration - minimums[candidateIndex];
      if (candidateMargin > margin) {
        index = candidateIndex;
        margin = candidateMargin;
      }
    });
    if (index < 0) break;
    durations[index] -= Math.min(5, margin);
  }
  return durations;
}

function accommodationStop(place: SingaporePlace, id: string, isReturn: boolean, isTransferDay = false): TripStop {
  const point = projectedPoint(place);
  return {
    id,
    name: isReturn ? `返回 ${place.name}` : place.name,
    area: place.address,
    time: "00:00",
    endTime: "00:00",
    duration: isReturn ? (isTransferDay ? "入住新酒店" : "返回酒店") : "出发",
    kind: "hotel",
    ...point,
    verified: true,
    note: isReturn
      ? isTransferDay ? "Google Routes 已计算前往新住宿的路线" : "Google Routes 已计算返回已确认酒店的路线"
      : isTransferDay ? "从上一晚已确认的住宿地点出发" : "已确认的 Google Places 酒店锚点",
    categoryLabel: "酒店",
    description: isReturn
      ? isTransferDay ? "当天行程结束后前往并入住新的住宿地点。" : "当天路线结束后返回已确认的住宿地点。"
      : isTransferDay ? "从上一晚入住的酒店出发，今天结束后将前往新的住宿地点。" : "当天路线的出发酒店，也是当天行程结束后的返回地点。",
    placeId: place.placeId,
    lat: place.location.lat,
    lng: place.location.lng,
    location: place.location,
    address: place.address,
    types: place.types,
    primaryType: place.primaryType,
    ...(place.rating !== null ? { rating: place.rating } : {}),
    ...(place.userRatingCount !== null ? { userRatingCount: place.userRatingCount } : {}),
    googleMapsUri: place.googleMapsUri,
    openingHours: place.openingHours?.weekdayDescriptions ?? [],
    openingHoursInfo: place.openingHours,
  };
}

async function reanchorDay(day: TripDay, startPlace: SingaporePlace, endPlace: SingaporePlace) {
  const oldStart = day.stops[0];
  const oldReturn = day.stops.at(-1)!;
  // Rebuild any old flexible block after routes change; it must never become a
  // fake landmark or consume the new hotel's travel budget as a fixed visit.
  const activities = day.stops.slice(1, -1).filter((stop) => stop.kind !== "hotel" && stop.kind !== "buffer");
  const startTime = validClock(oldStart.time, "09:30");
  const returnBy = validClock(day.returnBy || oldReturn.time, "21:00");
  if (clockMinutes(returnBy) <= clockMinutes(startTime)) {
    throw new GoogleMapsServiceError("INVALID_DAILY_WINDOW", `${day.label} 的返回酒店时间必须晚于出发时间。`, 422);
  }
  const isTransferDay = startPlace.placeId !== endPlace.placeId;
  const stops = [
    { ...accommodationStop(startPlace, oldStart.id, false, isTransferDay), time: startTime, endTime: startTime },
    ...activities,
    accommodationStop(endPlace, oldReturn.id, true, isTransferDay),
  ];
  const preferredMode = googleMode(day.legs[0]?.mode);
  const requests = stops.slice(0, -1).map((origin, index) => {
    const destination = stops[index + 1];
    const mode = preferredMode === "transit" && haversine(origin, destination) <= 1_100 ? "walk" : preferredMode;
    return { origin, destination, mode };
  });
  const routes = await mapLimit(requests, 3, (item) => computeSingaporeRoute({
    origin: coordinates(item.origin),
    destination: coordinates(item.destination),
    mode: item.mode,
  }));
  const travelMinutes = routes.reduce((sum, route) => sum + route.durationMinutes, 0);
  const durations = fitDurations(activities, clockMinutes(returnBy) - clockMinutes(startTime) - travelMinutes);
  if (!durations) {
    throw new GoogleMapsServiceError(
      "DAILY_WINDOW_TOO_SHORT",
      `更换住宿后，${day.label} 无法在 ${returnBy} 前返回酒店。请延后返店时间或减少当天地点。`,
      422,
    );
  }
  let cursor = clockMinutes(startTime);
  const scheduled: TripStop[] = [{ ...stops[0], time: startTime, endTime: startTime }];
  activities.forEach((stop, index) => {
    cursor += routes[index].durationMinutes;
    const arrival = cursor;
    cursor += durations[index];
    scheduled.push({ ...stop, time: formatClock(arrival), endTime: formatClock(cursor), duration: durationLabel(durations[index]) });
  });
  const returnRoute = routes.at(-1)!;
  const returnDeparture = clockMinutes(returnBy) - returnRoute.durationMinutes;
  const availableBuffer = returnDeparture - cursor;
  let bufferStopId: string | null = null;
  if (availableBuffer >= 15) {
    const previous = scheduled.at(-1)!;
    bufferStopId = `${day.id}-time-buffer`;
    scheduled.push({
      id: bufferStopId,
      name: cursor >= 17 * 60 ? "晚间自由活动与晚餐" : "自由活动与缓冲时间",
      area: previous.area,
      time: formatClock(cursor),
      endTime: formatClock(returnDeparture),
      duration: durationLabel(availableBuffer),
      kind: "buffer",
      x: previous.x,
      y: previous.y,
      verified: true,
      note: `为严格在 ${returnBy} 返回酒店预留的可自由安排时段。`,
      categoryLabel: "行程缓冲",
      description: "可用于用餐、散步或在附近自由停留；不虚构为收费景点。",
      ...(previous.lat !== undefined ? { lat: previous.lat } : {}),
      ...(previous.lng !== undefined ? { lng: previous.lng } : {}),
      ...(previous.location ? { location: previous.location } : {}),
    });
  } else if (availableBuffer > 0) {
    const previous = scheduled.at(-1)!;
    previous.endTime = formatClock(returnDeparture);
    previous.duration = durationLabel(Math.max(1, returnDeparture - clockMinutes(previous.time)));
  } else if (availableBuffer < 0) {
    throw new GoogleMapsServiceError(
      "DAILY_WINDOW_TOO_SHORT",
      `更换住宿后，${day.label} 无法在 ${returnBy} 前返回酒店。请延后返店时间或减少当天地点。`,
      422,
    );
  }
  scheduled.push({ ...stops.at(-1)!, time: returnBy, endTime: returnBy, duration: "返回酒店" });
  const legs: RouteLeg[] = routes.map((route: SingaporeRoute, index) => ({
    from: index === routes.length - 1 && bufferStopId ? bufferStopId : scheduled[index].id,
    to: index === routes.length - 1 ? scheduled.at(-1)!.id : scheduled[index + 1].id,
    mode: compatibleMode(route.mode),
    minutes: route.durationMinutes,
    distance: route.distanceText,
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    encodedPolyline: route.encodedPolyline,
    verified: true,
    provider: "google",
  }));
  const distanceMeters = routes.reduce((sum, route) => sum + route.distanceMeters, 0);
  const prefix = day.summary.replace(/\s*·\s*\d+\s*个真实地点.*$/, "").trim();
  const metrics = `${activities.length} 个真实地点 · 交通 ${travelMinutes} 分钟 · ${(distanceMeters / 1000).toFixed(1)} km`;
  return { ...day, returnBy, stops: scheduled, legs, summary: prefix ? `${prefix} · ${metrics}` : metrics };
}

function confirmedAccommodationAnchor(place: SingaporePlace): ConfirmedAccommodationAnchor {
  return {
    placeId: place.placeId,
    name: place.name,
    address: place.address,
    location: place.location,
    googleMapsUri: place.googleMapsUri,
    kind: "hotel",
    source: "google_places",
    userConfirmed: true,
  };
}

function placeFromAnchor(anchor: ConfirmedAccommodationAnchor): SingaporePlace {
  return {
    placeId: anchor.placeId,
    name: anchor.name,
    address: anchor.address,
    location: anchor.location,
    types: ["lodging"],
    primaryType: "lodging",
    rating: null,
    userRatingCount: null,
    priceLevel: null,
    businessStatus: "OPERATIONAL",
    googleMapsUri: anchor.googleMapsUri || null,
    openingHours: null,
  };
}

function anchorFromStop(stop: TripStop): ConfirmedAccommodationAnchor {
  const lat = Number(stop.lat ?? stop.location?.lat);
  const lng = Number(stop.lng ?? stop.location?.lng);
  return {
    placeId: stop.placeId || `legacy-${stop.id}`,
    name: stop.name.replace(/^返回\s+/, ""),
    address: stop.address || stop.area,
    location: { lat, lng },
    googleMapsUri: stop.googleMapsUri || null,
    kind: "hotel",
    source: "google_places",
    userConfirmed: true,
  };
}

function segmentIndex(dayId: string) {
  return Number(dayId.replace("day-", "")) - 1;
}

function normalizedSegments(trip: DemoTrip): AccommodationSegment[] {
  const candidates = (trip.accommodationSegments || [])
    .filter((segment) => segment && /^day-[1-7]$/.test(segment.startDayId) && segment.anchor?.placeId)
    .sort((left, right) => segmentIndex(left.startDayId) - segmentIndex(right.startDayId));
  if (candidates.length && candidates[0].startDayId === "day-1") return candidates;
  const fallback = trip.accommodationAnchor || anchorFromStop(trip.days[0].stops.at(-1)!);
  return [{ id: "stay-day-1", startDayId: "day-1", anchor: fallback }, ...candidates];
}

function anchorForDay(segments: AccommodationSegment[], dayIndex: number) {
  const matching = segments.filter((segment) => segmentIndex(segment.startDayId) <= dayIndex).at(-1);
  return matching?.anchor || segments[0].anchor;
}

function replaceSegment(
  segments: AccommodationSegment[],
  startDayId: string,
  anchor: ConfirmedAccommodationAnchor,
) {
  return [
    ...segments.filter((segment) => segment.startDayId !== startDayId),
    { id: `stay-${startDayId}`, startDayId, anchor },
  ].sort((left, right) => segmentIndex(left.startDayId) - segmentIndex(right.startDayId));
}

export async function POST(request: NextRequest) {
  const blocked = guardSingaporeApi(request, {
    bucket: "singapore-reanchor",
    limit: 3,
    windowMs: 5 * 60_000,
    maxBodyBytes: MAX_REQUEST_BYTES,
  });
  if (blocked) return blocked;

  try {
    const parsed = RequestSchema.safeParse(await request.json());
    if (!parsed.success || !isValidTrip(parsed.data.trip)) {
      return noStoreJson({ error: { code: "INVALID_REANCHOR_INPUT", message: "当前行程或酒店选择无效。" } }, 400);
    }
    const place = await getSingaporePlaceDetails(parsed.data.placeId);
    if (!isLodging(place)) {
      throw new GoogleMapsServiceError("ACCOMMODATION_NOT_LODGING", "所选地点不是 Google Places 识别的住宿，请重新选择酒店。", 422);
    }
    const startDayId = parsed.data.startDayId || "day-1";
    const startIndex = parsed.data.trip.days.findIndex((day) => day.id === startDayId);
    if (startIndex < 0) {
      return noStoreJson({ error: { code: "SEGMENT_DAY_NOT_FOUND", message: "没有找到要开始新住宿的日期。" } }, 422);
    }
    const newAnchor = confirmedAccommodationAnchor(place);
    const currentSegments = normalizedSegments(parsed.data.trip);
    const segments = replaceSegment(currentSegments, startDayId, newAnchor);
    const nextSegmentIndex = segments
      .map((segment) => segmentIndex(segment.startDayId))
      .filter((index) => index > startIndex)
      .at(0);
    // A hotel beginning on Day N changes Day N's destination and, when there
    // is a later segment, that next segment's departure. Nothing else needs a
    // route recomputation.
    const affectedLastIndex = nextSegmentIndex === undefined
      ? parsed.data.trip.days.length - 1
      : Math.min(parsed.data.trip.days.length - 1, nextSegmentIndex);
    const affected = new Set(Array.from({ length: affectedLastIndex - startIndex + 1 }, (_, offset) => startIndex + offset));
    const reroutedDays = await mapLimit(parsed.data.trip.days, 2, async (day, dayIndex) => {
      if (!affected.has(dayIndex)) return day;
      const startAnchor = anchorForDay(segments, Math.max(0, dayIndex - 1));
      const endAnchor = anchorForDay(segments, dayIndex);
      return reanchorDay(day, placeFromAnchor(startAnchor), placeFromAnchor(endAnchor));
    });
    const primaryAnchor = segments[0].anchor;
    const hotelLabel = segments.length === 1 ? primaryAnchor.name : `多酒店住宿 · ${segments.length} 段`;
    const baseTrip: DemoTrip = {
      ...parsed.data.trip,
      hotel: hotelLabel,
      accommodationMode: "hotel",
      accommodationAnchor: primaryAnchor,
      accommodationSegments: segments,
      days: reroutedDays,
      generatedAt: new Date().toISOString(),
      commerce: undefined,
      warnings: (parsed.data.trip.warnings || []).filter((warning) => !/区域参考点|尚未提供具体酒店/.test(warning)),
    };
    return noStoreJson({
      trip: baseTrip,
      accommodationAnchor: baseTrip.accommodationAnchor,
      reply: startIndex === 0 && segments.length === 1
        ? `已将全程住宿改为 ${place.name}；所有旅行日的出发、返回、路线与时间均已重新计算。`
        : `已从 ${startDayId.replace("day-", "Day ")} 起安排 ${place.name}；换酒店日会从上一晚住宿出发并在新酒店结束，已重算受影响的路线。`,
    });
  } catch (error) {
    const response = googleMapsErrorResponse(error);
    return noStoreJson(response.body, response.status);
  }
}
