import type { PlanningDraftV1, PlanningHandoffV1 } from "./planning-state";
import { reconcileBoardReviews, reconcileFlightReviews, type PlanningPendingReview } from "./planning-review";
import { PlanningTimeOverrideSchema } from "./planning-time-overrides";
import { effectivePlanningLocalBlocks } from "./planning-local-blocks";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Server-only projection, shared by restoration, confirmation and map compilation. No provider calls. */
export async function planningDraftWithReadiness(handoff: PlanningHandoffV1, draft: PlanningDraftV1): Promise<PlanningDraftV1> {
  let current = { ...draft, ...await reconcileBoardReviews(handoff, draft) };
  const pending: PlanningPendingReview[] = [];
  const add = (item: PlanningPendingReview) => { if (!pending.some((old) => old.kind === item.kind && old.day === item.day && old.message === item.message)) pending.push(item); };
  if (current.reviewItems.some((item) => item.kind === "board" && item.status === "pending")) add({ kind: "board", message: "地点与分天待复核", targetStage: "day_allocation" });
  if (!current.flightSelection) add({ kind: "flight", message: "请确认航班安排", targetStage: "flights" });
  if (!current.stayConfirmed) add({ kind: "stay", message: "请确认住宿安排", targetStage: "stays" });
  const stale: number[] = [];
  if (current.stage === "route" || current.stage === "complete") {
    const { planningDayInputFingerprint, derivePlanningStayBoundary } = await import("./planning-trip");
    let departureOnLastDay = false;
    try { departureOnLastDay = derivePlanningStayBoundary(handoff, current).departureOnLastDay; } catch { /* Existing boundary validation owns this error. */ }
    const fingerprints = new Map<number, string>();
    for (let day = 1; day <= handoff.dates.days; day++) {
      try { fingerprints.set(day, await planningDayInputFingerprint(handoff, current, day)); } catch { /* Missing upstream data is already a blocker. */ }
    }
    const reviewed = await reconcileFlightReviews(handoff, current, async (day) => fingerprints.get(day) || "");
    current = { ...current, ...reviewed };
    for (let day = 1; day <= handoff.dates.days; day++) {
      const estimate = current.dayEstimates?.find((item) => item.day === day);
      const metrics = record(estimate?.metrics);
      const override = PlanningTimeOverrideSchema.safeParse(current.scheduleOverrides?.find((item) => item.day === day));
      const blocks = override.success ? effectivePlanningLocalBlocks(override.data, { departure: departureOnLastDay && day === handoff.dates.days }) : [];
      if (blocks.some((block) => !block.anchor)) add({ kind: "local_block_position", message: `Day ${day} 已保存的安排需要选择时间轴位置`, targetStage: "route", day });
      const date = new Date(`${handoff.dates.start}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + day - 1);
      if (!estimate?.scheduledDay) add({ kind: "schedule_missing", message: `Day ${day} 尚未完成时间核算`, targetStage: "route", day });
      else if (metrics.travelSource === "user" || record(estimate.transport).source === "user" || estimate.date !== date.toISOString().slice(0, 10) || !fingerprints.get(day) || estimate.inputFingerprint !== fingerprints.get(day) ||
          current.flightSelection?.mode !== "none" && (day === 1 || day === handoff.dates.days) && !estimate.journey) {
        stale.push(day); add({ kind: "schedule_stale", message: `Day ${day} 核算依据已更新，请重新核算`, targetStage: "route", day });
      }
      if (estimate && record(estimate.transport).status !== "complete") add({ kind: "transport", message: `Day ${day} 地面交通尚未完整核实`, targetStage: "route", day });
      if (Number(metrics.overtimeMinutes) > 0) add({ kind: "overtime", message: `Day ${day} 超过最晚时间限制`, targetStage: "route", day });
      if (current.scheduleConflicts?.some((item) => item.day === day)) add({ kind: "schedule_conflict", message: `Day ${day} 仍有时间冲突`, targetStage: "route", day });
    }
    try {
      const boundary = derivePlanningStayBoundary(handoff, current);
      if (boundary.flightMode !== "none" && !boundary.departureOnLastDay && !current.dayEstimates?.find((item) => item.day === handoff.dates.days)?.nextDayDepartureTransfer)
        add({ kind: "departure_transfer", message: "次日离境机场交通待核算", targetStage: "route", day: handoff.dates.days });
    } catch { /* Upstream validation remains blocking. */ }
  }
  for (const message of current.reviewRequired || []) {
    if (message === "路线" || message === "地点与分天" && !current.reviewItems.some((item) => item.kind === "board" && item.status === "pending")) continue;
    if (message === "地点与分天") continue; // The typed board item above owns this exact legacy notice.
    add({ kind: message === "航班" ? "flight" : /住宿|预算/.test(message) ? "stay" : "review", message: `${message}待复核`, targetStage: message === "航班" ? "flights" : /住宿|预算/.test(message) ? "stays" : "route" });
  }
  for (const item of current.reviewItems.filter((item) => item.status === "pending" && item.kind !== "board")) {
    add({ kind: item.kind, message: `Day ${item.day} ${item.kind === "flight_arrival" ? "抵达后安排" : item.kind === "flight_departure" ? "离境前安排" : item.kind === "budget" ? "预算" : item.kind === "stay" ? "住宿" : item.kind === "opening" ? "开放时间" : "路线"}待核对`, targetStage: item.kind === "budget" || item.kind === "stay" ? "stays" : "route", day: item.day });
  }
  if ((current.stage === "route" || current.stage === "complete") && current.dayEstimates?.length) {
    const { projectPlanningDayAdvice } = await import("./planning-trip");
    current = { ...current, dayEstimates: current.dayEstimates.map((estimate) => projectPlanningDayAdvice(handoff, current,
      estimate as import("./planning-trip").PlanningDayEstimate,
      !stale.includes(Number(estimate.day)) && !pending.some((item) => item.day === estimate.day && ["schedule_missing", "transport", "schedule_conflict"].includes(item.kind)))) };
  }
  return { ...current, pendingReviews: pending, staleScheduleDays: stale, scheduleReady: (current.stage === "route" || current.stage === "complete") && pending.length === 0 };
}
