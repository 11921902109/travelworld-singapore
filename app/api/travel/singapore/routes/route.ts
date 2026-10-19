import { NextRequest, NextResponse } from "next/server";
import {
  computeSingaporeRoute,
  googleMapsErrorResponse,
  type GoogleRouteMode,
  type GoogleRouteWaypoint,
} from "@/lib/travel/google-maps";
import { guardSingaporeApi } from "@/lib/travel/api-guard";

export const dynamic = "force-dynamic";

const allowedModes = new Set<GoogleRouteMode>(["walk", "transit", "drive", "bicycle"]);

function waypoint(value: unknown): GoogleRouteWaypoint {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const nested = input.location && typeof input.location === "object"
    ? (input.location as Record<string, unknown>)
    : input;
  return {
    placeId: typeof input.placeId === "string" ? input.placeId : undefined,
    lat: typeof nested.lat === "number" ? nested.lat : Number(nested.latitude),
    lng: typeof nested.lng === "number" ? nested.lng : Number(nested.longitude),
  };
}

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: NextRequest) {
  const blocked = guardSingaporeApi(request, {
    bucket: "singapore-routes",
    limit: 20,
    windowMs: 60_000,
  });
  if (blocked) return blocked;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const requestedMode = typeof body.mode === "string" ? body.mode : "transit";
    if (!allowedModes.has(requestedMode as GoogleRouteMode)) {
      return noStoreJson(
        { error: { code: "INVALID_TRAVEL_MODE", message: "不支持该交通方式。" } },
        400,
      );
    }

    const route = await computeSingaporeRoute({
      origin: waypoint(body.origin),
      destination: waypoint(body.destination),
      mode: requestedMode as GoogleRouteMode,
      departureTime: typeof body.departureTime === "string" ? body.departureTime : undefined,
      languageCode: typeof body.languageCode === "string" ? body.languageCode : undefined,
    });

    return noStoreJson({ route, region: "SG", provider: "google" });
  } catch (error) {
    const response = googleMapsErrorResponse(error);
    return noStoreJson(response.body, response.status);
  }
}
