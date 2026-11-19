import { z } from "zod";
import { getSingaporePlaceDetails, searchSingaporePlaces, SINGAPORE_BOUNDS, type SingaporePlace } from "./google-maps";
import { singaporePlaceCategory } from "./place-description";
import { isEligiblePlanningScene, PlanningSceneCandidateSchema } from "./planning-scenes";
import type { PlanningDraftV1, PlanningHandoffV1 } from "./planning-state";
import { calculatePlanningOutcome, type PlanningDayEstimate } from "./planning-trip";
import { scheduleFingerprint } from "./planning-schedule-policy";
import type { PlanningTiming } from "./planning-timing";
import { mergePlanningTimeOverride, PlanningTimeOverrideSchema } from "./planning-time-overrides";

export const PlanningAttractionInputSchema = z.object({
  day: z.number().int().min(1).max(7), placeId: z.string().trim().min(8).max(255),
  minutes: z.number().int().min(15).max(480),
  anchor: z.object({ nodeId: z.string().min(1).max(255), placement: z.enum(["before", "after"]) }).optional(),
  period: z.enum(["morning", "afternoon"]).optional(),
});
export type PlanningAttractionInput = z.infer<typeof PlanningAttractionInputSchema>;
export type PlanningAttractionMatch = {
  placeId: string; name: string; address: string; categoryLabel: string; openingHours: string[]; rating: number | null;
};
export type PlanningAttractionPreview = {
  fingerprint: string; day: number; place: PlanningAttractionMatch; minutes: number;
  feasible: boolean; message: string; checks: Array<{ status: "passed" | "warning" | "blocked"; message: string }>;
  newTravelMinutes: number; previousTravelMinutes: number; freeMinutes: number; overtimeMinutes: number;
  requiresAcknowledgement?: boolean;
};

export class PlanningAttractionError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function withinSingapore(place: SingaporePlace) {
  return Number.isFinite(place.location.lat) && Number.isFinite(place.location.lng)
    && place.location.lat >= SINGAPORE_BOUNDS.south && place.location.lat <= SINGAPORE_BOUNDS.north
    && place.location.lng >= SINGAPORE_BOUNDS.west && place.location.lng <= SINGAPORE_BOUNDS.east;
}
function eligible(place: SingaporePlace, handoff: PlanningHandoffV1) {
  // Active searches may differ from suggested interests. Explicit exclusions are reported separately.
  const visitTypes = new Set(["tourist_attraction", "museum", "art_gallery", "park", "national_park", "state_park", "city_park", "botanical_garden", "garden", "zoo", "aquarium", "amusement_park", "water_park", "amusement_center", "historical_landmark", "historical_place", "cultural_landmark", "cultural_center", "monument", "sculpture", "observation_deck", "hiking_area", "beach", "marina", "shopping_mall", "visitor_center", "performing_arts_theater"]);
  const hasVisitType = [place.primaryType, ...place.types].some((type) => type && visitTypes.has(type));
  return withinSingapore(place) && hasVisitType && isEligiblePlanningScene(place, { ...handoff, preferences: { ...handoff.preferences, avoid: [] } }, false);
}
function match(place: SingaporePlace): PlanningAttractionMatch {
  return { placeId: place.placeId, name: place.name, address: place.address, categoryLabel: singaporePlaceCategory(place),
    openingHours: place.openingHours?.weekdayDescriptions || [], rating: place.rating };
}

export async function searchPlanningAttractions(handoff: PlanningHandoffV1, query: string, timing?: PlanningTiming) {
  const search = () => searchSingaporePlaces({ query: `${query.trim()} 新加坡 景点`, maxResults: 8, languageCode: "zh-CN" });
  const places = timing ? await timing.measureAsync("google_lookup", search) : await search();
  return places.filter((place) => eligible(place, handoff)).map(match);
}

/** A preview calculates against a copy; only its confirmed result may be committed. */
export async function previewPlanningAttraction(handoff: PlanningHandoffV1, draft: PlanningDraftV1,
  input: PlanningAttractionInput, timing?: PlanningTiming) {
  if (input.day > handoff.dates.days || draft.stage !== "route" || !draft.boardConfirmed || !draft.stayConfirmed || !draft.flightSelection)
    throw new PlanningAttractionError("ATTRACTION_STAGE_REQUIRED", "请先确认分天、航班和住宿，再在时间核算中增加景点。");
  const assignment = draft.assignments.find((item) => item.day === input.day);
  if (!assignment) throw new PlanningAttractionError("ATTRACTION_DAY_NOT_FOUND", "这个旅行日已不存在，请采用最新安排。");
  if (draft.candidates.length >= 100 && !draft.candidates.some((item) => item.placeId === input.placeId))
    throw new PlanningAttractionError("ATTRACTION_POOL_FULL", "候选清单已满，请先回挑地点移除不需要的候选，再增加景点。");
  const existing = draft.assignments.find((item) => item.orderedCandidateIds.some((id) => id === input.placeId
    || draft.candidates.some((candidate) => candidate.placeId === input.placeId && candidate.id === id)));
  if (existing) throw new PlanningAttractionError("ATTRACTION_ALREADY_ASSIGNED", `这个景点已在 Day ${existing.day}，请回分天板查看或移动，避免重复加入。`);
  const load = () => getSingaporePlaceDetails(input.placeId);
  const place = timing ? await timing.measureAsync("google_lookup", load) : await load();
  if (place.placeId !== input.placeId || !eligible(place, handoff)) throw new PlanningAttractionError("ATTRACTION_NOT_ELIGIBLE", "所选地点未通过新加坡景点核实，可能是餐厅、住宿、非游览场所或已永久关闭；请重新选择景点。");
  const previous = draft.dayEstimates?.find((item) => item.day === input.day) as PlanningDayEstimate | undefined;
  const anchorStop = input.anchor ? previous?.scheduledDay?.stops.find((item) => item.id === input.anchor!.nodeId) : undefined;
  if (input.anchor && !anchorStop) throw new PlanningAttractionError("ATTRACTION_ANCHOR_STALE", "插入位置已更新，请重新选择当前行程中的节点。");
  if (input.anchor && anchorStop) {
    const index = previous!.scheduledDay!.stops.indexOf(anchorStop);
    if (index === 0 && input.anchor.placement === "before" || index === previous!.scheduledDay!.stops.length - 1 && input.anchor.placement === "after")
      throw new PlanningAttractionError("ATTRACTION_OUTSIDE_WINDOW", "景点必须安排在当地出发后、返店或赴机场截止前。");
  }
  const ids = [...assignment.orderedCandidateIds];
  let insertionIndex = ids.length;
  let anchorId: string | undefined;
  if (anchorStop?.placeId) anchorId = ids.find((id) => id === anchorStop.placeId || draft.candidates.some((item) => item.id === id && item.placeId === anchorStop.placeId));
  if (anchorId) insertionIndex = ids.indexOf(anchorId) + (input.anchor!.placement === "after" ? 1 : 0);
  else if (anchorStop && previous?.scheduledDay?.stops[0]?.id === anchorStop.id) insertionIndex = 0;
  else if (anchorStop && previous?.scheduledDay?.stops.at(-1)?.id !== anchorStop.id)
    throw new PlanningAttractionError("ATTRACTION_ANCHOR_UNSUPPORTED", "请在已选景点或当地起终点旁选择插入位置。");
  const period = input.period || (anchorId ? assignment.periodByCandidateId?.[anchorId] : undefined) || "afternoon";
  ids.splice(insertionIndex, 0, place.placeId);
  const candidate = PlanningSceneCandidateSchema.parse({
    id: place.placeId, placeId: place.placeId, name: place.name, address: place.address, location: place.location,
    area: "新加坡", category: singaporePlaceCategory(place), kind: "sight", sceneRole: "attraction",
    googleTypes: place.types, googlePrimaryType: place.primaryType,
    reason: "你主动搜索并选择的景点。", estimatedMinutes: Math.max(30, input.minutes),
    pros: "地点身份来自 Google Places，停留时间由你设置。", cons: place.openingHours?.weekdayDescriptions.length ? "常规营业信息仍需出发前复核。" : "营业时间尚待核实。",
    source: "user_added", sourceNote: "你搜索选择的景点，地点身份经 Google Places 核实；未查询商品报价。",
    estimateSource: "user", verified: true, googleMapsUri: place.googleMapsUri,
    rating: place.rating, userRatingCount: place.userRatingCount, openingHours: place.openingHours?.weekdayDescriptions || [],
  });
  const proposed: PlanningDraftV1 = {
    ...draft, candidates: [...draft.candidates.filter((item) => item.placeId !== place.placeId), candidate],
    selectedPlaceIds: [...new Set([...(draft.selectedPlaceIds || draft.assignments.flatMap((item) => item.orderedCandidateIds)), place.placeId])],
    placesConfirmed: true,
    assignments: draft.assignments.map((item) => item.day !== input.day ? item : { ...item, orderedCandidateIds: ids, dayPurpose: "activities", status: "confirmed",
      periodByCandidateId: { ...item.periodByCandidateId, [place.placeId]: period },
      periodConstraintByCandidateId: { ...item.periodConstraintByCandidateId, [place.placeId]: { strength: "soft", source: "user", evidence: "用户在景点搜索预览中选择时段" } } }),
  };
  const priorOverrideValue = draft.scheduleOverrides?.find((item) => item.day === input.day);
  const priorOverride = priorOverrideValue ? PlanningTimeOverrideSchema.parse(priorOverrideValue) : undefined;
  const override = mergePlanningTimeOverride(priorOverride, { day: input.day, visitMinutesByPlaceId: { [place.placeId]: input.minutes } });
  proposed.scheduleOverrides = [...(draft.scheduleOverrides || []).filter((item) => item.day !== input.day), ...(override ? [override] : [])];
  const outcome = await calculatePlanningOutcome(handoff, proposed, { days: [input.day], timing });
  const estimate = outcome.estimates[0];
  const conflict = outcome.conflicts[0];
  const checks: PlanningAttractionPreview["checks"] = [{ status: "passed", message: "景点身份、类别及新加坡范围已核实。" }];
  const requiresAcknowledgement = !isEligiblePlanningScene(place, handoff, false);
  if (requiresAcknowledgement) checks.push({ status: "warning", message: "这个景点可能与你先前的明确排除项冲突。若仍要加入，请明确确认这次选择；原偏好不会被静默修改。" });
  if (!place.openingHours?.weekdayDescriptions.length) checks.push({ status: "warning", message: "营业信息待核实，不代表该日已确认开放。" });
  if (conflict) checks.push({ status: "blocked", message: conflict.message });
  if (estimate?.metrics.overtimeMinutes) checks.push({ status: "blocked", message: `调整后超出本日硬截止约 ${estimate.metrics.overtimeMinutes} 分钟，请调整位置或停留。` });
  if (estimate && input.anchor && anchorId) {
    const scheduledIds = estimate.scheduledDay?.stops.map((item) => item.placeId) || [];
    const anchorPlace = anchorStop!.placeId!, newIndex = scheduledIds.indexOf(place.placeId), oldIndex = scheduledIds.indexOf(anchorPlace);
    if (oldIndex >= 0 && newIndex >= 0 && (input.anchor.placement === "before" ? newIndex > oldIndex : newIndex < oldIndex))
      checks.push({ status: "blocked", message: "所选上午／下午使景点顺序偏离你指定的位置，请调整时段或插入位置后重试。" });
  }
  const feasible = Boolean(estimate) && !checks.some((item) => item.status === "blocked");
  const fingerprint = await scheduleFingerprint({ version: draft.version, handoffId: draft.handoffId, input,
    place: { placeId: place.placeId, location: place.location, openingHours: candidate.openingHours },
    result: estimate ? { metrics: estimate.metrics, stops: estimate.scheduledDay?.stops.map(({ id, time, endTime }) => ({ id, time, endTime })) } : outcome.conflicts,
    checks, requiresAcknowledgement });
  const preview: PlanningAttractionPreview = {
    fingerprint, day: input.day, place: match(place), minutes: input.minutes, feasible,
    message: feasible ? "已核对所选位置的路线与时间，确认后才加入；未知营业信息仍须核实。" : conflict?.message || checks.find((item) => item.status === "blocked")?.message || "本日尚无法容纳该安排。",
    checks, requiresAcknowledgement,
    newTravelMinutes: estimate?.metrics.travelMinutes || 0, previousTravelMinutes: previous?.metrics.travelMinutes || 0,
    freeMinutes: estimate?.metrics.freeMinutes || 0, overtimeMinutes: estimate?.metrics.overtimeMinutes || 0,
  };
  return { preview, proposed, outcome };
}
