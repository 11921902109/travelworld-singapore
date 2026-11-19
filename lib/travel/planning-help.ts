import { deriveFlightJourney } from "./planning-flight-journey";
import { planningHelpQuestions, type PlanningHelpStage } from "./planning-help-questions";
import type { PlanningDraftV1, PlanningHandoffV1 } from "./planning-state";
import { flightDayWindowLocks } from "./planning-time-overrides";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 160) => typeof value === "string" ? value.trim().slice(0, max) : "";
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const list = (value: unknown) => Array.isArray(value) ? value.map(record) : [];
const minutes = (value: number) => value >= 60 ? `${Math.floor(value / 60)} 小时${value % 60 ? ` ${value % 60} 分钟` : ""}` : `${value} 分钟`;
const clock = (value: unknown) => text(value, 20);
const local = (value: unknown) => clock(value).replace("T", " ");
const normalize = (value: string) => value.toLowerCase().replace(/[\s\p{P}]/gu, "");
const yes = (items: string[]) => items.filter(Boolean).join("、");

export function planningHelpFacts(handoff: PlanningHandoffV1, draft: PlanningDraftV1, day?: number) {
  const candidates = new Map<string, string>();
  for (const candidate of draft.candidates) {
    const name = text(candidate.name, 100);
    if (!name) continue;
    for (const id of [text(candidate.id, 255), text(candidate.placeId, 255)]) if (id) candidates.set(id, name);
  }
  const selectedIds = [...new Set(draft.selectedPlaceIds ?? draft.assignments.flatMap((item) => item.orderedCandidateIds))];
  const assignedIds = new Set(draft.assignments.flatMap((item) => item.orderedCandidateIds));
  const selection = draft.flightSelection;
  const journey = selection && selection.mode !== "none" ? deriveFlightJourney(selection) : null;
  const estimate = day === undefined ? undefined : draft.dayEstimates?.find((item) => item.day === day);
  const conflict = day === undefined ? undefined : draft.scheduleConflicts?.find((item) => item.day === day);
  const stale = day !== undefined && (draft.staleScheduleDays?.includes(day) || draft.pendingReviews?.some((item) => item.day === day && ["schedule_missing", "transport", "schedule_conflict"].includes(item.kind)));
  const currentEstimate = estimate?.scheduledDay && !stale && !conflict ? estimate : undefined;
  const metrics = record(currentEstimate?.metrics);
  const effectiveWindow = record(currentEstimate?.effectiveWindow);
  const preference = record(currentEstimate?.dailyWindow);
  const stops = list(record(currentEstimate?.scheduledDay).stops);
  const staySegments = (draft.staySegments || []).map((segment) => ({
    startDay: number(segment.startDay), checkIn: clock(segment.checkInDate), checkOut: clock(segment.checkOutDate), area: text(segment.area, 100),
    hotel: text(record(segment.hotel).name, 100),
  }));
  const locks = flightDayWindowLocks(day ?? 0, handoff.dates.days, selection?.mode);
  return {
    stage: draft.stage,
    routeDay: day,
    conditions: {
      destination: "新加坡", dates: handoff.dates, partySize: handoff.travelers.total, pace: handoff.pace,
      dailyWindow: { start: handoff.dailyWindow.start, preferredReturn: handoff.dailyWindow.preferredReturn,
        latestReturn: handoff.dailyWindow.latestReturn, returnStrength: handoff.dailyWindow.returnConstraint?.strength ?? "hard" },
      interests: handoff.preferences.interests.slice(0, 8), mustVisit: handoff.preferences.mustVisit.slice(0, 8),
      avoid: handoff.preferences.avoid.slice(0, 8), mobility: handoff.preferences.mobilityConstraints.slice(0, 5),
      accommodationArea: handoff.accommodationPreference?.areaName ?? null,
    },
    places: {
      candidateCount: draft.candidates.length, confirmed: draft.placesConfirmed === true,
      selected: selectedIds.slice(0, 24).flatMap((id) => candidates.get(id) || []),
      selectedCount: selectedIds.length,
      unassigned: selectedIds.filter((id) => !assignedIds.has(id)).slice(0, 24).flatMap((id) => candidates.get(id) || []),
      unassignedCount: selectedIds.filter((id) => !assignedIds.has(id)).length,
    },
    board: { confirmed: draft.boardConfirmed, days: draft.assignments.map((item) => ({ day: item.day, count: item.orderedCandidateIds.length, purpose: item.dayPurpose })) },
    flights: {
      mode: text(selection?.mode, 20) || "unconfirmed",
      arrival: journey?.outbound.arrival.localDateTime ?? null,
      departure: journey?.inbound.departure.localDateTime ?? null,
      airportArrival: text(journey?.outbound.arrival.airport?.name, 100), airportDeparture: text(journey?.inbound.departure.airport?.name, 100),
      reviewPending: Boolean(draft.reviewRequired?.includes("航班")),
    },
    stays: { confirmed: draft.stayConfirmed === true, segments: staySegments, skipped: draft.stayConfirmed === true && !staySegments.length },
    time: {
      locked: locks.start || locks.end, startLocked: locks.start, endLocked: locks.end,
      status: conflict ? "conflict" : currentEstimate ? "estimated" : estimate ? "stale" : "not_estimated",
      savedConflict: text(conflict?.message, 420),
      freeMinutes: number(metrics.freeMinutes), overtimeMinutes: number(metrics.overtimeMinutes), travelMinutes: number(metrics.travelMinutes),
      effectiveStart: clock(effectiveWindow.start), effectiveEnd: clock(effectiveWindow.returnBy),
      preferredEnd: clock(preference.preferredReturn), latestEnd: clock(preference.latestReturn),
      hotelStops: stops.filter((stop) => stop.kind === "hotel").slice(0, 4).map((stop) => ({ name: text(stop.name, 100), time: clock(stop.time) })),
      airportProcessMinutes: number(record(currentEstimate?.journey).airportProcessMinutes),
      stops: stops.filter((stop) => stop.kind === "sight" || stop.kind === "food").slice(0, 12)
        .map((stop) => ({ name: text(stop.name, 100), time: clock(stop.time) })),
    },
  } as const;
}

export function directPlanningHelp(question: string, facts: ReturnType<typeof planningHelpFacts>): string | null {
  const stage = facts.stage;
  if (stage === "complete") return null;
  const normalized = normalize(question);
  const routeDay = facts.routeDay ? `Day ${facts.routeDay}` : "当前日";
  const actionPattern = /^(?:(?:请|可以|能不能|能否|麻烦)?(?:你)?(?:直接)?(?:帮我|替我|给我|帮忙)?(?:把|将)\s*.+?(?:改成|改为|切换|设为|移到|换成|提前|推迟|删掉))|^(?:请|帮我|替我|直接|麻烦)(?:帮我|替我|直接)?(?:修改|保存|应用|确认|重算|选择|预订|订|删除|移除|加上|新增|换|查价|搜|查询)|^(?:修改|保存|确认|删除|移除|新增|预订|重算)\s*(?:day|第|本日|当天|行程|酒店|航班|住宿|景点)|^改(?:一下|成|到)/i;
  if (actionPattern.test(question) && !/^(?:为什么|如何|怎么|在哪里)/.test(question)) {
    if (/出发|结束|返回|返店|时间|几点|时刻|\bday\s*[1-7]/i.test(question) && !/机票|航班/.test(question))
      return stage === "route" ? "我没有修改行程。请在右侧选中对应日期，再点「时间修改」；航旅锁定日会说明不可编辑的原因。" : "我没有修改行程。到「时间核算」阶段后，可选中对应日期并点击「时间修改」。";
    return "我没有执行操作。这里仅解释当前规划；请在右侧相应步骤选择、查询或保存。";
  }
  if (/^(?:(?:请|帮我|替我|直接)*)?(?:查|查一下|搜索|看看)?(?:最新|实时).*(?:价格|库存|报价|有房)/.test(question) || /(?:查|搜索|告诉我).*(?:最新|实时)(?:价格|库存|报价)/.test(question))
    return "帮助不查询实时价格、库存或新路线。请在右侧相应步骤查看已有结果，或使用该步骤的查询入口。";

  const questions = planningHelpQuestions({ handoffId: "", stage: stage as PlanningHelpStage, day: facts.routeDay, locked: facts.time.locked });
  const activeQuestion = questions.map(normalize).indexOf(normalized);
  const selectedPlaces = () => facts.places.selectedCount
    ? `已保存 ${facts.places.selectedCount} 处地点${facts.places.selected.length ? `：${yes(facts.places.selected)}` : ""}。${facts.places.confirmed ? "地点清单已确认。" : "尚未确认清单；未保存的勾选以右侧为准。"}`
    : "当前还没有已保存的所选地点；如果你刚在右侧勾选，请以右侧尚未确认的选择为准。";
  const stayStatus = () => {
    if (facts.stays.skipped) return "当前规划无需过夜住宿。";
    const segments = facts.stays.segments;
    if (!segments.length) return "还没有保存住宿段，请在住宿步骤先确认入住／退房日期和分段。";
    const pending = segments.filter((segment) => !segment.hotel);
    if (pending.length) return `已有住宿段，但 ${pending.map((item) => `${item.checkIn || `Day ${item.startDay}`}${item.checkOut ? ` 至 ${item.checkOut}` : ""}`).join("、")} 还没选定酒店。`;
    return facts.stays.confirmed ? "规划中的住宿已确认；这不代表已订房。" : "各段已选酒店，但尚未完成住宿确认。";
  };
  const flightStatus = () => {
    if (facts.flights.mode === "none") return "当前规划记录为无需航班。";
    if (!facts.flights.arrival || !facts.flights.departure) return "目前还没有已确认的抵离时刻。航班查询候选不代表已选定或已订票。";
    const status = facts.flights.mode === "manual" ? "已填写" : "已选择";
    return `${status}：${local(facts.flights.arrival)} 抵达、${local(facts.flights.departure)} 离开新加坡（当地时间）。${facts.flights.reviewPending ? "当前航班安排仍待复核。" : ""}此处不代表已订票。`;
  };
  if (/^(酒店|住宿)(已经|已|现在)?确认(了)?(吗|没有)?$/.test(normalized)) return stayStatus();
  if (/^(我)?(已经|已|现在)?(确认|选定)了?(哪些|什么)航班(信息)?$/.test(normalized)) return flightStatus();
  if (/^(我)?(已经|已)?选了哪些地点$/.test(normalized)) return selectedPlaces();

  if (stage === "places") {
    if (activeQuestion === 0) {
      const interests = yes(facts.conditions.interests), must = yes(facts.conditions.mustVisit);
      return interests || must
        ? `主要参考你确认的${interests ? `兴趣：${interests}` : ""}${interests && must ? "；" : ""}${must ? `必去：${must}` : ""}，也会结合旅行节奏和避开项。具体理由见右侧候选卡片。`
        : "当前没有已确认的具体兴趣或必去点。可以在右侧查看按当前旅行条件得到的候选及推荐理由。";
    }
    if (activeQuestion === 1) return selectedPlaces();
    if (activeQuestion === 2) return "在右侧确认所选地点，然后进入分天板，将想去的地方分配到每一天。";
  }
  if (stage === "day_allocation") {
    if (activeQuestion === 0) return facts.places.unassignedCount
      ? `已保存规划中仍有 ${facts.places.unassignedCount} 处地点未分天${facts.places.unassigned.length ? `：${yes(facts.places.unassigned)}` : ""}。未保存调整以右侧分天板为准。`
      : "已保存规划中没有尚未分天的所选地点。未保存调整以右侧分天板为准。";
    if (activeQuestion === 1) {
      const max = Math.max(0, ...facts.board.days.map((item) => item.count));
      return max ? `以已保存分天为准，${facts.board.days.filter((item) => item.count === max).map((item) => `Day ${item.day}`).join("、")}最多，每天 ${max} 处地点。` : "已保存的分天安排里还没有地点，暂时没有最多的一天。";
    }
    if (activeQuestion === 2) return "可以把这一天明确设为休息／自由日，不必强行加地点。确认分天前请处理所有仍未安排的已选地点，并按右侧空白日提示确认。";
  }
  if (stage === "flights") {
    if (activeQuestion === 0) return flightStatus();
    if (activeQuestion === 1) return `${facts.flights.arrival ? `已保存的抵达时刻为 ${local(facts.flights.arrival)}（新加坡时间）。` : "当前还没有已确认的抵达时刻。"}抵达首日的活动窗口要在入境取行李预留之后开始；到酒店和景点的地面交通再单独核算。`;
    if (activeQuestion === 2) return "在右侧航班步骤点「已订，填写时刻」，按已订机票填写去、回程的起飞和抵达时刻，再确认保存。";
  }
  if (stage === "stays") {
    if (activeQuestion === 0) return facts.stays.segments.length
      ? `已保存住宿段：${facts.stays.segments.map((item, index) => `第 ${index + 1} 段 ${item.checkIn || "入住待定"} 入住、${item.checkOut || "退房待定"} 退房`).join("；")}。`
      : stayStatus();
    if (activeQuestion === 1) return stayStatus();
    if (activeQuestion === 2) return "酒店决定当天出发和返回的地点；换住日可能从前一段酒店出发、到后一段酒店结束。住宿改变后，相关地面交通和时间需要重新核算。";
  }
  if (stage === "route") {
    if (activeQuestion === 0) {
      if (!facts.routeDay) return "请先在右侧选中要查看的旅行日。";
      if (facts.time.freeMinutes === null) return `${routeDay} 暂无有效的已保存余量。请查看右侧核算状态；旧结果和未保存修改都不是当前余量。`;
      if (facts.time.overtimeMinutes && facts.time.overtimeMinutes > 0) return `${routeDay} 已超出允许时间约 ${minutes(facts.time.overtimeMinutes)}，先调整安排，不能把零余量当作已通过。`;
      return `${routeDay} 按已保存核算尚有约 ${minutes(facts.time.freeMinutes)} 未分配。能否加入新活动仍需检查插入位置、交通和营业窗口。`;
    }
    if (activeQuestion === 1 || /^(这一天可以修改哪些时间|为什么这一天的出发时间不能改|在哪里修改(?:day[1-7]|这一天)的出发时间)$/.test(normalized)) {
      const { startLocked, endLocked } = facts.time;
      if (startLocked && endLocked) return `${routeDay} 的当地出发和结束均按当天的抵离航班和机场预留核算。调整航班请使用「修改机票」。`;
      if (startLocked) return `${routeDay} 的出发由抵达航班和机场预留核算。可在「时间修改」里调整结束时间，然后「保存并核算本日」。`;
      if (endLocked) return `${routeDay} 的结束须符合返程航班和机场预留。可在「时间修改」里调整出发时间，然后「保存并核算本日」。`;
      return "在右侧选中日期、点击「时间修改」，编辑出发或结束时间，然后「保存并核算本日」。";
    }
    if (activeQuestion === 2 || /^为什么(?:day[1-7]|这一天)没保存成功$/.test(normalized) || normalized === "保存失败后我刚填的内容还在吗")
      return /失败|没保存/.test(question)
        ? facts.time.savedConflict || "本次未保存的修改不会覆盖原安排，输入保留在右侧。具体失败原因请看那一天的「保存并核算本日」旁；我不能把上次结果当成这次尝试的原因。"
        : "保存本日时间只核算这一天，不会修改其他日、已选机票或酒店。";
  }
  return null;
}
