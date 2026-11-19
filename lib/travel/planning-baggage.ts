import type { PlanningTimeOverride } from "./planning-time-overrides";
import type { TripStop } from "./types";
export type PlanningBaggage = NonNullable<PlanningTimeOverride["baggage"]>;
export type PlanningBaggageSummary = {
  mode: PlanningBaggage["mode"];
  status: "unknown" | "confirmed";
  needsCollection: boolean;
  storageName?: string;
  handlingMinutes?: number;
  handlingSource?: "user";
  note: string;
};

export function planningBaggageSummary(baggage?: PlanningBaggage, departure = false): PlanningBaggageSummary {
  const mode = baggage?.mode || "undecided";
  return {
    mode, status: mode === "undecided" ? "unknown" : "confirmed",
    needsCollection: departure && (mode === "hotel" || mode === "other"),
    ...(baggage?.storagePlace ? { storageName: baggage.storagePlace.name } : {}),
    ...(baggage?.handlingMinutes ? { handlingMinutes: baggage.handlingMinutes, handlingSource: "user" as const } : {}),
    note: mode === "undecided" ? "行李安排尚未明确，先保留余量，不自动增加景点。"
      : mode === "carry" ? "按你确认的行李随身安排；请自行核实场馆能否携带。"
        : mode === "hotel" ? "采用已确认酒店；寄存服务需自行核实，离境前的取物路径纳入核算。"
          : "地点身份由 Google 核实；是否提供寄存及实际开放需自行确认，寄存和取回分别计入操作及交通。",
  };
}

/** Inserts confirmed handling visits; the route engine then replaces all affected legs. */
export function planningBaggageStops(input: {
  day: number; baggage?: PlanningBaggage; arrival: boolean; departure: boolean; hotel: TripStop;
}) {
  const summary = planningBaggageSummary(input.baggage, input.departure);
  const deposit: TripStop[] = [];
  const collection: TripStop[] = [];
  const durations: Record<string, number> = {};
  const openingHours: Record<string, string[]> = {};
  if (!input.baggage || !["hotel", "other"].includes(input.baggage.mode) || !input.baggage.handlingMinutes || !input.arrival && !input.departure)
    return { summary, deposit, collection, durations, openingHours };
  const make = (purpose: "deposit" | "collection") => {
    const storage = input.baggage!.storagePlace;
    const hotel = input.baggage!.mode === "hotel";
    if (!hotel && (!storage || storage.placeId !== input.baggage!.placeId)) throw new Error("BAGGAGE_PLACE_NOT_VERIFIED");
    const original = input.hotel;
    const id = `day-${input.day}-baggage-${purpose}`;
    const stop: TripStop = {
      ...original, id, name: `${purpose === "deposit" ? "寄存行李" : "取回行李"} · ${hotel ? original.name : storage!.name}`,
      kind: hotel ? "hotel" : "other", categoryLabel: "行李事务", duration: `${input.baggage!.handlingMinutes} 分钟`,
      time: "00:00", endTime: "00:00", note: "按你确认的行李安排；操作时长由你设置，寄存服务需自行核实。",
      description: purpose === "deposit" ? "先前往确认地点寄存，再继续本日活动。" : "离开前取回行李，再前往当天终点。",
      ...(hotel ? {} : { placeId: storage!.placeId, address: storage!.address, area: storage!.address,
        location: storage!.location, lat: storage!.location.lat, lng: storage!.location.lng,
        googleMapsUri: undefined, openingHours: storage!.openingHours || [], aiAdvice: undefined, commerce: undefined }),
    };
    durations[id] = input.baggage!.handlingMinutes!;
    if (!hotel) openingHours[id] = storage!.openingHours || [];
    return stop;
  };
  if (input.baggage.mode === "other") {
    deposit.push(make("deposit")); collection.push(make("collection"));
  } else if (input.departure) collection.push(make("collection"));
  return { summary, deposit, collection, durations, openingHours };
}

/** Compatibility only: preserve a user's saved real waypoint, without
 * inventing a new baggage task or charging its handling minutes again. */
export function legacyPlanningBaggageWaypoints(input: {
  day: number; baggage?: PlanningBaggage; arrival: boolean; departure: boolean; hotel: TripStop;
}) {
  const baggage = input.baggage;
  const deposit: TripStop[] = [];
  const collection: TripStop[] = [];
  if (!baggage || !input.arrival && !input.departure) return { deposit, collection };
  const storage = baggage.storagePlace;
  // Only the authoritative saved projection may introduce a physical point.
  if (baggage.mode === "other" && storage?.placeId !== baggage.placeId) return { deposit, collection };
  if (baggage.mode !== "hotel" && !(baggage.mode === "other" && storage)) return { deposit, collection };
  const make = (purpose: "deposit" | "collection"): TripStop => ({
    ...input.hotel,
    id: `day-${input.day}-baggage-${purpose}`,
    name: baggage.mode === "hotel" ? input.hotel.name : storage!.name,
    kind: baggage.mode === "hotel" ? "hotel" : "other",
    categoryLabel: "已确认途经点", time: "00:00", endTime: "00:00", duration: "途经",
    note: "保留你此前确认的实际路线；操作时间由你自行安排，不自动预扣。",
    description: "旧记录中已确认的实际途经点。",
    ...(baggage.mode === "hotel" ? {} : {
      placeId: storage!.placeId, address: storage!.address, area: storage!.address,
      location: storage!.location, lat: storage!.location.lat, lng: storage!.location.lng,
      googleMapsUri: undefined, openingHours: storage!.openingHours || [], aiAdvice: undefined, commerce: undefined,
    }),
  });
  if (baggage.mode === "other") { deposit.push(make("deposit")); collection.push(make("collection")); }
  else if (input.departure) collection.push(make("collection"));
  return { deposit, collection };
}
