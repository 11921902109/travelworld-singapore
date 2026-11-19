import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import { getSingaporePlaceDetails, GoogleMapsServiceError, googleMapsErrorResponse, SINGAPORE_BOUNDS, type SingaporePlace } from "@/lib/travel/google-maps";
import { describeSingaporePlace } from "@/lib/travel/place-description";
import { schedulePlanningDay } from "@/lib/travel/planning-scheduler";
import { planningSceneRole } from "@/lib/travel/planning-scene-role";
import type { DemoTrip, TravelMode, TripStop } from "@/lib/travel/types";

export const dynamic = "force-dynamic";

const Coordinate = z.object({
  lat: z.number().finite().min(SINGAPORE_BOUNDS.south).max(SINGAPORE_BOUNDS.north),
  lng: z.number().finite().min(SINGAPORE_BOUNDS.west).max(SINGAPORE_BOUNDS.east),
});
const Request = z.object({
  trip: z.unknown(),
  dayId: z.string().regex(/^day-[1-7]$/),
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("add"), name: z.string().trim().min(1).max(80), category: z.enum(["sight", "food", "transport", "custom"]), location: Coordinate, visitMinutes: z.number().int().min(15).max(480).default(60) }),
    z.object({ type: z.literal("addPlace"), placeId: z.string().min(8).max(255), visitMinutes: z.number().int().min(15).max(480).default(60) }),
    z.object({ type: z.literal("remove"), stopId: z.string().min(1).max(120) }),
    z.object({ type: z.literal("move"), stopId: z.string().min(1).max(120), direction: z.enum(["up", "down"]) }),
    z.object({ type: z.literal("mode"), fromId: z.string().min(1).max(120), toId: z.string().min(1).max(120), mode: z.enum(["taxi", "transit", "walk"]) }),
  ]),
});

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function fixedEndpoint(stop: TripStop): boolean {
  return stop.kind === "hotel" || (stop.kind === "other" && stop.verified && Boolean(stop.placeId) &&
    /机场|airport/i.test(`${stop.categoryLabel || ""} ${stop.name}`));
}

function validTrip(input: unknown): input is DemoTrip {
  if (!input || typeof input !== "object") return false;
  const trip = input as Partial<DemoTrip>;
  if (trip.source !== "live" || !Array.isArray(trip.days) || trip.days.length < 1 || trip.days.length > 7 || typeof trip.id !== "string") return false;
  return trip.days.every((day) => Array.isArray(day.stops) && Array.isArray(day.legs)
    && day.stops.length >= 2 && day.stops.length <= 11
    && fixedEndpoint(day.stops[0]) && fixedEndpoint(day.stops.at(-1)!));
}

function location(stop: TripStop) {
  const lat = Number(stop.lat ?? stop.location?.lat);
  const lng = Number(stop.lng ?? stop.location?.lng);
  if (!Coordinate.safeParse({ lat, lng }).success) throw new Error("地点坐标不在新加坡服务范围内。");
  return { lat, lng };
}

function customStop(input: Extract<z.infer<typeof Request>["action"], { type: "add" }>): TripStop {
  const x = Math.round((10 + ((input.location.lng - SINGAPORE_BOUNDS.west) / (SINGAPORE_BOUNDS.east - SINGAPORE_BOUNDS.west)) * 80) * 10) / 10;
  const y = Math.round((18 + ((SINGAPORE_BOUNDS.north - input.location.lat) / (SINGAPORE_BOUNDS.north - SINGAPORE_BOUNDS.south)) * 64) * 10) / 10;
  return {
    id: `manual-${crypto.randomUUID()}`,
    name: input.name, area: "自定义位置", time: "00:00", endTime: "00:00",
    duration: `${input.visitMinutes} 分钟`, kind: input.category === "transport" || input.category === "custom" ? "other" : input.category, x, y,
    verified: false, note: "用户手动添加的坐标；未经过 Google Places 验证",
    warning: "位置和营业信息未经验证，请核对",
    categoryLabel: input.category === "sight" ? "景点与体验 · 手动地点" : input.category === "food" ? "餐饮 · 手动地点" : input.category === "transport" ? "交通节点 · 手动地点" : "自定义地点 · 手动坐标",
    description: "由你手动标注在地图上；交通路线仍由 Google Routes 计算。",
    lat: input.location.lat, lng: input.location.lng, location: input.location,
  };
}

function verifiedStop(place: SingaporePlace, visitMinutes: number, theme: string): TripStop {
  const types = [place.primaryType, ...place.types].filter(Boolean).join(" ");
  if (place.businessStatus === "CLOSED_PERMANENTLY" || /(?:^|\s)(?:hotel|lodging|motel|hostel|resort_hotel|bed_and_breakfast|airport|bus_station|train_station|subway_station|transit_station|taxi_stand|car_rental|parking|gas_station|hospital|doctor|dentist|pharmacy|school|university|bank|atm|police|fire_station|post_office|government_office|embassy)(?:\s|$)/i.test(types)) {
    throw new GoogleMapsServiceError("PLACE_NOT_ACTIVITY", "这里仅可添加活动或餐饮地点；住宿和机场需在专门环节设置。", 422);
  }
  const sceneRole = planningSceneRole(place);
  const kind = sceneRole === "attraction" ? "sight" : "food";
  const x = Math.round((10 + ((place.location.lng - SINGAPORE_BOUNDS.west) / (SINGAPORE_BOUNDS.east - SINGAPORE_BOUNDS.west)) * 80) * 10) / 10;
  const y = Math.round((18 + ((SINGAPORE_BOUNDS.north - place.location.lat) / (SINGAPORE_BOUNDS.north - SINGAPORE_BOUNDS.south)) * 64) * 10) / 10;
  const described = describeSingaporePlace({ ...place, kind }, theme);
  return {
    id: `place-${crypto.randomUUID()}`, name: place.name, area: "新加坡", time: "00:00", endTime: "00:00",
    duration: `${visitMinutes} 分钟`, kind, sceneRole, x, y, verified: true,
    note: "Google Places 已验证地点；营业状态请在出行前复核。",
    categoryLabel: described.categoryLabel, description: described.description,
    placeId: place.placeId, lat: place.location.lat, lng: place.location.lng,
    location: place.location, address: place.address, types: place.types, primaryType: place.primaryType,
    rating: place.rating ?? undefined, userRatingCount: place.userRatingCount ?? undefined,
    googleMapsUri: place.googleMapsUri, openingHours: place.openingHours?.weekdayDescriptions,
    openingHoursInfo: place.openingHours,
  };
}

function minutesBetween(start: string, end: string): number | null {
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return null;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const minutes = eh * 60 + em - sh * 60 - sm;
  return minutes >= 15 && minutes <= 480 ? minutes : null;
}

export async function POST(request: NextRequest) {
  const blocked = guardSingaporeApi(request, { bucket: "map-edit", limit: 12, windowMs: 5 * 60_000 });
  if (blocked) return blocked;
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 180_000) return json({ error: { code: "REQUEST_TOO_LARGE", message: "行程数据过大。" } }, 413);
  const parsed = Request.safeParse((() => { try { return JSON.parse(raw); } catch { return null; } })());
  if (!parsed.success || !validTrip(parsed.data.trip)) return json({ error: { code: "INVALID_MAP_EDIT", message: "地图编辑请求或行程格式不正确。" } }, 400);
  const { trip, dayId, action } = parsed.data;
  const day = trip.days.find((item) => item.id === dayId);
  if (!day) return json({ error: { code: "DAY_NOT_FOUND", message: "所选旅行日不存在。" } }, 404);
  try {
    let stops = day.stops.filter((stop) => stop.kind !== "buffer");
    let addedStopId: string | null = null;
    for (const stop of stops) location(stop);
    if (action.type === "add" || action.type === "addPlace") {
      if (stops.length >= 11) return json({ error: { code: "DAY_STOP_LIMIT", message: "一天最多安排 9 个活动地点。" } }, 422);
      const added = action.type === "add" ? customStop(action) : verifiedStop(await getSingaporePlaceDetails(action.placeId), action.visitMinutes, day.theme);
      if (stops.some((stop) => stop.placeId && stop.placeId === added.placeId)) return json({ error: { code: "PLACE_ALREADY_ON_DAY", message: "这个地点已在当天行程中。" } }, 422);
      addedStopId = added.id;
      stops = [...stops.slice(0, -1), added, stops.at(-1)!];
    } else if (action.type === "remove") {
      const targetIndex = stops.findIndex((stop) => stop.id === action.stopId);
      if (targetIndex < 1 || targetIndex >= stops.length - 1 || stops[targetIndex].kind === "hotel") return json({ error: { code: "STOP_NOT_REMOVABLE", message: "只能移除当天的活动地点；酒店与机场锚点保持固定。" } }, 422);
      stops = stops.filter((stop) => stop.id !== action.stopId);
    } else if (action.type === "move") {
      const index = stops.findIndex((stop) => stop.id === action.stopId);
      const destination = index + (action.direction === "up" ? -1 : 1);
      if (index < 1 || index >= stops.length - 1 || destination < 1 || destination >= stops.length - 1 ||
          stops[index].kind === "hotel" || stops[destination].kind === "hotel") {
        return json({ error: { code: "STOP_NOT_MOVABLE", message: "只能调整当天活动地点的先后顺序；酒店与机场锚点保持固定。" } }, 422);
      }
      const reordered = [...stops];
      [reordered[index], reordered[destination]] = [reordered[destination], reordered[index]];
      stops = reordered;
    } else if (!stops.some((stop, index) => stop.id === action.fromId && stops[index + 1]?.id === action.toId)) {
      return json({ error: { code: "LEG_NOT_FOUND", message: "所选交通段已变化，请刷新后重试。" } }, 422);
    }
    const modes: TravelMode[] = stops.slice(0, -1).map((stop, index) => {
      const next = stops[index + 1];
      if (action.type === "mode" && action.fromId === stop.id && action.toId === next.id) return action.mode;
      return day.legs.find((leg) => leg.from === stop.id && leg.to === next.id)?.mode || "taxi";
    });
    const requestedVisitMinutes = Object.fromEntries(stops.slice(1, -1).flatMap((stop) => {
      const minutes = (action.type === "add" || action.type === "addPlace") && stop.id === addedStopId
        ? action.visitMinutes : minutesBetween(stop.time, stop.endTime);
      return minutes ? [[stop.id, minutes]] : [];
    }));
    const startTime = stops[0].time;
    const returnBy = day.returnBy || day.stops.at(-1)!.time;
    const { day: updatedDay, metrics } = await schedulePlanningDay({ day, orderedStops: stops, startTime, returnBy, requestedVisitMinutes, modes });
    if (metrics.terminalKind === "airport" && metrics.overtimeMinutes > 0) {
      return json({ error: { code: "AIRPORT_DEADLINE_EXCEEDED", message: `${day.label} 预计 ${metrics.actualReturnTime} 到达机场，晚于预留的 ${returnBy} 截止时刻 ${metrics.overtimeMinutes} 分钟；这会影响已确认航班，请调整地点或交通方式。` } }, 422);
    }
    if (trip.departureTransfer && day.id === trip.days.at(-1)?.id) {
      const [returnHour, returnMinute] = metrics.actualReturnTime.split(":").map(Number);
      const [leaveHour, leaveMinute] = trip.departureTransfer.leaveHotelAt.slice(11).split(":").map(Number);
      const leaveDayOffset = trip.departureTransfer.leaveHotelAt.slice(0, 10) === trip.departureTransfer.date ? 1 : 0;
      if (returnHour * 60 + returnMinute >= leaveDayOffset * 1440 + leaveHour * 60 + leaveMinute) {
        return json({ error: { code: "DEPARTURE_TRANSFER_CONFLICT", message: `${day.label} 预计返店时间与已确认的酒店至机场接驳冲突；请减少当天地点或换乘更快的交通。` } }, 422);
      }
    }
    const updatedTrip: DemoTrip = { ...trip, days: trip.days.map((item) => item.id === dayId ? { ...updatedDay, overtimeAcceptance: undefined } : item), generatedAt: new Date().toISOString() };
    const requiresConfirmation = metrics.overtimeMinutes > 0;
    return json({
      trip: updatedTrip, metrics, requiresConfirmation,
      reply: requiresConfirmation
        ? `${day.label} 预计 ${metrics.actualReturnTime} ${metrics.terminalKind === "airport" ? "到达机场" : "返回酒店"}，超出 ${returnBy} 截止时刻 ${metrics.overtimeMinutes} 分钟。请确认是否仍保留此安排。`
        : `${day.label} 的地点、交通与时间已重新计算；预计 ${metrics.actualReturnTime} ${metrics.terminalKind === "airport" ? "到达机场" : "返回酒店"}。`,
    });
  } catch (error) {
    const mapped = googleMapsErrorResponse(error);
    return json(mapped.body.error.code === "GOOGLE_MAPS_ERROR" ? { error: { code: "MAP_EDIT_FAILED", message: "地图路线暂时无法重新计算；原行程未改变。" } } : mapped.body, mapped.status);
  }
}
