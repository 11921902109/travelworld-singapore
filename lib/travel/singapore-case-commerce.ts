import { hotelDates, quoteHotelCommerceBatch, quotePoiCommerce } from "@/lib/travel/flyai";
import {
  searchSingaporePlaces,
  type SingaporePlace,
} from "@/lib/travel/google-maps";
import { describeSingaporePlace } from "@/lib/travel/place-description";
import { SINGAPORE_CASE_DATES } from "@/lib/travel/singapore-case";
import type { SingaporeTravelIntent, TravelCommerce } from "@/lib/travel/types";

const CASE_COMMERCE_INTENT: SingaporeTravelIntent = {
  destination: "Singapore",
  ...SINGAPORE_CASE_DATES,
  travelers: { adults: 2, total: 2 },
  pace: "relaxed",
  dailyStartTime: "09:30",
  dailyEndTime: "21:00",
  interests: ["建筑", "美食", "夜景"],
};

const CASE_HOTEL_NAME = "Village Hotel Bugis";
const CASE_POI_NAME = "National Gallery Singapore";
const SNAPSHOT_TTL_MS = 30 * 60_000;

export type SingaporeCaseCommercePlace = {
  placeId: string | null;
  name: string;
  address: string | null;
  commerce: TravelCommerce;
};

export type SingaporeCaseCommerceSnapshot = {
  provider: "fliggy";
  fixedQuery: {
    itineraryStartDate: string;
    itineraryEndDate: string;
    hotelCheckInDate: string;
    hotelCheckOutDate: string;
    poiVisitDate: string;
    travelers: number;
  };
  queriedAt: string;
  expiresAt: string;
  hotel: SingaporeCaseCommercePlace;
  poi: SingaporeCaseCommercePlace;
};

export type SingaporeCaseCommerceResult = SingaporeCaseCommerceSnapshot & {
  /** True only when this Worker isolate served its short-lived query snapshot. */
  cached: boolean;
};

let snapshotCache: SingaporeCaseCommerceSnapshot | null = null;
let snapshotRequest: Promise<SingaporeCaseCommerceSnapshot> | null = null;

function unavailable(kind: TravelCommerce["kind"], note: string, updatedAt: string): TravelCommerce {
  return {
    provider: "fliggy",
    kind,
    status: "unavailable",
    note,
    updatedAt,
  };
}

/**
 * The case page promises a fixed, actionable commercial example. A price or
 * link on its own is not enough to render that example, so make the partial
 * result unavailable rather than inventing the missing field.
 */
function requireCaseOffer(
  commerce: TravelCommerce | null | undefined,
  kind: TravelCommerce["kind"],
  label: string,
  updatedAt: string,
): TravelCommerce {
  if (commerce?.status === "available" && commerce.price && commerce.bookingUrl) return commerce;
  return unavailable(
    kind,
    `暂未取得 ${label} 可同时展示的飞猪价格与预订链接。`,
    updatedAt,
  );
}

function hasAnyName(place: SingaporePlace, names: string[]) {
  const normalized = `${place.name} ${place.address}`.toLowerCase();
  return names.some((name) => normalized.includes(name.toLowerCase()));
}

async function findCaseHotel(): Promise<SingaporePlace | null> {
  try {
    const places = await searchSingaporePlaces({
      query: CASE_HOTEL_NAME,
      maxResults: 5,
      includedType: "lodging",
      strictTypeFiltering: true,
      languageCode: "en",
    });
    return places.find((place) => hasAnyName(place, ["village hotel bugis", "village bugis"])) ?? null;
  } catch {
    return null;
  }
}

async function findCasePoi(): Promise<SingaporePlace | null> {
  try {
    const places = await searchSingaporePlaces({
      query: CASE_POI_NAME,
      maxResults: 5,
      languageCode: "en",
    });
    return places.find((place) => hasAnyName(place, ["national gallery singapore", "新加坡国家美术馆"])) ?? null;
  } catch {
    return null;
  }
}

async function lookupCaseHotel(place: SingaporePlace | null, updatedAt: string): Promise<TravelCommerce> {
  if (!place) {
    return unavailable("hotel", "案例酒店暂时无法由 Google Places 确认，未查询飞猪报价。", updatedAt);
  }
  try {
    const results = await quoteHotelCommerceBatch(CASE_COMMERCE_INTENT, [{
      placeId: place.placeId,
      name: place.name,
      address: place.address,
    }]);
    return requireCaseOffer(results.get(place.placeId), "hotel", "案例酒店", updatedAt);
  } catch {
    return unavailable("hotel", "暂时无法查询案例酒店的飞猪价格与预订链接。", updatedAt);
  }
}

async function lookupCasePoi(place: SingaporePlace | null, updatedAt: string): Promise<TravelCommerce> {
  if (!place) {
    return unavailable("poi", "案例景点暂时无法由 Google Places 确认，未查询飞猪商品。", updatedAt);
  }
  try {
    const description = describeSingaporePlace(place);
    const commerce = await quotePoiCommerce({
      name: place.name,
      address: place.address,
      category: description.categoryLabel,
      visitDate: SINGAPORE_CASE_DATES.startDate,
    });
    return requireCaseOffer(commerce, "poi", "案例景点", updatedAt);
  } catch {
    return unavailable("poi", "暂时无法查询案例景点的飞猪商品与预订链接。", updatedAt);
  }
}

async function buildSnapshot(): Promise<SingaporeCaseCommerceSnapshot> {
  const queriedAt = new Date().toISOString();
  const dates = hotelDates(CASE_COMMERCE_INTENT);
  // Fail closed if a future case-date edit becomes invalid. Showing a guessed
  // checkout date would make a real FlyAI link misleading.
  if (!dates) throw new Error("Invalid fixed Singapore case hotel dates.");
  const [hotelPlace, poiPlace] = await Promise.all([findCaseHotel(), findCasePoi()]);
  const [hotelCommerce, poiCommerce] = await Promise.all([
    lookupCaseHotel(hotelPlace, queriedAt),
    lookupCasePoi(poiPlace, queriedAt),
  ]);

  return {
    provider: "fliggy",
    fixedQuery: {
      itineraryStartDate: SINGAPORE_CASE_DATES.startDate,
      itineraryEndDate: SINGAPORE_CASE_DATES.endDate,
      hotelCheckInDate: dates.checkInDate,
      hotelCheckOutDate: dates.checkOutDate,
      poiVisitDate: SINGAPORE_CASE_DATES.startDate,
      travelers: 2,
    },
    queriedAt,
    expiresAt: new Date(Date.parse(queriedAt) + SNAPSHOT_TTL_MS).toISOString(),
    hotel: {
      placeId: hotelPlace?.placeId ?? null,
      name: hotelPlace?.name ?? CASE_HOTEL_NAME,
      address: hotelPlace?.address ?? null,
      commerce: hotelCommerce,
    },
    poi: {
      placeId: poiPlace?.placeId ?? null,
      name: poiPlace?.name ?? CASE_POI_NAME,
      address: poiPlace?.address ?? null,
      commerce: poiCommerce,
    },
  };
}

/**
 * Resolves one server-only fixed-date snapshot. The cache prevents duplicate
 * FlyAI sessions while concurrent case-page visitors hit the same Worker
 * isolate. It is intentionally process-local: no price or credential is
 * persisted in browser storage or source control.
 */
export async function getSingaporeCaseCommerce(): Promise<SingaporeCaseCommerceResult> {
  const now = Date.now();
  if (snapshotCache && Date.parse(snapshotCache.expiresAt) > now) {
    return { ...snapshotCache, cached: true };
  }

  if (!snapshotRequest) {
    snapshotRequest = buildSnapshot();
  }
  try {
    const snapshot = await snapshotRequest;
    snapshotCache = snapshot;
    return { ...snapshot, cached: false };
  } finally {
    snapshotRequest = null;
  }
}
