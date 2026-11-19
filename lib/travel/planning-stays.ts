import { askBailianAgent } from "@/lib/travel/bailian";
import { computeSingaporeRoute, searchSingaporePlaces, type SingaporePlace } from "@/lib/travel/google-maps";
import { PlanningSceneCandidateSchema, type PlanningSceneCandidate } from "@/lib/travel/planning-scenes";
import { extractJsonObject } from "@/lib/travel/singapore-intent";
import type { PlanningDraftV1, PlanningHandoffV1 } from "@/lib/travel/planning-state";

export type StayAdviceOption = {
  id: "same" | "split";
  segments: Array<{ startDay: number; area: string; representativeHotelPlaceId: string; representativeHotelName: string }>;
  estimatedDailyRoundTripMinutes: number;
  estimatedMoveMinutes: number;
  totalEstimatedMinutes: number;
  advantage: string;
  drawback: string;
  dailyBasis: Array<{
    day: number;
    firstPlace: string | null;
    lastPlace: string | null;
    startHotel: string;
    endHotel: string;
    outboundMinutes: number;
    inboundMinutes: number;
  }>;
};

export type StayAdvice = {
  status?: "no_overnight";
  options: StayAdviceOption[];
  recommendationId: "same" | "split";
  basis: string;
  source: { areaHotels: "Google Places"; roadTimes: "Google Routes"; explanation: "Bailian" | "calculation" };
};

function selectedDays(draft: PlanningDraftV1): PlanningSceneCandidate[][] {
  const byId = new Map<string, PlanningSceneCandidate>();
  draft.candidates.forEach((candidate) => {
    const parsed = PlanningSceneCandidateSchema.safeParse(candidate);
    if (parsed.success) byId.set(parsed.data.id, parsed.data);
  });
  return [...draft.assignments].sort((a, b) => a.day - b.day)
    .map((assignment) => assignment.orderedCandidateIds.map((id) => byId.get(id)).filter((value): value is PlanningSceneCandidate => Boolean(value)));
}

function lodging(place: SingaporePlace): boolean {
  return place.types.some((type) => /^(?:lodging|hotel|motel|hostel|resort_hotel|bed_and_breakfast)$/.test(type));
}

function usefulAreas(days: PlanningSceneCandidate[][]): string[] {
  const counts = new Map<string, number>();
  days.flat().forEach((candidate) => counts.set(candidate.area, (counts.get(candidate.area) || 0) + 1));
  return [...counts].sort((a, b) => b[1] - a[1]).map(([area]) => area).filter(Boolean).slice(0, 4);
}

async function representativeHotels(areas: string[]) {
  const results = await Promise.allSettled(areas.map(async (area) => {
    const found = await searchSingaporePlaces({ query: `${area} Singapore hotel`, maxResults: 5, includedType: "lodging" });
    const place = found.find(lodging);
    return place ? { area, place } : null;
  }));
  return results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
}

async function dayRoundTrips(hotels: Array<{ area: string; place: SingaporePlace }>, days: PlanningSceneCandidate[][]) {
  return Promise.all(hotels.map(async (hotel) => {
    const durations = await Promise.all(days.map(async (day) => {
      if (!day.length) return { outbound: 0, inbound: 0 };
      try {
        const [outbound, inbound] = await Promise.all([
          computeSingaporeRoute({ origin: hotel.place.location, destination: day[0].location, mode: "drive" }),
          computeSingaporeRoute({ origin: day.at(-1)!.location, destination: hotel.place.location, mode: "drive" }),
        ]);
        return { outbound: outbound.durationMinutes, inbound: inbound.durationMinutes };
      } catch {
        return null;
      }
    }));
    return { ...hotel, durations };
  }));
}

function option(
  id: StayAdviceOption["id"],
  hotels: Array<{ area: string; place: SingaporePlace; durations: Array<{ outbound: number; inbound: number } | null> }>,
  days: PlanningSceneCandidate[][],
  indices: number[],
  moveMinutes: number,
): StayAdviceOption {
  const segments: StayAdviceOption["segments"] = [];
  indices.forEach((hotelIndex, dayIndex) => {
    if (dayIndex > 0 && hotelIndex === indices[dayIndex - 1]) return;
    const hotel = hotels[hotelIndex];
    segments.push({
      startDay: dayIndex + 1,
      area: hotel.area,
      representativeHotelPlaceId: hotel.place.placeId,
      representativeHotelName: hotel.place.name,
    });
  });
  const dailyBasis = indices.map((endIndex, dayIndex) => {
    const startIndex = dayIndex > 0 ? indices[dayIndex - 1] : endIndex;
    const outboundMinutes = hotels[startIndex].durations[dayIndex]?.outbound ?? 0;
    const inboundMinutes = hotels[endIndex].durations[dayIndex]?.inbound ?? 0;
    return {
      day: dayIndex + 1,
      firstPlace: days[dayIndex]?.[0]?.name || null,
      lastPlace: days[dayIndex]?.at(-1)?.name || null,
      startHotel: hotels[startIndex].place.name,
      endHotel: hotels[endIndex].place.name,
      outboundMinutes, inboundMinutes,
    };
  });
  const travel = dailyBasis.reduce((sum, day) => sum + day.outboundMinutes + day.inboundMinutes, 0);
  return {
    id,
    segments,
    estimatedDailyRoundTripMinutes: travel,
    estimatedMoveMinutes: moveMinutes,
    totalEstimatedMinutes: travel + moveMinutes,
    advantage: id === "same" ? "不需要搬运行李或重新办理入住。" : "可缩短部分日期往返景点的车程。",
    drawback: id === "same" ? "距离较远的日期可能需要更多往返交通。" : "换住日需预留收拾行李和入住时间。",
    dailyBasis,
  };
}

export async function suggestStayAdvice(input: {
  handoff: PlanningHandoffV1;
  draft: PlanningDraftV1;
  visitToken: string;
  lastHotelNightDay: number;
}): Promise<StayAdvice> {
  const days = selectedDays(input.draft);
  if (!input.draft.boardConfirmed || !days.length || days.every((day) => !day.length)) {
    throw new Error("DAY_BOARD_NOT_CONFIRMED");
  }
  const hotels = await representativeHotels(usefulAreas(days));
  if (!hotels.length) throw new Error("NO_VERIFIED_STAY_AREAS");
  const compared = await dayRoundTrips(hotels, days);
  const comparable = compared.filter((item) => item.durations.every((duration) => duration !== null));
  if (!comparable.length) throw new Error("STAY_ROUTE_UNAVAILABLE");
  let bestSame = option("same", comparable, days, Array(days.length).fill(0), 0);
  comparable.forEach((_, index) => {
    const next = option("same", comparable, days, Array(days.length).fill(index), 0);
    if (next.totalEstimatedMinutes < bestSame.totalEstimatedMinutes) bestSame = next;
  });
  let bestSplit: StayAdviceOption | null = null;
  if (input.lastHotelNightDay >= 2 && comparable.length >= 2) {
    // A checkout day without an overnight stay cannot start a new hotel segment.
    for (let splitAt = 1; splitAt < input.lastHotelNightDay; splitAt += 1) {
      for (let first = 0; first < comparable.length; first += 1) {
        for (let second = 0; second < comparable.length; second += 1) {
          if (first === second) continue;
          const indices = days.map((_, index) => index < splitAt ? first : second);
          const next = option("split", comparable, days, indices, 90);
          if (!bestSplit || next.totalEstimatedMinutes < bestSplit.totalEstimatedMinutes) bestSplit = next;
        }
      }
    }
  }
  const options = bestSplit ? [bestSame, bestSplit] : [bestSame];
  const recommendationId = bestSplit && bestSplit.totalEstimatedMinutes + 20 < bestSame.totalEstimatedMinutes ? "split" : "same";
  let explanationSource: StayAdvice["source"]["explanation"] = "calculation";
  try {
    const comparison = options.map(({ id, segments, totalEstimatedMinutes, estimatedMoveMinutes }) => ({ id, segments, totalEstimatedMinutes, estimatedMoveMinutes }));
    const reply = await askBailianAgent(`你是旅行住宿顾问。仅根据以下 Google 路程估算与用户条件，为 same/split 两项各用一句话写优点和缺点。不要生成新酒店、价格或路线。换住需算上90分钟行李和入住成本。用户条件：${JSON.stringify({ pace: input.handoff.pace, preferences: input.handoff.preferences })}。比较数据：${JSON.stringify(comparison)}。仅返回 JSON {"same":{"advantage":"...","drawback":"..."},"split":{"advantage":"...","drawback":"..."}}。`, "planning", input.visitToken);
    if (reply) {
      const explanation = extractJsonObject(reply.text) as Record<string, unknown>;
      for (const item of options) {
        const words = explanation[item.id] as Record<string, unknown> | undefined;
        if (typeof words?.advantage === "string" && typeof words.drawback === "string") {
          item.advantage = words.advantage.trim().slice(0, 100);
          item.drawback = words.drawback.trim().slice(0, 100);
          explanationSource = "Bailian";
        }
      }
    }
  } catch {
    // Google route comparison remains usable when the explanatory model fails.
  }
  return {
    options,
    recommendationId,
    basis: "以已选地点的每日首末站为样本，比较 Google 驾车交通时间；换住日从旧酒店出发、在新酒店结束，另计约 90 分钟行李与入住时间。机场接驳、日内交通和实际酒店价格未计入此项粗估；选定酒店后会重新核算。",
    source: { areaHotels: "Google Places", roadTimes: "Google Routes", explanation: explanationSource },
  };
}
