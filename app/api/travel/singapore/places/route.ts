import { NextRequest, NextResponse } from "next/server";
import {
  getSingaporePlaceDetails,
  googleMapsErrorResponse,
  searchSingaporePlaces,
} from "@/lib/travel/google-maps";
import { guardSingaporeApi } from "@/lib/travel/api-guard";

export const dynamic = "force-dynamic";

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: NextRequest) {
  const blocked = guardSingaporeApi(request, {
    bucket: "singapore-places",
    limit: 20,
    windowMs: 60_000,
  });
  if (blocked) return blocked;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const placeId = typeof body.placeId === "string" ? body.placeId.trim() : "";
    if (placeId) {
      const place = await getSingaporePlaceDetails(
        placeId,
        typeof body.languageCode === "string" ? body.languageCode : "zh-CN",
      );
      return noStoreJson({ place, attribution: "Google Maps" });
    }

    const query = typeof body.query === "string" ? body.query : "";
    const places = await searchSingaporePlaces({
      query,
      maxResults: Number(body.maxResults),
      includedType: typeof body.includedType === "string" ? body.includedType : undefined,
      strictTypeFiltering: body.strictTypeFiltering === true,
      openNow: typeof body.openNow === "boolean" ? body.openNow : undefined,
      minRating: typeof body.minRating === "number" ? body.minRating : undefined,
      languageCode: typeof body.languageCode === "string" ? body.languageCode : undefined,
    });

    return noStoreJson({
      places,
      query: query.trim(),
      region: "SG",
      attribution: "Google Maps",
    });
  } catch (error) {
    const response = googleMapsErrorResponse(error);
    return noStoreJson(response.body, response.status);
  }
}
