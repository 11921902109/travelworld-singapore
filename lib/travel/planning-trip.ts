import {
  getSingaporePlaceDetails,
  searchSingaporePlaces,
  computeSingaporeRoute,
  SINGAPORE_BOUNDS,
  type SingaporePlace,
} from "@/lib/travel/google-maps";
import type { PlanningTiming } from "@/lib/travel/planning-timing";
import { assessPlanningCapacity } from "./planning-capacity";
import { minuteClock, type PlanningScheduleConflict, type ScheduleMoveBatchPreview, type ScheduleMoveRequest, type ScheduleMovePreview } from "@/lib/travel/planning-conflicts";
import { scheduleFingerprint, buildDailyAdvice, type DailyTransport, type DailyAdvice, type PlanningFreeWindow } from "@/lib/travel/planning-schedule-policy";
import { legacyPlanningBaggageWaypoints, type PlanningBaggageSummary } from "@/lib/travel/planning-baggage";
import { effectivePlanningLocalBlocks, validatePlanningLocalBlocks, type PlanningLocalBlock, type ScheduledPlanningLocalBlock } from "./planning-local-blocks";
import { sceneTimeAdvice, type RecommendedDuration } from "@/lib/travel/planning-duration";
import { PlanningSceneCandidateSchema, type PlanningSceneCandidate } from "@/lib/travel/planning-scenes";
import { RegularOpeningConflictError, schedulePlanningDay, type ScheduledDayMetrics, type PlanningRouteReference } from "@/lib/travel/planning-scheduler";
import { PlanningTimeOverrideSchema, routeOwnedTimeOverride, type PlanningTimeOverride } from "@/lib/travel/planning-time-overrides";
import { deriveFlightJourney, flightJourneyLegMinutes, flightLocalDateTimeEpoch, type FlightJourneyEndpoint, type FlightJourneyLeg } from "@/lib/travel/planning-flight-journey";
import { assessRegularOpeningHours, planRegularVisit, regularOpeningHoursLabel, type PlanningDayPeriod } from "@/lib/travel/planning-hours";
import type { PlanningDraftV1, PlanningHandoffV1 } from "@/lib/travel/planning-state";
import { pendingReviewLabels } from "@/lib/travel/planning-review";
import { projectPlanningMapHotelQuotes, type MapHotelSegment } from "@/lib/travel/planning-map-hotel-commerce";
import type { HotelQuoteJob } from "@/lib/travel/planning-hotel-jobs";
import type { AccommodationSegment, ConfirmedAccommodationAnchor, DemoTrip, NextDayDepartureTransfer, TripDay, TripStop } from "@/lib/travel/types";

const colors = ["#f16449", "#15745f", "#d8983e", "#5676a8", "#835c9d", "#a95d73", "#4f8172"];

type StaySegment = {
  startDay: number;
  area: string;
  checkInDate?: string;
  checkOutDate?: string;
  hotel?: ConfirmedAccommodationAnchor;
};

export type PlanningStayBoundary = {
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  lastHotelNightDay: number;
  arrivalOnFirstDay: boolean;
  departureOnLastDay: boolean;
  flightMode: "quoted" | "manual" | "none";
  note: string;
};

export type PlanningDayMilestone = {
  id: string;
  label: string;
  localDateTime: string | null;
  timeZone: string | null;
  airportName?: string;
  source: "user" | "supplier" | "legacy" | "confirmed_conditions" | "schedule";
  role: "flight" | "activity" | "hotel";
  airportReminderAt?: string | null;
};

export type PlanningDayJourney = {
  kind: "arrival" | "departure" | "arrival_departure";
  milestones: PlanningDayMilestone[];
  flightMinutes: number | null;
  groundMinutes: number;
  nextDayGroundMinutes: number;
  totalTransportMinutes: number | null;
  airportProcessMinutes: number;
  airportPreparationMinutes: number;
};

export type PlanningDayEstimate = {
  day: number;
  date: string;
  sceneIds: string[];
  dailyWindow?: NonNullable<PlanningTimeOverride["dailyWindow"]>;
  effectiveWindow?: { start: string; returnBy: string };
  journey?: PlanningDayJourney;
  routeReference?: PlanningRouteReference;
  overrides?: PlanningTimeOverride;
  scenes?: Array<{
    candidateId: string;
    name: string;
    period: "morning" | "afternoon" | "evening";
    preferredPeriod: PlanningDayPeriod;
    regularOpeningHours: string | null;
    recommendedMinutes?: number;
    recommendedDuration?: RecommendedDuration;
    selectedVisitMinutes?: number;
    durationReason?: string;
    sceneRole?: "culinary_area" | "restaurant_meal" | "attraction";
    includedMealMinutes?: number;
  }>;
  metrics: ScheduledDayMetrics;
  computedAt: string;
  inputFingerprint?: string;
  scheduledDay?: TripDay;
  transport?: DailyTransport;
  advice?: DailyAdvice;
  freeWindows?: PlanningFreeWindow[];
  baggage?: PlanningBaggageSummary;
  localBlocks?: PlanningLocalBlock[];
  scheduledLocalBlocks?: ScheduledPlanningLocalBlock[];
  airportAnchors?: Partial<Record<"arrival" | "departure", { identityFingerprint: string; place: SingaporePlace }>>;
  lastScheduleOperation?: { turnId: string; fingerprint: string };
  notes: string[];
  nextDayDepartureTransfer?: NextDayDepartureTransfer;
};

export class PlanningScheduleError extends Error {
  constructor(readonly code: string, message: string, readonly day?: number, readonly conflict?: PlanningScheduleConflict) {
    super(message);
    this.name = "PlanningScheduleError";
  }
}

function addDays(date: string, count: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

function selectedFlightTimes(draft: PlanningDraftV1) {
  const selection = (draft.flightSelection || {}) as Record<string, unknown>;
  const outbound = selection.outbound as Record<string, unknown> | undefined;
  const inbound = selection.inbound as Record<string, unknown> | undefined;
  const arrivalAt = selection.mode === "manual" ? selection.arrivalAt : outbound?.arrivalLocal;
  const departureAt = selection.mode === "manual" ? selection.departureAt : inbound?.departureLocal;
  return {
    selection,
    arrivalAt: typeof arrivalAt === "string" ? arrivalAt : null,
    departureAt: typeof departureAt === "string" ? departureAt : null,
  };
}

/** A departure on the final itinerary date is a checkout date, not a booked night. */
export function derivePlanningStayBoundary(handoff: PlanningHandoffV1, draft: PlanningDraftV1): PlanningStayBoundary {
  const { selection, arrivalAt, departureAt } = selectedFlightTimes(draft);
  const mode = selection.mode;
  if (mode !== "quoted" && mode !== "manual" && mode !== "none") {
    throw new PlanningScheduleError("FLIGHTS_NOT_DECIDED", "请先根据已订机票填写时刻，或选择查询返回的航班并确认。");
  }
  if (mode === "none") {
    const checkout = addDays(handoff.dates.end, 1);
    return {
      checkInDate: handoff.dates.start, checkOutDate: checkout,
      nights: handoff.dates.days, lastHotelNightDay: handoff.dates.days,
      arrivalOnFirstDay: false, departureOnLastDay: false, flightMode: "none",
      note: "未提供离境航班，住宿暂按最后旅行日当晚入住、次日退房估算；请在确认酒店前核对退房日期。",
    };
  }
  if (!arrivalAt || !departureAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(arrivalAt) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(departureAt)) {
    throw new PlanningScheduleError("FLIGHT_TIMES_MISSING", "所选航班缺少可靠的抵达或离境当地时间，请重新确认航班。");
  }
  const arrivalDate = arrivalAt.slice(0, 10);
  const departureDate = departureAt.slice(0, 10);
  if (arrivalDate !== handoff.dates.start) {
    throw new PlanningScheduleError("FLIGHT_ARRIVAL_DATE_CONFLICT", "抵达新加坡日期应与旅行开始日一致；请调整日期或航班，避免遗漏抵达前住宿。", 1);
  }
  const departureOffset = daysBetween(handoff.dates.end, departureDate);
  if (departureOffset < 0 || departureOffset > 1) {
    throw new PlanningScheduleError("FLIGHT_DEPARTURE_DATE_CONFLICT", "离境应在最后旅行日或次日；其他日期需先调整旅行日期，避免漏算住宿。", handoff.dates.days);
  }
  const checkout = departureDate;
  const nights = daysBetween(handoff.dates.start, checkout);
  return {
    checkInDate: handoff.dates.start,
    checkOutDate: checkout,
    nights,
    lastHotelNightDay: nights,
    arrivalOnFirstDay: true,
    departureOnLastDay: departureOffset === 0,
    flightMode: mode,
    note: departureOffset === 0
      ? `航班在 ${checkout} 离境；当天退房，最后旅行日不计为住宿夜。`
      : `航班在 ${checkout} 离境；最后旅行日仍需住宿，次日退房。`,
  };
}

function clockMinutes(value: string): number {
  const [hours, mins] = value.split(":").map(Number);
  return hours * 60 + mins;
}

function clock(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

const SINGAPORE_OFFSET_MS = 8 * 60 * 60_000;
const AIRPORT_LEAD_MINUTES = 180;
const ARRIVAL_PROCESS_MINUTES = 120;
const TAXI_PICKUP_MINUTES = 8;

function singaporeLocalTime(epochMs: number): string {
  return new Date(epochMs + SINGAPORE_OFFSET_MS).toISOString().slice(0, 16);
}

function singaporeEpoch(localDateTime: string): number {
  const epoch = Date.parse(`${localDateTime}+08:00`);
  if (!Number.isFinite(epoch)) throw new PlanningScheduleError("INVALID_FLIGHT_TIME", "返程航班当地时间无效，请重新确认。");
  return epoch;
}

function lastDayReturnEpoch(lastDayDate: string, clockTime: string): number {
  if (!/^\d{2,3}:[0-5]\d$/.test(clockTime)) {
    throw new PlanningScheduleError("INVALID_RETURN_TIME", "末日预计返店时间无效，请重新核算路线。");
  }
  const [hours, minutes] = clockTime.split(":").map(Number);
  return singaporeEpoch(`${lastDayDate}T00:00`) + (hours * 60 + minutes) * 60_000;
}

async function buildNextDayDepartureTransfer(
  departureAt: string,
  hotel: ConfirmedAccommodationAnchor,
  airport: NextDayDepartureTransfer["toAirport"],
  lastDayActualReturnTime?: string,
): Promise<NextDayDepartureTransfer> {
  const departureEpoch = singaporeEpoch(departureAt);
  const airportCutoffEpoch = departureEpoch - AIRPORT_LEAD_MINUTES * 60_000;
  const route = await computeSingaporeRoute({ origin: hotel.location, destination: airport.location, mode: "drive" });
  const travelMinutes = route.durationMinutes + TAXI_PICKUP_MINUTES;
  const leaveEpoch = airportCutoffEpoch - travelMinutes * 60_000;
  const lastDayDate = addDays(departureAt.slice(0, 10), -1);
  if (lastDayActualReturnTime && leaveEpoch < lastDayReturnEpoch(lastDayDate, lastDayActualReturnTime)) {
    throw new PlanningScheduleError(
      "NEXT_DAY_AIRPORT_TRANSFER_CONFLICT",
      `次日 ${departureAt.slice(11)} 的航班需在 ${singaporeLocalTime(leaveEpoch).replace("T", " ")} 从酒店出发，早于末日预计返店时间。请减少末日活动或更换航班。`,
    );
  }
  return {
    date: departureAt.slice(0, 10), departureAt,
    leaveHotelAt: singaporeLocalTime(leaveEpoch),
    arriveAirportAt: singaporeLocalTime(airportCutoffEpoch),
    airportCutoffAt: singaporeLocalTime(airportCutoffEpoch),
    airportLeadMinutes: AIRPORT_LEAD_MINUTES,
    fromHotel: hotel, toAirport: airport,
    leg: {
      from: hotel.placeId, to: airport.placeId, mode: "taxi",
      minutes: travelMinutes, pickupMinutes: TAXI_PICKUP_MINUTES,
      distance: route.distanceText, distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds, encodedPolyline: route.encodedPolyline,
      verified: true, provider: "google",
    },
    note: "单独列出次日离境交通；Google Routes 驾车时间加预计叫车等候，机场提前 3 小时到达。请以航空公司值机要求和实时路况为准。",
  };
}

/** Recalculate after the last hotel's anchor changes, without requiring the planning draft. */
export async function recalculateNextDayDepartureTransfer(
  transfer: NextDayDepartureTransfer,
  hotel: ConfirmedAccommodationAnchor,
  lastDayActualReturnTime?: string,
): Promise<NextDayDepartureTransfer> {
  return buildNextDayDepartureTransfer(transfer.departureAt, hotel, transfer.toAirport, lastDayActualReturnTime);
}

function projection(location: { lat: number; lng: number }) {
  const x = 10 + ((location.lng - SINGAPORE_BOUNDS.west) / (SINGAPORE_BOUNDS.east - SINGAPORE_BOUNDS.west)) * 80;
  const y = 18 + ((SINGAPORE_BOUNDS.north - location.lat) / (SINGAPORE_BOUNDS.north - SINGAPORE_BOUNDS.south)) * 64;
  return { x: Math.round(Math.min(94, Math.max(6, x)) * 10) / 10, y: Math.round(Math.min(90, Math.max(10, y)) * 10) / 10 };
}

function hotelStop(day: number, anchor: ConfirmedAccommodationAnchor, side: "start" | "return" | "arrival"): TripStop {
  return {
    id: `day-${day}-hotel-${side}`,
    name: side === "return" ? `返回 ${anchor.name}` : anchor.name,
    area: anchor.address,
    time: "00:00", endTime: "00:00", duration: side === "start" ? "出发" : side === "arrival" ? "到达酒店" : "返回酒店",
    kind: "hotel", ...projection(anchor.location), verified: true,
    note: "用户确认的 Google Places 酒店锚点",
    categoryLabel: "酒店",
    description: side === "start" ? "当天从已确认的酒店出发。"
      : side === "arrival" ? "按已确认路线到达酒店；办理与行李操作由你自行安排，不自动扣时。"
        : "当天行程结束后返回已确认的酒店。",
    placeId: anchor.placeId,
    lat: anchor.location.lat, lng: anchor.location.lng, location: anchor.location,
    address: anchor.address, googleMapsUri: anchor.googleMapsUri,
  };
}

function airportStop(day: number, place: SingaporePlace, side: "arrival" | "departure"): TripStop {
  return {
    id: `day-${day}-airport-${side}`,
    name: side === "arrival" ? `抵达 ${place.name}` : `前往 ${place.name}`,
    area: place.address,
    time: "00:00", endTime: "00:00",
    duration: side === "arrival" ? "抵达" : "前往机场",
    kind: "other", ...projection(place.location), verified: true,
    note: "航班机场锚点 · Google Places 已验证；航班手续时间为规划估计。",
    categoryLabel: "机场 · 交通锚点",
    description: side === "arrival"
      ? "以已选航班的抵达机场作为当天起点。"
      : "以已选航班的出发机场作为当天终点；需按航班要求预留值机与安检时间。",
    placeId: place.placeId,
    lat: place.location.lat, lng: place.location.lng, location: place.location,
    address: place.address, googleMapsUri: place.googleMapsUri,
  };
}

function airportIdentity(selection: Record<string, unknown>, side: "arrival" | "departure"): {
  placeId: string | null; query: string | null;
} {
  const placeId = selection[`${side}AirportPlaceId`];
  const name = selection[`${side}AirportName`];
  const flight = selection[side === "arrival" ? "outbound" : "inbound"] as Record<string, unknown> | undefined;
  const quotedName = flight?.[side === "arrival" ? "destination" : "origin"];
  const raw = typeof name === "string" && name.trim() ? name.trim()
    : typeof quotedName === "string" ? quotedName.trim() : "";
  let query: string | null = raw || null;
  if (/\bSIN\b|樟宜|changi/i.test(raw)) query = "Singapore Changi Airport";
  else if (/\bXSP\b|实里达|seletar/i.test(raw)) query = "Seletar Airport Singapore";
  else if (!/airport|机场/i.test(raw)) query = null;
  return {
    placeId: typeof placeId === "string" && placeId.trim() ? placeId.trim() : null,
    query,
  };
}

async function verifiedAirport(
  selection: Record<string, unknown>, side: "arrival" | "departure",
): Promise<SingaporePlace> {
  const identity = airportIdentity(selection, side);
  if (!identity.placeId && !identity.query) {
    throw new PlanningScheduleError("AIRPORT_REQUIRED", `请确认${side === "arrival" ? "抵达" : "离境"}机场；仅有“新加坡”城市名无法准确规划机场路线。`);
  }
  const place = identity.placeId
    ? await getSingaporePlaceDetails(identity.placeId)
    : (await searchSingaporePlaces({ query: identity.query!, maxResults: 3, includedType: "airport" }))[0];
  if (!place || ![place.primaryType, ...place.types].some((type) => /airport/i.test(type || ""))) {
    throw new PlanningScheduleError("AIRPORT_NOT_VERIFIED", `${side === "arrival" ? "抵达" : "离境"}机场未能通过 Google Places 核验，请重新选择机场。`);
  }
  return place;
}

async function verifiedAirportForDraft(draft: PlanningDraftV1, side: "arrival" | "departure", timing?: PlanningTiming): Promise<SingaporePlace> {
  const selection = draft.flightSelection as Record<string, unknown>;
  const fingerprint = await scheduleFingerprint(airportIdentity(selection, side));
  for (const estimate of (draft.dayEstimates || []) as PlanningDayEstimate[]) {
    const saved = estimate.airportAnchors?.[side];
    if (saved?.identityFingerprint === fingerprint && saved.place && [saved.place.primaryType, ...(saved.place.types || [])].some((type) => /airport/i.test(type || ""))) return saved.place;
  }
  return timing ? timing.measureAsync("google_lookup", () => verifiedAirport(selection, side)) : verifiedAirport(selection, side);
}

function sceneStop(day: number, scene: PlanningSceneCandidate): TripStop {
  return {
    id: `day-${day}-${scene.placeId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 36)}`,
    name: scene.name, area: scene.area,
    time: "00:00", endTime: "00:00", duration: `${scene.estimatedMinutes} 分钟`,
    kind: scene.kind, sceneRole: scene.sceneRole, includedMealMinutes: scene.includedMealMinutes, durationReason: scene.durationReason, types: scene.googleTypes, primaryType: scene.googlePrimaryType,
    ...projection(scene.location), verified: true,
    note: scene.source === "user_added" ? "由你选择 · Google Places 已验证" : "百炼推荐 · Google Places 已验证",
    categoryLabel: scene.category,
    description: scene.reason,
    aiAdvice: { pros: scene.pros, cons: scene.cons },
    placeId: scene.placeId,
    lat: scene.location.lat, lng: scene.location.lng, location: scene.location,
    address: scene.address,
    rating: scene.rating ?? undefined,
    userRatingCount: scene.userRatingCount ?? undefined,
    googleMapsUri: scene.googleMapsUri,
    openingHours: scene.openingHours,
  };
}

function flightWindow(handoff: PlanningHandoffV1, draft: PlanningDraftV1, day: number) {
  const override = draft.scheduleOverrides?.find((item) => item.day === day);
  const requestedWindow = override ? PlanningTimeOverrideSchema.parse(override).dailyWindow || handoff.dailyWindow : handoff.dailyWindow;
  let start = clockMinutes(requestedWindow.start);
  const returnConstraint = (requestedWindow as typeof requestedWindow & { returnConstraint?: { strength: "soft" | "hard"; source: string } }).returnConstraint;
  const softReturn = returnConstraint?.strength === "soft" && returnConstraint.source === "user";
  const requestedEnd = clockMinutes(requestedWindow.latestReturn);
  let end = softReturn ? Math.min(23 * 60 + 59, start + 18 * 60) : requestedEnd;
  const notes: string[] = [];
  const { arrivalAt, departureAt } = selectedFlightTimes(draft);
  const date = addDays(handoff.dates.start, day - 1);
  if (day === 1 && arrivalAt?.slice(0, 10) === date) {
    start = Math.max(start, clockMinutes(arrivalAt.slice(11)) + ARRIVAL_PROCESS_MINUTES);
    notes.push("抵达日从已验证机场出发；航班落地后约 2 小时用于入境和取行李，去酒店交通另由 Google Routes 计算。");
  }
  if (day === handoff.dates.days && departureAt?.slice(0, 10) === date) {
    end = Math.min(end, clockMinutes(departureAt.slice(11)) - AIRPORT_LEAD_MINUTES);
    notes.push("离境日以已验证机场为终点，机场前一段交通由 Google Routes 计算；预计提前至少 3 小时到达机场。实际航班要求需复核。");
  }
  if (start >= end || start < 0 || end > 24 * 60) {
    throw new PlanningScheduleError("FLIGHT_DAY_WINDOW_CONFLICT", `Day ${day} 的航班与每日活动时段冲突，请减少或移动当天地点。`, day);
  }
  return { startTime: clock(start), returnBy: clock(end), preferredReturnBy: softReturn ? clock(Math.min(end, requestedEnd)) : undefined, notes, requestedWindow };
}

function airportReminder(endpoint: FlightJourneyEndpoint): string | null {
  if (!endpoint.localDateTime || !endpoint.timeZone) return null;
  const epoch = flightLocalDateTimeEpoch(endpoint.localDateTime, endpoint.timeZone);
  if (epoch === null) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: endpoint.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(epoch - AIRPORT_LEAD_MINUTES * 60_000));
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
}

/** Display-only ledger. Flight and airport entries never enter the local free-time calculation. */
export function buildPlanningDayJourney(handoff: PlanningHandoffV1, draft: PlanningDraftV1, estimate: PlanningDayEstimate): PlanningDayJourney | undefined {
  const selection = draft.flightSelection as Record<string, unknown> | undefined;
  if (!selection || selection.mode === "none") return undefined;
  const arrival = estimate.day === 1;
  const departure = estimate.day === handoff.dates.days;
  if (!arrival && !departure) return undefined;
  const journey = deriveFlightJourney(selection);
  const milestones: PlanningDayMilestone[] = [];
  const flightLegs: FlightJourneyLeg[] = [];
  const flightNode = (id: string, label: string, leg: FlightJourneyLeg, endpoint: "departure" | "arrival") => {
    const value = leg[endpoint];
    milestones.push({
      id, label, role: "flight", localDateTime: value.localDateTime, timeZone: value.timeZone,
      airportName: value.airport?.name, source: leg.source,
      ...(endpoint === "departure" ? { airportReminderAt: airportReminder(value) } : {}),
    });
  };
  if (arrival) {
    flightLegs.push(journey.outbound);
    flightNode("outbound-departure", "去程起飞", journey.outbound, "departure");
    flightNode("outbound-arrival", "抵达新加坡", journey.outbound, "arrival");
  } else {
    milestones.push({ id: "hotel-start", label: "酒店出发", role: "hotel", localDateTime: `${estimate.date}T${estimate.dailyWindow?.start || handoff.dailyWindow.start}`, timeZone: "Asia/Singapore", source: "confirmed_conditions" });
  }
  milestones.push({ id: "local-activities", label: "当地活动", role: "activity", localDateTime: null, timeZone: "Asia/Singapore", source: "schedule" });
  if (departure) {
    flightLegs.push(journey.inbound);
    flightNode("inbound-departure", "返程起飞 · 离开新加坡", journey.inbound, "departure");
    flightNode("inbound-arrival", "返程抵达", journey.inbound, "arrival");
  } else {
    milestones.push({ id: "hotel-return", label: "返店目标", role: "hotel", localDateTime: `${estimate.date}T${estimate.dailyWindow?.latestReturn || handoff.dailyWindow.latestReturn}`, timeZone: "Asia/Singapore", source: "confirmed_conditions" });
  }
  const durations = flightLegs.map(flightJourneyLegMinutes);
  const flightMinutes = durations.every((value) => value !== null) ? durations.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  const nextDayGroundMinutes = estimate.nextDayDepartureTransfer?.leg.minutes || 0;
  const groundMinutes = estimate.metrics.travelMinutes + nextDayGroundMinutes;
  return {
    kind: arrival && departure ? "arrival_departure" : arrival ? "arrival" : "departure",
    milestones, flightMinutes, groundMinutes, nextDayGroundMinutes,
    totalTransportMinutes: flightMinutes === null ? null : flightMinutes + groundMinutes,
    airportProcessMinutes: arrival ? ARRIVAL_PROCESS_MINUTES : 0,
    airportPreparationMinutes: flightLegs.length * AIRPORT_LEAD_MINUTES,
  };
}

/** Rebuild explanations from existing evidence. This never fetches Google or changes a route. */
export function projectPlanningDayAdvice(handoff: PlanningHandoffV1, draft: PlanningDraftV1, estimate: PlanningDayEstimate, currentEstimate = true): PlanningDayEstimate {
  if (!estimate.metrics) return estimate;
  const hasFlight = Boolean(draft.flightSelection?.mode && draft.flightSelection.mode !== "none");
  const arrival = hasFlight && estimate.day === 1;
  const departure = hasFlight && estimate.day === handoff.dates.days;
  const dayType: DailyAdvice["dayType"] = arrival && departure ? "arrival_departure" : arrival ? "arrival" : departure ? "departure" : "normal";
  const sceneIds = estimate.sceneIds || [];
  const selected = new Set(sceneIds);
  const advice = buildDailyAdvice({
    fingerprint: estimate.inputFingerprint || estimate.computedAt, pace: handoff.pace,
    sceneCount: sceneIds.length, visitMinutes: estimate.metrics.visitMinutes,
    travelMinutes: estimate.metrics.travelMinutes, freeMinutes: estimate.metrics.freeMinutes,
    overtimeMinutes: estimate.metrics.overtimeMinutes, softOverrunMinutes: estimate.metrics.softOverrunMinutes,
    outdoorCaution: draft.candidates.some((scene) => (selected.has(String(scene.id)) || selected.has(String(scene.placeId))) && /室外|步行|暴晒|outdoor|walking/i.test(String(scene.cons || ""))),
    dayType, baggageStatus: "confirmed", freeWindows: estimate.freeWindows,
    currentEstimate, transportComplete: estimate.transport?.status === "complete",
    hasConflict: draft.scheduleConflicts?.some((conflict) => conflict.day === estimate.day),
    recommendationDeclined: handoff.preferences?.recommendationDeclined,
  });
  if (JSON.stringify(estimate.advice) === JSON.stringify(advice) && estimate.baggage === undefined) return estimate;
  const projected = { ...estimate, advice };
  delete projected.baggage;
  return projected;
}

function hotelsByNight(draft: PlanningDraftV1, boundary: PlanningStayBoundary): ConfirmedAccommodationAnchor[] {
  const segments = [...((draft.staySegments || []) as StaySegment[])].sort((a, b) => a.startDay - b.startDay);
  if (!draft.stayConfirmed) {
    throw new PlanningScheduleError("STAYS_NOT_CONFIRMED", "请先确认每个住宿时段的具体酒店。");
  }
  if (boundary.nights === 0) {
    if (segments.length) throw new PlanningScheduleError("UNNEEDED_STAY_SEGMENT", "当天抵离无需过夜，请移除多余的住宿时段。");
    return [];
  }
  if (!segments.length || segments[0].startDay !== 1 ||
      segments.some((item) => item.startDay > boundary.lastHotelNightDay || !item.hotel?.placeId)) {
    throw new PlanningScheduleError("STAYS_NOT_CONFIRMED", "请确认与航班日期一致的每一晚住宿酒店。");
  }
  for (const [index, segment] of segments.entries()) {
    const expectedCheckIn = addDays(boundary.checkInDate, segment.startDay - 1);
    const expectedCheckOut = index + 1 < segments.length
      ? addDays(boundary.checkInDate, segments[index + 1].startDay - 1)
      : boundary.checkOutDate;
    if (segment.checkInDate !== expectedCheckIn || segment.checkOutDate !== expectedCheckOut ||
        daysBetween(expectedCheckIn, expectedCheckOut) < 1) {
      throw new PlanningScheduleError("STAY_DATES_STALE", "住宿入住、退房日期与航班不一致，请重新确认住宿时段。");
    }
  }
  return Array.from({ length: boundary.lastHotelNightDay }, (_, index) => {
    const segment = segments.filter((item) => item.startDay <= index + 1).at(-1);
    return segment!.hotel!;
  });
}

/** The flight can leave the next calendar day while the 1–7 itinerary days remain unchanged. */
export async function calculateNextDayDepartureTransfer(
  handoff: PlanningHandoffV1,
  draft: PlanningDraftV1,
  lastDayActualReturnTime?: string,
): Promise<NextDayDepartureTransfer | null> {
  const boundary = derivePlanningStayBoundary(handoff, draft);
  if (boundary.flightMode === "none" || boundary.departureOnLastDay) return null;
  const { selection, departureAt } = selectedFlightTimes(draft);
  if (!departureAt || departureAt.slice(0, 10) !== addDays(handoff.dates.end, 1)) {
    throw new PlanningScheduleError("FLIGHT_DEPARTURE_DATE_CONFLICT", "次日离境航班日期与旅行结束日不一致，请重新确认航班。");
  }
  const hotel = hotelsByNight(draft, boundary).at(-1);
  if (!hotel) throw new PlanningScheduleError("STAYS_NOT_CONFIRMED", "次日离境前需要确认最后一晚的酒店。");
  const cached = (draft.dayEstimates?.at(-1) as PlanningDayEstimate | undefined)?.nextDayDepartureTransfer;
  if (cached && cached.departureAt === departureAt && cached.fromHotel.placeId === hotel.placeId &&
      (cached.toAirport.placeId === selection.departureAirportPlaceId || (cached as NextDayDepartureTransfer & { airportIdentityFingerprint?: string }).airportIdentityFingerprint === await scheduleFingerprint(airportIdentity(selection, "departure")))) {
    if (lastDayActualReturnTime && singaporeEpoch(cached.leaveHotelAt) < lastDayReturnEpoch(handoff.dates.end, lastDayActualReturnTime)) {
      throw new PlanningScheduleError("NEXT_DAY_AIRPORT_TRANSFER_CONFLICT", `次日航班需在 ${cached.leaveHotelAt.replace("T", " ")} 离开酒店，早于末日预计返店时间，请缩短末日活动。`, handoff.dates.days);
    }
    return cached;
  }
  const airport = await verifiedAirportForDraft(draft, "departure");
  try {
    const transfer = await buildNextDayDepartureTransfer(departureAt, hotel, {
      placeId: airport.placeId, name: airport.name, address: airport.address,
      location: airport.location, googleMapsUri: airport.googleMapsUri,
    }, lastDayActualReturnTime);
    return Object.assign(transfer, { airportIdentityFingerprint: await scheduleFingerprint(airportIdentity(selection, "departure")) });
  } catch (error) {
    if (error instanceof PlanningScheduleError && error.code === "NEXT_DAY_AIRPORT_TRANSFER_CONFLICT") {
      throw new PlanningScheduleError(error.code, error.message, handoff.dates.days);
    }
    throw error;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function planningDayInputFingerprint(handoff: PlanningHandoffV1, draft: PlanningDraftV1, day: number): Promise<string> {
  const assignment = draft.assignments.find((item) => item.day === day);
  const ids = new Set(assignment?.orderedCandidateIds || []);
  const boundary = derivePlanningStayBoundary(handoff, draft);
  const hotels = hotelsByNight(draft, boundary);
  const selection = draft.flightSelection as Record<string, unknown>;
  const flightTimes = selectedFlightTimes(draft);
  const anchorIdentity = (hotel?: ConfirmedAccommodationAnchor) => hotel ? { placeId: hotel.placeId, name: hotel.name, address: hotel.address, location: hotel.location } : null;
  return scheduleFingerprint({
    algorithm: 7, day, dates: handoff.dates, dailyWindow: handoff.dailyWindow, pace: handoff.pace, preferences: handoff.preferences,
    handoffId: draft.handoffId, sourceIntentStateVersion: draft.sourceIntentStateVersion,
    assignment, placeTimePreferences: Object.fromEntries(Object.entries(draft.placeTimePreferences || {}).filter(([id]) => ids.has(id))), candidates: draft.candidates.filter((item) => ids.has(String(item.id)) || ids.has(String(item.placeId))),
    overrides: routeOwnedTimeOverride(draft.scheduleOverrides?.find((item) => item.day === day)),
    startingHotel: anchorIdentity(hotels[Math.max(0, day - 2)]), endingHotel: anchorIdentity(hotels[day - 1]), boundary,
    flight: {
      mode: selection?.mode,
      ...(day === 1 ? { arrivalAt: flightTimes.arrivalAt, arrival: airportIdentity(selection || {}, "arrival"), outbound: deriveFlightJourney(selection).outbound } : {}),
      ...(day === handoff.dates.days ? { departureAt: flightTimes.departureAt, departure: airportIdentity(selection || {}, "departure"), inbound: deriveFlightJourney(selection).inbound } : {}),
    },
  });
}

export async function calculatePlanningDays(handoff: PlanningHandoffV1, draft: PlanningDraftV1, options: { day?: number; force?: boolean; timing?: PlanningTiming; precheckCapacity?: boolean } = {}) {
  if (!draft.boardConfirmed || !draft.flightSelection) {
    throw new PlanningScheduleError("UPSTREAM_NOT_CONFIRMED", "请先确认地点分天与航班选择。");
  }
  const byId = new Map<string, PlanningSceneCandidate>();
  for (const value of draft.candidates) {
    const candidate = PlanningSceneCandidateSchema.safeParse(value);
    if (candidate.success) { byId.set(candidate.data.id, candidate.data); byId.set(candidate.data.placeId, candidate.data); }
  }
  const boundary = derivePlanningStayBoundary(handoff, draft);
  const hotels = hotelsByNight(draft, boundary);
  const flightSelection = draft.flightSelection as Record<string, unknown>;
  const assignments = [...draft.assignments].sort((a, b) => a.day - b.day);
  if (assignments.length !== handoff.dates.days || assignments.some((item, index) => item.day !== index + 1)) {
    throw new PlanningScheduleError("DAY_BOARD_INCOMPLETE", "请先确认每个旅行日的地点分配；抵离日可以暂时留空。");
  }
  const computedAt = new Date().toISOString();
  const chosenAssignments = options.day ? assignments.filter((item) => item.day === options.day) : assignments;
  if (!chosenAssignments.length) throw new PlanningScheduleError("DAY_NOT_FOUND", "找不到要核算的旅行日。", options.day);
  const calculated = await mapLimit(chosenAssignments, 2, async (assignment) => {
    const index = assignment.day - 1;
    const inputFingerprint = await planningDayInputFingerprint(handoff, draft, assignment.day);
    const previousEstimate = draft.dayEstimates?.find((item) => item.day === assignment.day) as PlanningDayEstimate | undefined;
    if (!options.force && previousEstimate?.inputFingerprint === inputFingerprint && previousEstimate.scheduledDay && previousEstimate.transport?.status === "complete" && previousEstimate.transport.source !== "user" && previousEstimate.metrics.travelSource !== "user" && Array.isArray(previousEstimate.freeWindows)) {
      options.timing?.annotate({ cacheHit: true });
      const cachedDay = previousEstimate.scheduledDay;
      // Older estimates can reuse their route and time checks while restoring the same selected place's advice.
      const stops = cachedDay.stops.map((stop) => {
        if (stop.aiAdvice || !stop.placeId) return stop;
        const scene = byId.get(stop.placeId);
        if (!scene || scene.kind !== stop.kind) return stop;
        return { ...stop, aiAdvice: { pros: scene.pros, cons: scene.cons } };
      });
      if (stops.every((stop, i) => stop === cachedDay.stops[i])) return { day: cachedDay, estimate: projectPlanningDayAdvice(handoff, draft, previousEstimate) };
      const day = { ...cachedDay, stops };
      return { day, estimate: projectPlanningDayAdvice(handoff, draft, { ...previousEstimate, scheduledDay: day }) };
    }
    const [arrivalAirport, departureAirport] = await Promise.all([
      index === 0 && boundary.arrivalOnFirstDay ? verifiedAirportForDraft(draft, "arrival", options.timing) : Promise.resolve(null),
      index === handoff.dates.days - 1 && boundary.departureOnLastDay ? verifiedAirportForDraft(draft, "departure", options.timing) : Promise.resolve(null),
    ]);
    const scenes = assignment.orderedCandidateIds.map((id) => byId.get(id));
    if (scenes.some((item) => !item)) throw new PlanningScheduleError("SCENE_NOT_FOUND", `Day ${index + 1} 的部分地点已失效，请重新选择。`, index + 1);
    const periodByCandidateId = { ...Object.fromEntries(Object.entries(draft.placeTimePreferences || {}).map(([id, value]) => [id, value.period])), ...assignment.periodByCandidateId };
    const periodPriority: Record<PlanningDayPeriod, number> = { morning: 0, flexible: 1, afternoon: 2 };
    const confirmedScenes = (scenes as PlanningSceneCandidate[]).map((scene, order) => ({ scene, order }))
      .sort((a, b) => periodPriority[periodByCandidateId[a.scene.id] || "flexible"] - periodPriority[periodByCandidateId[b.scene.id] || "flexible"] || a.order - b.order)
      .map(({ scene }) => scene);
    const date = addDays(handoff.dates.start, index);
    const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
    const theme = [...new Set(confirmedScenes.map((scene) => scene.area))].slice(0, 2).join(" · ") || `Day ${index + 1}`;
    const skeleton: TripDay = {
      id: `day-${index + 1}`, label: `Day ${index + 1}`,
      date: `${date.slice(5, 7)}/${date.slice(8, 10)}`,
      weekday, theme, color: colors[index], summary: "待核算路线", stops: [], legs: [],
    };
    const window = flightWindow(handoff, draft, index + 1);
    const overrideValue = routeOwnedTimeOverride(draft.scheduleOverrides?.find((item) => item.day === index + 1));
    const override = overrideValue ? PlanningTimeOverrideSchema.parse(overrideValue) : undefined;
    const dayNumber = index + 1;
    const starting = index === 0 && arrivalAirport
      ? airportStop(dayNumber, arrivalAirport, "arrival")
      : hotelStop(dayNumber, hotels[Math.max(0, index - 1)], "start");
    const ending = index === handoff.dates.days - 1 && departureAirport
      ? airportStop(dayNumber, departureAirport, "departure")
      : hotelStop(dayNumber, hotels[index], "return");
    const arrivalHotel = index === 0 && arrivalAirport && hotels[0] && confirmedScenes.length > 0
      ? [hotelStop(dayNumber, hotels[0], "arrival")] : [];
    const localBlocks = effectivePlanningLocalBlocks(override, { departure: Boolean(departureAirport) });
    const legacyHotel = hotels[index] || hotels[0];
    const legacyWaypoints = legacyHotel
      ? legacyPlanningBaggageWaypoints({ day: dayNumber, baggage: override?.baggage, arrival: Boolean(arrivalAirport), departure: Boolean(departureAirport), hotel: hotelStop(dayNumber, legacyHotel, "arrival") })
      : { deposit: [], collection: [] };
    const sceneStops = confirmedScenes.map((scene) => sceneStop(dayNumber, { ...scene, includedMealMinutes: override?.includedMealMinutesByPlaceId?.[scene.placeId] ?? scene.includedMealMinutes }));
    const orderedStops = [starting, ...arrivalHotel, ...legacyWaypoints.deposit, ...sceneStops, ...legacyWaypoints.collection, ending];
    try { validatePlanningLocalBlocks(localBlocks, dayNumber, orderedStops); }
    catch (error) { throw new PlanningScheduleError("INVALID_LOCAL_BLOCK", error instanceof Error ? error.message : "本日安排位置已失效，请重新选择。", dayNumber); }
    const requestedVisitMinutes = Object.fromEntries([
      ...arrivalHotel.map((stop) => [stop.id, 0] as const),
      ...[...legacyWaypoints.deposit, ...legacyWaypoints.collection].map((stop) => [stop.id, 0] as const),
      ...confirmedScenes.map((scene, sceneIndex) => [sceneStops[sceneIndex].id, override?.visitMinutesByPlaceId?.[scene.placeId] ?? scene.estimatedMinutes] as const),
    ]);
    if (options.precheckCapacity) {
      const position = (stop: TripStop) => ({ lat: Number(stop.lat ?? stop.location?.lat), lng: Number(stop.lng ?? stop.location?.lng) });
      const expectedRoute = JSON.stringify(orderedStops.slice(0, -1).map((stop, i) => [position(stop), position(orderedStops[i + 1]), "taxi"]));
      const reference = previousEstimate?.routeReference;
      // Same stops and modes only: mirror the scheduler's 8-minute taxi pickup
      // estimate. A changed route must be queried, not compared to old traffic.
      const cachedTravel = reference?.fingerprint === expectedRoute && reference.routes.length === orderedStops.length - 1 && reference.routes.every(route => Number.isFinite(route.durationMinutes) && route.durationMinutes >= 0)
        ? reference.routes.reduce((sum, route) => sum + route.durationMinutes + 8, 0) : undefined;
      const baseline = previousEstimate?.scenes?.every(scene => Number.isFinite(scene.selectedVisitMinutes)) && cachedTravel !== undefined && previousEstimate.metrics?.travelSource === "google" && Number.isFinite(previousEstimate.metrics.travelMinutes)
        ? previousEstimate.scenes.reduce((sum, scene) => sum + scene.selectedVisitMinutes!, 0) + (previousEstimate.localBlocks || []).reduce((sum, block) => sum + block.durationMinutes, 0) + previousEstimate.metrics.travelMinutes : undefined;
      const capacity = assessPlanningCapacity({ day: dayNumber, startTime: window.startTime, preferredEndTime: window.preferredReturnBy,
        hardEndTime: window.returnBy, visitMinutes: Object.values(requestedVisitMinutes).reduce((sum, value) => sum + value, 0),
        localBlockMinutes: localBlocks.reduce((sum, block) => sum + block.durationMinutes, 0), travelMinutes: cachedTravel, baselineOccupiedMinutes: baseline });
      if (capacity.status === "hard_exceeded") throw new PlanningScheduleError("DAY_CAPACITY_EXCEEDED", capacity.message, dayNumber,
        { code: "DAY_CAPACITY_EXCEEDED", day: dayNumber, date, draftVersion: draft.version, message: capacity.message, capacity });
    }
    let scheduled: Awaited<ReturnType<typeof schedulePlanningDay>>;
    try {
      scheduled = await schedulePlanningDay({
        day: skeleton, orderedStops, startTime: window.startTime, returnBy: window.returnBy,
        requestedVisitMinutes, visitDate: date, timing: options.timing, preferredReturnBy: window.preferredReturnBy,
        localBlocks,
        routeReference: previousEstimate?.routeReference,
        openingHoursByStop: Object.fromEntries(confirmedScenes.map((scene, sceneIndex) => [sceneStops[sceneIndex].id, scene.openingHours ?? []])),
        logisticsStopIds: [...arrivalHotel, ...legacyWaypoints.deposit, ...legacyWaypoints.collection].map((stop) => stop.id),
        periodByStop: Object.fromEntries(confirmedScenes.map((scene, sceneIndex) => [sceneStops[sceneIndex].id, periodByCandidateId[scene.id] ?? "flexible"])),
        periodConstraintByStop: Object.fromEntries(confirmedScenes.map((scene, sceneIndex) => [sceneStops[sceneIndex].id, assignment.periodConstraintByCandidateId?.[scene.id] || draft.placeTimePreferences?.[scene.id]?.constraint || { strength: periodByCandidateId[scene.id] && periodByCandidateId[scene.id] !== "flexible" ? "hard" : "soft", source: periodByCandidateId[scene.id] ? "legacy" : "suggestion" }])),
        sceneRoleByStop: Object.fromEntries(confirmedScenes.map((scene, sceneIndex) => [sceneStops[sceneIndex].id, (scene as PlanningSceneCandidate & { sceneRole?: "culinary_area" | "restaurant_meal" | "attraction" }).sceneRole || (scene.kind === "food" ? "restaurant_meal" : "attraction")])),
        includedMealMinutesByStop: Object.fromEntries(confirmedScenes.map((scene, sceneIndex) => [sceneStops[sceneIndex].id, override?.includedMealMinutesByPlaceId?.[scene.placeId] ?? scene.includedMealMinutes ?? 0])),
      });
    } catch (error) {
      if (error instanceof RegularOpeningConflictError) {
        const evidence = error.evidence;
        const scene = confirmedScenes.find((item) => item.placeId === evidence?.placeId || sceneStops[confirmedScenes.indexOf(item)]?.id === evidence?.stopId);
        const { arrivalAt } = selectedFlightTimes(draft);
        const arrivalHere = dayNumber === 1 && arrivalAt?.slice(0, 10) === date ? arrivalAt : null;
        const failure = evidence?.failure;
        const endingReason = failure?.limitingBoundary === "planning_day"
          ? `预计 ${minuteClock(failure.earliestVisitStart + failure.visitMinutes)} 结束，超过当天核算上限 ${minuteClock(failure.planningCutoffMinute ?? 1440)}；场馆常规营业结束为 ${minuteClock(failure.actualClosingMinute ?? failure.closingMinute ?? 1440)}，并非午夜闭馆`
          : failure?.closingMinute !== null && failure?.closingMinute !== undefined ? `预计 ${minuteClock(failure.earliestVisitStart + failure.visitMinutes)} 结束，超过 ${minuteClock(failure.closingMinute)} 闭馆${failure.missingMinutes ? `约 ${failure.missingMinutes} 分钟` : ""}` : "可用开放窗口不足";
        const reason = failure?.reasonCode === "arrival_too_late"
          ? `${arrivalHere ? `航班 ${arrivalHere.slice(11)} 抵达，机场流程估算预留 120 分钟；` : ""}${evidence?.hotelMinutes ? `已安排操作 ${evidence.hotelMinutes} 分钟；` : ""}此前交通约 ${evidence?.routeMinutes ?? "待核实"} 分钟${evidence?.earlierVisitMinutes ? `、其他地点停留 ${evidence.earlierVisitMinutes} 分钟` : ""}${evidence?.localBlockMinutes ? `、你添加的安排 ${evidence.localBlockMinutes} 分钟` : ""}，最早 ${minuteClock(failure.earliestVisitStart)} 可到。当前安排 ${failure.visitMinutes} 分钟，${endingReason}。`
          : error.message;
        const suggestion = failure?.reasonCode === "period_conflict" && failure.effectivePeriod === "morning"
          ? "建议先核对改到当天下午；全日核对通过并经你确认后才调整分区，也可选择后一天。"
          : dayNumber < handoff.dates.days ? `建议先核对后一天（Day ${dayNumber + 1}）并移动；也可调整停留时长。` : "可以调整停留时长，或返回分天板选择其他日期。";
        const message = `Day ${dayNumber} 的“${error.stopName}”${error.openingHours ? `（Google 常规开放：${error.openingHours}）` : ""}：${reason}${suggestion}`;
        const conflict: PlanningScheduleConflict = {
          code: failure?.reasonCode || "PLACE_OPENING_CONFLICT", day: dayNumber, date, draftVersion: draft.version, message,
          placeId: scene?.placeId || evidence?.placeId, placeName: error.stopName, openingHours: error.openingHours,
          visitSource: scene && override?.visitMinutesByPlaceId?.[scene.placeId] !== undefined ? "user" : scene?.estimateSource === "user" ? "user" : "bailian",
          periodStrength: evidence?.periodStrength, periodSource: evidence?.periodSource,
          arrivalAt: arrivalHere, preferredStartTime: window.requestedWindow.start, effectiveStartTime: window.startTime,
          ...(arrivalHere ? { arrivalSource: flightSelection.mode === "manual" ? "user" as const : "bailian" as const } : {}),
          airportReserveMinutes: arrivalHere ? ARRIVAL_PROCESS_MINUTES : 0,
          hotelMinutes: evidence?.hotelMinutes, routeMinutes: evidence?.routeMinutes, earlierVisitMinutes: evidence?.earlierVisitMinutes,
          window: failure, ...(dayNumber < handoff.dates.days ? { suggestedDay: dayNumber + 1 } : {}),
        };
        throw new PlanningScheduleError(
          "PLACE_OPENING_CONFLICT",
          message, dayNumber, conflict,
        );
      }
      throw error;
    }
    const hoursNotes = scheduled.adjustments.slice();
    if (confirmedScenes.some((scene, sceneIndex) => scene.id !== assignment.orderedCandidateIds[sceneIndex])) {
      hoursNotes.unshift("已按你选择的上午／下午偏好调整同日地点顺序；各段路程已重新估算。");
    }
    for (const scene of confirmedScenes) {
      const stop = scheduled.day.stops.find((item) => item.placeId === scene.placeId);
      if (!stop) continue;
      const hours = assessRegularOpeningHours({
        weekdayDescriptions: scene.openingHours ?? [], visitDate: date,
        startTime: stop.time, endTime: stop.endTime,
      });
      if (hours.status === "closed") {
        throw new PlanningScheduleError(
          "PLACE_OPENING_CONFLICT",
          `Day ${dayNumber} 的“${scene.name}”与 Google 常规开放信息仍有冲突：${hours.reason}。请回分天板调整上午／下午安排，或调整停留，并在出发前复核特殊营业时间。`,
          dayNumber,
        );
      }
    }
    const estimate: PlanningDayEstimate = {
      day: index + 1, date, sceneIds: confirmedScenes.map((scene) => scene.id),
      dailyWindow: window.requestedWindow,
      effectiveWindow: { start: window.startTime, returnBy: window.returnBy },
      routeReference: scheduled.routeReference,
      inputFingerprint, scheduledDay: scheduled.day, transport: scheduled.transport,
      airportAnchors: {
        ...(arrivalAirport ? { arrival: { place: arrivalAirport, identityFingerprint: await scheduleFingerprint(airportIdentity(flightSelection, "arrival")) } } : {}),
        ...(departureAirport ? { departure: { place: departureAirport, identityFingerprint: await scheduleFingerprint(airportIdentity(flightSelection, "departure")) } } : {}),
      },
      freeWindows: scheduled.freeWindows,
      localBlocks, scheduledLocalBlocks: scheduled.scheduledLocalBlocks,
      overrides: override,
      scenes: confirmedScenes.map((scene, sceneIndex) => {
        const stop = scheduled.day.stops.find((item) => item.id === sceneStops[sceneIndex].id);
        const startMinute = stop ? clockMinutes(stop.time) : 12 * 60;
        return {
          candidateId: scene.placeId, name: scene.name,
          period: startMinute < 12 * 60 ? "morning" as const : startMinute < 18 * 60 ? "afternoon" as const : "evening" as const,
          preferredPeriod: periodByCandidateId[scene.id] ?? "flexible",
          regularOpeningHours: regularOpeningHoursLabel(scene.openingHours ?? [], date),
          durationReason: (scene as PlanningSceneCandidate & { durationReason?: string }).durationReason,
          sceneRole: (scene as PlanningSceneCandidate & { sceneRole?: "culinary_area" | "restaurant_meal" | "attraction" }).sceneRole,
          includedMealMinutes: override?.includedMealMinutesByPlaceId?.[scene.placeId] ?? scene.includedMealMinutes ?? 0,
          ...sceneTimeAdvice(scene, override?.visitMinutesByPlaceId?.[scene.placeId] ?? scene.estimatedMinutes),
        };
      }),
      metrics: scheduled.metrics, computedAt, notes: [...window.notes, ...hoursNotes],
    };
    estimate.journey = buildPlanningDayJourney(handoff, draft, estimate);
    return { day: scheduled.day, estimate: projectPlanningDayAdvice(handoff, draft, estimate) };
  });
  const lastDay = calculated.at(-1);
  if (lastDay && lastDay.estimate.day === handoff.dates.days && !lastDay.estimate.nextDayDepartureTransfer) {
    const transfer = await calculateNextDayDepartureTransfer(handoff, draft, lastDay.estimate.metrics.actualReturnTime);
    if (transfer) {
      lastDay.estimate.nextDayDepartureTransfer = transfer;
      lastDay.estimate.journey = buildPlanningDayJourney(handoff, draft, lastDay.estimate);
      lastDay.estimate.notes.push(`次日 ${transfer.date} 航班：预计 ${transfer.leaveHotelAt.replace("T", " ")} 从酒店出发，${transfer.arriveAirportAt.replace("T", " ")} 到达机场；已单列交通，不计入 Day ${handoff.dates.days} 的游玩时间。`);
    }
  }
  return calculated;
}

/** A conflict in one day must not discard the successful evidence from other days. */
export async function calculatePlanningOutcome(handoff: PlanningHandoffV1, draft: PlanningDraftV1, options: { days?: number[]; timing?: PlanningTiming; retainUnavailableDays?: boolean } = {}) {
  const days = options.days || Array.from({ length: handoff.dates.days }, (_, index) => index + 1);
  const results = await mapLimit(days, 2, async (day) => {
    try {
      const calculated = await calculatePlanningDays(handoff, draft, { day, timing: options.timing, precheckCapacity: true });
      return { estimate: calculated[0].estimate, conflicts: [] };
    } catch (error) {
      if (!(error instanceof PlanningScheduleError)) {
        if (!options.retainUnavailableDays || !(error instanceof Error) || (error.name !== "GoogleMapsServiceError" && error.message !== "INCOMPLETE_ROUTE_EVIDENCE")) throw error;
        const unavailable: PlanningScheduleConflict = {
          code: "ROUTE_EVIDENCE_UNAVAILABLE", day, date: addDays(handoff.dates.start, day - 1), draftVersion: draft.version,
          message: "当天交通或地点依据暂时无法核实，请保留这份调整并重试核对。",
        };
        return { estimate: null, conflicts: [unavailable] };
      }
      const conflict: PlanningScheduleConflict = error.conflict || {
        code: error.code, day, date: addDays(handoff.dates.start, day - 1), draftVersion: draft.version, message: error.message,
      };
      return { estimate: null, conflicts: [conflict, ...additionalMorningConflicts(handoff, draft, conflict)] };
    }
  });
  return { estimates: results.flatMap((item) => item.estimate ? [item.estimate] : []), conflicts: results.flatMap((item) => item.conflicts) };
}

/** Build an uncommitted move. User-controlled durations travel with the place, not the source day. */
export function draftForScheduleMove(handoff: PlanningHandoffV1, draft: PlanningDraftV1, input: ScheduleMoveRequest): PlanningDraftV1 {
  if ((input.day === input.targetDay && !input.targetPeriod) || input.targetDay < 1 || input.targetDay > handoff.dates.days) throw new PlanningScheduleError("INVALID_MOVE_DAY", "请选择其他有效旅行日，或明确选择本日的新分区。", input.day);
  const scene = draft.candidates.find((item) => item.placeId === input.placeId || item.id === input.placeId);
  if (!scene) throw new PlanningScheduleError("SCENE_NOT_FOUND", "该地点已不在当前安排，请重新读取规划。", input.day);
  const ids = [String(scene.id), String(scene.placeId)];
  const source = draft.assignments.find((item) => item.day === input.day);
  const target = draft.assignments.find((item) => item.day === input.targetDay);
  const id = source?.orderedCandidateIds.find((value) => ids.includes(value));
  if (!id || !target) throw new PlanningScheduleError("SCENE_NOT_IN_DAY", "该地点已经被移动，请重新读取当前安排。", input.day);
  const period = source!.periodByCandidateId?.[id] || draft.placeTimePreferences?.[id]?.period;
  const constraint = source!.periodConstraintByCandidateId?.[id] || draft.placeTimePreferences?.[id]?.constraint;
  if (input.day === input.targetDay && input.targetPeriod === period) throw new PlanningScheduleError("PERIOD_ALREADY_SELECTED", "该地点已在这个分区，请重新读取当前安排。", input.day);
  const nextPeriod = input.targetPeriod || period;
  const priorStrength = constraint?.strength || (period && period !== "flexible" ? "hard" : "soft");
  const nextConstraint = input.targetPeriod ? {
    strength: priorStrength, source: "user" as const,
    evidence: `用户确认将原${period === "morning" ? "上午" : period === "afternoon" ? "下午" : "未指定"}${priorStrength === "hard" ? "固定要求" : "安排"}改为${input.targetPeriod === "morning" ? "上午" : "下午"}${constraint?.evidence ? `；原要求：${constraint.evidence}` : ""}`.slice(0, 300),
  } : constraint;
  const assignments = draft.assignments.map((item) => {
    if (input.day === input.targetDay && item.day === input.day) return { ...item,
      periodByCandidateId: { ...item.periodByCandidateId, [id]: input.targetPeriod! },
      periodConstraintByCandidateId: { ...item.periodConstraintByCandidateId, [id]: nextConstraint! } };
    if (item.day === input.day) {
      const periodByCandidateId = { ...item.periodByCandidateId }; delete periodByCandidateId[id];
      const periodConstraintByCandidateId = { ...item.periodConstraintByCandidateId }; delete periodConstraintByCandidateId[id];
      const orderedCandidateIds = item.orderedCandidateIds.filter((value) => value !== id);
      return { ...item, orderedCandidateIds, periodByCandidateId, periodConstraintByCandidateId, dayPurpose: orderedCandidateIds.length ? "activities" as const : "rest" as const };
    }
    if (item.day !== input.targetDay) return item;
    return { ...item, orderedCandidateIds: [...item.orderedCandidateIds.filter((value) => !ids.includes(value)), id], dayPurpose: "activities" as const,
      periodByCandidateId: { ...item.periodByCandidateId, ...(nextPeriod ? { [id]: nextPeriod } : {}) },
      periodConstraintByCandidateId: { ...item.periodConstraintByCandidateId, ...(nextConstraint ? { [id]: nextConstraint } : {}) } };
  });
  if (input.day === input.targetDay) return { ...draft, assignments,
    placeTimePreferences: { ...draft.placeTimePreferences, [id]: { period: input.targetPeriod!, constraint: nextConstraint } } };
  const overrides = (draft.scheduleOverrides || []).map((item) => {
    const parsed = PlanningTimeOverrideSchema.parse(item);
    return { ...parsed, visitMinutesByPlaceId: { ...parsed.visitMinutesByPlaceId },
      includedMealMinutesByPlaceId: { ...parsed.includedMealMinutesByPlaceId } };
  });
  const old = overrides.find((item) => item.day === input.day);
  const visit = old?.visitMinutesByPlaceId[input.placeId], meal = old?.includedMealMinutesByPlaceId[input.placeId];
  if (old) { delete old.visitMinutesByPlaceId[input.placeId]; delete old.includedMealMinutesByPlaceId[input.placeId]; }
  if (visit !== undefined || meal !== undefined) {
    let destination = overrides.find((item) => item.day === input.targetDay);
    if (!destination) { destination = { day: input.targetDay, visitMinutesByPlaceId: {}, includedMealMinutesByPlaceId: {} }; overrides.push(destination); }
    if (visit !== undefined) destination.visitMinutesByPlaceId[input.placeId] = visit;
    if (meal !== undefined) destination.includedMealMinutesByPlaceId[input.placeId] = meal;
  }
  return { ...draft, assignments, scheduleOverrides: overrides,
    ...(input.targetPeriod ? { placeTimePreferences: { ...draft.placeTimePreferences, [id]: { period: input.targetPeriod, constraint: nextConstraint } } } : {}) };
}

export async function previewScheduleMove(handoff: PlanningHandoffV1, draft: PlanningDraftV1, input: ScheduleMoveRequest, timing?: PlanningTiming) {
  const moved = draftForScheduleMove(handoff, draft, input);
  const outcome = await calculatePlanningOutcome(handoff, moved, { days: [...new Set([input.day, input.targetDay])], timing });
  const conflicts = outcome.conflicts.slice();
  for (const estimate of outcome.estimates) {
    if (estimate.metrics.overtimeMinutes > 0) conflicts.push({ code: "DAILY_WINDOW_TOO_SHORT", day: estimate.day, date: estimate.date, draftVersion: draft.version, message: `Day ${estimate.day} 移动后超出截止 ${estimate.metrics.overtimeMinutes} 分钟。` });
    if (estimate.day === input.targetDay && estimate.scenes?.find((scene) => scene.candidateId === input.placeId)?.regularOpeningHours == null) conflicts.push({ code: "OPENING_HOURS_UNKNOWN", day: estimate.day, date: estimate.date, placeId: input.placeId, draftVersion: draft.version, message: "目标日开放信息尚未核实，暂不能确认此移动可行；请核实开放信息或返回分天板调整。" });
  }
  const fingerprint = await scheduleFingerprint({ version: draft.version, handoffId: draft.handoffId, input,
    source: await planningDayInputFingerprint(handoff, moved, input.day), target: await planningDayInputFingerprint(handoff, moved, input.targetDay) });
  const source = draft.assignments.find((assignment) => assignment.day === input.day);
  const scene = draft.candidates.find((item) => item.placeId === input.placeId || item.id === input.placeId);
  const sourceId = source?.orderedCandidateIds.find((id) => id === scene?.id || id === scene?.placeId);
  const oldPeriod = sourceId ? source?.periodByCandidateId?.[sourceId] || draft.placeTimePreferences?.[sourceId]?.period : undefined;
  const oldConstraint = sourceId ? source?.periodConstraintByCandidateId?.[sourceId] || draft.placeTimePreferences?.[sourceId]?.constraint : undefined;
  const preview: ScheduleMovePreview = { ...input, feasible: !conflicts.length, fingerprint, conflicts,
    ...(input.targetPeriod ? { periodChange: { from: oldPeriod || "flexible", to: input.targetPeriod, strength: oldConstraint?.strength || (oldPeriod && oldPeriod !== "flexible" ? "hard" : "soft"), ...(oldConstraint?.evidence ? { evidence: oldConstraint.evidence } : {}) } } : {}),
    message: conflicts.length ? "调整后仍有待处理的时间或开放问题，尚未改变安排。" : input.day === input.targetDay
      ? `已核对 Day ${input.day} 的全部常规开放、路线与截止；确认后才将此地点改到当天${input.targetPeriod === "morning" ? "上午" : "下午"}。航班和酒店保持原选择。`
      : `已核对 Day ${input.day} 和 Day ${input.targetDay} 的常规开放、路线与截止；确认后才移动。原日无地点时将作为休息日。`,
    days: outcome.estimates.map((estimate) => ({ day: estimate.day, date: estimate.date, placeNames: estimate.scenes?.map((scene) => scene.name) || [], freeMinutes: estimate.metrics.freeMinutes, returnTime: estimate.metrics.actualReturnTime })) };
  return { preview, moved, outcome };
}

/** List independently provable morning conflicts without estimating later stops from an incomplete route. */
function additionalMorningConflicts(handoff: PlanningHandoffV1, draft: PlanningDraftV1, conflict: PlanningScheduleConflict): PlanningScheduleConflict[] {
  const earliest = conflict.effectiveStartTime ? clockMinutes(conflict.effectiveStartTime) : 0;
  if (conflict.code !== "period_conflict" || earliest < 720) return [];
  const assignment = draft.assignments.find((day) => day.day === conflict.day);
  const override = PlanningTimeOverrideSchema.safeParse(draft.scheduleOverrides?.find((day) => day.day === conflict.day));
  return (assignment?.orderedCandidateIds || []).flatMap((id) => {
    const scene = PlanningSceneCandidateSchema.safeParse(draft.candidates.find((item) => item.id === id || item.placeId === id));
    if (!scene.success || scene.data.placeId === conflict.placeId) return [];
    const period = assignment?.periodByCandidateId?.[id] || draft.placeTimePreferences?.[id]?.period;
    const constraint = assignment?.periodConstraintByCandidateId?.[id] || draft.placeTimePreferences?.[id]?.constraint;
    if (period !== "morning" || (constraint?.strength === "soft" && constraint.source !== "user")) return [];
    const visitMinutes = override.success ? override.data.visitMinutesByPlaceId?.[scene.data.placeId] : undefined;
    const regular = planRegularVisit({
      weekdayDescriptions: scene.data.openingHours ?? [], visitDate: conflict.date,
      arrivalMinute: earliest, durationMinutes: visitMinutes ?? scene.data.estimatedMinutes,
      preferredPeriod: period, periodStrength: "hard",
    });
    if (regular.status !== "closed" || regular.failure?.reasonCode !== "period_conflict") return [];
    return [{
      code: "period_conflict", day: conflict.day, date: conflict.date, draftVersion: draft.version, startBoundaryOnly: true,
      placeId: scene.data.placeId, placeName: scene.data.name, openingHours: regular.openingHours,
      periodStrength: constraint?.strength || "hard", periodSource: constraint?.source,
      visitSource: visitMinutes !== undefined || scene.data.estimateSource === "user" ? "user" : "bailian",
      effectiveStartTime: conflict.effectiveStartTime,
      message: `当天最早约 ${minuteClock(earliest)} 开始活动，已无法在上午开始此地点的安排。请选择下午或其他日期重新核对。`,
      window: regular.failure, ...(conflict.day < handoff.dates.days ? { suggestedDay: conflict.day + 1 } : {}),
    }];
  });
}

/** Apply each proposed move to a copy, then calculate the final arrangement of every touched day. */
export async function previewScheduleMoves(handoff: PlanningHandoffV1, draft: PlanningDraftV1, inputs: ScheduleMoveRequest[], timing?: PlanningTiming) {
  if (!inputs.length) throw new PlanningScheduleError("MOVE_REQUIRED", "请选择至少一处地点调整。");
  const seen = new Set<string>();
  let moved = draft;
  let requiresAcknowledgement = false;
  const moves: ScheduleMoveBatchPreview["moves"] = [];
  for (const input of inputs) {
    const candidate = draft.candidates.find((item) => item.id === input.placeId || item.placeId === input.placeId);
    if (!candidate || typeof candidate.placeId !== "string" || typeof candidate.name !== "string") {
      throw new PlanningScheduleError("SCENE_NOT_FOUND", "该地点已不在当前安排，请重新读取规划。", input.day);
    }
    const placeId = candidate.placeId;
    if (seen.has(placeId)) throw new PlanningScheduleError("DUPLICATE_MOVE", "每个地点只可保留一项调整。", input.day);
    seen.add(placeId);
    const source = draft.assignments.find((item) => item.day === input.day);
    const id = source?.orderedCandidateIds.find((item) => item === candidate.id || item === placeId);
    if (!id) throw new PlanningScheduleError("SCENE_NOT_IN_DAY", "该地点的原安排已变化，请重新读取当前安排。", input.day);
    const fromPeriod = source?.periodByCandidateId?.[id] || draft.placeTimePreferences?.[id]?.period || "flexible";
    const constraint = source?.periodConstraintByCandidateId?.[id] || draft.placeTimePreferences?.[id]?.constraint;
    const targetPeriod = input.targetPeriod === fromPeriod ? undefined : input.targetPeriod;
    const move = { day: input.day, placeId, targetDay: input.targetDay, ...(targetPeriod ? { targetPeriod } : {}) };
    moved = draftForScheduleMove(handoff, moved, move);
    if (targetPeriod && constraint?.strength === "hard" && constraint.source === "user") requiresAcknowledgement = true;
    moves.push({
      ...move, placeName: candidate.name, fromPeriod,
      ...(targetPeriod ? { periodChange: { from: fromPeriod, to: targetPeriod,
        strength: constraint?.strength || (fromPeriod === "flexible" ? "soft" : "hard"), evidence: constraint?.evidence } } : {}),
    });
  }
  const affectedDays = [...new Set(moves.flatMap(({ day, targetDay }) => [day, targetDay]))].sort((a, b) => a - b);
  const outcome = await calculatePlanningOutcome(handoff, moved, { days: affectedDays, timing, retainUnavailableDays: true });
  const conflicts = outcome.conflicts.slice();
  for (const estimate of outcome.estimates) {
    if (estimate.metrics.overtimeMinutes > 0) conflicts.push({
      code: "DAILY_WINDOW_TOO_SHORT", day: estimate.day, date: estimate.date, draftVersion: draft.version,
      message: `Day ${estimate.day} 调整后超出截止 ${estimate.metrics.overtimeMinutes} 分钟。`,
    });
    for (const move of moves.filter((item) => item.targetDay === estimate.day)) {
      const stop = estimate.scheduledDay?.stops.find((item) => item.placeId === move.placeId);
      const candidate = PlanningSceneCandidateSchema.safeParse(moved.candidates.find((item) => item.placeId === move.placeId));
      const hours = stop && candidate.success ? assessRegularOpeningHours({
        weekdayDescriptions: candidate.data.openingHours ?? [], visitDate: estimate.date, startTime: stop.time, endTime: stop.endTime,
      }) : null;
      if (hours?.status !== "open") conflicts.push({
        code: "OPENING_HOURS_UNKNOWN", day: estimate.day, date: estimate.date, draftVersion: draft.version,
        placeId: move.placeId, placeName: move.placeName,
        message: "当前日期的开放信息尚未核实，暂不能确认；请重新核对或选择其他日期。",
      });
    }
  }
  const days = outcome.estimates.map((estimate) => ({ day: estimate.day, date: estimate.date,
    placeNames: estimate.scenes?.map((scene) => scene.name) || [], freeMinutes: estimate.metrics.freeMinutes, returnTime: estimate.metrics.actualReturnTime }));
  const feasible = conflicts.length === 0 && days.length === affectedDays.length;
  const fingerprint = await scheduleFingerprint({
    version: draft.version, handoffId: draft.handoffId, moves, days, conflicts,
    inputs: await Promise.all(affectedDays.map((day) => planningDayInputFingerprint(handoff, moved, day))),
    stops: outcome.estimates.map((estimate) => estimate.scheduledDay?.stops.map(({ id, time, endTime }) => ({ id, time, endTime }))),
  });
  const preview: ScheduleMoveBatchPreview = {
    moves, affectedDays, draftVersion: draft.version, feasible, fingerprint, conflicts, days, requiresAcknowledgement,
    message: feasible ? "所有受影响日期已通过核算，确认后将一次保存全部调整。" : "仍有日期待调整或核实，已保留本次选择。",
  };
  return { preview, moved, outcome };
}

export async function compilePlanningTrip(handoff: PlanningHandoffV1, draft: PlanningDraftV1): Promise<{ trip: DemoTrip; estimates: PlanningDayEstimate[] }> {
  if (draft.scheduleConflicts?.length) throw new PlanningScheduleError("SCHEDULE_CONFLICTS_REQUIRED", "请先解决各日时间冲突后再生成地图。");
  if (draft.stage !== "complete") throw new PlanningScheduleError("SCHEDULE_NOT_CONFIRMED", "请先确认每日时间与未安排时段。");
  const pending = pendingReviewLabels(draft);
  if (pending.length) throw new PlanningScheduleError("REVIEW_REQUIRED", `请先复核：${pending.join("、")}。`);
  const boundary = derivePlanningStayBoundary(handoff, draft);
  for (const value of draft.scheduleOverrides || []) {
    const parsed = PlanningTimeOverrideSchema.safeParse(value);
    if (parsed.success && effectivePlanningLocalBlocks(parsed.data, { departure: boundary.departureOnLastDay && parsed.data.day === handoff.dates.days }).some((block) => !block.anchor))
      throw new PlanningScheduleError("LOCAL_BLOCK_POSITION_REQUIRED", `Day ${parsed.data.day} 已保存的安排仍待放置，请先选择时间轴位置。`, parsed.data.day);
  }
  const calculated = await calculatePlanningDays(handoff, draft);
  const overtime = calculated.find((item) => item.estimate.metrics.overtimeMinutes > 0);
  if (overtime) throw new PlanningScheduleError("DAILY_WINDOW_TOO_SHORT", `Day ${overtime.estimate.day} 超出要求返回时间 ${overtime.estimate.metrics.overtimeMinutes} 分钟，请调整地点或交通方式。`, overtime.estimate.day);
  const segments = ((draft.staySegments || []) as StaySegment[]).map((segment) => ({
    id: `stay-day-${segment.startDay}`,
    startDayId: `day-${segment.startDay}`,
    anchor: segment.hotel!,
  })) satisfies AccommodationSegment[];
  const people = handoff.travelers.total;
  const generatedAt = new Date().toISOString();
  const trip: DemoTrip = {
    id: `singapore-${generatedAt.slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`,
    title: handoff.preferences.interests.length ? `新加坡 · ${handoff.preferences.interests.slice(0, 3).join("、")}` : "新加坡 · 你选的地点",
    destination: "新加坡",
    dateRange: `${handoff.dates.start.slice(5).replace("-", "/")} — ${handoff.dates.end.slice(5).replace("-", "/")}`,
    timezone: "Asia/Singapore (GMT+8)",
    hotel: segments.length === 0 ? "当日抵离 · 无过夜住宿"
      : segments.length === 1 ? segments[0].anchor.name : `多酒店住宿 · ${segments.length} 段`,
    accommodationMode: segments.length ? "hotel" : "area",
    ...(segments.length ? { accommodationAnchor: segments[0].anchor } : {}),
    accommodationSegments: segments,
    ...(calculated.at(-1)?.estimate.nextDayDepartureTransfer
      ? { departureTransfer: calculated.at(-1)!.estimate.nextDayDepartureTransfer } : {}),
    pace: handoff.pace === "relaxed" ? "轻松" : handoff.pace === "intensive" ? "紧凑" : "平衡",
    people,
    days: calculated.map(({ day, estimate }) => projectPlanningMapHotelQuotes(day, estimate.date, draft.handoffId, (draft.staySegments || []) as MapHotelSegment[], draft.hotelQuoteJob as HotelQuoteJob | undefined)),
    source: "live", generatedAt,
    warnings: [
      "交通初始参考来自 Google 路线及预留；标为“你的设置”的交通总时长按原路段比例分配。实际路况、营业与航班手续请出发前复核。",
      boundary.note,
      ...(draft.flightSelection && (draft.flightSelection as Record<string, unknown>).mode !== "none" ? ["航班抵离日的入境、行李及机场时间为保守估计，并非航空公司承诺。"] : []),
    ],
  };
  return { trip, estimates: calculated.map((item) => item.estimate) };
}
