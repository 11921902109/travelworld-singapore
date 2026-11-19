import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withPlanningTiming, type PlanningTiming } from "@/lib/travel/planning-timing";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import { calculatePlanningOutcome, previewScheduleMove, previewScheduleMoves, derivePlanningStayBoundary, planningDayInputFingerprint, PlanningScheduleError, type PlanningDayEstimate } from "@/lib/travel/planning-trip";
import type { PlanningScheduleConflict } from "@/lib/travel/planning-conflicts";
import { commitPlanningDraft, readPlanningDraft, readPlanningHandoff, type PlanningDraftV1, type PlanningHandoffV1 } from "@/lib/travel/planning-state";
import { readPlanningSceneContext } from "@/lib/travel/planning-scenes";
import { defaultFreeTimePolicies, estimatePolicyFingerprint, scheduleFingerprint } from "@/lib/travel/planning-schedule-policy";
import { readTravelVisitToken } from "@/lib/travel/visit-session";
import { flightDayWindowLocks, mergePlanningTimeOverride, PlanningTimeOverrideSchema, routeOwnedTimeOverride } from "@/lib/travel/planning-time-overrides";
import { reconcileBoardReviews, reconcileFlightReviews } from "@/lib/travel/planning-review";
import { planningDraftWithReadiness } from "@/lib/travel/planning-readiness";
import { getSingaporePlaceDetails, searchSingaporePlaces, SINGAPORE_BOUNDS } from "@/lib/travel/google-maps";
import { PlanningAttractionInputSchema, PlanningAttractionError, previewPlanningAttraction, searchPlanningAttractions } from "@/lib/travel/planning-attractions";
import { effectivePlanningLocalBlocks } from "@/lib/travel/planning-local-blocks";
import { readableMinutes } from "@/lib/travel/planning-conflicts";

export const dynamic = "force-dynamic";
const ScheduleMoveSchema = z.object({
  day: z.number().int().min(1).max(7), targetDay: z.number().int().min(1).max(7),
  placeId: z.string().min(1).max(255), targetPeriod: z.enum(["morning", "afternoon"]).optional(),
});
const Request = z.object({
  action: z.enum(["calculate", "updateDay", "decideFreeTime", "confirm", "reopen", "previewMove", "applyMove", "searchBaggagePlaces", "searchAttractions", "previewAttraction", "addAttraction"]),
  expectedVersion: z.number().int().min(0), turnId: z.string().min(8).max(100),
  day: z.number().int().min(1).max(7).optional(), decision: z.enum(["keep", "add"]).optional(), overrides: PlanningTimeOverrideSchema.optional(),
  move: ScheduleMoveSchema.optional(),
  moves: z.array(ScheduleMoveSchema).min(1).max(100).optional(),
  previewFingerprint: z.string().min(8).max(100).optional(),
  query: z.string().trim().min(1).max(180).optional(),
  attraction: PlanningAttractionInputSchema.optional(),
  preferenceAcknowledged: z.boolean().optional(),
}).refine(({ move, moves }) => !move || !moves, { message: "请只提交单项移动或一份待确认调整列表。" });
function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
const estimatesOf = (draft: PlanningDraftV1) => (draft.dayEstimates || []) as PlanningDayEstimate[];
const decisionsOf = (draft: PlanningDraftV1) => (draft.freeTimeDecisions || []) as Array<{ day: number; decision: "keep" | "add"; source?: string; estimateFingerprint?: string }>;
async function payload(handoff: PlanningHandoffV1, draft: PlanningDraftV1, extra: Record<string, unknown> = {}) {
  return { draft: await planningDraftWithReadiness(handoff, draft), estimates: estimatesOf(draft), conflicts: draft.scheduleConflicts || [], decisions: decisionsOf(draft), departureTransfer: estimatesOf(draft).at(-1)?.nextDayDepartureTransfer || null, ...extra };
}
function nextDraft(draft: PlanningDraftV1, changes: Partial<PlanningDraftV1>) {
  const { version: _version, updatedAt: _updatedAt, ...base } = draft;
  void _version; void _updatedAt; return { ...base, ...changes };
}

async function getScheduleResponse(request: NextRequest, timing: PlanningTiming) {
  const token = readTravelVisitToken(request);
  if (!token) return json({ error: { code: "VISIT_REQUIRED", message: "请刷新页面后重试。" } }, 400);
  const [draft, handoff] = await timing.measureAsync("context_read", () => Promise.all([readPlanningDraft(token), readPlanningHandoff(token)]));
  return draft && handoff ? json(await payload(handoff.handoff, draft)) : json({ error: { code: "PLANNING_NOT_STARTED", message: "请先确认旅行条件。" } }, 404);
}

async function postScheduleResponse(request: NextRequest, timing: PlanningTiming) {
  const blocked = guardSingaporeApi(request, { bucket: "planning-schedule", limit: 24, windowMs: 5 * 60_000 });
  if (blocked) return blocked;
  const token = readTravelVisitToken(request);
  if (!token) return json({ error: { code: "VISIT_REQUIRED", message: "请刷新页面后重试。" } }, 400);
  const parsed = Request.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: { code: "INVALID_SCHEDULE_REQUEST", message: parsed.error.issues.find((issue) => issue.code === "custom")?.message || "请检查小时数及时间偏好，地点停留为 0.25–8 小时，交通总量为 0–12 小时。" } }, 422);
  const body = parsed.data;
  timing.setAction(body.action); timing.annotate({ day: body.overrides?.day || body.day, version: body.expectedVersion });
  try {
    const context = await timing.measureAsync("context_read", () => readPlanningSceneContext(token, request.signal, timing));
    const { handoff } = context;
    const draft = await planningDraftWithReadiness(handoff, context.draft);
    if (body.action === "searchAttractions") {
      if (!body.query?.trim() || body.query.trim().length < 2) return json({ error: { code: "ATTRACTION_QUERY_REQUIRED", message: "请输入至少两个字的景点名称。" } }, 422);
      const attractionMatches = await searchPlanningAttractions(handoff, body.query, timing);
      return json(await payload(handoff, draft, { attractionMatches }));
    }
    if (body.action === "searchBaggagePlaces") {
      if (!body.query) return json({ error: { code: "BAGGAGE_QUERY_REQUIRED", message: "请输入需要搜索的实际寄存地点。" } }, 422);
      const places = await timing.measureAsync("google_lookup", () => searchSingaporePlaces({ query: `${body.query} 新加坡`, maxResults: 5, languageCode: "zh-CN" }));
      return json(await payload(handoff, draft, { matches: places.filter((place) => place.businessStatus !== "CLOSED_PERMANENTLY").map((place) => ({ placeId: place.placeId, name: place.name, address: place.address })) }));
    }
    const requestFingerprint = await timing.measureAsync("cache_lookup", () => scheduleFingerprint(body));
    const savedOperation = draft.lastScheduleOperation as { turnId?: string; fingerprint?: string } | undefined;
    const replay = savedOperation?.turnId === body.turnId ? savedOperation : estimatesOf(draft).find((estimate) => estimate.lastScheduleOperation?.turnId === body.turnId)?.lastScheduleOperation;
    if (replay) {
      if (replay.fingerprint !== requestFingerprint) return json({ error: { code: "TURN_INPUT_CHANGED", message: "同一次操作的内容已改变，请重新确认。" }, draft }, 409);
      return json(await payload(handoff, draft, { alreadyApplied: true }), 200);
    }
    if (draft.version !== body.expectedVersion) return json({ error: { code: "PLANNING_VERSION_CONFLICT", message: "规划已更新，请使用最新结果重试。" }, draft }, 409);
    if (!draft.boardConfirmed || !draft.stayConfirmed || !draft.flightSelection) return json({ error: { code: "UPSTREAM_NOT_CONFIRMED", message: "请先确认地点分天、航班和住宿。" }, draft }, 409);
    let changes: Partial<PlanningDraftV1>;
    let unchangedResult = false;
    if (body.action === "previewAttraction" || body.action === "addAttraction") {
      if (!body.attraction) return json({ error: { code: "ATTRACTION_INPUT_REQUIRED", message: "请选择景点、日期、时长和插入位置。" } }, 422);
      const result = await timing.measureAsync("calculation", () => previewPlanningAttraction(handoff, draft, body.attraction!, timing));
      if (body.action === "previewAttraction") return json(await payload(handoff, draft, { attractionPreview: result.preview }));
      if (body.previewFingerprint !== result.preview.fingerprint) return json(await payload(handoff, draft, { attractionPreview: result.preview, error: { code: "ATTRACTION_PREVIEW_STALE", message: "地点、路线或时间依据已更新，请查看最新预览再确认。" } }), 409);
      if (!result.preview.feasible) return json(await payload(handoff, draft, { attractionPreview: result.preview, error: { code: "ATTRACTION_NOT_FEASIBLE", message: result.preview.message } }), 422);
      if (result.preview.requiresAcknowledgement && !body.preferenceAcknowledged) return json(await payload(handoff, draft, { attractionPreview: result.preview, error: { code: "ATTRACTION_PREFERENCE_REQUIRED", message: "所选景点可能与明确排除项冲突，请先确认这次例外选择。" } }), 422);
      const day = body.attraction.day;
      const estimates = [...estimatesOf(draft).filter((item) => item.day !== day), ...result.outcome.estimates].sort((a, b) => a.day - b.day);
      const conflicts = (draft.scheduleConflicts || []).filter((item) => item.day !== day);
      changes = { candidates: result.proposed.candidates, selectedPlaceIds: result.proposed.selectedPlaceIds, placesConfirmed: true,
        assignments: result.proposed.assignments, scheduleOverrides: result.proposed.scheduleOverrides, stage: "route", boardConfirmed: true,
        dayEstimates: estimates, scheduleConflicts: conflicts, freeTimeDecisions: defaultFreeTimePolicies(estimates, decisionsOf(draft)),
        reviewRequired: conflicts.length ? [...new Set([...(draft.reviewRequired || []), "路线"])] : (draft.reviewRequired || []).filter((item) => item !== "路线") };
      Object.assign(changes, await reconcileBoardReviews(handoff, { ...draft, ...changes }, true));
    } else if (body.action === "previewMove" || body.action === "applyMove") {
      const { move, moves } = body;
      const firstMove = move ?? moves?.[0];
      if (!firstMove) return json({ error: { code: "MOVE_REQUIRED", message: "请选择要移动的地点和目标日期。" } }, 422);
      const batch = moves ? await timing.measureAsync("calculation", () => previewScheduleMoves(handoff, draft, moves, timing)) : undefined;
      const result = batch ?? await timing.measureAsync("calculation", () => previewScheduleMove(handoff, draft, firstMove, timing));
      if (body.action === "previewMove") return json(await payload(handoff, draft, { movePreview: result.preview }));
      if (result.preview.fingerprint !== body.previewFingerprint) {
        const error = { code: "MOVE_PREVIEW_STALE", message: "安排已有变化，请重新核对移动预览后确认。" };
        return json(batch ? await payload(handoff, draft, { movePreview: result.preview, error }) : { error, draft }, 409);
      }
      if (!result.preview.feasible) return json(await payload(handoff, draft, { movePreview: result.preview, error: { code: "MOVE_NOT_FEASIBLE", message: result.preview.message } }), 422);
      if (batch?.preview.requiresAcknowledgement && !body.preferenceAcknowledged) {
        return json(await payload(handoff, draft, { movePreview: batch.preview, error: { code: "MOVE_PREFERENCE_REQUIRED", message: "请先确认接受本次对明确时段要求的调整。" } }), 422);
      }
      const affected = new Set(batch?.preview.affectedDays ?? [firstMove.day, firstMove.targetDay]);
      const mergedEstimates = [...estimatesOf(draft).filter((item) => !affected.has(item.day)), ...result.outcome.estimates].sort((a, b) => a.day - b.day);
      const conflicts = (draft.scheduleConflicts || []).filter((item) => !affected.has(Number(item.day)));
      const unaffectedDecisions = decisionsOf(draft).filter((item) => !affected.has(item.day));
      changes = { assignments: result.moved.assignments, placeTimePreferences: result.moved.placeTimePreferences, scheduleOverrides: result.moved.scheduleOverrides,
        stage: "route", dayEstimates: mergedEstimates, scheduleConflicts: conflicts,
        freeTimeDecisions: batch
          ? [...unaffectedDecisions, ...defaultFreeTimePolicies(result.outcome.estimates)].sort((a, b) => a.day - b.day)
          : defaultFreeTimePolicies(mergedEstimates, unaffectedDecisions),
        reviewRequired: conflicts.length ? [...new Set([...(draft.reviewRequired || []), "路线"])] : (draft.reviewRequired || []).filter((item) => item !== "路线") };
      Object.assign(changes, await reconcileBoardReviews(handoff, { ...draft, ...changes }, true));
    } else if (body.action === "reopen") {
      changes = { stage: "route", reviewRequired: [...new Set([...(draft.reviewRequired || []), "路线"])] };
    } else if (body.action === "calculate" || body.action === "updateDay") {
      let submitted = body.overrides;
      if (body.action === "updateDay" && (!submitted || submitted.day > handoff.dates.days)) return json({ error: { code: "INVALID_TIME_OVERRIDE", message: "请填写本旅行日的有效时间设置。" } }, 422);
      if (submitted) {
        const submittedDay = submitted.day;
        const submittedVisits = submitted.visitMinutesByPlaceId;
        const previous = draft.scheduleOverrides?.find((item) => item.day === submittedDay);
        const locks = flightDayWindowLocks(submittedDay, handoff.dates.days, draft.flightSelection.mode);
        if (submitted.dailyWindow && (locks.start || locks.end)) {
          const savedWindow = previous ? PlanningTimeOverrideSchema.parse(previous).dailyWindow : undefined;
          const current = savedWindow || handoff.dailyWindow;
          const next = submitted.dailyWindow;
          const violation = locks.start && next.start !== current.start ? "首日出发时间按抵达航班和机场预留核算，请使用「修改机票」调整航班。"
            : locks.end && (next.preferredReturn !== current.preferredReturn || next.latestReturn !== current.latestReturn ||
              next.returnConstraint?.strength !== current.returnConstraint?.strength ||
              next.returnConstraint?.source !== current.returnConstraint?.source ||
              next.returnConstraint?.evidence !== current.returnConstraint?.evidence)
              ? "末日结束时间受返程航班和机场预留约束，请使用「修改机票」调整航班。" : "";
          if (violation) return json({ error: { code: "FLIGHT_DAY_FIXED_TIMES", message: violation }, draft }, 422);
        }
        if (submitted.travelTotalMinutes !== undefined) return json({ error: {
          code: "TRAVEL_DURATION_READ_ONLY", message: "地面交通时长按 Google 路线核算，不接受手动填写。若页面仍显示交通输入，请刷新后重试。",
        } }, 422);
        const assigned = draft.assignments.find((item) => item.day === submittedDay)?.orderedCandidateIds || [];
        const available = new Set(draft.candidates.filter((item) => assigned.includes(String(item.id)) || assigned.includes(String(item.placeId))).map((item) => String(item.placeId)));
        if (Object.keys(submitted.visitMinutesByPlaceId || {}).some((id) => !available.has(id))) return json({ error: { code: "INVALID_TIME_PLACE", message: "部分地点不属于这一天，请采用最新结果。" } }, 422);
        if (submitted.localBlocks) {
          const parsedPrevious = previous ? PlanningTimeOverrideSchema.parse(previous) : undefined;
          const previousLegacyIds = new Set(effectivePlanningLocalBlocks(parsedPrevious, { departure: Boolean(estimatesOf(draft).find((item) => item.day === submittedDay)?.journey?.kind.includes("departure")) })
            .filter((block) => block.source === "legacy").map((block) => block.id));
          if (submitted.localBlocks.some((block) => block.source === "legacy" && !previousLegacyIds.has(block.id)))
            return json({ error: { code: "INVALID_LEGACY_BLOCK", message: "旧安排标记仅用于已保存数据的兼容转换；请为新增安排选择时间轴位置。" } }, 422);
        }
        const meals = { ...(previous?.includedMealMinutesByPlaceId as Record<string, number> | undefined), ...submitted.includedMealMinutesByPlaceId };
        if (Object.entries(meals).some(([id, minutes]) => {
          const candidate = draft.candidates.find((item) => item.placeId === id);
          const visits = (previous?.visitMinutesByPlaceId || {}) as Record<string, number>;
          const visit = submittedVisits?.[id] ?? visits[id] ?? Number(candidate?.estimatedMinutes);
          return !available.has(id) || candidate?.sceneRole !== "culinary_area" || !Number.isFinite(visit) || minutes > visit;
        })) return json({ error: { code: "INVALID_INCLUDED_MEAL", message: "仅美食区域体验可标记已含用餐，且其中的用餐时长不能超过本地点总停留。" } }, 422);
        if (submitted.baggage) {
          const { mode, handlingMinutes, placeId } = submitted.baggage;
          let storagePlace;
          if (mode === "other") {
            const previousBaggage = PlanningTimeOverrideSchema.safeParse(previous);
            const stored = previousBaggage.success && previousBaggage.data.baggage?.mode === "other"
              && previousBaggage.data.baggage.placeId === placeId ? previousBaggage.data.baggage.storagePlace : undefined;
            if (stored && stored.placeId === placeId) storagePlace = stored;
            else {
              const place = await timing.measureAsync("google_lookup", () => getSingaporePlaceDetails(placeId!));
              if (place.placeId !== placeId || place.businessStatus === "CLOSED_PERMANENTLY" ||
                  place.location.lat < SINGAPORE_BOUNDS.south || place.location.lat > SINGAPORE_BOUNDS.north ||
                  place.location.lng < SINGAPORE_BOUNDS.west || place.location.lng > SINGAPORE_BOUNDS.east)
                return json({ error: { code: "BAGGAGE_PLACE_INVALID", message: "所选地点未通过新加坡真实地点核验，请重新选择；地点验证不代表保证提供寄存。" } }, 422);
              storagePlace = { placeId: place.placeId, name: place.name, address: place.address, location: place.location, openingHours: place.openingHours?.weekdayDescriptions || [] };
            }
          }
          // Never trust the coordinates or place label echoed by a client.
          submitted = { ...submitted, baggage: { mode, ...(handlingMinutes !== undefined ? { handlingMinutes } : {}), ...(mode === "other" ? { placeId, storagePlace } : {}) } };
        }
      }
      let overrides = draft.scheduleOverrides;
      if (submitted) {
        const previous = routeOwnedTimeOverride(overrides?.find((item) => item.day === submitted.day));
        const merged = mergePlanningTimeOverride(previous ? PlanningTimeOverrideSchema.parse(previous) : undefined, submitted);
        overrides = [...(overrides || []).filter((item) => item.day !== submitted.day), ...(merged ? [merged] : [])].sort((a, b) => Number(a.day) - Number(b.day));
      }
      const calculated = await timing.measureAsync("calculation", () => calculatePlanningOutcome(handoff, { ...draft, scheduleOverrides: overrides }, { ...(body.action === "updateDay" ? { days: [submitted!.day] } : {}), timing }));
      const attemptedConflicts = [...calculated.conflicts];
      for (const estimate of calculated.estimates) if (estimate.metrics.overtimeMinutes > 0) attemptedConflicts.push({
        code: "DAILY_WINDOW_TOO_SHORT", day: estimate.day, date: estimate.date, draftVersion: draft.version,
        message: `Day ${estimate.day} 的安排预计 ${estimate.metrics.actualReturnTime} 结束，超过已确认硬截止 ${estimate.effectiveWindow?.returnBy || estimate.metrics.requestedReturnTime}，相差约 ${readableMinutes(estimate.metrics.overtimeMinutes)}。请修改本日安排；原成功结果仍保留。`,
      });
      if (body.action === "updateDay" && attemptedConflicts.length) {
        // A rejected edit is never a saved draft. Keep the successful estimate,
        // override and operation id intact so the user can correct the same form.
        const latest = await readPlanningDraft(token);
        if (!latest || latest.version !== draft.version) return json({ error: { code: "PLANNING_VERSION_CONFLICT", message: "规划已更新，请使用最新结果重试。" }, draft: latest }, 409);
        const previous = draft.scheduleOverrides?.find(item => item.day === submitted!.day);
        const previousBlocks = effectivePlanningLocalBlocks(previous ? PlanningTimeOverrideSchema.parse(previous) : undefined);
        const changedBlocks = (submitted?.localBlocks || []).filter(block => {
          const prior = previousBlocks.find(item => item.id === block.id);
          return !prior || prior.durationMinutes < block.durationMinutes;
        });
        const mergedOverride = overrides?.find(item => item.day === submitted!.day);
        const otherSettings = (value: typeof previous) => { const { localBlocks: _blocks, day: _day, ...rest } = value || {}; void _blocks; void _day; return rest; };
        const focusBlock = changedBlocks.length === 1 ? changedBlocks[0] : undefined;
        const hasOnlyOneEffectiveChange = focusBlock
          && JSON.stringify(otherSettings(previous)) === JSON.stringify(otherSettings(mergedOverride))
          && JSON.stringify(previousBlocks.filter(block => block.id !== focusBlock.id)) === JSON.stringify((submitted?.localBlocks || []).filter(block => block.id !== focusBlock.id));
        const capacity = attemptedConflicts.find(item => item.capacity)?.capacity;
        return json({ error: { code: attemptedConflicts[0].code, message: attemptedConflicts[0].message, day: submitted!.day },
          conflicts: attemptedConflicts, ...(capacity ? { capacity } : {}), ...(hasOnlyOneEffectiveChange ? { blockId: focusBlock!.id } : {}) }, 422);
      }
      const failedDays = new Set(attemptedConflicts.map(item => item.day));
      const mergedEstimates = body.action === "updateDay" ? [...estimatesOf(draft).filter((item) => item.day !== submitted!.day), ...calculated.estimates].sort((a, b) => a.day - b.day)
        : [...estimatesOf(draft).filter(item => failedDays.has(item.day)), ...calculated.estimates].sort((a, b) => a.day - b.day);
      const conflicts: PlanningScheduleConflict[] = body.action === "updateDay" ? [...((draft.scheduleConflicts || []) as PlanningScheduleConflict[]).filter((item) => item.day !== submitted!.day), ...attemptedConflicts] : attemptedConflicts;
      const policies = defaultFreeTimePolicies(mergedEstimates, decisionsOf(draft));
      const unchanged = !conflicts.length && body.action === "updateDay" && calculated.estimates[0] === estimatesOf(draft).find((item) => item.day === submitted!.day)
        && await scheduleFingerprint(overrides || []) === await scheduleFingerprint(draft.scheduleOverrides || [])
        && await scheduleFingerprint(policies) === await scheduleFingerprint(decisionsOf(draft));
      unchangedResult = unchanged;
      changes = { stage: "route", scheduleOverrides: overrides, dayEstimates: mergedEstimates, scheduleConflicts: conflicts,
        freeTimeDecisions: policies, reviewRequired: conflicts.length ? [...new Set([...(draft.reviewRequired || []), "路线"])] : (draft.reviewRequired || []).filter((item) => item !== "路线") };
    } else if (body.action === "decideFreeTime") {
      const estimates = estimatesOf(draft);
      const estimate = estimates.find((item) => item.day === body.day);
      if (!estimate || !body.decision || estimates.length !== handoff.dates.days) return json({ error: { code: "ESTIMATES_REQUIRED", message: "请先核算所有旅行日。" } }, 422);
      changes = body.decision === "add" ? {
        stage: "day_allocation", boardConfirmed: false,
        assignments: draft.assignments.map((item) => ({ ...item, status: "provisional" as const })), dayEstimates: [], scheduleConflicts: [], freeTimeDecisions: [],
        reviewRequired: [...new Set([...(draft.reviewRequired || []), "路线"])],
      } : { freeTimeDecisions: defaultFreeTimePolicies(estimates, decisionsOf(draft)).map((item) => item.day === body.day ? { ...item, source: "user", estimateFingerprint: estimatePolicyFingerprint(estimate) } : item) };
    } else {
      if (draft.scheduleConflicts?.length) return json(await payload(handoff, draft, { error: { code: "SCHEDULE_CONFLICTS_REQUIRED", message: "请先处理下面各日的时间冲突，再生成地图。" } }), 422);
      const estimates = estimatesOf(draft);
      if (estimates.length !== handoff.dates.days || draft.stage !== "route") return json({ error: { code: "ESTIMATES_REQUIRED", message: "请先核算所有旅行日。" }, draft }, 422);
      for (const estimate of estimates) if (!estimate.scheduledDay || estimate.inputFingerprint !== await planningDayInputFingerprint(handoff, draft, estimate.day)) return json({ error: { code: "ESTIMATES_STALE", message: "核算依据已过期，请先重新核算所有旅行日。" }, draft }, 409);
      const reviewed = await reconcileFlightReviews(handoff, draft, (day) => planningDayInputFingerprint(handoff, draft, day));
      const readyDraft = await planningDraftWithReadiness(handoff, { ...draft, ...reviewed });
      const requiredReview = readyDraft.pendingReviews || [];
      if (requiredReview.length) return json({ error: { code: "REVIEW_REQUIRED", message: `请先复核：${requiredReview.map((item) => item.message).join("、")}。` }, draft: readyDraft }, 409);
      const boundary = derivePlanningStayBoundary(handoff, draft);
      if (boundary.flightMode !== "none" && !boundary.departureOnLastDay && !estimates.at(-1)?.nextDayDepartureTransfer) return json({ error: { code: "DEPARTURE_TRANSFER_REQUIRED", message: "请重新核算次日离境机场交通。" } }, 422);
      const overtime = estimates.find((item) => item.metrics.overtimeMinutes > 0);
      if (overtime) return json({ error: { code: "DAILY_WINDOW_TOO_SHORT", message: `Day ${overtime.day} 超出硬截止约 ${overtime.metrics.overtimeMinutes / 60} 小时，请调整地点或时长。` } }, 422);
      changes = { stage: "complete", freeTimeDecisions: defaultFreeTimePolicies(estimates, decisionsOf(draft)), ...reviewed, reviewRequired: reviewed.reviewRequired.filter((item) => item !== "路线") };
    }
    if (["calculate", "updateDay", "applyMove", "addAttraction"].includes(body.action)) {
      const current = { ...draft, ...changes };
      const reviewed = await reconcileFlightReviews(handoff, current, (day) => planningDayInputFingerprint(handoff, current, day));
      changes = { ...changes, ...reviewed };
      if (unchangedResult && await scheduleFingerprint(reviewed) === await scheduleFingerprint({ reviewItems: draft.reviewItems || [], reviewRequired: draft.reviewRequired || [] })) return json(await payload(handoff, draft, { unchanged: true }));
    }
    if ((changes.dayEstimates || draft.dayEstimates)?.length && body.action !== "decideFreeTime") {
      const estimates = (changes.dayEstimates || draft.dayEstimates) as PlanningDayEstimate[];
      const operationDay = body.attraction?.day || body.overrides?.day || (body.action === "applyMove" && body.moves?.[0].day) || estimates[0].day;
      changes.dayEstimates = estimates.map((estimate) => estimate.day === operationDay ? { ...estimate, lastScheduleOperation: { turnId: body.turnId, fingerprint: requestFingerprint } } : estimate);
    }
    changes.lastScheduleOperation = { turnId: body.turnId, fingerprint: requestFingerprint };
    const result = await timing.measureAsync("state_commit", () => commitPlanningDraft(token, { expectedVersion: draft.version, turnId: body.turnId, nextDraft: nextDraft(draft, changes) }, timing));
    if (!result.committed) return json({ error: { code: "PLANNING_VERSION_CONFLICT", message: "规划已更新，请使用最新结果重试。" }, draft: result.draft }, 409);
    return json(await payload(handoff, result.draft), 200);
  } catch (error) {
    if (error instanceof PlanningAttractionError) return json({ error: { code: error.code, message: error.message } }, 422);
    if (error instanceof PlanningScheduleError) return json({ error: { code: error.code, message: error.message, day: error.day },
      ...(error.conflict ? { conflicts: [error.conflict], ...(error.conflict.capacity ? { capacity: error.conflict.capacity } : {}) } : {}) }, 422);
    return json({ error: { code: "SCHEDULE_FAILED", message: "路线暂时无法核算，请稍后重试。" } }, 502);
  }
}


export async function GET(request: NextRequest) {
  return withPlanningTiming("schedule", "read", (timing) => getScheduleResponse(request, timing));
}
export async function POST(request: NextRequest) {
  return withPlanningTiming("schedule", "request", (timing) => postScheduleResponse(request, timing));
}
