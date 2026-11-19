import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import { getSingaporePlaceDetails, GoogleMapsServiceError, searchSingaporePlaces, type SingaporePlace } from "@/lib/travel/google-maps";
import { type FlightOffer, type FlightSearchResult } from "@/lib/travel/planning-flights";
import { createPlanningFlightJob, pollPlanningFlightJob } from "@/lib/travel/planning-flight-jobs";
import { commitPlanningDraft, readPlanningDraft, readPlanningHandoff, type PlanningDraftV1, type PlanningHandoffV1 } from "@/lib/travel/planning-state";
import { readTravelVisitToken } from "@/lib/travel/visit-session";
import { normalizeFlightLocation } from "@/lib/travel/flight-location";
import { withPlanningTiming, type PlanningTiming } from "@/lib/travel/planning-timing";
import { deriveFlightJourney, normalizeFlightTimeZone, validateFlightJourney, type FlightJourney } from "@/lib/travel/planning-flight-journey";
import { refreshFlightReviews } from "@/lib/travel/planning-review";
import { scheduleFingerprint } from "@/lib/travel/planning-schedule-policy";

export const dynamic = "force-dynamic";

const Base = z.object({
  action: z.enum(["search", "select", "manual", "skip", "reopen"]),
  expectedVersion: z.number().int().min(0),
  turnId: z.string().min(8).max(100),
}).passthrough();
const LocalDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/);
const AirportQuery = z.string().trim().min(3).max(120);

class AirportVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AirportVerificationError";
  }
}

function airportIdentity(place: SingaporePlace) {
  return {
    placeId: place.placeId,
    name: place.name,
    address: place.address,
    location: place.location,
    googleMapsUri: place.googleMapsUri,
  };
}

function airportSignal(value: string): "changi" | "seletar" | null {
  if (/(?:\bSIN\b|changi|樟宜)/i.test(value)) return "changi";
  if (/(?:\bXSP\b|seletar|实里达|實里達)/i.test(value)) return "seletar";
  return null;
}

function isAirport(place: SingaporePlace): boolean {
  return place.primaryType === "airport" || place.types.includes("airport");
}

async function verifiedSingaporeAirport(query: string, label: string) {
  const raw = query.trim();
  const signal = airportSignal(raw);
  if (!signal && /^(?:singapore|新加坡|sg|singapore airport|新加坡机场)$/i.test(raw)) {
    throw new AirportVerificationError(`${label}只写了城市，无法确认具体机场。请填写机场名称（例如新加坡樟宜机场）。`);
  }
  const matches = await searchSingaporePlaces({
    query: signal === "changi" ? "Singapore Changi Airport" : signal === "seletar" ? "Seletar Airport Singapore" : raw,
    includedType: "airport",
    strictTypeFiltering: true,
    maxResults: 5,
    languageCode: "zh-CN",
  });
  const matching = matches.find((place) => {
    if (!isAirport(place)) return false;
    if (signal) return airportSignal(`${place.name} ${place.address}`) === signal;
    const key = raw.toLowerCase().replace(/singapore|新加坡|airport|机场|機場|[^a-z\u3400-\u9fff]/g, "");
    const name = `${place.name} ${place.address}`.toLowerCase().replace(/[^a-z\u3400-\u9fff]/g, "");
    return key.length >= 3 && name.includes(key);
  });
  if (!matching) {
    throw new AirportVerificationError(`${label}“${raw}”未能通过 Google Places 核验为新加坡机场。请填写准确的机场名称。`);
  }
  const detail = await getSingaporePlaceDetails(matching.placeId);
  if (!isAirport(detail) || (signal && airportSignal(`${detail.name} ${detail.address}`) !== signal)) {
    throw new AirportVerificationError(`${label}“${raw}”不是已核验的新加坡机场，请重新填写。`);
  }
  return airportIdentity(detail);
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function offerList(draft: PlanningDraftV1, direction: "outbound" | "inbound"): FlightOffer[] {
  const quoted = draft.flightQuotes as Partial<FlightSearchResult> | undefined;
  return Array.isArray(quoted?.[direction]) ? quoted[direction] as FlightOffer[] : [];
}

function selectedFlightImpact(
  arrivalAt: string | null, departureAt: string | null,
  firstDate: string, lastDate: string, dailyStart: string, returnBy: string,
) {
  const affected: string[] = [];
  if (arrivalAt?.slice(0, 10) === firstDate && arrivalAt.slice(11) >= dailyStart) affected.push("Day 1 抵达后还需预留约 2 小时入境、行李与交通；请复核当天地点。");
  if (departureAt?.slice(0, 10) === lastDate && departureAt.slice(11) <= returnBy) affected.push("最后一天需提前至少 3 小时结束游览并前往机场；请复核当天地点。");
  return affected;
}

function nextDraft(draft: PlanningDraftV1, changes: Partial<PlanningDraftV1>): Omit<PlanningDraftV1, "version" | "updatedAt"> {
  const { version: _version, updatedAt: _updatedAt, ...base } = draft;
  void _version; void _updatedAt;
  return { ...base, ...changes };
}

function addDays(date: string, count: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

/** Keep selected hotels only when their nights still match the new flight boundary. */
function compatibleStaySegments(draft: PlanningDraftV1, firstDate: string, checkoutDate: string) {
  const nights = Math.round((Date.parse(`${checkoutDate}T00:00:00Z`) - Date.parse(`${firstDate}T00:00:00Z`)) / 86_400_000);
  const segments = draft.staySegments || [];
  if (nights === 0 || !segments.length) return [];
  const ordered = [...segments].sort((a, b) => Number(a.startDay) - Number(b.startDay));
  const compatible = ordered[0]?.startDay === 1 && ordered.every((segment, index) => {
    const startDay = Number(segment.startDay);
    const nextStartDay = Number(ordered[index + 1]?.startDay);
    return Number.isInteger(startDay) && startDay >= 1 && startDay <= nights &&
      segment.checkInDate === addDays(firstDate, startDay - 1) &&
      segment.checkOutDate === (ordered[index + 1] ? addDays(firstDate, nextStartDay - 1) : checkoutDate);
  });
  return compatible ? ordered : [];
}

async function savedFlightChanges(handoff: PlanningHandoffV1, draft: PlanningDraftV1, selection: Record<string, unknown>, checkoutDate: string): Promise<Partial<PlanningDraftV1>> {
  const previous = draft.flightSelection;
  const oldJourney = deriveFlightJourney(previous);
  const journey = deriveFlightJourney(selection);
  const sameStayBoundary = Boolean(previous && previous.mode !== "none" && oldJourney.inbound.departure.localDateTime?.slice(0, 10) === checkoutDate);
  const allDays = !previous || previous.mode !== selection.mode || !sameStayBoundary;
  const affected = new Set<number>();
  if (allDays) for (let day = 1; day <= handoff.dates.days; day++) affected.add(day);
  else {
    if (await scheduleFingerprint(oldJourney.outbound) !== await scheduleFingerprint(journey.outbound)) affected.add(1);
    if (await scheduleFingerprint(oldJourney.inbound) !== await scheduleFingerprint(journey.inbound)) affected.add(handoff.dates.days);
  }
  const staySegments = compatibleStaySegments(draft, handoff.dates.start, checkoutDate);
  const sameSegments = await scheduleFingerprint(staySegments) === await scheduleFingerprint(draft.staySegments || []);
  const stayConfirmed = Boolean(draft.stayConfirmed && sameStayBoundary && sameSegments);
  const reviews = await refreshFlightReviews(handoff, draft, selection);
  return {
    flightSelection: selection, stage: stayConfirmed ? "route" : "stays", flightSearchJob: undefined,
    stayAdvice: sameStayBoundary ? draft.stayAdvice : undefined, staySegments, stayConfirmed,
    dayEstimates: (draft.dayEstimates || []).filter((item) => !affected.has(Number(item.day))),
    scheduleConflicts: (draft.scheduleConflicts || []).filter((item) => !affected.has(Number(item.day))),
    freeTimeDecisions: (draft.freeTimeDecisions || []).filter((item) => !affected.has(Number(item.day))),
    lastScheduleOperation: undefined, ...reviews,
    reviewRequired: [...new Set([...reviews.reviewRequired, ...(affected.size ? ["路线"] : [])])],
  };
}

async function getFlightResponse(request: NextRequest, timing: PlanningTiming) {
  const token = readTravelVisitToken(request);
  if (!token) return json({ error: { code: "VISIT_REQUIRED", message: "请刷新页面后重试。" } }, 400);
  if (request.nextUrl.searchParams.get("poll") === "1") {
    const blocked = guardSingaporeApi(request, { bucket: "planning-flight-poll", limit: 90, windowMs: 60_000 });
    if (blocked) return blocked;
    try {
      const result = await pollPlanningFlightJob(token, request.nextUrl.searchParams.get("resume") === "1", timing);
      if (!result) return json({ error: { code: "FLIGHT_JOB_NOT_FOUND", message: "暂时找不到本次查询，请重新读取规划。" } }, 404);
      return json(result, result.job && ["queued", "running"].includes(String(result.job.status)) ? 202 : 200);
    } catch {
      return json({ error: { code: "FLIGHT_JOB_READ_UNAVAILABLE", message: "暂时无法读取同次查询，已保存的任务仍可继续读取。" } }, 503);
    }
  }
  const [draft, handoff] = await timing.measureAsync("context_read", () => Promise.all([readPlanningDraft(token), readPlanningHandoff(token)]));
  if (!draft || !handoff) return json({ error: { code: "PLANNING_NOT_STARTED", message: "请先确认旅行条件。" } }, 404);
  return json({ draft, quotes: draft.flightQuotes || null, selection: draft.flightSelection || null, originCity: handoff.handoff.originCity });
}

async function postFlightResponse(request: NextRequest, timing: PlanningTiming) {
  const blocked = guardSingaporeApi(request, { bucket: "planning-flights", limit: 6, windowMs: 5 * 60_000 });
  if (blocked) return blocked;
  const token = readTravelVisitToken(request);
  if (!token) return json({ error: { code: "VISIT_REQUIRED", message: "请刷新页面后重试。" } }, 400);
  try {
    const parsed = Base.safeParse(await request.json());
    if (!parsed.success) return json({ error: { code: "INVALID_FLIGHT_REQUEST", message: "航班请求格式不正确。" } }, 400);
    const body = parsed.data as z.infer<typeof Base> & Record<string, unknown>;
    timing.setAction(body.action);
    timing.annotate({ version: body.expectedVersion });
    const [handoff, draft] = await timing.measureAsync("context_read", () => Promise.all([readPlanningHandoff(token), readPlanningDraft(token)]));
    if (!handoff || !draft) return json({ error: { code: "PLANNING_NOT_STARTED", message: "请先确认旅行条件。" } }, 409);
    if (!draft.boardConfirmed || draft.assignments.length !== handoff.handoff.dates.days) {
      return json({ error: { code: "DAY_BOARD_NOT_CONFIRMED", message: "请先将地点分配到各天并确认。" } }, 409);
    }
    if (body.action !== "search" && draft.version !== body.expectedVersion) return json({ error: { code: "PLANNING_VERSION_CONFLICT", message: "规划已更新，请查看最新结果后重试。" }, draft }, 409);
    if (body.action === "skip") return json({ error: { code: "FLIGHT_INFORMATION_REQUIRED", message: "请填写已订往返航班的四个时刻，或查询并确认实际候选后继续。" } }, 422);

    let changes: Partial<PlanningDraftV1>;
    let affectedDays: string[] = [];
    if (body.action === "reopen") {
      changes = {
        stage: "flights", flightSearchJob: undefined,
        reviewRequired: [...new Set([...(draft.reviewRequired || []),
          ...(draft.flightSelection ? ["航班"] : []),
        ])],
      };
    } else if (body.action === "search") {
      const originCity = normalizeFlightLocation(typeof body.originCity === "string" ? body.originCity : handoff.handoff.originCity || "").input;
      if (!originCity) return json({ error: { code: "ORIGIN_CITY_REQUIRED", message: "请先说明出发城市或机场，再查询往返航班。" } }, 422);
      if (/[\u0000-\u001f\u007f]/.test(originCity)) return json({ error: { code: "ORIGIN_CITY_INVALID", message: "请用完整的城市或机场名称查询。" } }, 422);
      const preference = z.object({
        direction: z.enum(["outbound", "inbound", "both"]).optional(),
        arrivalBefore: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
        departureAfter: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
        outboundDepartureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        inboundDepartureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        includePreviousEvening: z.boolean().optional(),
        includeNextDayReturn: z.boolean().optional(),
      }).safeParse(body);
      if (!preference.success) return json({ error: { code: "INVALID_FLIGHT_TIME_PREFERENCE", message: "请填写有效的抵达与离境时段偏好。" } }, 422);
      const result = await createPlanningFlightJob(token, draft, {
        originCity, startDate: handoff.handoff.dates.start, endDate: handoff.handoff.dates.end,
        direction: preference.data.direction,
        travelers: handoff.handoff.travelers, preferences: preference.data,
        outboundDepartureDate: preference.data.outboundDepartureDate, inboundDepartureDate: preference.data.inboundDepartureDate,
        includePreviousEvening: preference.data.includePreviousEvening, includeNextDayReturn: preference.data.includeNextDayReturn,
      }, body.expectedVersion, body.turnId, timing);
      return json({ ...result, quotes: result.draft.flightQuotes || null }, 202);
    } else if (body.action === "select") {
      if (draft.flightSearchJob && ["queued", "running", "timed_out"].includes(String(draft.flightSearchJob.status))) {
        return json({ error: { code: "FLIGHT_QUERY_NOT_FINISHED", message: "本次查询尚未完成，请继续读取结果后再确认航班。" } }, 422);
      }
      const outbound = offerList(draft, "outbound").find((offer) => offer.id === body.outboundId);
      const inbound = offerList(draft, "inbound").find((offer) => offer.id === body.inboundId);
      if (!outbound || !inbound) return json({ error: { code: "FLIGHT_QUOTE_NOT_FOUND", message: "请选择本次查询中实际返回的去程和返程航班。" } }, 422);
      const outboundTimeZone = normalizeFlightTimeZone(body.outboundTimeZone), inboundTimeZone = normalizeFlightTimeZone(body.inboundTimeZone);
      if (!outboundTimeZone || !inboundTimeZone || body.timeZonesConfirmed !== true) return json({ error: { code: "FLIGHT_TIME_ZONES_REQUIRED", message: "请确认去程出发机场和返程到达机场的当地 IANA 时区。" } }, 422);
      const journey = deriveFlightJourney({ mode: "quoted", outbound, inbound });
      journey.outbound.departure.timeZone = outboundTimeZone;
      journey.outbound.departure.timeZoneSource = "user_confirmed";
      journey.inbound.arrival.timeZone = inboundTimeZone;
      journey.inbound.arrival.timeZoneSource = "user_confirmed";
      const validation = validateFlightJourney(journey);
      if (!validation.valid) return json({ error: { code: "INVALID_FLIGHT_JOURNEY", message: validation.message } }, 422);
      const departureOffset = Math.round((Date.parse(`${inbound.departureLocal.slice(0, 10)}T00:00:00Z`) - Date.parse(`${handoff.handoff.dates.end}T00:00:00Z`)) / 86_400_000);
      if (outbound.arrivalLocal.slice(0, 10) !== handoff.handoff.dates.start || departureOffset < 0 || departureOffset > 1) {
        return json({ error: { code: "FLIGHT_DATES_CONFLICT", message: "去程须在旅行首日抵达新加坡；返程须在旅行末日或次日离境。请换航班或调整旅行日期。" } }, 422);
      }
      const [arrivalAirport, departureAirport] = await timing.measureAsync("google_lookup", () => Promise.all([
        verifiedSingaporeAirport(outbound.destination, "去程抵达机场"),
        verifiedSingaporeAirport(inbound.origin, "返程离境机场"),
      ]));
      journey.outbound.arrival.airport = { ...arrivalAirport, source: "google_places" };
      journey.outbound.arrival.timeZoneSource = "airport_location";
      journey.inbound.departure.airport = { ...departureAirport, source: "google_places" };
      journey.inbound.departure.timeZoneSource = "airport_location";
      affectedDays = selectedFlightImpact(outbound.arrivalLocal, inbound.departureLocal, handoff.handoff.dates.start, handoff.handoff.dates.end, handoff.handoff.dailyWindow.start, handoff.handoff.dailyWindow.latestReturn);
      const selection = {
        mode: "quoted", outbound, inbound, journey, arrivalAirport, departureAirport,
        arrivalAirportPlaceId: arrivalAirport.placeId, departureAirportPlaceId: departureAirport.placeId,
        arrivalAirportName: arrivalAirport.name, departureAirportName: departureAirport.name,
        affectedDays, selectedAt: new Date().toISOString(),
      };
      changes = await savedFlightChanges(handoff.handoff, draft, selection, inbound.departureLocal.slice(0, 10));
    } else if (body.action === "manual") {
      const values = z.object({
        outboundDepartureAt: LocalDateTime, arrivalAt: LocalDateTime, departureAt: LocalDateTime, inboundArrivalAt: LocalDateTime,
        outboundAirportQuery: AirportQuery, arrivalAirportQuery: AirportQuery, departureAirportQuery: AirportQuery, inboundAirportQuery: AirportQuery,
        outboundTimeZone: z.string().max(100), inboundTimeZone: z.string().max(100),
        airportsConfirmed: z.literal(true),
      }).safeParse(body);
      if (!values.success || values.data.departureAt <= values.data.arrivalAt) {
        return json({ error: { code: "INVALID_MANUAL_FLIGHT", message: "请补齐往返四个带日期的时刻、具体机场及当地时区，并确认机票信息。" } }, 422);
      }
      const manual = values.data;
      const journey: FlightJourney = {
        source: "user",
        outbound: { source: "user", departure: { localDateTime: manual.outboundDepartureAt, timeZone: normalizeFlightTimeZone(manual.outboundTimeZone), timeZoneSource: "user_confirmed", airport: { name: manual.outboundAirportQuery, source: "user" } },
          arrival: { localDateTime: manual.arrivalAt, timeZone: "Asia/Singapore", timeZoneSource: "airport_location", airport: { name: manual.arrivalAirportQuery, source: "user" } } },
        inbound: { source: "user", departure: { localDateTime: manual.departureAt, timeZone: "Asia/Singapore", timeZoneSource: "airport_location", airport: { name: manual.departureAirportQuery, source: "user" } },
          arrival: { localDateTime: manual.inboundArrivalAt, timeZone: normalizeFlightTimeZone(manual.inboundTimeZone), timeZoneSource: "user_confirmed", airport: { name: manual.inboundAirportQuery, source: "user" } } },
      };
      const validation = validateFlightJourney(journey);
      if (!validation.valid) return json({ error: { code: "INVALID_MANUAL_FLIGHT", message: validation.message } }, 422);
      const departureOffset = Math.round((Date.parse(`${values.data.departureAt.slice(0, 10)}T00:00:00Z`) - Date.parse(`${handoff.handoff.dates.end}T00:00:00Z`)) / 86_400_000);
      if (values.data.arrivalAt.slice(0, 10) !== handoff.handoff.dates.start || departureOffset < 0 || departureOffset > 1) {
        return json({ error: { code: "FLIGHT_DATES_CONFLICT", message: "抵达应在旅行首日，离境应在旅行末日或次日；请调整时刻或日期。" } }, 422);
      }
      const [arrivalAirport, departureAirport] = await timing.measureAsync("google_lookup", () => Promise.all([
        verifiedSingaporeAirport(values.data.arrivalAirportQuery, "抵达机场"),
        verifiedSingaporeAirport(values.data.departureAirportQuery, "离境机场"),
      ]));
      journey.outbound.arrival.airport = { ...arrivalAirport, source: "google_places" };
      journey.inbound.departure.airport = { ...departureAirport, source: "google_places" };
      affectedDays = selectedFlightImpact(values.data.arrivalAt, values.data.departureAt, handoff.handoff.dates.start, handoff.handoff.dates.end, handoff.handoff.dailyWindow.start, handoff.handoff.dailyWindow.latestReturn);
      const selection = {
        mode: "manual", arrivalAt: values.data.arrivalAt, departureAt: values.data.departureAt, journey,
        arrivalAirport, departureAirport,
        arrivalAirportPlaceId: arrivalAirport.placeId, departureAirportPlaceId: departureAirport.placeId,
        arrivalAirportName: arrivalAirport.name, departureAirportName: departureAirport.name,
        affectedDays, selectedAt: new Date().toISOString(),
      };
      changes = await savedFlightChanges(handoff.handoff, draft, selection, values.data.departureAt.slice(0, 10));
    } else {
      return json({ error: { code: "INVALID_FLIGHT_REQUEST", message: "航班请求格式不正确。" } }, 400);
    }
    const result = await timing.measureAsync("state_commit", () => commitPlanningDraft(token, { expectedVersion: draft.version, turnId: body.turnId, nextDraft: nextDraft(draft, changes) }));
    if (!result.committed) return json({ error: { code: "PLANNING_VERSION_CONFLICT", message: "规划已更新，请查看最新结果后重试。" }, draft: result.draft }, 409);
    return json({ draft: result.draft, quotes: result.draft.flightQuotes || null, selection: result.draft.flightSelection || null, affectedDays });
  } catch (error) {
    if (error instanceof Error && error.message === "FLIGHT_RETRY_CONTEXT_CHANGED") return json({ error: { code: "FLIGHT_RETRY_CONTEXT_CHANGED", message: "查询条件或旅行安排已有变化，无法与原来的单程结果合并。请按当前条件完整查询往返航班。" } }, 422);
    if (error instanceof Error && error.message === "FLIGHT_JOB_VERSION_CONFLICT") return json({ error: { code: "PLANNING_VERSION_CONFLICT", message: "规划已有更新，请重新读取后查询。" }, draft: await readPlanningDraft(token) }, 409);
    if (error instanceof AirportVerificationError) return json({ error: { code: "AIRPORT_NOT_VERIFIED", message: error.message } }, 422);
    if (error instanceof GoogleMapsServiceError) return json({ error: { code: "AIRPORT_LOOKUP_FAILED", message: `Google Places 暂时无法核验机场：${error.message}请稍后重试。` } }, error.status >= 500 ? error.status : 422);
    return json({ error: { code: "FLIGHT_SEARCH_FAILED", message: error instanceof Error && error.message === "FLIGHT_SEARCH_INPUT_INVALID" ? "出发城市或日期无效。" : "航班查询暂不可用；可稍后重试，或填写已订航班的四个时刻。" } }, 502);
  }
}

export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get("poll") === "1" ? request.nextUrl.searchParams.get("resume") === "1" ? "resume" : "poll" : "read";
  return withPlanningTiming("flights", action, (timing) => getFlightResponse(request, timing));
}

export async function POST(request: NextRequest) {
  return withPlanningTiming("flights", "request", (timing) => postFlightResponse(request, timing));
}
