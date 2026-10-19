import { NextRequest, NextResponse } from "next/server";
import {
  computeSingaporeRoute,
  getSingaporePlaceDetails,
  GoogleMapsServiceError,
  googleMapsErrorResponse,
  searchSingaporePlaces,
  SINGAPORE_BOUNDS,
  type GoogleRouteMode,
  type SingaporePlace,
  type SingaporeRoute,
} from "@/lib/travel/google-maps";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import { describeSingaporePlace } from "@/lib/travel/place-description";
import type {
  ConfirmedAccommodationAnchor,
  DemoTrip,
  RouteLeg,
  TripStop,
} from "@/lib/travel/types";

export const dynamic = "force-dynamic";

type LooseIntent = Record<string, unknown>;
type CandidateKind = "food" | "sight";
type Candidate = {
  place: SingaporePlace;
  kind: CandidateKind;
  sourceQuery: string;
  required: boolean;
  preferredDayIndex: number;
};
type ResolvedAnchor = {
  place: SingaporePlace;
  label: string;
};
type OutlineDay = {
  day: number;
  theme: string;
  areas: string[];
  experiences: string[];
  summary: string;
};

const colors = ["#f16449", "#15745f", "#d8983e", "#5676a8", "#835c9d", "#a95d73", "#4f8172"];

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, max = 160): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stringList(value: unknown, maxItems = 10): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item, 80)).filter(Boolean))].slice(0, maxItems);
}

function integer(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function parseOutline(value: unknown, durationDays: number): OutlineDay[] | null {
  if (!Array.isArray(value) || value.length !== durationDays) return null;
  const outline: OutlineDay[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = record(value[index]);
    const day = integer(item.day);
    const theme = text(item.theme, 120);
    const areas = stringList(item.areas, 4);
    const experiences = stringList(item.experiences, 5);
    const summary = text(item.summary, 240);
    if (day !== index + 1 || !theme || !areas.length || !experiences.length || !summary) {
      return null;
    }
    outline.push({ day, theme, areas, experiences, summary });
  }
  return outline;
}

function outlineText(day: OutlineDay) {
  return [day.theme, ...day.areas, ...day.experiences, day.summary].join(" ").toLowerCase();
}

function preferredOutlineDay(query: string, outline: OutlineDay[], fallback: number) {
  const needle = query.toLowerCase();
  const exactIndex = outline.findIndex((day) => {
    const haystack = outlineText(day);
    return haystack.includes(needle) || day.experiences.some((item) => needle.includes(item.toLowerCase()));
  });
  return exactIndex >= 0 ? exactIndex : fallback % outline.length;
}

function validClock(value: string, fallback: string): string {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
}

function validCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function inclusiveDays(startDate: string, endDate: string) {
  if (!validCalendarDate(startDate) || !validCalendarDate(endDate)) return null;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86_400_000) + 1;
}

function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function formatClock(totalMinutes: number): string {
  const safe = Math.max(0, totalMinutes);
  const hours = Math.floor(safe / 60) % 24;
  const minutes = Math.round(safe % 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分` : `${hours} 小时`;
}

function placeKind(query: string, place: SingaporePlace): CandidateKind {
  const signal = `${query} ${place.types.join(" ")}`.toLowerCase();
  return /food|eat|restaurant|cafe|hawker|meal|美食|吃|餐厅|小吃|咖啡/.test(signal)
    ? "food"
    : "sight";
}

function haversine(left: SingaporePlace, right: SingaporePlace): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const lat1 = toRadians(left.location.lat);
  const lat2 = toRadians(right.location.lat);
  const deltaLat = toRadians(right.location.lat - left.location.lat);
  const deltaLng = toRadians(right.location.lng - left.location.lng);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nearestOrder(anchor: SingaporePlace, candidates: Candidate[]): Candidate[] {
  const remaining = [...candidates];
  const result: Candidate[] = [];
  let current = anchor;
  while (remaining.length) {
    let nearestIndex = 0;
    for (let index = 1; index < remaining.length; index += 1) {
      if (haversine(current, remaining[index].place) < haversine(current, remaining[nearestIndex].place)) {
        nearestIndex = index;
      }
    }
    const [next] = remaining.splice(nearestIndex, 1);
    result.push(next);
    current = next.place;
  }
  return result;
}

function projectedPoint(place: SingaporePlace) {
  const x = 10 + ((place.location.lng - SINGAPORE_BOUNDS.west) / (SINGAPORE_BOUNDS.east - SINGAPORE_BOUNDS.west)) * 80;
  const y = 18 + ((SINGAPORE_BOUNDS.north - place.location.lat) / (SINGAPORE_BOUNDS.north - SINGAPORE_BOUNDS.south)) * 64;
  return {
    x: Math.round(Math.min(94, Math.max(6, x)) * 10) / 10,
    y: Math.round(Math.min(90, Math.max(10, y)) * 10) / 10,
  };
}

function routeMode(intent: LooseIntent): GoogleRouteMode {
  const transport = Array.isArray(intent.preferredTransport)
    ? intent.preferredTransport.join(" ")
    : intent.preferredTransport;
  const raw = text(
    transport ?? intent.transportMode ?? intent.preferredTravelMode,
    80,
  ).toLowerCase();
  if (/walk|步行/.test(raw)) return "walk";
  if (/drive|taxi|car|驾车|打车|出租/.test(raw)) return "drive";
  if (/bike|bicycle|骑行/.test(raw)) return "bicycle";
  return "transit";
}

function modeForLeg(origin: SingaporePlace, destination: SingaporePlace, preferred: GoogleRouteMode) {
  return preferred === "transit" && haversine(origin, destination) <= 1_100 ? "walk" : preferred;
}

function compatibleMode(mode: GoogleRouteMode): "walk" | "transit" | "taxi" {
  if (mode === "drive") return "taxi";
  if (mode === "bicycle") return "walk";
  return mode;
}

function paceLabel(pace: string): string {
  if (pace === "relaxed") return "轻松";
  if (pace === "intensive") return "紧凑";
  return "平衡";
}

function paceStops(pace: string): number {
  if (pace === "relaxed") return 2;
  if (pace === "intensive") return 4;
  return 3;
}

function visitMinutes(kind: CandidateKind, pace: string): number {
  if (kind === "food") return pace === "intensive" ? 60 : 75;
  if (pace === "relaxed") return 120;
  if (pace === "intensive") return 75;
  return 90;
}

function fittedVisitMinutes(candidates: Candidate[], pace: string, availableMinutes: number): number[] | null {
  const minimums = candidates.map((candidate) => candidate.kind === "food" ? 45 : 60);
  const durations = candidates.map((candidate) => visitMinutes(candidate.kind, pace));
  const target = Math.max(0, availableMinutes);
  if (minimums.reduce((sum, value) => sum + value, 0) > target) return null;
  while (durations.reduce((sum, value) => sum + value, 0) > target) {
    let reducibleIndex = -1;
    let largestMargin = 0;
    durations.forEach((duration, index) => {
      const margin = duration - minimums[index];
      if (margin > largestMargin) {
        largestMargin = margin;
        reducibleIndex = index;
      }
    });
    if (reducibleIndex < 0) break;
    durations[reducibleIndex] -= Math.min(5, largestMargin);
  }
  return durations;
}

function dateParts(startDate: string, dayIndex: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return { date: "待定", weekday: "" };
  }
  const [year, month, day] = startDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + dayIndex));
  if (!Number.isFinite(date.getTime())) return { date: "待定", weekday: "" };
  return {
    date: `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}`,
    weekday: new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: "Asia/Singapore" }).format(date),
  };
}

function dateRange(startDate: string, durationDays: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return `${durationDays} 天 · 日期待确认`;
  const first = dateParts(startDate, 0).date;
  const last = dateParts(startDate, durationDays - 1).date;
  return `${first} — ${last}`;
}

function travelersCount(intent: LooseIntent): number {
  const travelers = record(intent.travelers);
  const statedTotal = Number(travelers.total);
  if (Number.isFinite(statedTotal) && statedTotal > 0) return Math.round(statedTotal);
  const values = [travelers.adults, travelers.children, travelers.seniors]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  return total > 0 ? Math.round(total) : 1;
}

function travelersProvided(intent: LooseIntent): boolean {
  const travelers = record(intent.travelers);
  return [travelers.total, travelers.adults, travelers.children, travelers.seniors].some(
    (value) => value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0,
  );
}

function forbidden(place: SingaporePlace, avoid: string[]) {
  const haystack = `${place.name} ${place.address} ${place.types.join(" ")}`.toLowerCase();
  return avoid.some((item) => haystack.includes(item.toLowerCase()));
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return output;
}

function isLodging(place: SingaporePlace) {
  return place.types.some((type) => /^(?:lodging|hotel|motel|hostel|resort_hotel|bed_and_breakfast)$/.test(type));
}

async function resolveAnchor(value: unknown): Promise<ResolvedAnchor> {
  const source = record(value);
  const placeId = text(source.placeId, 255);
  if (!placeId || source.kind !== "hotel" || source.source !== "google_places" || source.userConfirmed !== true) {
    throw new GoogleMapsServiceError(
      "MISSING_CONFIRMED_ACCOMMODATION",
      "请先从 Google Places 候选中确认一间具体酒店，再生成真实地图。",
      422,
    );
  }
  const place = await getSingaporePlaceDetails(placeId);
  if (!isLodging(place)) {
    throw new GoogleMapsServiceError(
      "ACCOMMODATION_NOT_LODGING",
      "所选地点不是 Google Places 识别的住宿，请重新选择酒店。",
      422,
    );
  }
  return { place, label: place.name };
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

async function resolveCandidates(
  intent: LooseIntent,
  durationDays: number,
  perDay: number,
  outline: OutlineDay[],
): Promise<{ candidates: Candidate[]; sourceQueries: string[]; warnings: string[] }> {
  const mustVisit = stringList(intent.mustVisit);
  const avoid = stringList(intent.avoid);
  const dietaryPreferences = stringList(intent.dietaryPreferences);
  if (mustVisit.length > durationDays * perDay) {
    throw new GoogleMapsServiceError(
      "TOO_MANY_MUST_VISIT",
      `当前节奏最多可安排 ${durationDays * perDay} 个必去地点，请减少必去项或增加天数。`,
      422,
    );
  }

  const mustResults = await Promise.all(
    mustVisit.map(async (query, index) => {
      const places = await searchSingaporePlaces({ query, maxResults: 3 });
      const place = places.find((item) => !forbidden(item, avoid));
      if (!place) {
        throw new GoogleMapsServiceError(
          "MUST_VISIT_NOT_FOUND",
          `Google Places 没有找到必去地点“${query}”。`,
          422,
        );
      }
      return {
        place,
        kind: placeKind(query, place),
        sourceQuery: query,
        required: true,
        preferredDayIndex: preferredOutlineDay(query, outline, index),
      } satisfies Candidate;
    }),
  );

  const outlineQueries = outline.map((day) => {
    const focus = `${day.areas.slice(0, 2).join(" ")} ${day.experiences.slice(0, 3).join(" ")}`.trim();
    return /food|eat|restaurant|hawker|美食|吃|餐厅|小吃|餐饮/i.test(focus)
      ? `${dietaryPreferences.join(" ")} ${focus} places to visit and eat in Singapore`.trim()
      : `${focus} attractions in Singapore`;
  });
  const resultCount = Math.min(12, Math.max(6, perDay * 3));
  const outlineSettled = await Promise.allSettled(
    outlineQueries.map(async (query, dayIndex) => {
      const places = await searchSingaporePlaces({ query, maxResults: resultCount });
      return places
        .filter((place) => !forbidden(place, avoid))
        .map((place) => ({
          place,
          kind: placeKind(query, place),
          sourceQuery: `Day ${dayIndex + 1} · ${outline[dayIndex].theme}`,
          required: false,
          preferredDayIndex: dayIndex,
        }) satisfies Candidate);
    }),
  );

  const warnings: string[] = [];
  const outlineBuckets: Candidate[][] = [];
  outlineSettled.forEach((result, index) => {
    if (result.status === "fulfilled") outlineBuckets.push(result.value);
    else {
      outlineBuckets.push([]);
      warnings.push(`Day ${index + 1}“${outline[index].theme}”的地点查询暂未返回结果。`);
    }
  });

  const outlineResults: Candidate[] = [];
  const longestBucket = Math.max(0, ...outlineBuckets.map((bucket) => bucket.length));
  for (let resultIndex = 0; resultIndex < longestBucket; resultIndex += 1) {
    outlineBuckets.forEach((bucket) => {
      if (bucket[resultIndex]) outlineResults.push(bucket[resultIndex]);
    });
  }

  const deduped = new Map<string, Candidate>();
  for (const candidate of [...mustResults, ...outlineResults]) {
    if (!deduped.has(candidate.place.placeId)) deduped.set(candidate.place.placeId, candidate);
  }
  const candidates = [...deduped.values()];
  if (candidates.length < durationDays) {
    throw new GoogleMapsServiceError(
      "INSUFFICIENT_REAL_PLACES",
      "真实地点候选不足以覆盖全部旅行日，请增加兴趣偏好或减少天数。",
      422,
    );
  }
  return {
    candidates,
    sourceQueries: [...mustVisit, ...outlineQueries],
    warnings,
  };
}

function allocateCandidates(candidates: Candidate[], durationDays: number, perDay: number) {
  const buckets = Array.from({ length: durationDays }, () => [] as Candidate[]);
  const used = new Set<string>();

  // Give every confirmed day one matching place before filling extra stops.
  for (let dayIndex = 0; dayIndex < durationDays; dayIndex += 1) {
    const candidate = candidates.find(
      (item) => item.preferredDayIndex === dayIndex && !used.has(item.place.placeId),
    );
    if (candidate) {
      buckets[dayIndex].push(candidate);
      used.add(candidate.place.placeId);
    }
  }

  const remaining = [
    ...candidates.filter((candidate) => candidate.required && !used.has(candidate.place.placeId)),
    ...candidates.filter((candidate) => !candidate.required && !used.has(candidate.place.placeId)),
  ];
  for (const candidate of remaining) {
    let target = candidate.preferredDayIndex;
    if (buckets[target].length >= perDay) {
      target = buckets.reduce(
        (best, bucket, index) => bucket.length < buckets[best].length ? index : best,
        0,
      );
    }
    if (buckets[target].length >= perDay) break;
    buckets[target].push(candidate);
    used.add(candidate.place.placeId);
  }
  return buckets;
}

/**
 * Builds a complete, route-backed Singapore trip from a confirmed planning
 * payload.  It is intentionally exported so fixed public showcase cases can
 * use exactly the same Places + Routes + scheduling pipeline as the planner,
 * rather than maintaining a second, stale set of map timings.
 */
export async function buildSingaporePlanResponse(body: Record<string, unknown>) {
  try {
    const intent = Object.keys(record(body.intent)).length ? record(body.intent) : body;
    const startDate = text(intent.startDate, 10);
    const endDate = text(intent.endDate, 10);
    if (!validCalendarDate(startDate) || !validCalendarDate(endDate)) {
      return noStoreJson(
        { error: { code: "MISSING_EXACT_DATES", message: "请先提供含年份的准确开始与结束日期。" } },
        422,
      );
    }
    const dateDays = inclusiveDays(startDate, endDate);
    if (dateDays === null || dateDays < 1) {
      return noStoreJson(
        { error: { code: "INVALID_DATE_RANGE", message: "结束日期必须不早于开始日期。" } },
        400,
      );
    }
    const durationDays = integer(intent.durationDays);
    if (durationDays === null || durationDays < 1 || durationDays > 7 || dateDays > 7) {
      return noStoreJson(
        { error: { code: "INVALID_DURATION", message: "新加坡第一版支持 1–7 天行程。" } },
        400,
      );
    }
    if (durationDays !== dateDays) {
      return noStoreJson(
        { error: { code: "DATE_DURATION_MISMATCH", message: "行程天数必须与开始、结束日期按自然日计算的结果一致。" } },
        422,
      );
    }
    if (!travelersProvided(intent)) {
      return noStoreJson(
        { error: { code: "MISSING_TRAVELERS", message: "请先提供至少一位同行人数。" } },
        422,
      );
    }

    if (body.outlineConfirmed !== true) {
      return noStoreJson(
        { error: { code: "OUTLINE_NOT_CONFIRMED", message: "请先确认每日行程草案，再生成真实地图。" } },
        409,
      );
    }
    const outline = parseOutline(body.outline, durationDays);
    if (!outline) {
      return noStoreJson(
        { error: { code: "INVALID_OUTLINE", message: "每日行程草案不完整，请先重新整理并确认。" } },
        400,
      );
    }

    const pace = text(intent.pace);
    if (!["relaxed", "balanced", "intensive"].includes(pace)) {
      return noStoreJson(
        { error: { code: "MISSING_PACE", message: "请先选择轻松、平衡或紧凑的旅行节奏。" } },
        422,
      );
    }
    const dailyStartTime = validClock(text(intent.dailyStartTime, 5), "");
    const dailyEndTime = validClock(text(intent.dailyEndTime, 5), "");
    if (!dailyStartTime || !dailyEndTime) {
      return noStoreJson(
        { error: { code: "MISSING_DAILY_WINDOW", message: "请先提供每日开始时间和返回住宿锚点时间。" } },
        422,
      );
    }
    if (clockMinutes(dailyEndTime) <= clockMinutes(dailyStartTime)) {
      return noStoreJson(
        { error: { code: "INVALID_DAILY_WINDOW", message: "每日结束时间必须晚于开始时间。" } },
        400,
      );
    }
    const availableMinutes = clockMinutes(dailyEndTime) - clockMinutes(dailyStartTime);
    const perDay = Math.max(
      1,
      Math.min(paceStops(pace), Math.floor(Math.max(105, availableMinutes - 30) / 105)),
    );

    // Resolve the anchor first so incomplete requests do not spend Places quota
    // on attractions that cannot yet be routed.
    const resolvedAnchor = await resolveAnchor(body.accommodationAnchor);
    const anchor = resolvedAnchor.place;
    const candidateResult = await resolveCandidates(intent, durationDays, perDay, outline);
    const dayBuckets = allocateCandidates(candidateResult.candidates, durationDays, perDay);
    if (dayBuckets.some((bucket) => bucket.length === 0)) {
      throw new GoogleMapsServiceError(
        "INSUFFICIENT_REAL_PLACES",
        "真实地点候选不足以覆盖确认的每日草案，请修改草案后重试。",
        422,
      );
    }
    const orderedDays = dayBuckets.map((bucket) => nearestOrder(anchor, bucket));

    const preferredMode = routeMode(intent);
    const legRequests = orderedDays.flatMap((day, dayIndex) => {
      const points = [anchor, ...day.map((candidate) => candidate.place), anchor];
      return points.slice(0, -1).map((origin, legIndex) => ({
        dayIndex,
        legIndex,
        origin,
        destination: points[legIndex + 1],
        mode: modeForLeg(origin, points[legIndex + 1], preferredMode),
      }));
    });
    const routeResults = await mapLimit(legRequests, 4, (leg) =>
      computeSingaporeRoute({
        origin: { lat: leg.origin.location.lat, lng: leg.origin.location.lng },
        destination: { lat: leg.destination.location.lat, lng: leg.destination.location.lng },
        mode: leg.mode,
      }),
    );
    const routesByDay = orderedDays.map((_, dayIndex) =>
      routeResults.filter((_, routeIndex) => legRequests[routeIndex].dayIndex === dayIndex),
    );

    const warnings = [...candidateResult.warnings];
    if (legRequests.some((leg) => leg.mode === "walk" || leg.mode === "bicycle")) {
      warnings.push("Google 提示：步行或骑行路线可能未完整反映人行道、自行车道与现场路况，请结合实际环境判断。");
    }
    const days = orderedDays.map((candidates, dayIndex) => {
      const outlineDay = outline[dayIndex];
      const dayRoutes = routesByDay[dayIndex];
      const dayId = `day-${dayIndex + 1}`;
      const anchorPoint = projectedPoint(anchor);
      const firstHotelId = `${dayId}-hotel-start`;
      const returnHotelId = `${dayId}-hotel-return`;
      const anchorCategory = "酒店";
      const anchorDescription = "当天路线的出发酒店，也是当天行程结束后的返回地点。";
      let cursor = clockMinutes(dailyStartTime);
      const travelMinutesForDay = dayRoutes.reduce((sum, route) => sum + route.durationMinutes, 0);
      const visitDurations = fittedVisitMinutes(
        candidates,
        pace,
        clockMinutes(dailyEndTime) - clockMinutes(dailyStartTime) - travelMinutesForDay,
      );
      if (!visitDurations) {
        throw new GoogleMapsServiceError(
          "DAILY_WINDOW_TOO_SHORT",
          `${outlineDay.theme} 无法在 ${dailyEndTime} 前完成并返回酒店。请减少地点、缩短停留或延后返回时间。`,
          422,
        );
      }
      const stops: TripStop[] = [
        {
          id: firstHotelId,
          name: resolvedAnchor.label,
          area: anchor.address,
          time: formatClock(cursor),
          endTime: formatClock(cursor),
          duration: "出发",
          kind: "hotel",
          ...anchorPoint,
          verified: true,
          note: "已确认的 Google Places 酒店锚点",
          categoryLabel: anchorCategory,
          description: anchorDescription,
          placeId: anchor.placeId,
          lat: anchor.location.lat,
          lng: anchor.location.lng,
          location: anchor.location,
          address: anchor.address,
          types: anchor.types,
          primaryType: anchor.primaryType,
          ...(anchor.rating !== null ? { rating: anchor.rating } : {}),
          ...(anchor.userRatingCount !== null ? { userRatingCount: anchor.userRatingCount } : {}),
          googleMapsUri: anchor.googleMapsUri,
          openingHours: anchor.openingHours?.weekdayDescriptions ?? [],
          openingHoursInfo: anchor.openingHours,
        },
      ];

      candidates.forEach((candidate, index) => {
        const route = dayRoutes[index];
        cursor += route.durationMinutes;
        const start = cursor;
        const stay = visitDurations[index];
        cursor += stay;
        const point = projectedPoint(candidate.place);
        const placeDescription = describeSingaporePlace(
          {
            name: candidate.place.name,
            types: candidate.place.types,
            primaryType: candidate.place.primaryType,
            kind: candidate.kind,
          },
          outlineDay.theme,
        );
        const warning = candidate.place.businessStatus && candidate.place.businessStatus !== "OPERATIONAL"
          ? `Google Places 状态：${candidate.place.businessStatus}`
          : undefined;
        stops.push({
          id: `${dayId}-${candidate.place.placeId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 36)}`,
          name: candidate.place.name,
          area: candidate.place.address,
          time: formatClock(start),
          endTime: formatClock(cursor),
          duration: durationLabel(stay),
          kind: candidate.kind,
          ...point,
          verified: true,
          note: candidate.required
            ? "用户必去地点 · Google Places 已验证"
            : `来自“${candidate.sourceQuery}”的 Google Places 候选`,
          categoryLabel: placeDescription.categoryLabel,
          description: placeDescription.description,
          ...(warning ? { warning } : {}),
          placeId: candidate.place.placeId,
          lat: candidate.place.location.lat,
          lng: candidate.place.location.lng,
          location: candidate.place.location,
          address: candidate.place.address,
          types: candidate.place.types,
          primaryType: candidate.place.primaryType,
          ...(candidate.place.rating !== null ? { rating: candidate.place.rating } : {}),
          ...(candidate.place.userRatingCount !== null
            ? { userRatingCount: candidate.place.userRatingCount }
            : {}),
          googleMapsUri: candidate.place.googleMapsUri,
          openingHours: candidate.place.openingHours?.weekdayDescriptions ?? [],
          openingHoursInfo: candidate.place.openingHours,
        });
      });

      const returnRoute = dayRoutes[dayRoutes.length - 1];
      const returnDeparture = clockMinutes(dailyEndTime) - returnRoute.durationMinutes;
      const availableBuffer = returnDeparture - cursor;
      let bufferStopId: string | null = null;
      if (availableBuffer >= 15) {
        const previous = stops.at(-1)!;
        bufferStopId = `${dayId}-time-buffer`;
        const isEvening = cursor >= 17 * 60;
        stops.push({
          id: bufferStopId,
          name: isEvening ? "晚间自由活动与晚餐" : "自由活动与缓冲时间",
          area: previous.area,
          time: formatClock(cursor),
          endTime: formatClock(returnDeparture),
          duration: durationLabel(availableBuffer),
          kind: "buffer",
          x: previous.x,
          y: previous.y,
          verified: true,
          note: `为严格在 ${dailyEndTime} 返回酒店预留的可自由安排时段。`,
          categoryLabel: "行程缓冲",
          description: "可用于用餐、散步或在附近自由停留；不虚构为收费景点。",
          ...(previous.lat !== undefined ? { lat: previous.lat } : {}),
          ...(previous.lng !== undefined ? { lng: previous.lng } : {}),
          ...(previous.location ? { location: previous.location } : {}),
        });
      } else if (availableBuffer > 0) {
        const previous = stops.at(-1)!;
        const start = clockMinutes(previous.time);
        previous.endTime = formatClock(returnDeparture);
        previous.duration = durationLabel(Math.max(1, returnDeparture - start));
      } else if (availableBuffer < 0) {
        throw new GoogleMapsServiceError(
          "DAILY_WINDOW_TOO_SHORT",
          `${outlineDay.theme} 无法在 ${dailyEndTime} 前返回酒店。请减少地点或延后返回时间。`,
          422,
        );
      }
      stops.push({
        id: returnHotelId,
        name: `返回 ${resolvedAnchor.label}`,
        area: anchor.address,
        time: dailyEndTime,
        endTime: dailyEndTime,
        duration: "返回酒店",
        kind: "hotel",
        ...anchorPoint,
        verified: true,
        note: "Google Routes 已计算返回路线",
        categoryLabel: anchorCategory,
        description: "当天路线结束后返回已确认的住宿地点。",
        placeId: anchor.placeId,
        lat: anchor.location.lat,
        lng: anchor.location.lng,
        location: anchor.location,
        address: anchor.address,
        types: anchor.types,
        primaryType: anchor.primaryType,
        ...(anchor.rating !== null ? { rating: anchor.rating } : {}),
        ...(anchor.userRatingCount !== null ? { userRatingCount: anchor.userRatingCount } : {}),
        googleMapsUri: anchor.googleMapsUri,
        openingHours: anchor.openingHours?.weekdayDescriptions ?? [],
        openingHoursInfo: anchor.openingHours,
      });

      const legs: RouteLeg[] = dayRoutes.map((route: SingaporeRoute, index) => ({
        from: index === dayRoutes.length - 1 && bufferStopId ? bufferStopId : String(stops[index].id),
        to: index === dayRoutes.length - 1 ? returnHotelId : String(stops[index + 1].id),
        mode: compatibleMode(route.mode),
        minutes: route.durationMinutes,
        distance: route.distanceText,
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        encodedPolyline: route.encodedPolyline,
        verified: true,
        provider: "google",
      }));
      const travelMinutes = dayRoutes.reduce((sum, route) => sum + route.durationMinutes, 0);
      const distanceMeters = dayRoutes.reduce((sum, route) => sum + route.distanceMeters, 0);
      const date = dateParts(startDate, dayIndex);
      return {
        id: dayId,
        label: `Day ${dayIndex + 1}`,
        date: date.date,
        weekday: date.weekday,
        theme: outlineDay.theme,
        color: colors[dayIndex],
        summary: `${outlineDay.summary} · ${candidates.length} 个真实地点 · 交通 ${travelMinutes} 分钟 · ${(distanceMeters / 1000).toFixed(1)} km`,
        returnBy: dailyEndTime,
        stops,
        legs,
      };
    });

    const interests = stringList(intent.interests);
    const generatedAt = new Date().toISOString();
    const tripId = `singapore-${generatedAt.slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
    const trip: DemoTrip = {
      id: tripId,
      title: interests.length ? `新加坡 · ${interests.slice(0, 3).join("、")}` : `新加坡 · ${outline[0].theme}`,
      destination: "新加坡",
      dateRange: dateRange(startDate, durationDays),
      timezone: "Asia/Singapore (GMT+8)",
      hotel: resolvedAnchor.label,
      accommodationMode: "hotel",
      accommodationAnchor: confirmedAccommodationAnchor(anchor),
      accommodationSegments: [{
        id: "stay-day-1",
        startDayId: "day-1",
        anchor: confirmedAccommodationAnchor(anchor),
      }],
      pace: paceLabel(pace),
      people: travelersCount(intent),
      days,
      source: "live",
      generatedAt,
      warnings: [...new Set(warnings)],
    };
    return noStoreJson({
      trip,
      meta: {
        provider: "google",
        status: "candidate",
        generatedAt,
        attribution: "Google Maps",
        warnings: [...new Set(warnings)],
        sourceQueries: candidateResult.sourceQueries,
        assumptions: [
          "行程天数按已确认的开始与结束日期计算。",
        ],
      },
    });
  } catch (error) {
    const response = googleMapsErrorResponse(error);
    return noStoreJson(response.body, response.status);
  }
}

export async function POST(request: NextRequest) {
  const blocked = guardSingaporeApi(request, {
    bucket: "singapore-plan",
    limit: 4,
    windowMs: 5 * 60_000,
  });
  if (blocked) return blocked;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    return buildSingaporePlanResponse(body);
  } catch {
    return noStoreJson(
      { error: { code: "INVALID_PLAN_REQUEST", message: "行程请求格式无效，请重新提交。" } },
      400,
    );
  }
}
