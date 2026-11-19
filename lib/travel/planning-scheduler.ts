import {
  computeSingaporeRoute,
  SINGAPORE_BOUNDS,
  type GoogleRouteMode,
  type SingaporeRoute,
} from "@/lib/travel/google-maps";
import type { RouteLeg, TravelMode, TripDay, TripStop } from "@/lib/travel/types";
import { planRegularVisit, type PlanningDayPeriod } from "@/lib/travel/planning-hours";
import { distributeTravelMinutes } from "@/lib/travel/planning-time-overrides";
import type { PlanningTiming } from "@/lib/travel/planning-timing";
import type { DailyTransport, PlanningFreeWindow } from "@/lib/travel/planning-schedule-policy";
import { planningLocalBlockStopId, validatePlanningLocalBlocks, type PlanningLocalBlock, type ScheduledPlanningLocalBlock } from "./planning-local-blocks";

export type PlanningRouteReference = { fingerprint: string; routes: SingaporeRoute[]; queriedAt: string };

export type ScheduledDayMetrics = {
  visitMinutes: number;
  foodMinutes: number;
  logisticsMinutes: number;
  mealReserveMinutes: number;
  bufferMinutes: number;
  openingWaitMinutes: number;
  travelMinutes: number;
  pickupMinutes: number;
  freeMinutes: number;
  overtimeMinutes: number;
  actualReturnTime: string;
  requestedReturnTime: string;
  terminalKind: "hotel" | "airport";
  startTime: string;
  personalMinutes: number;
  referenceTravelMinutes: number;
  travelSource: "google" | "user";
  periodFreeMinutes?: number;
  requestedMealReserveMinutes?: number;
  softOverrunMinutes?: number;
  preferredReturnTime?: string;
  localBlockMinutes?: number;
};

export class RegularOpeningConflictError extends Error {
  constructor(readonly stopName: string, readonly openingHours: string | null, reason: string,
    readonly evidence?: { stopId: string; placeId?: string; failure?: import("./planning-conflicts").VisitWindowFailure; routeMinutes: number; hotelMinutes: number; earlierVisitMinutes: number; localBlockMinutes?: number; periodStrength: "soft" | "hard"; periodSource?: string }) {
    super(reason);
    this.name = "RegularOpeningConflictError";
  }
}

function airportEndpoint(stop: TripStop): boolean {
  return stop.kind === "other" && stop.verified && Boolean(stop.placeId) &&
    /机场|airport/i.test(`${stop.categoryLabel || ""} ${stop.name}`);
}

function minutes(clock: string): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock)) throw new Error("INVALID_CLOCK");
  const [hours, mins] = clock.split(":").map(Number);
  return hours * 60 + mins;
}

function clock(value: number): string {
  const safe = Math.max(0, Math.round(value));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function durationLabel(value: number): string {
  const hours = Math.floor(value / 60);
  const mins = value % 60;
  return hours ? `${hours} 小时${mins ? ` ${mins} 分` : ""}` : `${mins} 分钟`;
}

function localBlockStop(block: PlanningLocalBlock, start: number, end: number): TripStop {
  return {
    id: planningLocalBlockStopId(block.id), name: block.title, area: "用户安排", kind: "buffer",
    time: clock(start), endTime: clock(end), duration: durationLabel(block.durationMinutes),
    x: 0, y: 0, verified: false, note: block.source === "legacy" && !block.anchor ? "已保存时间，位置待选择" : "用户自行安排 · 无独立坐标",
    description: block.details, categoryLabel: block.kind === "meal" ? "吃饭" : block.kind === "rest" ? "休息" : "自定义",
  };
}

function coordinate(stop: TripStop): { lat: number; lng: number } {
  const lat = Number(stop.lat ?? stop.location?.lat);
  const lng = Number(stop.lng ?? stop.location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)
    || lat < SINGAPORE_BOUNDS.south || lat > SINGAPORE_BOUNDS.north
    || lng < SINGAPORE_BOUNDS.west || lng > SINGAPORE_BOUNDS.east) {
    throw new Error("STOP_OUTSIDE_SINGAPORE");
  }
  return { lat, lng };
}

function googleMode(mode: TravelMode): GoogleRouteMode {
  if (mode === "taxi") return "drive";
  if (mode === "walk" || mode === "transit" || mode === "drive" || mode === "bicycle") return mode;
  return "drive";
}

function durationForStop(stop: TripStop, override?: number, logistics = false): number {
  if (Number.isInteger(override) && override! >= (logistics ? 0 : 15) && override! <= 480) return override!;
  const scheduledMinutes = (value: string) => /^\d{2,3}:[0-5]\d$/.test(value)
    ? Number(value.split(":")[0]) * 60 + Number(value.split(":")[1]) : 0;
  const start = scheduledMinutes(stop.time);
  const end = scheduledMinutes(stop.endTime);
  if (end - start >= 15 && end - start <= 480) return end - start;
  return stop.kind === "food" ? 75 : stop.kind === "sight" ? 120 : 60;
}

type GapWindow = { start: number; end: number; anchorId: string };
/** Reserve consumption follows the scheduler's chronological gaps, not a second time budget. */
export function planningFreeWindows(input: { gaps: GapWindow[]; allocatedReserveMinutes: number; preferredDeadline: number; finishedAt: number; terminalId: string }): PlanningFreeWindow[] {
  let remainingReserve = input.allocatedReserveMinutes;
  const windows: PlanningFreeWindow[] = [];
  input.gaps.forEach((gap, index) => {
    const end = Math.min(gap.end, input.preferredDeadline);
    const length = Math.max(0, end - gap.start);
    const used = Math.min(length, remainingReserve);
    remainingReserve -= used;
    const start = gap.start + used;
    if (end > start) windows.push({ id: `period-gap-${index}`, kind: "period_gap", startTime: clock(start), endTime: clock(end), minutes: end - start, fromStopId: gap.anchorId, toStopId: gap.anchorId });
  });
  if (input.preferredDeadline > input.finishedAt) windows.push({ id: "after-route", kind: "after_route", startTime: clock(input.finishedAt), endTime: clock(input.preferredDeadline), minutes: input.preferredDeadline - input.finishedAt, fromStopId: input.terminalId, toStopId: input.terminalId });
  return windows;
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Google calculates travel between the user's chosen stops. Travelworld adds
 * a visible taxi pickup estimate; it never pads a day with invented places.
 * The returned day retains the actual hotel return time and the separate
 * requested deadline, so an early finish is explicit instead of a large fake
 * activity block.
 */
export async function schedulePlanningDay(input: {
  day: TripDay;
  orderedStops: TripStop[];
  startTime: string;
  returnBy: string;
  requestedVisitMinutes?: Record<string, number>;
  modes?: TravelMode[];
  taxiPickupMinutes?: number;
  visitDate?: string;
  openingHoursByStop?: Record<string, string[]>;
  periodByStop?: Record<string, PlanningDayPeriod>;
  travelTotalMinutes?: number;
  mealReserveMinutes?: number;
  bufferReserveMinutes?: number;
  personalMinutes?: number;
  routeReference?: PlanningRouteReference;
  timing?: PlanningTiming;
  preferredReturnBy?: string;
  periodConstraintByStop?: Record<string, { strength: "soft" | "hard"; source?: string }>;
  sceneRoleByStop?: Record<string, "culinary_area" | "restaurant_meal" | "attraction">;
  includedMealMinutesByStop?: Record<string, number>;
  logisticsStopIds?: string[];
  localBlocks?: PlanningLocalBlock[];
}): Promise<{ day: TripDay; metrics: ScheduledDayMetrics; adjustments: string[]; routeReference?: PlanningRouteReference; transport: DailyTransport; freeWindows: PlanningFreeWindow[]; scheduledLocalBlocks: ScheduledPlanningLocalBlock[] }> {
  const stops = input.orderedStops.filter((stop) => stop.kind !== "buffer");
  const terminal = stops.at(-1);
  if (stops.length < 2 || stops.length > 15 ||
      !(stops[0].kind === "hotel" || airportEndpoint(stops[0])) ||
      !terminal || !(terminal.kind === "hotel" || airportEndpoint(terminal))) {
    throw new Error("INVALID_DAY_STOPS");
  }
  const terminalKind = airportEndpoint(terminal) ? "airport" as const : "hotel" as const;
  const terminalDuration = terminalKind === "airport" ? "到达机场" : "返回酒店";
  const start = minutes(input.startTime);
  const localBlocks = input.localBlocks || [];
  const dayNumber = Number(input.day.id.match(/\d+/)?.[0] || localBlocks[0]?.day || 1);
  validatePlanningLocalBlocks(localBlocks, dayNumber, stops);
  const deadline = minutes(input.returnBy);
  const preferredDeadline = input.preferredReturnBy ? Math.min(deadline, minutes(input.preferredReturnBy)) : deadline;
  if (deadline <= start || deadline - start > 18 * 60) throw new Error("INVALID_DAILY_WINDOW");
  const pickupEstimate = Number.isInteger(input.taxiPickupMinutes)
    ? Math.min(30, Math.max(0, input.taxiPickupMinutes!)) : 8;
  if (stops.length === 2 && stops[0].placeId === stops[1].placeId) {
    const travel = input.travelTotalMinutes ?? 0;
    const meal = input.localBlocks !== undefined ? 0 : input.mealReserveMinutes ?? 0;
    const buffer = input.localBlocks !== undefined ? 0 : input.bufferReserveMinutes ?? 0;
    const personal = input.localBlocks !== undefined ? 0 : input.personalMinutes ?? 0;
    let cursor = start;
    const scheduledLocalBlocks: ScheduledPlanningLocalBlock[] = [];
    const scheduled: TripStop[] = [];
    const append = (block: PlanningLocalBlock) => {
      const first = cursor; cursor += block.durationMinutes;
      scheduledLocalBlocks.push({ ...block, startTime: clock(first), endTime: clock(cursor) });
      scheduled.push(localBlockStop(block, first, cursor));
    };
    localBlocks.filter((block) => block.anchor?.nodeId === stops[0].id && block.anchor.placement === "before").forEach(append);
    scheduled.push({ ...stops[0], time: clock(cursor), endTime: clock(cursor), duration: "出发" });
    localBlocks.filter((block) => block.anchor?.nodeId === stops[0].id && block.anchor.placement === "after").forEach(append);
    localBlocks.filter((block) => !block.anchor || block.anchor.nodeId === terminal.id && block.anchor.placement === "before").forEach(append);
    cursor += travel + meal + buffer + personal;
    const arrival = cursor;
    scheduled.push({ ...stops[1], time: clock(cursor), endTime: clock(cursor), duration: terminalDuration });
    localBlocks.filter((block) => block.anchor?.nodeId === terminal.id && block.anchor.placement === "after").forEach(append);
    const finish = cursor;
    const localMeal = localBlocks.filter((block) => block.kind === "meal").reduce((sum, block) => sum + block.durationMinutes, 0);
    const localRest = localBlocks.filter((block) => block.kind === "rest").reduce((sum, block) => sum + block.durationMinutes, 0);
    const localCustom = localBlocks.filter((block) => block.kind === "custom").reduce((sum, block) => sum + block.durationMinutes, 0);
    const metrics = {
      visitMinutes: 0, foodMinutes: localMeal, mealReserveMinutes: meal, bufferMinutes: buffer + localRest, openingWaitMinutes: 0,
      logisticsMinutes: 0,
      travelMinutes: travel, pickupMinutes: 0, personalMinutes: personal + localCustom, localBlockMinutes: localMeal + localRest + localCustom, startTime: input.startTime,
      referenceTravelMinutes: 0, travelSource: input.travelTotalMinutes === undefined ? "google" as const : "user" as const,
      freeMinutes: Math.max(0, preferredDeadline - finish), overtimeMinutes: Math.max(0, finish - deadline),
      actualReturnTime: clock(arrival), requestedReturnTime: input.returnBy, terminalKind,
      requestedMealReserveMinutes: meal, periodFreeMinutes: 0, preferredReturnTime: input.preferredReturnBy || input.returnBy, softOverrunMinutes: Math.max(0, finish - preferredDeadline),
    } satisfies ScheduledDayMetrics;
    return {
      day: { ...input.day, returnBy: input.returnBy, terminalKind, stops: scheduled, legs: [], summary: `当天未安排地点 · 尚未分配 ${durationLabel(metrics.freeMinutes)}` },
      metrics,
      adjustments: [],
      scheduledLocalBlocks,
      freeWindows: planningFreeWindows({ gaps: [], allocatedReserveMinutes: 0, preferredDeadline, finishedAt: finish, terminalId: terminal.id }),
      transport: { status: "complete", totalMinutes: travel, hotelMinutes: travel, airportMinutes: 0, includesHotelReturn: true, source: input.travelTotalMinutes === undefined ? "google" : "user", noOuting: travel === 0 },
    };
  }
  const requests = stops.slice(0, -1).map((from, index) => ({
    from,
    to: stops[index + 1],
    mode: input.modes?.[index] || "taxi" as TravelMode,
  }));
  const fingerprint = JSON.stringify(requests.map((item) => [coordinate(item.from), coordinate(item.to), item.mode]));
  const cached = input.routeReference?.fingerprint === fingerprint && input.routeReference.routes.length === requests.length ? input.routeReference : null;
  const validCached = cached && cached.routes.every((route) => Number.isFinite(route.durationMinutes) && route.durationMinutes >= 0) ? cached : null;
  input.timing?.annotate({ cacheHit: Boolean(validCached) });
  const routes = validCached?.routes || await mapLimit(requests, 3, (request) => {
    const lookup = () => computeSingaporeRoute({ origin: coordinate(request.from), destination: coordinate(request.to), mode: googleMode(request.mode) });
    return input.timing ? input.timing.measureAsync("google_lookup", lookup) : lookup();
  });
  if (routes.length !== requests.length || routes.some((route) => !Number.isFinite(route.durationMinutes) || route.durationMinutes < 0)) throw new Error("INCOMPLETE_ROUTE_EVIDENCE");
  const routeReference = validCached || { fingerprint, routes, queriedAt: new Date().toISOString() };
  const referenceMinutes = routes.map((route, index) => route.durationMinutes + (requests[index].mode === "taxi" ? pickupEstimate : 0));
  const travelMinutesByLeg = input.travelTotalMinutes === undefined ? referenceMinutes : distributeTravelMinutes(input.travelTotalMinutes, referenceMinutes);
  const scheduled: TripStop[] = [];
  const scheduledLocalBlocks: ScheduledPlanningLocalBlock[] = [];
  const legs: RouteLeg[] = [];
  let cursor = start;
  let localMealMinutes = 0;
  let localRestMinutes = 0;
  let localCustomMinutes = 0;
  const appendBlock = (block: PlanningLocalBlock) => {
    const first = cursor; cursor += block.durationMinutes;
    scheduledLocalBlocks.push({ ...block, startTime: clock(first), endTime: clock(cursor) });
    scheduled.push(localBlockStop(block, first, cursor));
    if (block.kind === "meal") localMealMinutes += block.durationMinutes;
    else if (block.kind === "rest") localRestMinutes += block.durationMinutes;
    else localCustomMinutes += block.durationMinutes;
  };
  const at = (nodeId: string, placement: "before" | "after") => localBlocks.filter((block) => block.anchor?.nodeId === nodeId && block.anchor.placement === placement).forEach(appendBlock);
  at(stops[0].id, "before");
  scheduled.push({ ...stops[0], time: clock(cursor), endTime: clock(cursor), duration: "出发" });
  at(stops[0].id, "after");
  let visitMinutes = 0;
  let foodMinutes = 0;
  let logisticsMinutes = 0;
  let googleTravelMinutes = 0;
  let pickupMinutes = 0;
  let openingWaitMinutes = 0;
  let periodFreeMinutes = 0;
  let periodFreeWithinBudgetMinutes = 0;
  let allocatedReserveInGapMinutes = 0;
  const periodGapWindows: GapWindow[] = [];
  const logisticsStops = new Set(input.logisticsStopIds || []);
  const adjustments: string[] = [];
  const roleOf = (stop: TripStop) => input.sceneRoleByStop?.[stop.id] || stop.sceneRole || (stop.kind === "food" ? "restaurant_meal" : "attraction");
  const includedMeal = (stop: TripStop) => roleOf(stop) === "culinary_area" ? Math.min(durationForStop(stop, input.requestedVisitMinutes?.[stop.id]), Math.max(0, input.includedMealMinutesByStop?.[stop.id] ?? stop.includedMealMinutes ?? 0)) : 0;
  const includedCulinaryMeals = stops.slice(1, -1).reduce((sum, stop) => sum + includedMeal(stop), 0);
  const requestedMealReserveMinutes = input.localBlocks !== undefined ? 0 : input.mealReserveMinutes ?? 0;
  const mealReserveMinutes = Math.max(0, requestedMealReserveMinutes - includedCulinaryMeals);
  const bufferMinutes = input.localBlocks !== undefined ? 0 : input.bufferReserveMinutes ?? 0;
  const personalMinutes = input.localBlocks !== undefined ? 0 : input.personalMinutes ?? 0;
  if (input.travelTotalMinutes !== undefined) adjustments.push(`当天交通总时长由你设为 ${input.travelTotalMinutes} 分钟，按原路线参考比例分配；Google 原参考合计 ${referenceMinutes.reduce((a, b) => a + b, 0)} 分钟。`);
  routes.forEach((route: SingaporeRoute, index) => {
    const request = requests[index];
    const pickup = input.travelTotalMinutes === undefined && request.mode === "taxi" ? pickupEstimate : 0;
    if (index === routes.length - 1) {
      localBlocks.filter((block) => !block.anchor).forEach(appendBlock);
      const reserves = mealReserveMinutes + bufferMinutes + personalMinutes;
      allocatedReserveInGapMinutes = Math.min(periodFreeMinutes, reserves);
      cursor += reserves - allocatedReserveInGapMinutes;
    }
    cursor += travelMinutesByLeg[index];
    googleTravelMinutes += route.durationMinutes;
    pickupMinutes += pickup;
    legs.push({
      from: request.from.id,
      to: request.to.id,
      mode: request.mode,
      minutes: travelMinutesByLeg[index],
      pickupMinutes: pickup || undefined,
      timeSource: input.travelTotalMinutes === undefined ? "google" : "user",
      referenceMinutes: referenceMinutes[index],
      distance: route.distanceText,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      encodedPolyline: route.encodedPolyline,
      verified: true,
      provider: "google",
    });
    at(request.to.id, "before");
    if (index === routes.length - 1) {
      scheduled.push({ ...request.to, time: clock(cursor), endTime: clock(cursor), duration: terminalDuration });
      at(request.to.id, "after");
      return;
    }
    const stay = durationForStop(request.to, input.requestedVisitMinutes?.[request.to.id], logisticsStops.has(request.to.id));
    const physicalArrival = cursor;
    if (stay > 0 && input.visitDate && (request.to.kind === "sight" || request.to.kind === "food" || logisticsStops.has(request.to.id))) {
      const slot = planRegularVisit({
        weekdayDescriptions: input.openingHoursByStop?.[request.to.id] ?? request.to.openingHours ?? [],
        visitDate: input.visitDate,
        arrivalMinute: physicalArrival,
        durationMinutes: stay,
        preferredPeriod: input.periodByStop?.[request.to.id] ?? "flexible",
        // A user-selected AM/PM bucket needs explicit confirmation before
        // crossing groups, even when it is a preference rather than a fixed
        // restriction. Model-only suggestions may still adapt automatically.
        periodStrength: input.periodConstraintByStop?.[request.to.id]?.source === "user"
          ? "hard" : input.periodConstraintByStop?.[request.to.id]?.strength || "hard",
      });
      if (slot.status === "closed") throw new RegularOpeningConflictError(request.to.name, slot.openingHours, slot.reason, {
        stopId: request.to.id, placeId: request.to.placeId, failure: slot.failure,
        routeMinutes: travelMinutesByLeg.slice(0, index + 1).reduce((sum, value) => sum + value, 0),
        hotelMinutes: logisticsMinutes, earlierVisitMinutes: visitMinutes + foodMinutes,
        localBlockMinutes: localMealMinutes + localRestMinutes + localCustomMinutes,
        periodStrength: input.periodConstraintByStop?.[request.to.id]?.strength || "hard", periodSource: input.periodConstraintByStop?.[request.to.id]?.source,
      });
      cursor = slot.startMinute;
      openingWaitMinutes += slot.openingWaitMinutes ?? slot.waitMinutes;
      periodFreeMinutes += slot.periodFreeMinutes || 0;
      periodFreeWithinBudgetMinutes += Math.max(0, Math.min(preferredDeadline, slot.startMinute) - Math.min(preferredDeadline, physicalArrival + (slot.openingWaitMinutes ?? slot.waitMinutes)));
      if ((slot.periodFreeMinutes || 0) > 0) periodGapWindows.push({ start: physicalArrival + (slot.openingWaitMinutes ?? slot.waitMinutes), end: slot.startMinute, anchorId: request.to.id });
      if ((slot.openingWaitMinutes ?? slot.waitMinutes) > 0) adjustments.push(`${request.to.name}：场馆开放前需等约 ${durationLabel(slot.openingWaitMinutes ?? slot.waitMinutes)}。`);
      if ((slot.periodFreeMinutes || 0) > 0) adjustments.push(`${request.to.name}：按明确时段要求保留约 ${durationLabel(slot.periodFreeMinutes || 0)}，优先容纳用餐和休息，剩余作为自由时间。`);
      if (input.periodConstraintByStop?.[request.to.id]?.strength === "soft" && ((input.periodByStop?.[request.to.id] === "morning" && slot.startMinute >= 720) || (input.periodByStop?.[request.to.id] === "afternoon" && slot.startMinute < 720))) adjustments.push(`${request.to.name}：上午／下午为建议，已按可用开放窗口估算；可自行调整顺序。`);
      if (slot.status === "unknown" && slot.reason) adjustments.push(`${request.to.name}：${slot.reason}。`);
    }
    const arrival = cursor;
    cursor += stay;
    if (request.to.kind === "hotel" || logisticsStops.has(request.to.id)) logisticsMinutes += stay;
    else if (roleOf(request.to) === "restaurant_meal") foodMinutes += stay;
    else { const included = includedMeal(request.to); foodMinutes += included; visitMinutes += stay - included; }
    scheduled.push({ ...request.to, time: clock(arrival), endTime: clock(cursor), duration: durationLabel(stay) });
    at(request.to.id, "after");
  });
  const unallocatedPeriodFree = Math.max(0, periodFreeWithinBudgetMinutes - Math.min(periodFreeWithinBudgetMinutes, allocatedReserveInGapMinutes));
  const freeMinutes = Math.min(Math.max(0, preferredDeadline - start), Math.max(0, preferredDeadline - cursor) + unallocatedPeriodFree);
  const overtimeMinutes = Math.max(0, cursor - deadline);
  const distanceMeters = routes.reduce((sum, route) => sum + route.distanceMeters, 0);
  const metrics = {
    visitMinutes,
    foodMinutes: foodMinutes + localMealMinutes,
    logisticsMinutes,
    mealReserveMinutes,
    bufferMinutes: bufferMinutes + localRestMinutes,
    openingWaitMinutes,
    travelMinutes: input.travelTotalMinutes ?? googleTravelMinutes + pickupMinutes,
    pickupMinutes,
    personalMinutes: personalMinutes + localCustomMinutes, localBlockMinutes: localMealMinutes + localRestMinutes + localCustomMinutes, startTime: input.startTime,
    referenceTravelMinutes: referenceMinutes.reduce((a, b) => a + b, 0),
    travelSource: input.travelTotalMinutes === undefined ? "google" : "user",
    periodFreeMinutes: unallocatedPeriodFree, requestedMealReserveMinutes, preferredReturnTime: input.preferredReturnBy || input.returnBy, softOverrunMinutes: Math.max(0, cursor - preferredDeadline),
    freeMinutes,
    overtimeMinutes,
    actualReturnTime: scheduled.find((stop) => stop.id === terminal.id)?.time || clock(cursor),
    requestedReturnTime: input.returnBy,
    terminalKind,
  } satisfies ScheduledDayMetrics;
  return {
    day: {
      ...input.day,
      returnBy: input.returnBy,
      terminalKind,
      stops: scheduled,
      legs,
      summary: `${scheduled.filter((stop) => stop.kind === "sight" || stop.kind === "food").length} 个地点 · 游玩 ${durationLabel(visitMinutes)}${metrics.foodMinutes + mealReserveMinutes ? ` · 吃饭 ${durationLabel(metrics.foodMinutes + mealReserveMinutes)}` : ""}${metrics.bufferMinutes ? ` · 休息 ${durationLabel(metrics.bufferMinutes)}` : ""}${metrics.personalMinutes ? ` · 自定义 ${durationLabel(metrics.personalMinutes)}` : ""}${logisticsMinutes ? ` · 已安排操作 ${durationLabel(logisticsMinutes)}` : ""}${openingWaitMinutes ? ` · 等待开放 ${durationLabel(openingWaitMinutes)}` : ""} · 交通 ${durationLabel(metrics.travelMinutes)} · ${(distanceMeters / 1000).toFixed(1)} km · 尚未分配 ${durationLabel(freeMinutes)}${overtimeMinutes ? ` · 超出 ${durationLabel(overtimeMinutes)}` : ""}`,
    },
    metrics,
    adjustments,
    scheduledLocalBlocks,
    routeReference,
    freeWindows: planningFreeWindows({ gaps: periodGapWindows, allocatedReserveMinutes: allocatedReserveInGapMinutes, preferredDeadline, finishedAt: cursor, terminalId: terminal.id }),
    transport: {
      status: "complete", totalMinutes: travelMinutesByLeg.reduce((sum, value) => sum + value, 0),
      hotelMinutes: travelMinutesByLeg.reduce((sum, value, index) => sum + (airportEndpoint(requests[index].from) || airportEndpoint(requests[index].to) ? 0 : value), 0),
      airportMinutes: travelMinutesByLeg.reduce((sum, value, index) => sum + (airportEndpoint(requests[index].from) || airportEndpoint(requests[index].to) ? value : 0), 0),
      includesHotelReturn: terminal.kind === "hotel" && stops.some((stop) => stop.kind === "hotel"), source: input.travelTotalMinutes === undefined ? "google" : "user",
    },
  };
}
