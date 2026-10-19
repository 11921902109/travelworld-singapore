import { env } from "cloudflare:workers";

const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const PLACES_DETAILS_URL = "https://places.googleapis.com/v1/places";
const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const DEFAULT_TIMEOUT_MS = 10_000;

export const SINGAPORE_BOUNDS = {
  south: 1.1496,
  west: 103.594,
  north: 1.4784,
  east: 104.106,
} as const;

const PLACE_FIELDS = [
  "id",
  "displayName",
  "formattedAddress",
  "location",
  "types",
  "primaryType",
  "rating",
  "userRatingCount",
  "priceLevel",
  "businessStatus",
  "googleMapsUri",
  "regularOpeningHours",
].join(",");

const PLACE_SEARCH_FIELD_MASK = PLACE_FIELDS
  .split(",")
  .map((field) => `places.${field}`)
  .join(",");

const ROUTE_FIELD_MASK = [
  "routes.duration",
  "routes.distanceMeters",
  "routes.polyline.encodedPolyline",
].join(",");

export type GooglePlaceLocation = {
  lat: number;
  lng: number;
};

export type GoogleOpeningHours = {
  openNow: boolean | null;
  weekdayDescriptions: string[];
  nextOpenTime: string | null;
  nextCloseTime: string | null;
};

export type SingaporePlace = {
  placeId: string;
  name: string;
  address: string;
  location: GooglePlaceLocation;
  types: string[];
  primaryType: string | null;
  rating: number | null;
  userRatingCount: number | null;
  priceLevel: string | null;
  businessStatus: string | null;
  googleMapsUri: string | null;
  openingHours: GoogleOpeningHours | null;
};

export type SingaporePlaceSearch = {
  query: string;
  maxResults?: number;
  includedType?: string;
  strictTypeFiltering?: boolean;
  openNow?: boolean;
  minRating?: number;
  languageCode?: string;
};

export type GoogleRouteMode = "walk" | "transit" | "drive" | "bicycle";

export type GoogleRouteWaypoint = {
  lat?: number;
  lng?: number;
  placeId?: string;
};

export type SingaporeRoute = {
  mode: GoogleRouteMode;
  distanceMeters: number;
  distanceText: string;
  durationSeconds: number;
  durationMinutes: number;
  durationText: string;
  encodedPolyline: string;
};

export class GoogleMapsServiceError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: string;

  constructor(code: string, message: string, status = 502, details?: string) {
    super(message);
    this.name = "GoogleMapsServiceError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function runtimeValue(name: string): string {
  const runtime = env as unknown as Record<string, unknown>;
  const value = runtime[name] ?? (typeof process !== "undefined" ? process.env[name] : undefined);
  return typeof value === "string" ? value.trim() : "";
}

export function getGoogleMapsBrowserKey(): string {
  return runtimeValue("GOOGLE_MAPS_BROWSER_KEY");
}

function getGoogleMapsServerKey(): string {
  const key = runtimeValue("GOOGLE_MAPS_SERVER_KEY");
  if (!key) {
    throw new GoogleMapsServiceError(
      "GOOGLE_MAPS_NOT_CONFIGURED",
      "Google Maps 服务端服务尚未配置。",
      503,
    );
  }
  return key;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asFiniteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function sanitizedLanguageCode(value: unknown): string {
  const code = asString(value).trim();
  return /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(code) ? code : "zh-CN";
}

function isSingaporeCoordinate(location: GooglePlaceLocation): boolean {
  return (
    location.lat >= SINGAPORE_BOUNDS.south &&
    location.lat <= SINGAPORE_BOUNDS.north &&
    location.lng >= SINGAPORE_BOUNDS.west &&
    location.lng <= SINGAPORE_BOUNDS.east
  );
}

function parseOpeningHours(value: unknown): GoogleOpeningHours | null {
  const hours = asRecord(value);
  if (!Object.keys(hours).length) return null;
  const weekdayDescriptions = Array.isArray(hours.weekdayDescriptions)
    ? hours.weekdayDescriptions.filter((item): item is string => typeof item === "string")
    : [];
  return {
    openNow: typeof hours.openNow === "boolean" ? hours.openNow : null,
    weekdayDescriptions,
    nextOpenTime: asString(hours.nextOpenTime) || null,
    nextCloseTime: asString(hours.nextCloseTime) || null,
  };
}

function normalizePlace(value: unknown): SingaporePlace | null {
  const place = asRecord(value);
  const displayName = asRecord(place.displayName);
  const location = asRecord(place.location);
  const lat = asFiniteNumber(location.latitude);
  const lng = asFiniteNumber(location.longitude);
  const placeId = asString(place.id);
  const name = asString(displayName.text);
  if (!placeId || !name || lat === null || lng === null) return null;
  const normalizedLocation = { lat, lng };
  if (!isSingaporeCoordinate(normalizedLocation)) return null;

  return {
    placeId,
    name,
    address: asString(place.formattedAddress),
    location: normalizedLocation,
    types: Array.isArray(place.types)
      ? place.types.filter((item): item is string => typeof item === "string")
      : [],
    primaryType: asString(place.primaryType) || null,
    rating: asFiniteNumber(place.rating),
    userRatingCount: asFiniteNumber(place.userRatingCount),
    priceLevel: asString(place.priceLevel) || null,
    businessStatus: asString(place.businessStatus) || null,
    googleMapsUri: asString(place.googleMapsUri) || null,
    openingHours: parseOpeningHours(place.regularOpeningHours),
  };
}

function extractGoogleError(value: unknown): string {
  const error = asRecord(asRecord(value).error);
  return asString(error.message).slice(0, 300);
}

async function googleJson<T>(
  url: string,
  init: RequestInit,
  fieldMask: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Goog-Api-Key": getGoogleMapsServerKey(),
        "X-Goog-FieldMask": fieldMask,
        ...init.headers,
      },
    });
    const raw = await response.text();
    let payload: unknown = {};
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new GoogleMapsServiceError(
          "GOOGLE_MAPS_INVALID_RESPONSE",
          "Google Maps 返回了无法解析的数据。",
        );
      }
    }
    if (!response.ok) {
      const status = response.status === 429 ? 429 : response.status >= 500 ? 503 : 502;
      throw new GoogleMapsServiceError(
        response.status === 429 ? "GOOGLE_MAPS_RATE_LIMITED" : "GOOGLE_MAPS_UPSTREAM_ERROR",
        response.status === 429
          ? "Google Maps 查询额度暂时受限，请稍后重试。"
          : "Google Maps 暂时无法完成查询。",
        status,
        extractGoogleError(payload) || `HTTP ${response.status}`,
      );
    }
    return payload as T;
  } catch (error) {
    if (error instanceof GoogleMapsServiceError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new GoogleMapsServiceError(
        "GOOGLE_MAPS_TIMEOUT",
        "Google Maps 查询超时，请稍后重试。",
        504,
      );
    }
    throw new GoogleMapsServiceError(
      "GOOGLE_MAPS_NETWORK_ERROR",
      "暂时无法连接 Google Maps。",
      503,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function singaporeQuery(query: string): string {
  const cleaned = query.trim().replace(/\s+/g, " ").slice(0, 160);
  if (!cleaned) {
    throw new GoogleMapsServiceError("INVALID_QUERY", "请输入要查询的新加坡地点。", 400);
  }
  return /singapore|新加坡|シンガポール|싱가포르/i.test(cleaned)
    ? cleaned
    : `${cleaned}, Singapore`;
}

export async function searchSingaporePlaces(
  input: SingaporePlaceSearch,
): Promise<SingaporePlace[]> {
  const includedType = asString(input.includedType).trim();
  if (includedType && !/^[a-z_]{2,60}$/.test(includedType)) {
    throw new GoogleMapsServiceError("INVALID_PLACE_TYPE", "地点类型无效。", 400);
  }
  const minRating = asFiniteNumber(input.minRating);
  const body: Record<string, unknown> = {
    textQuery: singaporeQuery(input.query),
    languageCode: sanitizedLanguageCode(input.languageCode),
    regionCode: "SG",
    pageSize: clampInteger(input.maxResults, 8, 1, 20),
    locationRestriction: {
      rectangle: {
        low: {
          latitude: SINGAPORE_BOUNDS.south,
          longitude: SINGAPORE_BOUNDS.west,
        },
        high: {
          latitude: SINGAPORE_BOUNDS.north,
          longitude: SINGAPORE_BOUNDS.east,
        },
      },
    },
  };
  if (includedType) {
    body.includedType = includedType;
    body.strictTypeFiltering = Boolean(input.strictTypeFiltering);
  }
  if (typeof input.openNow === "boolean") body.openNow = input.openNow;
  if (minRating !== null && minRating >= 0 && minRating <= 5) body.minRating = minRating;

  const payload = await googleJson<{ places?: unknown[] }>(
    PLACES_SEARCH_URL,
    { method: "POST", body: JSON.stringify(body) },
    PLACE_SEARCH_FIELD_MASK,
  );
  return (payload.places ?? [])
    .map(normalizePlace)
    .filter((place): place is SingaporePlace => Boolean(place));
}

export async function getSingaporePlaceDetails(
  placeId: string,
  languageCode = "zh-CN",
): Promise<SingaporePlace> {
  const cleanedId = placeId.trim();
  if (!/^[A-Za-z0-9_-]{8,255}$/.test(cleanedId)) {
    throw new GoogleMapsServiceError("INVALID_PLACE_ID", "Google Place ID 无效。", 400);
  }
  const target = new URL(`${PLACES_DETAILS_URL}/${encodeURIComponent(cleanedId)}`);
  target.searchParams.set("languageCode", sanitizedLanguageCode(languageCode));
  target.searchParams.set("regionCode", "SG");
  const payload = await googleJson<unknown>(target.toString(), { method: "GET" }, PLACE_FIELDS);
  const place = normalizePlace(payload);
  if (!place) {
    throw new GoogleMapsServiceError(
      "PLACE_OUTSIDE_SINGAPORE",
      "该地点不在 Singapore Intelligence v1 的新加坡范围内。",
      422,
    );
  }
  return place;
}

function normalizeWaypoint(value: GoogleRouteWaypoint, label: string): Record<string, unknown> {
  const placeId = asString(value.placeId).trim();
  if (placeId) {
    if (!/^[A-Za-z0-9_-]{8,255}$/.test(placeId)) {
      throw new GoogleMapsServiceError("INVALID_WAYPOINT", `${label}的 Place ID 无效。`, 400);
    }
    return { placeId };
  }
  const lat = asFiniteNumber(value.lat);
  const lng = asFiniteNumber(value.lng);
  if (lat === null || lng === null || !isSingaporeCoordinate({ lat, lng })) {
    throw new GoogleMapsServiceError(
      "WAYPOINT_OUTSIDE_SINGAPORE",
      `${label}必须是新加坡范围内的有效坐标。`,
      422,
    );
  }
  return { location: { latLng: { latitude: lat, longitude: lng } } };
}

function parseDurationSeconds(value: unknown): number {
  const match = asString(value).match(/^([0-9]+(?:\.[0-9]+)?)s$/);
  return match ? Math.max(0, Math.ceil(Number(match[1]))) : 0;
}

function distanceText(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters >= 10_000 ? 0 : 1)} km`;
}

function durationText(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`;
}

export async function computeSingaporeRoute(input: {
  origin: GoogleRouteWaypoint;
  destination: GoogleRouteWaypoint;
  mode?: GoogleRouteMode;
  departureTime?: string;
  languageCode?: string;
}): Promise<SingaporeRoute> {
  const mode = input.mode ?? "transit";
  const modeMap: Record<GoogleRouteMode, string> = {
    walk: "WALK",
    transit: "TRANSIT",
    drive: "DRIVE",
    bicycle: "BICYCLE",
  };
  if (!modeMap[mode]) {
    throw new GoogleMapsServiceError("INVALID_TRAVEL_MODE", "不支持该交通方式。", 400);
  }
  const body: Record<string, unknown> = {
    origin: normalizeWaypoint(input.origin, "起点"),
    destination: normalizeWaypoint(input.destination, "终点"),
    travelMode: modeMap[mode],
    computeAlternativeRoutes: false,
    languageCode: sanitizedLanguageCode(input.languageCode),
    units: "METRIC",
  };
  if (mode === "drive") body.routingPreference = "TRAFFIC_AWARE";
  if (input.departureTime) {
    const departure = new Date(input.departureTime);
    if (!Number.isFinite(departure.getTime()) || departure.getTime() < Date.now() - 300_000) {
      throw new GoogleMapsServiceError(
        "INVALID_DEPARTURE_TIME",
        "出发时间必须是有效的当前或未来时间。",
        400,
      );
    }
    body.departureTime = departure.toISOString();
  }

  const payload = await googleJson<{ routes?: unknown[] }>(
    ROUTES_URL,
    { method: "POST", body: JSON.stringify(body) },
    ROUTE_FIELD_MASK,
    12_000,
  );
  const route = asRecord(payload.routes?.[0]);
  const distanceMeters = Math.max(0, Math.round(asFiniteNumber(route.distanceMeters) ?? 0));
  const durationSeconds = parseDurationSeconds(route.duration);
  const polyline = asString(asRecord(route.polyline).encodedPolyline);
  if (!distanceMeters || !durationSeconds || !polyline) {
    throw new GoogleMapsServiceError(
      "NO_ROUTE_FOUND",
      "Google Maps 未找到这两个地点之间的可用路线。",
      422,
    );
  }

  return {
    mode,
    distanceMeters,
    distanceText: distanceText(distanceMeters),
    durationSeconds,
    durationMinutes: Math.max(1, Math.ceil(durationSeconds / 60)),
    durationText: durationText(durationSeconds),
    encodedPolyline: polyline,
  };
}

export function googleMapsErrorResponse(error: unknown): {
  status: number;
  body: { error: { code: string; message: string; details?: string } };
} {
  if (error instanceof GoogleMapsServiceError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details && process.env.NODE_ENV !== "production"
            ? { details: error.details }
            : {}),
        },
      },
    };
  }
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: "旅行地图服务暂时不可用。" } },
  };
}
