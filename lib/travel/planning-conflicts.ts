export type VisitWindowFailure = {
  reasonCode: "closed_day" | "arrival_too_late" | "period_conflict" | "duration_exceeds_opening" | "invalid_input";
  arrivalMinute: number;
  earliestVisitStart: number;
  visitMinutes: number;
  openingIntervals: Array<[number, number]>;
  latestFeasibleStart: number | null;
  closingMinute: number | null;
  actualClosingMinute?: number | null;
  planningCutoffMinute?: number;
  limitingBoundary?: "opening" | "planning_day";
  missingMinutes: number | null;
  effectivePeriod: "morning" | "afternoon" | "flexible";
};

export type PlanningScheduleConflict = {
  code: string;
  day: number;
  date: string;
  message: string;
  draftVersion: number;
  placeId?: string;
  placeName?: string;
  openingHours?: string | null;
  visitSource?: "user" | "bailian";
  periodStrength?: "soft" | "hard";
  periodSource?: string;
  arrivalAt?: string | null;
  arrivalSource?: "user" | "bailian";
  preferredStartTime?: string;
  effectiveStartTime?: string;
  startBoundaryOnly?: boolean;
  airportReserveMinutes?: number;
  hotelMinutes?: number;
  routeMinutes?: number;
  earlierVisitMinutes?: number;
  window?: VisitWindowFailure;
  suggestedDay?: number;
  capacity?: import("./planning-capacity").PlanningCapacityAssessment;
};

export type ScheduleMoveRequest = { day: number; placeId: string; targetDay: number; targetPeriod?: "morning" | "afternoon" };
export type ScheduleMovePreview = ScheduleMoveRequest & {
  feasible: boolean;
  fingerprint: string;
  conflicts: PlanningScheduleConflict[];
  message: string;
  days: Array<{ day: number; date: string; placeNames: string[]; freeMinutes: number; returnTime: string }>;
  periodChange?: { from: "morning" | "afternoon" | "flexible"; to: "morning" | "afternoon"; strength: "soft" | "hard"; evidence?: string };
};

export type ScheduleMoveBatchPreview = Pick<ScheduleMovePreview, "feasible" | "fingerprint" | "conflicts" | "message" | "days"> & {
  draftVersion: number;
  affectedDays: number[];
  moves: Array<ScheduleMoveRequest & {
    placeName: string;
    fromPeriod: "morning" | "afternoon" | "flexible";
    periodChange?: ScheduleMovePreview["periodChange"];
  }>;
  requiresAcknowledgement: boolean;
};

export function minuteClock(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "待核实";
  const minute = Math.round(value), days = Math.floor(minute / 1440), local = minute % 1440;
  return `${days ? days === 1 ? "次日 " : `${days} 天后 ` : ""}${Math.floor(local / 60).toString().padStart(2, "0")}:${(local % 60).toString().padStart(2, "0")}`;
}

/** Display only: scheduling keeps the original integer-minute evidence. */
export function readableMinutes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "待核实";
  const minutes = Math.round(value), hours = Math.floor(minutes / 60), rest = minutes % 60;
  return hours ? `${hours} 小时${rest ? ` ${rest} 分钟` : ""}` : `${rest} 分钟`;
}

export const periodLabel = (period: "morning" | "afternoon" | "flexible") => period === "morning" ? "上午" : period === "afternoon" ? "下午" : "未指定分区";

/** A venue-only suggestion; the preview must still check every stop, route and deadline. */
export function suggestedPeriodAdjustment(conflict: PlanningScheduleConflict): "morning" | "afternoon" | null {
  const window = conflict.window;
  if (!window || window.reasonCode !== "period_conflict" || window.effectivePeriod === "flexible") return null;
  const target = window.effectivePeriod === "morning" ? "afternoon" : "morning";
  const fits = window.openingIntervals.some(([open, close]) => {
    const start = Math.max(window.arrivalMinute, open, target === "afternoon" ? 720 : 0);
    return start + window.visitMinutes <= Math.min(close, 1440) && (target !== "morning" || start < 720);
  });
  return fits ? target : null;
}

export function conflictPresentation(conflict: PlanningScheduleConflict): {
  title: string; conclusion: string; advisory: boolean; steps: Array<{ title: string; detail: string }>;
} {
  const window = conflict.window;
  const target = suggestedPeriodAdjustment(conflict);
  const titles: Record<string, string> = {
    closed_day: "该日常规信息显示不开放", arrival_too_late: "抵达后无法完成当前参观",
    period_conflict: `${window ? periodLabel(window.effectivePeriod) : "当前时段"}安排需要调整`, duration_exceeds_opening: "完整停留超出开放窗口",
    FLIGHT_DAY_WINDOW_CONFLICT: "航班与当天行动时段冲突",
    DAY_CAPACITY_EXCEEDED: "本日可安排时间不足",
  };
  const title = titles[conflict.code] || "本日安排需要调整";
  let conclusion = conflict.message;
  if (window && !conflict.startBoundaryOnly) {
    const arrival = minuteClock(window.earliestVisitStart), end = minuteClock(window.earliestVisitStart + window.visitMinutes);
    conclusion = conflict.code === "period_conflict"
      ? `最早约 ${arrival} 可到，与已选${periodLabel(window.effectivePeriod)}不符。${target ? `建议先核对改到当天${periodLabel(target)}；完整日程通过后再由你确认。` : "请核对其他分区或日期。"}`
      : conflict.code === "closed_day" ? "Google 常规信息显示当天不开放，建议核对其他日期；特殊日期开放情况仍需复核。"
      : `最早约 ${arrival} 可到，当前停留需 ${readableMinutes(window.visitMinutes)}，预计 ${end} 结束${window.limitingBoundary === "planning_day" ? `，超过当天核算上限 ${minuteClock(window.planningCutoffMinute ?? 1440)}${window.actualClosingMinute !== null && window.actualClosingMinute !== undefined ? `；场馆常规营业结束为 ${minuteClock(window.actualClosingMinute)}` : ""}` : window.closingMinute !== null ? `，常规闭馆 ${minuteClock(window.closingMinute)}` : "，没有足够的完整参观窗口"}${window.missingMinutes ? `，相差约 ${readableMinutes(window.missingMinutes)}` : ""}。请修改本日安排，或核对其他日期。`;
  }
  const steps: Array<{ title: string; detail: string }> = [];
  if (conflict.arrivalAt) steps.push({ title: "抵达新加坡", detail: `${conflict.arrivalAt.replace("T", " ")}（当地时间） · ${conflict.arrivalSource === "user" ? "你填写的机票时刻" : conflict.arrivalSource === "bailian" ? "选中的查询航班" : "当前已填／已选航班"}` });
  if (conflict.airportReserveMinutes) {
    const arrival = conflict.arrivalAt?.match(/T(\d{2}):(\d{2})/);
    const ready = arrival ? minuteClock(Number(arrival[1]) * 60 + Number(arrival[2]) + conflict.airportReserveMinutes) : null;
    steps.push({ title: "机场事务", detail: `入境、行李预留约 ${readableMinutes(conflict.airportReserveMinutes)}${ready ? `，约 ${ready} 后可离开机场` : ""}；系统估算，不含地面交通。` });
  }
  if (conflict.effectiveStartTime) steps.push({ title: "当天开始条件", detail: `${conflict.effectiveStartTime} 开始当地核算${conflict.preferredStartTime ? `；每日出发偏好为 ${conflict.preferredStartTime}，还需满足航班边界` : ""}。` });
  if (conflict.routeMinutes !== undefined || conflict.hotelMinutes !== undefined) steps.push({ title: "前往场馆", detail: [conflict.routeMinutes !== undefined ? `此前地面交通约 ${readableMinutes(conflict.routeMinutes)}（按当前路线分配）` : "地面交通待核实", conflict.hotelMinutes ? `酒店处理约 ${readableMinutes(conflict.hotelMinutes)}（系统估算）` : null, window ? `最早约 ${minuteClock(window.earliestVisitStart)} 到馆` : null].filter(Boolean).join("；") + "。" });
  if (conflict.earlierVisitMinutes) steps.push({ title: "此前地点停留", detail: `${readableMinutes(conflict.earlierVisitMinutes)}；采用本轮已保存安排。` });
  if (window) steps.push({ title: "当前选择", detail: `${periodLabel(window.effectivePeriod)} · 停留 ${readableMinutes(window.visitMinutes)}（${conflict.visitSource === "user" ? "你的设置" : "当前采用的 AI 建议"}）。${conflict.periodStrength === "hard" ? "这是固定要求，改变前须明确确认。" : "改变分区仍需你确认。"}` });
  steps.push({ title: "开放核对", detail: `${conflict.openingHours ? `Google 常规开放：${conflict.openingHours}` : "当日常规开放待核实"}${window && target ? `；从场馆窗口看，${periodLabel(target)}可能容纳本次停留，仍需核对全日交通和截止` : window && window.latestFeasibleStart !== null ? `；完整参观最晚约 ${minuteClock(window.latestFeasibleStart)} 开始` : ""}。` });
  return { title, conclusion, advisory: conflict.code === "period_conflict" && conflict.periodStrength === "soft", steps };
}
