import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSingaporePlaceDetails } from "@/lib/travel/google-maps";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import { quoteHotelCommerceBatch } from "@/lib/travel/flyai";
import { SingaporeTravelIntentSchema } from "@/lib/travel/singapore-intent";
import type { TravelCommerce } from "@/lib/travel/types";

export const dynamic = "force-dynamic";

const HotelQuoteRequestSchema = z.object({
  intent: SingaporeTravelIntentSchema,
  candidates: z.array(z.object({
    placeId: z.string().trim().min(1).max(255),
  })).min(1).max(5),
});

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function hasTravelers(intent: z.infer<typeof SingaporeTravelIntentSchema>) {
  const total = Number(intent.travelers.total);
  if (Number.isFinite(total) && total > 0) return true;
  return [intent.travelers.adults, intent.travelers.children, intent.travelers.seniors]
    .map(Number)
    .some((value) => Number.isFinite(value) && value > 0);
}

function isLodging(types: string[]) {
  return types.some((type) => /^(?:lodging|hotel|motel|hostel|resort_hotel|bed_and_breakfast)$/.test(type));
}

function unavailableCommerce(note: string): TravelCommerce {
  return {
    provider: "fliggy",
    kind: "hotel",
    status: "unavailable",
    note,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Provides price references for a small, Google-verified set of hotel cards.
 * It never makes a hotel a route anchor: that remains an explicit client choice.
 */
export async function POST(request: NextRequest) {
  const blocked = guardSingaporeApi(request, {
    bucket: "singapore-hotel-quotes",
    limit: 3,
    windowMs: 5 * 60_000,
  });
  if (blocked) return blocked;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return noStoreJson({ error: "请求必须是有效的 JSON。" }, 400);
  }

  const parsed = HotelQuoteRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return noStoreJson({ error: "酒店报价请求格式不正确。" }, 400);
  }

  const { intent } = parsed.data;
  if (!intent.startDate || !intent.endDate || !intent.durationDays || !hasTravelers(intent)) {
    return noStoreJson({ error: "请先补齐准确日期、行程时长与同行人数，再查询酒店价格。" }, 422);
  }

  const uniqueCandidates = [...new Map(
    parsed.data.candidates.map((candidate) => [candidate.placeId, candidate]),
  ).values()];

  const verified = await Promise.all(uniqueCandidates.map(async ({ placeId }) => {
    try {
      const place = await getSingaporePlaceDetails(placeId, "zh-CN");
      if (!isLodging(place.types)) {
        return { placeId, commerce: unavailableCommerce("该地点不是 Google Places 识别的住宿，未查询飞猪报价。"), place: null };
      }
      return { placeId, commerce: null, place };
    } catch {
      return { placeId, commerce: unavailableCommerce("暂时无法验证该酒店，不影响你选择其他 Google 候选。"), place: null };
    }
  }));

  // All verified candidates share one temporary Agent session. FlyAI is asked
  // sequentially inside that session, while every returned offer is mapped back
  // to its original Google Place ID before it reaches the browser.
  const commerceByPlace = await quoteHotelCommerceBatch(
    intent,
    verified
      .filter((item) => item.place)
      .map((item) => ({
        placeId: item.placeId,
        name: item.place!.name,
        address: item.place!.address,
      })),
  );
  const quotes = verified.map((item) => ({
    placeId: item.placeId,
    commerce: item.commerce
      ?? commerceByPlace.get(item.placeId)
      ?? unavailableCommerce("暂未取得该酒店的飞猪参考价，不影响你选择住宿。"),
  }));

  return noStoreJson({ quotes, provider: "fliggy" });
}
