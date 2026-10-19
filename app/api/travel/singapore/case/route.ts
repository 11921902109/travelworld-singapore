import { NextRequest, NextResponse } from "next/server";
import {
  GoogleMapsServiceError,
  googleMapsErrorResponse,
  searchSingaporePlaces,
} from "@/lib/travel/google-maps";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import { SINGAPORE_CASE_DATES } from "@/lib/travel/singapore-case";
import { buildSingaporePlanResponse } from "../plan/route";

export const dynamic = "force-dynamic";

const CASE_INTENT = {
  destination: "新加坡",
  ...SINGAPORE_CASE_DATES,
  travelers: { adults: 2, total: 2 },
  pace: "relaxed",
  dailyStartTime: "09:30",
  dailyEndTime: "21:00",
  preferredTransport: ["公共交通"],
  interests: ["建筑", "美食", "夜景"],
  mustVisit: [
    "National Gallery Singapore",
    "Gardens by the Bay",
    "Sultan Mosque Singapore",
    "Haji Lane Singapore",
    "Singapore Botanic Gardens",
    "National Orchid Garden Singapore",
    "Henderson Waves Singapore",
    "Marina Bay Waterfront Promenade Singapore",
  ],
} as const;

const CASE_OUTLINE = [
  {
    day: 1,
    theme: "滨海城市初印象 · 建筑与夜景",
    areas: ["Civic District", "Marina Bay"],
    experiences: ["National Gallery Singapore", "Gardens by the Bay"],
    summary: "从 Bugis 的酒店出发，以国家美术馆与滨海湾花园展开建筑、艺术与夜景的一天。",
  },
  {
    day: 2,
    theme: "街区建筑与慢行",
    areas: ["Kampong Glam", "Bugis"],
    experiences: ["Sultan Mosque Singapore", "Haji Lane Singapore"],
    summary: "以街区建筑和可步行的巷弄为主，餐饮仅作为沿途体验而非报价商品。",
  },
  {
    day: 3,
    theme: "花园与兰花",
    areas: ["Tanglin", "Singapore Botanic Gardens"],
    experiences: ["Singapore Botanic Gardens", "National Orchid Garden Singapore"],
    summary: "在植物园与兰花园之间放慢节奏，保留真实交通和返店余量。",
  },
  {
    day: 4,
    theme: "南部步道与海湾收束",
    areas: ["Mount Faber", "Marina Bay"],
    experiences: ["Henderson Waves Singapore", "Marina Bay Waterfront Promenade Singapore"],
    summary: "以南部步道和海湾水岸收束四日行程，并在 21:00 前回到确认酒店。",
  },
] as const;

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

/**
 * A deliberately allow-listed public case.  The browser never sends route
 * inputs or Google server credentials; this endpoint resolves the current
 * hotel record and regenerates the complete route just for the case view.
 */
export async function POST(request: NextRequest) {
  const blocked = guardSingaporeApi(request, {
    bucket: "singapore-case",
    limit: 3,
    windowMs: 5 * 60_000,
  });
  if (blocked) return blocked;

  try {
    const hotels = await searchSingaporePlaces({
      query: "Village Hotel Bugis",
      maxResults: 5,
      includedType: "lodging",
      strictTypeFiltering: true,
      languageCode: "zh-CN",
    });
    const hotel = hotels.find((item) => item.name.toLowerCase().includes("village hotel bugis"));
    if (!hotel) {
      throw new GoogleMapsServiceError(
        "CASE_HOTEL_NOT_FOUND",
        "案例酒店暂时无法由 Google Places 确认，请稍后重试。",
        503,
      );
    }

    return buildSingaporePlanResponse({
      intent: CASE_INTENT,
      outlineConfirmed: true,
      outline: CASE_OUTLINE,
      accommodationAnchor: {
        placeId: hotel.placeId,
        kind: "hotel",
        source: "google_places",
        userConfirmed: true,
      },
    });
  } catch (error) {
    const response = googleMapsErrorResponse(error);
    return noStoreJson(response.body, response.status);
  }
}
