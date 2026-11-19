import { z } from "zod";
import { RecommendedDurationSchema, validRecommendedDuration } from "./planning-duration";
import { askBailianAgent } from "./bailian";
import {
  getSingaporePlaceDetails,
  searchSingaporePlaces,
  type SingaporePlace,
} from "./google-maps";
import { singaporePlaceCategory } from "./place-description";
import { extractJsonObject } from "./singapore-intent";
import {
  PlanningDraftSchema,
  PlanningHandoffSchema,
  type PlanningDraftV1,
  type PlanningHandoffV1,
} from "./planning-state";
import { acquireTravelVisit } from "./visit-session";
import type { PlanningTiming, PlanningTimingStep } from "./planning-timing";

function measured<T>(timing: PlanningTiming | undefined, step: PlanningTimingStep, operation: () => Promise<T>): Promise<T> { return timing ? timing.measureAsync(step, operation) : operation(); }
function measuredSearch(timing: PlanningTiming | undefined, ...args: Parameters<typeof searchSingaporePlaces>) { return measured(timing, "google_lookup", () => searchSingaporePlaces(...args)); }
function measuredAgent(timing: PlanningTiming | undefined, ...args: Parameters<typeof askBailianAgent>) { return measured(timing, "agent_wait", () => askBailianAgent(...args)); }
import { allowAutomaticFoodScene, planningSceneRole } from "./planning-scene-role";

const brief = z.string().trim().min(1).max(180);
const optionalDuration = z.preprocess((value) => validRecommendedDuration(value), RecommendedDurationSchema.optional());
export const suggestionSchema = z.object({
  query: z.string().trim().min(2).max(120),
  kind: z.enum(["sight", "food"]).optional(),
  area: z.string().trim().min(1).max(80),
  reason: brief,
  estimatedMinutes: z.number().int().min(30).max(480),
  recommendedDuration: optionalDuration,
  durationReason: z.string().trim().min(1).max(180).optional(),
  pros: brief,
  cons: brief,
});

const suggestionBatchSchema = z.object({
  suggestions: z.array(suggestionSchema).max(20),
});

const popularAssessmentSchema = z.object({
  assessments: z.array(z.object({
    placeId: z.string().trim().min(8).max(255),
    area: z.string().trim().min(1).max(80),
    reason: brief,
    estimatedMinutes: z.number().int().min(30).max(480),
    recommendedDuration: optionalDuration,
    durationReason: z.string().trim().min(1).max(180).optional(),
    pros: brief,
    cons: brief,
  })).max(12),
});

export const PlanningSceneCandidateSchema = z.object({
  id: z.string().trim().min(8).max(255),
  placeId: z.string().trim().min(8).max(255),
  name: z.string().trim().min(1).max(240),
  address: z.string().trim().min(1).max(500),
  location: z.object({ lat: z.number(), lng: z.number() }),
  area: z.string().trim().min(1).max(80),
  category: z.string().trim().min(1).max(120),
  kind: z.enum(["sight", "food"]),
  sceneRole: z.enum(["culinary_area", "restaurant_meal", "attraction"]).optional(),
  includedMealMinutes: z.number().int().min(0).max(240).optional(),
  durationReason: z.string().trim().min(1).max(180).optional(),
  googleTypes: z.array(z.string()).max(100).optional(),
  googlePrimaryType: z.string().nullable().optional(),
  reason: brief,
  estimatedMinutes: z.number().int().min(30).max(480),
  recommendedMinutes: z.number().int().min(15).max(480).optional(),
  recommendedDuration: optionalDuration,
  pros: brief,
  cons: brief,
  source: z.enum(["preference", "popular", "user_added"]),
  sourceNote: z.string().trim().min(1).max(240),
  estimateSource: z.enum(["bailian", "user"]),
  verified: z.literal(true),
  googleMapsUri: z.string().url().nullable(),
  rating: z.number().min(0).max(5).nullable(),
  userRatingCount: z.number().int().min(0).nullable(),
  openingHours: z.array(z.string()).max(7),
});

export type PlanningSceneCandidate = z.infer<typeof PlanningSceneCandidateSchema>;

export const PlanningSceneSearchMatchSchema = z.object({
  placeId: z.string().trim().min(8).max(255),
  name: z.string().trim().min(1).max(240),
  address: z.string().trim().min(1).max(500),
  location: z.object({ lat: z.number(), lng: z.number() }),
  categoryLabel: z.string().trim().min(1).max(120),
  kind: z.enum(["sight", "food"]),
  googleMapsUri: z.string().url().nullable(),
  rating: z.number().min(0).max(5).nullable(),
  userRatingCount: z.number().int().min(0).nullable(),
});

export type PlanningSceneSearchMatch = z.infer<typeof PlanningSceneSearchMatchSchema>;

export async function readPlanningSceneContext(
  visitToken: string,
  signal: AbortSignal,
  timing?: PlanningTiming,
): Promise<{ handoff: PlanningHandoffV1; handoffId: string; draft: PlanningDraftV1 }> {
  const lease = await measured(timing, "lease_wait", () => acquireTravelVisit(visitToken, signal));
  try {
    const [handoffRow, draftRow, intentState] = await Promise.all([
      lease.readPlanningHandoff(),
      lease.readPlanningDraftRow(),
      lease.readIntentState(),
    ]);
    if (!handoffRow || !draftRow) throw new Error("请先确认旅行条件并进入地点规划阶段。");
    if (handoffRow.source_intent_state_version !== intentState.stateVersion ||
        draftRow.source_intent_state_version !== intentState.stateVersion ||
        draftRow.handoff_id !== handoffRow.handoff_id) {
      throw new Error("旅行条件已有更新，请重新确认后再规划地点。");
    }
    return {
      handoff: PlanningHandoffSchema.parse(JSON.parse(handoffRow.handoff_json)),
      handoffId: handoffRow.handoff_id,
      draft: PlanningDraftSchema.parse(JSON.parse(draftRow.draft_json)),
    };
  } finally {
    await lease.release();
  }
}

/** Returns a committed draft for a retry of one already accepted turn. */
export async function readCommittedPlanningSceneTurn(
  visitToken: string,
  turnId: string,
  signal: AbortSignal,
): Promise<PlanningDraftV1 | null> {
  const lease = await acquireTravelVisit(visitToken, signal);
  try {
    const turn = await lease.findPlanningDraftTurn(turnId);
    return turn ? PlanningDraftSchema.parse(JSON.parse(turn.response_json)) : null;
  } finally {
    await lease.release();
  }
}

function normalizedText(value: string): string {
  return value.toLocaleLowerCase("en").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function excludedByPreference(place: SingaporePlace, avoid: string[]): boolean {
  const name = normalizedText(place.name);
  const category = singaporePlaceCategory(place);
  const typeText = [place.primaryType, ...place.types].filter(Boolean).join(" ").toLowerCase();
  return avoid.some((raw) => {
    const term = normalizedText(raw);
    if (term.length >= 2 && name.includes(term)) return true;
    if (/展览|博物馆|museum|exhibition|gallery|文物/.test(raw.toLowerCase())) {
      if (/museum|art_gallery/.test(typeText) || category === "博物馆与展览空间") return true;
    }
    if (/动物园|水族馆|zoo|aquarium|wildlife/.test(raw.toLowerCase())) {
      if (/zoo|aquarium|wildlife/.test(typeText)) return true;
    }
    if (/购物|商场|shopping|mall/.test(raw.toLowerCase())) {
      if (/shopping_mall|department_store/.test(typeText)) return true;
    }
    return false;
  });
}

function isFood(place: SingaporePlace): boolean {
  return planningSceneRole(place) !== "attraction";
}

function isScene(place: SingaporePlace, allowFood: boolean): boolean {
  if (place.businessStatus === "CLOSED_PERMANENTLY") return false;
  const types = [place.primaryType, ...place.types].filter(Boolean).join(" ");
  // Meals and lodging have their own later planning stages. A place can be a
  // genuine Google result and still be the wrong kind of travel scene.
  if (/(?:^|\s)(?:hotel|lodging|motel|hostel|resort_hotel|bed_and_breakfast)(?:\s|$)/i.test(types)) return false;
  if (/(?:^|\s)(?:airport|bus_station|train_station|subway_station|transit_station|taxi_stand|car_rental|car_dealer|parking|gas_station|hospital|doctor|dentist|pharmacy|school|university|bank|atm|police|fire_station|post_office|government_office|embassy|travel_agency)(?:\s|$)/i.test(types)) return false;
  return allowFood || planningSceneRole(place) !== "restaurant_meal";
}

export function isEligiblePlanningScene(
  place: SingaporePlace,
  handoff: PlanningHandoffV1,
  allowFood = false,
): boolean {
  return isScene(place, allowFood) && !excludedByPreference(place, handoff.preferences.avoid);
}

function toSearchMatch(place: SingaporePlace): PlanningSceneSearchMatch {
  return PlanningSceneSearchMatchSchema.parse({
    placeId: place.placeId,
    name: place.name,
    address: place.address,
    location: place.location,
    categoryLabel: singaporePlaceCategory(place),
    kind: isFood(place) ? "food" : "sight",
    googleMapsUri: place.googleMapsUri,
    rating: place.rating,
    userRatingCount: place.userRatingCount,
  });
}

export function toCandidate(
  place: SingaporePlace,
  description: z.infer<typeof suggestionSchema>,
  source: PlanningSceneCandidate["source"],
): PlanningSceneCandidate {
  return PlanningSceneCandidateSchema.parse({
    id: place.placeId,
    placeId: place.placeId,
    name: place.name,
    address: place.address,
    location: place.location,
    area: description.area,
    category: singaporePlaceCategory(place),
    kind: isFood(place) ? "food" : "sight",
    sceneRole: planningSceneRole(place),
    googleTypes: place.types,
    googlePrimaryType: place.primaryType || null,
    durationReason: description.durationReason,
    reason: description.reason,
    estimatedMinutes: description.estimatedMinutes,
    recommendedMinutes: description.estimatedMinutes,
    recommendedDuration: validRecommendedDuration(description.recommendedDuration, description.estimatedMinutes),
    pros: description.pros,
    cons: description.cons,
    source,
    sourceNote: source === "popular"
      ? "偏好候选不足时补入；来自 Google Places 热门景点搜索结果，按评分及评价数量筛选。"
      : source === "user_added"
        ? "你添加的地点；地点信息经 Google Places 验证。"
        : "百炼根据旅行偏好建议；地点信息经 Google Places 验证。",
    estimateSource: "bailian",
    verified: true,
    googleMapsUri: place.googleMapsUri,
    rating: place.rating,
    userRatingCount: place.userRatingCount,
    openingHours: place.openingHours?.weekdayDescriptions ?? [],
  });
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current]);
    }
  }));
  return results;
}

function promptContext(handoff: PlanningHandoffV1) {
  return JSON.stringify({
    days: handoff.dates.days,
    interests: handoff.preferences.interests,
    mustVisit: handoff.preferences.mustVisit,
    avoid: handoff.preferences.avoid,
    pace: handoff.pace,
    mobilityConstraints: handoff.preferences.mobilityConstraints,
    dailyWindow: handoff.dailyWindow,
  });
}

function automaticSuggestionsAllowed(handoff: PlanningHandoffV1): boolean {
  return !handoff.preferences.recommendationDeclined;
}

function foodRequested(handoff: PlanningHandoffV1): boolean {
  return handoff.preferences.interests.some((item) => /美食|餐饮|餐厅|小吃|咖啡|甜品|food|dining|restaurant|cafe/i.test(item));
}

export function suggestionPrompt(handoff: PlanningHandoffV1): string {
  const scope = automaticSuggestionsAllowed(handoff)
    ? `根据兴趣和必去地点，建议至多 ${Math.min(18, handoff.dates.days * 3 + 3)} 个具体新加坡地点`
    : "用户不接受额外自动推荐，只能说明用户明确列出的必去地点";
  return `你是新加坡旅行地点策划助手。此轮建议景点、建筑、自然、夜景和可到访的体验地点；${foodRequested(handoff) ? "用户喜欢美食，优先推荐真实美食街、食阁、熟食中心等可到访区域体验，标记 kind=food；不自动指定单家餐厅或三餐。只有用户明确点名某家餐厅时才可保留该餐厅。不查询飞猪餐饮商品或价格。" : "未明确要求美食时不要主动加入餐厅。"}不制定完整路线，不查询酒店、机票、飞猪、地图或其他工具。地点真实性稍后由服务端 Google Places 验证。\n旅行条件：${promptContext(handoff)}\n${scope}，避免重复、避免清单中的排除项；排除项优先于必去项。名称 query 必须是可用于 Google Places 搜索的具体名称，不能只写区域或活动类别。景点标记 kind=sight，美食区域体验或用户点名餐厅标记 kind=food。area 是你估计的简短片区（不确定就写“新加坡”）；estimatedMinutes 是 AI 的粗略游玩估计（30-480 分钟），不是营业时间或 Google 数据。可在有把握时补充 recommendedDuration（含 minMinutes、maxMinutes、source=ai_suggestion），范围为15–480分钟且必须包含 estimatedMinutes，不确定时省略范围，不可所有地点套用同一区间。durationReason 可用一句解释为什么推荐这个停留时长，基于体验内容及旅行节奏；pros 与 cons 各一句，缺点可说明步行强度、室外暴晒、拥挤或额外费用；不得捏造具体票价/营业时间。只返回 JSON：{"suggestions":[{"query":"...","kind":"sight","area":"滨海湾","reason":"...","estimatedMinutes":90,"pros":"...","cons":"..."}]}。`;
}

export function assessmentPrompt(handoff: PlanningHandoffV1, places: SingaporePlace[]): string {
  return `你是新加坡旅行地点策划助手。此轮只为 Google Places 已验证的景点或用户主动添加的餐饮地点写简短建议和粗略停留时间，不调用工具、不虚构票价/营业时间，不制定路线。用户的排除项优先，若地点与排除项冲突请省略。餐厅只介绍真实地点与用餐体验，不声称飞猪有餐饮报价。\n旅行条件：${promptContext(handoff)}\n已验证地点：${JSON.stringify(places.map((place) => ({ placeId: place.placeId, name: place.name, address: place.address, category: singaporePlaceCategory(place) })))}\n每个地点最多一项，placeId 必须原样复制。area 写简短片区，不确定就写“新加坡”。estimatedMinutes 为30–480分钟的粗略建议；有把握时补充 recommendedDuration（含 minMinutes、maxMinutes、source=ai_suggestion），范围为15–480分钟且包含 estimatedMinutes，不确定则省略范围。durationReason 可用一句解释游玩所需时间，美食街/食阁按逛摊与体验估计，不能自动加入未指定的单家餐厅或重复计算用餐。只返回 JSON：{"assessments":[{"placeId":"...","area":"滨海湾","reason":"...","estimatedMinutes":90,"pros":"...","cons":"..."}]}。`;
}

function parseAgentJson<S extends z.ZodTypeAny>(content: string, schema: S): z.output<S> | null {
  try {
    const parsed = schema.safeParse(extractJsonObject(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parsePlanningSceneSuggestions(content: string) {
  return parseAgentJson(content, suggestionBatchSchema)?.suggestions ?? null;
}

export function parsePlanningSceneAssessments(content: string) {
  return parseAgentJson(content, popularAssessmentSchema)?.assessments ?? null;
}

/** The durable discovery job uses the same eligibility rules as synchronous discovery. */
export function verifiedPlanningSuggestion(place: SingaporePlace, suggestion: z.infer<typeof suggestionSchema>, handoff: PlanningHandoffV1) {
  const named = handoff.preferences.mustVisit.some((name) => normalizedText(name) === normalizedText(suggestion.query) || normalizedText(name) === normalizedText(place.name));
  return isEligiblePlanningScene(place, handoff, named) && allowAutomaticFoodScene(place, foodRequested(handoff), named)
    && (suggestion.kind !== "food" || isFood(place)) ? toCandidate(place, suggestion, "preference") : null;
}

export function popularPlanningScenes(places: SingaporePlace[], candidates: PlanningSceneCandidate[], handoff: PlanningHandoffV1) {
  const selected = new Set(candidates.map((candidate) => candidate.placeId));
  const desired = Math.min(18, Math.max(handoff.dates.days * 2, 4));
  return places.filter((place) => !selected.has(place.placeId) && isEligiblePlanningScene(place, handoff)
    && allowAutomaticFoodScene(place, foodRequested(handoff), false))
    .sort((left, right) => ((right.rating ?? 0) * Math.log1p(right.userRatingCount ?? 0)) - ((left.rating ?? 0) * Math.log1p(left.userRatingCount ?? 0)))
    .slice(0, Math.min(12, desired - candidates.length + 3));
}

async function agentSuggestions(handoff: PlanningHandoffV1, visitToken: string, turnId: string, timing?: PlanningTiming) {
  const answer = await measuredAgent(timing, suggestionPrompt(handoff), "planning", visitToken, `${turnId}:suggest`);
  if (!answer?.text) throw new Error("百炼暂时无法提供地点建议，请重试。");
  const parsed = parseAgentJson(answer.text, suggestionBatchSchema);
  if (parsed) return parsed.suggestions;
  const repaired = await measuredAgent(timing,
    "上一轮地点建议未通过 JSON 字段校验。请根据刚才同一旅行条件完整重发，只返回 {\"suggestions\":[{\"query\":\"具体地点\",\"kind\":\"sight 或 food\",\"area\":\"简短片区\",\"reason\":\"理由\",\"estimatedMinutes\":90,\"pros\":\"一句优点\",\"cons\":\"一句缺点\"}]}；不要调用工具。",
    "planning", visitToken, `${turnId}:suggest:repair`,
  );
  const valid = repaired?.text ? parseAgentJson(repaired.text, suggestionBatchSchema) : null;
  if (!valid) throw new Error("百炼地点建议格式暂时不完整，请重试。");
  return valid.suggestions;
}

async function assessPlaces(
  handoff: PlanningHandoffV1,
  places: SingaporePlace[],
  visitToken: string,
  turnId: string,
  timing?: PlanningTiming,
): Promise<Map<string, z.infer<typeof suggestionSchema>>> {
  if (!places.length) return new Map();
  const answer = await measuredAgent(timing, assessmentPrompt(handoff, places), "planning", visitToken, `${turnId}:assess`);
  if (!answer?.text) throw new Error("百炼暂时无法说明地点的游玩时长，请重试。");
  let parsed = parseAgentJson(answer.text, popularAssessmentSchema);
  if (!parsed) {
    const repaired = await measuredAgent(timing,
      "上一轮地点说明未通过 JSON 字段校验。请对刚才 Google 已验证地点完整重发，只返回 {\"assessments\":[{\"placeId\":\"原样复制\",\"area\":\"简短片区\",\"reason\":\"理由\",\"estimatedMinutes\":90,\"pros\":\"一句优点\",\"cons\":\"一句缺点\"}]}；不要调用工具。",
      "planning", visitToken, `${turnId}:assess:repair`,
    );
    parsed = repaired?.text ? parseAgentJson(repaired.text, popularAssessmentSchema) : null;
  }
  if (!parsed) throw new Error("百炼地点说明格式暂时不完整，请重试。");
  const assessments = parsed.assessments;
  const allowed = new Set(places.map((place) => place.placeId));
  return new Map(assessments
    .filter((item) => allowed.has(item.placeId))
    .map((item) => [item.placeId, { ...item, query: item.placeId }]));
}

/** Suggests named places, then accepts only Google-verified Singapore scenes. */
export async function generatePlanningScenes(
  handoff: PlanningHandoffV1,
  visitToken: string,
  turnId: string,
  timing?: PlanningTiming,
): Promise<{ candidates: PlanningSceneCandidate[]; warnings: string[] }> {
  const allowAutomatic = automaticSuggestionsAllowed(handoff);
  if (!allowAutomatic) {
    if (!handoff.preferences.mustVisit.length) {
      throw new Error("你已关闭自动推荐，请先添加想去的具体地点。");
    }
    const requested = await mapLimited(handoff.preferences.mustVisit.slice(0, 20), 3, async (name) => {
      try {
        const places = await measuredSearch(timing, { query: name, maxResults: 1, languageCode: "zh-CN" });
        const place = places[0];
        return place && isEligiblePlanningScene(place, handoff, true) ? place : null;
      } catch {
        return null;
      }
    });
    const places = [...new Map(requested.filter((place): place is SingaporePlace => Boolean(place))
      .map((place) => [place.placeId, place])).values()];
    if (!places.length) throw new Error("明确列出的必去地点尚未通过 Google Places 验证，请检查地点名称或排除条件。");
    const descriptions = await assessPlaces(handoff, places, visitToken, turnId, timing);
    const candidates = places.flatMap((place) => {
      const description = descriptions.get(place.placeId);
      return description ? [toCandidate(place, description, "preference")] : [];
    });
    if (!candidates.length) throw new Error("百炼暂时无法说明已验证的必去地点，请重试。");
    return { candidates, warnings: places.length < handoff.preferences.mustVisit.length
      ? ["部分必去地点未能通过 Google Places 验证或与排除条件冲突，已省略。"] : [] };
  }
  const hasNamedPreferences = handoff.preferences.mustVisit.length > 0 || handoff.preferences.interests.length > 0;
  const suggestions = hasNamedPreferences ? await agentSuggestions(handoff, visitToken, turnId, timing) : [];
  let failedLookups = 0;
  const verified = await mapLimited(suggestions, 3, async (suggestion) => {
    try {
      const results = await measuredSearch(timing, { query: suggestion.query, maxResults: 3, languageCode: "zh-CN" });
      const place = results[0];
      if (!place) return null;
      const named = handoff.preferences.mustVisit.some((name) => normalizedText(name) === normalizedText(suggestion.query) || normalizedText(name) === normalizedText(place.name));
      return isEligiblePlanningScene(place, handoff, named) && allowAutomaticFoodScene(place, foodRequested(handoff), named) &&
        (suggestion.kind !== "food" || isFood(place))
        ? toCandidate(place, suggestion, "preference") : null;
    } catch {
      failedLookups += 1;
      return null;
    }
  });
  const unique = new Map<string, PlanningSceneCandidate>();
  verified.forEach((item) => { if (item) unique.set(item.placeId, item); });
  const warnings: string[] = [];
  if (unique.size < suggestions.length) warnings.push("部分建议未能通过 Google Places 地点或排除条件验证，已省略。");
  if (suggestions.length > 0 && failedLookups === suggestions.length) {
    throw new Error("Google Places 暂时无法核验地点，请稍后重试。");
  }

  const desired = Math.min(18, Math.max(handoff.dates.days * 2, 4));
  if (unique.size < desired && allowAutomatic) {
    try {
      const popular = await measuredSearch(timing, {
        query: "popular attractions landmarks gardens Singapore",
        maxResults: 20,
        languageCode: "zh-CN",
      });
      const eligible = popular
        .filter((place) => !unique.has(place.placeId) && isEligiblePlanningScene(place, handoff) && allowAutomaticFoodScene(place, foodRequested(handoff), false))
        .sort((left, right) =>
          ((right.rating ?? 0) * Math.log1p(right.userRatingCount ?? 0)) -
          ((left.rating ?? 0) * Math.log1p(left.userRatingCount ?? 0)))
        .slice(0, Math.min(12, desired - unique.size + 3));
      const assessed = await assessPlaces(handoff, eligible, visitToken, turnId, timing);
      for (const place of eligible) {
        const description = assessed.get(place.placeId);
        if (!description) continue;
        unique.set(place.placeId, toCandidate(place, description, "popular"));
        if (unique.size >= desired) break;
      }
      if (eligible.length) warnings.push("偏好候选不足，已补入 Google Places 热门景点搜索中可验证的地点；评分与评价数量仅供参考。");
    } catch {
      warnings.push("热门景点补充暂不可用；已保留通过验证的偏好候选。");
    }
  }
  if (!unique.size) throw new Error("目前没有找到符合偏好且通过 Google Places 验证的景点，请调整排除条件或重试。");
  return { candidates: [...unique.values()], warnings };
}

export async function searchPlanningScenes(
  handoff: PlanningHandoffV1,
  query: string,
  timing?: PlanningTiming,
): Promise<PlanningSceneSearchMatch[]> {
  const places = await measuredSearch(timing, { query, maxResults: 8, languageCode: "zh-CN" });
  return places.filter((place) => isEligiblePlanningScene(place, handoff, true)).map(toSearchMatch);
}

export async function addPlanningScene(
  handoff: PlanningHandoffV1,
  placeId: string,
  visitToken: string,
  turnId: string,
  timing?: PlanningTiming,
): Promise<PlanningSceneCandidate> {
  const place = await measured(timing, "google_lookup", () => getSingaporePlaceDetails(placeId));
  if (!isEligiblePlanningScene(place, handoff, true)) {
    throw new Error("该地点不是可安排的景点或餐饮地点，或与排除条件冲突；请先修改旅行偏好。");
  }
  const assessments = await assessPlaces(handoff, [place], visitToken, turnId, timing);
  const description = assessments.get(place.placeId);
  if (!description) throw new Error("百炼暂时无法提供该地点的游玩建议，请重试。");
  return toCandidate(place, description, "user_added");
}
