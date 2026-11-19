import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import { getSingaporePlaceDetails, searchSingaporePlaces, type SingaporePlace } from "@/lib/travel/google-maps";
import { commitPlanningDraft, type PlanningDraftV1 } from "@/lib/travel/planning-state";
import { readPlanningSceneContext } from "@/lib/travel/planning-scenes";
import { createHotelQuoteJob, currentActiveHotelQuoteJob, pollHotelQuoteJob } from "@/lib/travel/planning-hotel-jobs";
import type { HotelQuoteJob } from "@/lib/travel/planning-hotel-jobs";
import { hotelBatchWaiting, hotelQuoteJobMatchesSegment } from "@/lib/travel/planning-hotel-batch";
import { hotelIdentityContextKey, verifiedHotelAnchor, type HotelVerifiedPlace } from "@/lib/travel/planning-hotel-snapshot";
import { suggestStayAdvice } from "@/lib/travel/planning-stays";
import { reconcileStaySegments } from "@/lib/travel/planning-stay-segments";
import { assessHotelBudget, hotelBudgetAcknowledgementKey } from "@/lib/travel/hotel-budget";
import { derivePlanningStayBoundary, PlanningScheduleError, type PlanningStayBoundary } from "@/lib/travel/planning-trip";
import { readTravelVisitToken } from "@/lib/travel/visit-session";
import { withPlanningTiming, type PlanningTiming } from "@/lib/travel/planning-timing";
import type { ConfirmedAccommodationAnchor, TravelCommerce } from "@/lib/travel/types";

export const dynamic = "force-dynamic";

const Action = z.object({
  action: z.enum(["advise", "segments", "searchHotels", "quoteHotels", "selectHotel", "confirm", "reopen"]),
  expectedVersion: z.number().int().min(0),
  turnId: z.string().min(8).max(100),
}).passthrough();
const SegmentInput = z.object({
  startDay: z.number().int().min(1).max(7),
  area: z.string().trim().min(2).max(80),
  budgetPerNight: z.object({ amount: z.number().positive().max(100_000), currency: z.enum(["SGD", "CNY"]) }).nullable().optional(),
});

type StaySegment = z.infer<typeof SegmentInput> & {
  id: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  hotelSearchId?: string;
  hotel?: ConfirmedAccommodationAnchor;
  hotelCandidates?: Array<{ placeId: string; name: string; address: string; rating: number | null; commerce: TravelCommerce | null;
    quoteStatus?: "not_requested" | "available" | "unavailable" | "failed"; verifiedPlace?: HotelVerifiedPlace }>;
  budgetReviewRequired?: boolean;
  budgetAcknowledgement?: string;
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function addDays(date: string, count: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

function lodging(place: SingaporePlace): boolean {
  return place.types.some((type) => /^(?:lodging|hotel|motel|hostel|resort_hotel|bed_and_breakfast)$/.test(type));
}

function asSegments(draft: PlanningDraftV1): StaySegment[] {
  return (draft.staySegments || []) as StaySegment[];
}

function nextDraft(draft: PlanningDraftV1, changes: Partial<PlanningDraftV1>) {
  const { version: _version, updatedAt: _updatedAt, ...base } = draft;
  void _version; void _updatedAt;
  return { ...base, ...changes };
}

function segmentDates(input: z.infer<typeof SegmentInput>[], boundary: PlanningStayBoundary): StaySegment[] {
  const sorted = [...input].sort((a, b) => a.startDay - b.startDay);
  if (boundary.nights === 0) {
    if (sorted.length) throw new Error("INVALID_STAY_SEGMENTS");
    return [];
  }
  if (!sorted.length || sorted[0].startDay !== 1 || sorted.length > 4
    || sorted.some((item, index) => item.startDay > boundary.lastHotelNightDay || index > 0 && item.startDay === sorted[index - 1].startDay)) {
    throw new Error("INVALID_STAY_SEGMENTS");
  }
  return sorted.map((item, index) => {
    const checkInDate = addDays(boundary.checkInDate, item.startDay - 1);
    const checkOutDate = sorted[index + 1]
      ? addDays(boundary.checkInDate, sorted[index + 1].startDay - 1)
      : boundary.checkOutDate;
    const nights = Math.round((Date.parse(`${checkOutDate}T00:00:00Z`) - Date.parse(`${checkInDate}T00:00:00Z`)) / 86_400_000);
    if (nights < 1) throw new Error("INVALID_STAY_SEGMENTS");
    return { ...item, id: `stay-day-${item.startDay}`, checkInDate, checkOutDate, nights };
  });
}

function segmentsMatchBoundary(segments: StaySegment[], boundary: PlanningStayBoundary): boolean {
  if (boundary.nights === 0) return segments.length === 0;
  if (!segments.length || segments[0].startDay !== 1 || segments.some((item) => item.startDay > boundary.lastHotelNightDay)) return false;
  return segments.every((item, index) => item.checkInDate === addDays(boundary.checkInDate, item.startDay - 1) &&
    item.checkOutDate === (segments[index + 1]?.checkInDate || boundary.checkOutDate));
}

function anchor(place: SingaporePlace): ConfirmedAccommodationAnchor {
  return {
    placeId: place.placeId, name: place.name, address: place.address,
    location: place.location, googleMapsUri: place.googleMapsUri,
    kind: "hotel", source: "google_places", userConfirmed: true,
  };
}

export async function GET(request: NextRequest) {
  return withPlanningTiming("stays", "read", (timing) => getStays(request, timing));
}

async function getStays(request: NextRequest, timing: PlanningTiming) {
  const blocked = guardSingaporeApi(request, { bucket: "planning-stays-read", limit: 90, windowMs: 60_000 });
  if (blocked) return blocked;
  const token = readTravelVisitToken(request);
  if (!token) return json({ error: { code: "VISIT_REQUIRED", message: "请刷新页面后重试。" } }, 400);
  try {
    const context = await timing.measureAsync("context_read", () => readPlanningSceneContext(token, request.signal, timing));
    const polling = request.nextUrl.searchParams.get("pollQuotes") === "1";
    timing.setAction(polling ? request.nextUrl.searchParams.get("resume") === "1" ? "resume" : "poll" : "read");
    timing.annotate({ version: context.draft.version });
    const polled = polling ? await pollHotelQuoteJob(token, request.nextUrl.searchParams.get("resume") === "1", context, timing) : null;
    const draft = polled?.draft || context.draft;
    let boundary: PlanningStayBoundary | null = null;
    try { if (draft.flightSelection) boundary = derivePlanningStayBoundary(context.handoff, draft); } catch { /* POST explains invalid flight dates. */ }
    return json({ draft, advice: draft.stayAdvice || null, segments: draft.staySegments || [], boundary });
  } catch { return json({ error: { code: "STAY_READ_FAILED", message: "暂时无法读取住宿阶段，已保存内容仍保留，请重试。" } }, 503); }
}

export async function POST(request: NextRequest) {
  return withPlanningTiming("stays", "request", (timing) => postStays(request, timing));
}

async function postStays(request: NextRequest, timing: PlanningTiming) {
  const blocked = guardSingaporeApi(request, { bucket: "planning-stays", limit: 24, windowMs: 5 * 60_000 });
  if (blocked) return blocked;
  const token = readTravelVisitToken(request);
  if (!token) return json({ error: { code: "VISIT_REQUIRED", message: "请刷新页面后重试。" } }, 400);
  try {
    const parsed = Action.safeParse(await request.json());
    if (!parsed.success) return json({ error: { code: "INVALID_STAY_REQUEST", message: "住宿请求格式不正确。" } }, 400);
    const body = parsed.data;
    timing.setAction(body.action);
    const { handoff, draft, handoffId } = await timing.measureAsync("context_read", () => readPlanningSceneContext(token, request.signal, timing));
    timing.annotate({ version: draft.version, segment: Number(body.startDay) });
    if (!draft.boardConfirmed || !draft.flightSelection) {
      return json({ error: { code: "FLIGHTS_NOT_DECIDED", message: "请先确认航班、填入已订时刻，或明确选择无需航班。" } }, 409);
    }
    const boundary = derivePlanningStayBoundary(handoff, draft);
    let segmentSave: ReturnType<typeof reconcileStaySegments<StaySegment>> | null = null;
    if (body.action === "segments") {
      const segmentInput = z.array(SegmentInput).max(4).safeParse(body.segments);
      if (!segmentInput.success) return json({ error: { code: "INVALID_STAY_SEGMENTS", message: "请填写每段至少 2 个字的住宿区域、有效人民币预算（CNY，也可留空），以及从 Day 1 起逐段递增的换住日期。" } }, 422);
      if (segmentInput.data.some((segment) => segment.budgetPerNight && segment.budgetPerNight.currency !== "CNY")) {
        return json({ error: { code: "CNY_BUDGET_REQUIRED", message: "当前仅使用人民币预算。原外币金额仍保留，请重新填写人民币预算，或明确取消该段预算后保存。" } }, 422);
      }
      segmentSave = reconcileStaySegments(asSegments(draft), segmentDates(segmentInput.data, boundary));
      if (segmentSave.unchanged) {
        return json({ draft, advice: draft.stayAdvice || null, segments: draft.staySegments || [], boundary,
          saveResult: { saved: true, unchanged: true, segments: asSegments(draft), changedFields: [],
            invalidatedHotelSegments: [], budgetReviewSegments: [],
            message: `住宿安排已保存：${asSegments(draft).length} 段 / ${boundary.nights} 晚，内容未变化；已选酒店与报价保留。` } });
      }
    }
    if (["searchHotels", "quoteHotels", "selectHotel", "confirm"].includes(body.action)) {
      const relevant = body.action === "confirm" ? asSegments(draft) : asSegments(draft).filter((segment) => segment.startDay === Number(body.startDay));
      if (relevant.some((segment) => segment.budgetPerNight && segment.budgetPerNight.currency !== "CNY")) {
        return json({ error: { code: "CNY_BUDGET_REQUIRED", message: "原外币预算已保留。请先重新填写人民币预算，或明确取消该段预算，并保存住宿安排后继续。" }, draft }, 422);
      }
    }
    if ((body.action === "searchHotels" || body.action === "quoteHotels" || body.action === "selectHotel") &&
        !segmentsMatchBoundary(asSegments(draft), boundary)) {
      return json({ error: { code: "STAY_DATES_STALE", message: "航班变化后住宿日期已不匹配。请重新保存住宿区域和夜段，再查询对应日期的价格。" }, draft }, 422);
    }
    if (body.action === "quoteHotels") {
      const input = z.object({ startDay: z.number().int().min(1).max(7), placeIds: z.array(z.string().min(8).max(255)).min(1).max(5).optional() }).safeParse(body);
      if (!input.success) return json({ error: { code: "HOTEL_QUOTE_INPUT_INVALID", message: "请从当前住宿段选择要查询价格的酒店。" } }, 422);
      const result = await createHotelQuoteJob(token, { handoff, draft }, { ...input.data, expectedVersion: body.expectedVersion, turnId: body.turnId }, timing);
      return json({ draft: result.draft, job: result.job, boundary }, 202);
    }
    if (body.action === "searchHotels") {
      const previousSearch = asSegments(draft).find((segment) => segment.startDay === Number(body.startDay) && segment.hotelSearchId === body.turnId);
      if (previousSearch) return json({ draft, boundary, replayed: true, job: draft.hotelQuoteJob || null }, draft.hotelQuoteJob?.status === "queued" || draft.hotelQuoteJob?.status === "running" ? 202 : 200);
    }
    if (draft.version !== body.expectedVersion) return json({ error: { code: "PLANNING_VERSION_CONFLICT", message: "规划已更新，请查看最新结果后重试。" }, draft }, 409);
    if (body.action === "searchHotels") {
      const activeJob = await currentActiveHotelQuoteJob(token, { handoff, draft }, timing);
      if (activeJob) return json({ error: { code: "HOTEL_QUOTE_ALREADY_RUNNING", message: activeJob.status === "timed_out"
        ? "本段报价仍可继续读取，请先恢复同一次报价；不能重新搜索覆盖尚未结束的查询。"
        : `Day ${activeJob.startDay} 起的酒店与报价仍在查询，请等待本批完成后再搜索其他住宿段。` }, draft, job: activeJob }, 409);
    }
    let changes: Partial<PlanningDraftV1>;
    if (body.action === "reopen") {
      changes = { stage: "stays", stayConfirmed: false, dayEstimates: [], scheduleConflicts: [], lastScheduleOperation: undefined, freeTimeDecisions: [],
        reviewRequired: [...new Set([...(draft.reviewRequired || []), "住宿", "路线"])] };
    } else if (body.action === "advise") {
      if (boundary.nights === 0) {
        changes = { stayAdvice: {
          status: "no_overnight", options: [], recommendationId: "same",
          basis: "抵达与离境在同一天，无需预订过夜酒店。",
          source: { areaHotels: "Google Places", roadTimes: "Google Routes", explanation: "calculation" },
        }, staySegments: [], stayConfirmed: false, stage: "stays" };
      } else {
        const advice = await timing.measureAsync("agent_wait", () => suggestStayAdvice({ handoff, draft, visitToken: token, lastHotelNightDay: boundary.lastHotelNightDay }));
        const options = advice.options.filter((option) => option.segments.every((segment) => segment.startDay <= boundary.lastHotelNightDay));
        const validAdvice = {
          ...advice,
          options,
          recommendationId: options.some((option) => option.id === advice.recommendationId)
            ? advice.recommendationId : "same",
          stayBoundary: boundary,
        };
        changes = { stayAdvice: validAdvice as unknown as Record<string, unknown>, stage: "stays" };
      }
    } else if (body.action === "segments") {
      changes = { staySegments: segmentSave!.segments as unknown as Array<Record<string, unknown>>, stayConfirmed: false, stage: "stays",
        ...(segmentSave!.timingChanged ? { dayEstimates: [], scheduleConflicts: [], lastScheduleOperation: undefined, freeTimeDecisions: [] } : {}),
        reviewRequired: [...new Set([...(draft.reviewRequired || []), ...(segmentSave!.timingChanged ? ["住宿", "路线"] : ["住宿预算"])])] };
    } else if (body.action === "searchHotels") {
      if (boundary.nights === 0) return json({ error: { code: "NO_OVERNIGHT_STAY", message: "当天抵离无需过夜酒店。" } }, 422);
      const startDay = Number(body.startDay);
      const segments = asSegments(draft);
      const segment = segments.find((item) => item.startDay === startDay);
      if (!segment) return json({ error: { code: "STAY_SEGMENT_NOT_FOUND", message: "请先设置该天起的住宿片区。" } }, 422);
      const found = await timing.measureAsync("google_lookup", () => searchSingaporePlaces({ query: `${segment.area} Singapore hotel`, maxResults: 8, includedType: "lodging" }));
      const hotels = found.filter(lodging).slice(0, 5);
      const contextKey = hotelIdentityContextKey(handoffId, segment);
      const verifiedAt = new Date().toISOString();
      const hotelCandidates = hotels.map((hotel) => ({
        placeId: hotel.placeId, name: hotel.name, address: hotel.address,
        rating: hotel.rating, commerce: null, quoteStatus: "not_requested",
        verifiedPlace: { ...anchor(hotel), userConfirmed: undefined, verifiedAt, contextKey },
      }));
      changes = { staySegments: segments.map((item) => item.id === segment.id ? { ...item, hotelCandidates, hotelSearchId: body.turnId } : item) as unknown as Array<Record<string, unknown>>, hotelQuoteJob: undefined, stage: "stays" };
      if (hotels.length) {
        // Candidate discovery and task reservation are one draft commit. A
        // refresh can resume this exact batch without another Google/quote run.
        const result = await createHotelQuoteJob(token, { handoff, draft: { ...draft, ...changes } },
          { startDay, expectedVersion: draft.version, turnId: body.turnId }, timing);
        return json({ draft: result.draft, job: result.job, boundary }, 202);
      }
    } else if (body.action === "selectHotel") {
      const startDay = Number(body.startDay);
      const placeId = typeof body.placeId === "string" ? body.placeId : "";
      const segments = asSegments(draft);
      const segment = segments.find((item) => item.startDay === startDay);
      if (!segment || !segment.hotelCandidates?.some((item) => item.placeId === placeId)) {
        return json({ error: { code: "HOTEL_NOT_IN_CANDIDATES", message: "请先搜索该住宿段，再选择已验证的酒店。" } }, 422);
      }
      const candidate = segment.hotelCandidates.find((item) => item.placeId === placeId)!;
      const budgetAssessment = assessHotelBudget(segment.budgetPerNight, candidate.commerce);
      if (budgetAssessment.status === "over_budget" && body.budgetAcknowledged !== true) {
        return json({ error: { code: "HOTEL_OVER_BUDGET_CONFIRMATION_REQUIRED", message: `${budgetAssessment.message}。请明确确认仍选择此酒店，或调整预算／选择其他酒店。` } }, 422);
      }
      const contextKey = hotelIdentityContextKey(handoffId, segment);
      let selectedAnchor = timing.measureSync("cache_lookup", () => verifiedHotelAnchor(candidate.verifiedPlace, placeId, contextKey));
      timing.annotate({ cacheHit: Boolean(selectedAnchor) });
      let verifiedAt = candidate.verifiedPlace?.verifiedAt || "";
      if (!selectedAnchor) {
        const place = await timing.measureAsync("google_lookup", () => getSingaporePlaceDetails(placeId));
        if (!lodging(place)) return json({ error: { code: "HOTEL_NOT_LODGING", message: "所选地点不是 Google 验证的酒店。" } }, 422);
        selectedAnchor = anchor(place);
        verifiedAt = new Date().toISOString();
      }
      if (segment.hotel?.placeId === placeId && !segment.budgetReviewRequired && (budgetAssessment.status !== "over_budget" || segment.budgetAcknowledgement === hotelBudgetAcknowledgementKey(segment, candidate))) {
        return json({ draft, boundary, unchanged: true });
      }
      changes = {
        staySegments: segments.map((item) => item.id === segment.id ? { ...item, hotel: selectedAnchor, budgetReviewRequired: false,
          hotelCandidates: item.hotelCandidates?.map((hotel) => hotel.placeId === placeId ? { ...hotel, verifiedPlace: { ...selectedAnchor!, userConfirmed: undefined, verifiedAt, contextKey } } : hotel),
          budgetAcknowledgement: budgetAssessment.status === "over_budget" ? hotelBudgetAcknowledgementKey(segment, candidate) : undefined } : item) as unknown as Array<Record<string, unknown>>,
        stayConfirmed: false, stage: "stays", dayEstimates: [], scheduleConflicts: [], lastScheduleOperation: undefined, freeTimeDecisions: [],
      };
    } else {
      const segments = asSegments(draft);
      const batch = draft.hotelQuoteJob as HotelQuoteJob | undefined;
      if (segments.some((segment) => hotelQuoteJobMatchesSegment(batch, segment) && hotelBatchWaiting(batch))) {
        return json({ error: { code: "HOTEL_BATCH_PENDING", message: "本段酒店与报价仍在处理中，请等待整批结果；等待到期可继续读取同一次报价。" }, draft }, 409);
      }
      if (boundary.nights === 0) {
        if (segments.length) return json({ error: { code: "UNNEEDED_STAY_SEGMENT", message: "当天抵离无需过夜酒店，请清空住宿时段。" } }, 422);
      } else if (!segmentsMatchBoundary(segments, boundary) || segments.some((item) => !item.hotel?.placeId)) {
        return json({ error: { code: "HOTELS_NOT_CONFIRMED", message: "请为每个住宿时段选择一间 Google 验证的酒店。" } }, 422);
      }
      const unacknowledged = segments.find((segment) => {
        const candidate = segment.hotelCandidates?.find((hotel) => hotel.placeId === segment.hotel?.placeId);
        return segment.budgetReviewRequired || candidate && assessHotelBudget(segment.budgetPerNight, candidate.commerce).status === "over_budget" &&
          segment.budgetAcknowledgement !== hotelBudgetAcknowledgementKey(segment, candidate);
      });
      if (unacknowledged) return json({ error: { code: "HOTEL_OVER_BUDGET_CONFIRMATION_REQUIRED",
        message: `Day ${unacknowledged.startDay} 起的已选酒店超出当前预算，请先明确确认此预算选择，或调整预算／酒店。` } }, 422);
      changes = { stayConfirmed: true, stage: "route", dayEstimates: [], scheduleConflicts: [], lastScheduleOperation: undefined, freeTimeDecisions: [],
        reviewRequired: (draft.reviewRequired || []).filter((item) => item !== "住宿" && item !== "住宿预算"),
        staySegments: segments.map((segment) => ({ ...segment, budgetReviewRequired: false })) as unknown as Array<Record<string, unknown>> };
    }
    const result = await timing.measureAsync("state_commit", () => commitPlanningDraft(token, { expectedVersion: draft.version, turnId: body.turnId, nextDraft: nextDraft(draft, changes) }, timing));
    if (!result.committed) return json({ error: { code: "PLANNING_VERSION_CONFLICT", message: "规划已更新，请查看最新结果后重试。" }, draft: result.draft }, 409);
    const saveResult = segmentSave ? {
      saved: true, unchanged: false, segments: asSegments(result.draft), changedFields: segmentSave.changedFields,
      invalidatedHotelSegments: segmentSave.invalidatedHotelSegments, budgetReviewSegments: segmentSave.budgetReviewSegments,
      message: `已保存 ${segmentSave.segments.length} 段 / ${boundary.nights} 晚。${segmentSave.invalidatedHotelSegments.length
        ? `Day ${segmentSave.invalidatedHotelSegments.join("、Day ")} 起的区域或入住日期已改变，请重新搜索并选择对应酒店。`
        : segmentSave.budgetReviewSegments.length ? "已选酒店保留；预算已调整，请核对参考报价。" : "请继续为每段搜索并选择酒店。"}`,
    } : undefined;
    return json({ draft: result.draft, advice: result.draft.stayAdvice || null, segments: result.draft.staySegments || [], boundary, ...(saveResult ? { saveResult } : {}) });
  } catch (error) {
    if (error instanceof PlanningScheduleError) return json({ error: { code: error.code, message: error.message, day: error.day } }, 422);
    const code = error instanceof Error ? error.message : "";
    if (code === "HOTEL_QUOTE_ALREADY_RUNNING") return json({ error: { code, message: "已有酒店报价正在查询；请等待本次结果后再发起另一批。选择酒店仍可继续。" } }, 409);
    if (/^HOTEL_QUOTE_(?:SEGMENT_MISSING|CANDIDATE_MISSING|INPUT_INVALID)$/.test(code)) return json({ error: { code, message: "住宿段或候选已有变化，请查看当前酒店后重试。" } }, 422);
    if (code === "HOTEL_QUOTE_VERSION_CONFLICT") return json({ error: { code, message: "规划已有更新，本轮报价尚未开始，请重新读取后重试。" } }, 409);
    if (code === "INVALID_STAY_SEGMENTS") return json({ error: { code, message: "住宿时段必须从 Day 1 开始，且每段至少一晚；离境日不能新开酒店夜段。" } }, 422);
    return json({ error: { code: "STAY_PLANNING_FAILED", message: "暂时无法取得住宿或路线建议，请重试；已有选择不会丢失。" } }, 502);
  }
}
