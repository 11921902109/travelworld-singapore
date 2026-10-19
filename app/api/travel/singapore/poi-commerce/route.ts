import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import { quotePoiCommerce } from "@/lib/travel/flyai";
import { getSingaporePlaceDetails } from "@/lib/travel/google-maps";
import { describeSingaporePlace } from "@/lib/travel/place-description";
import type { TravelCommerce } from "@/lib/travel/types";

export const dynamic = "force-dynamic";

const CalendarDateSchema = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "到访日期无效。");

const RequestSchema = z.object({
  placeId: z.string().trim().min(1).max(255),
  // Optional for normal itinerary cards; the public case uses its own fixed
  // server-side date, while future dated ticket cards can pass this context.
  visitDate: CalendarDateSchema.optional(),
});

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function unavailable(note: string): TravelCommerce {
  return {
    provider: "fliggy",
    kind: "poi",
    status: "unavailable",
    note,
    updatedAt: new Date().toISOString(),
  };
}

function isRestaurantOrFoodVenue(place: { types?: string[]; primaryType?: string | null }) {
  const types = [place.primaryType || "", ...(place.types || [])].join(" ").toLowerCase();
  return /restaurant|cafe|coffee_shop|bakery|bar|meal_takeaway|food/.test(types);
}

/**
 * This endpoint is deliberately on-demand: opening a place detail asks FlyAI
 * about that one Google-verified place, rather than turning every itinerary
 * render into a batch of commercial requests.
 */
export async function POST(request: NextRequest) {
  const blocked = guardSingaporeApi(request, {
    bucket: "singapore-poi-commerce",
    limit: 10,
    windowMs: 5 * 60_000,
  });
  if (blocked) return blocked;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStoreJson({ error: "请求必须是有效的 JSON。" }, 400);
  }
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) return noStoreJson({ error: "地点价格请求格式不正确。" }, 400);

  try {
    const place = await getSingaporePlaceDetails(parsed.data.placeId, "zh-CN");
    // FlyAI's current product data does not cover restaurants or dining deals.
    // Never make a commercial request for a food venue and never present an
    // unavailable FlyAI result as if it were a restaurant-price lookup.
    if (isRestaurantOrFoodVenue(place)) {
      return noStoreJson({
        placeId: place.placeId,
        supported: false,
        commerce: null,
      });
    }
    const description = describeSingaporePlace(place);
    const commerce = await quotePoiCommerce({
      name: place.name,
      address: place.address,
      category: description.categoryLabel,
      visitDate: parsed.data.visitDate,
    });
    return noStoreJson({
      placeId: place.placeId,
      supported: true,
      commerce: commerce ?? unavailable("暂未找到该地点可展示的飞猪价格或预订链接。"),
    });
  } catch {
    return noStoreJson({
      commerce: unavailable("暂时无法查询该地点的飞猪价格；行程地点与路线不受影响。"),
    });
  }
}
