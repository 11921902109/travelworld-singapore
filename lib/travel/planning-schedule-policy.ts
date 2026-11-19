import { hoursLabel } from "./planning-duration";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export async function scheduleFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (item) => item.toString(16).padStart(2, "0")).join("");
}

export type ScheduleEstimateLike = {
  day: number; inputFingerprint?: string; computedAt: string;
  metrics: { freeMinutes: number; overtimeMinutes: number };
};
export type FreeTimePolicy = { day: number; decision: "keep"; source: "default_policy" | "user"; estimateFingerprint: string };

export function estimatePolicyFingerprint(estimate: ScheduleEstimateLike): string {
  return `${estimate.inputFingerprint || estimate.computedAt}:${estimate.metrics.freeMinutes}:${estimate.metrics.overtimeMinutes}`;
}

export function defaultFreeTimePolicies(estimates: ScheduleEstimateLike[], previous: Array<{ day?: unknown; decision?: unknown; source?: unknown; estimateFingerprint?: unknown }> = []): FreeTimePolicy[] {
  return estimates.filter((estimate) => estimate.metrics.overtimeMinutes === 0).map((estimate) => {
    const fingerprint = estimatePolicyFingerprint(estimate);
    const prior = previous.find((item) => item.day === estimate.day && item.decision === "keep" && item.estimateFingerprint === fingerprint);
    return { day: estimate.day, decision: "keep", source: prior?.source === "user" ? "user" : "default_policy", estimateFingerprint: fingerprint };
  });
}

export type DailyTransport = {
  status: "complete" | "unknown"; totalMinutes: number; hotelMinutes: number; airportMinutes: number;
  includesHotelReturn: boolean; source: "google" | "user"; noOuting?: boolean;
};

export function dailyTransportSummary(transport?: DailyTransport): string {
  if (!transport || transport.status !== "complete" || ![transport.totalMinutes, transport.hotelMinutes, transport.airportMinutes].every((value) => Number.isFinite(value) && value >= 0) || transport.hotelMinutes + transport.airportMinutes !== transport.totalMinutes) return "全天交通待估算／待核实";
  if (transport.noOuting && transport.totalMinutes === 0) return "当天未安排外出交通";
  return `约 ${hoursLabel(transport.totalMinutes)}`;
}

export type DailyAdvice = {
  source: "planning_rules"; basisFingerprint: string; load: "rest" | "relaxed" | "balanced" | "busy";
  summary: string; adjustment: { action: "keep" | "optional_add" | "reduce"; reason: string };
  version: 2;
  dayType: "normal" | "arrival" | "departure" | "arrival_departure";
  reasonCode: "estimate_unavailable" | "overloaded" | "rest_day" | "flight_day" | "baggage_unknown" | "recommendation_declined" | "windows_unverified" | "optional_activity" | "keep_balance";
  canSuggestAddition: boolean;
  needsLogisticsCheck: boolean;
  maxContinuousFreeMinutes: number | null;
};

export type PlanningFreeWindow = {
  id: string;
  startTime: string;
  endTime: string;
  minutes: number;
  fromStopId: string;
  toStopId: string;
  kind: "period_gap" | "after_route";
};

export type DailyAdviceInput = {
  fingerprint: string; pace: string; sceneCount: number; visitMinutes: number; travelMinutes: number;
  freeMinutes: number; overtimeMinutes: number; softOverrunMinutes?: number; outdoorCaution?: boolean;
  dayType?: DailyAdvice["dayType"];
  currentEstimate?: boolean;
  transportComplete?: boolean;
  hasConflict?: boolean;
  baggageStatus?: "unknown" | "confirmed";
  freeWindows?: PlanningFreeWindow[];
  recommendationDeclined?: boolean;
};

export function buildDailyAdvice(input: DailyAdviceInput): DailyAdvice {
  const rest = input.sceneCount === 0;
  const busy = input.overtimeMinutes > 0 || (input.softOverrunMinutes || 0) > 30 || input.travelMinutes > 180 || input.outdoorCaution && input.visitMinutes >= 300;
  const dayType = input.dayType || "normal";
  const needsLogisticsCheck = dayType !== "normal" && input.baggageStatus !== "confirmed";
  const windows = input.freeWindows;
  const windowsVerified = Array.isArray(windows) && windows.every((item) => Number.isFinite(item.minutes) && item.minutes > 0)
    && Math.abs(windows.reduce((sum, item) => sum + item.minutes, 0) - input.freeMinutes) < 0.01;
  const maxContinuousFreeMinutes = windowsVerified ? Math.max(0, ...windows.map((item) => item.minutes)) : null;
  const available = input.currentEstimate !== false && input.transportComplete !== false && !input.hasConflict;
  const optional = available && !rest && !busy && dayType === "normal" && !input.recommendationDeclined
    && input.freeMinutes >= (input.pace === "relaxed" ? 180 : input.pace === "intensive" ? 90 : 120)
    && maxContinuousFreeMinutes !== null && maxContinuousFreeMinutes >= 60;
  let reasonCode: DailyAdvice["reasonCode"] = "keep_balance";
  let adjustment: DailyAdvice["adjustment"] = { action: "keep", reason: "建议先保留当前地点与必要余量；用餐和休息可按你的偏好安排。" };
  if (!available) {
    reasonCode = "estimate_unavailable";
    adjustment = { action: "keep", reason: "请先保存并核对当前安排、交通和冲突，再更新本日节奏建议；旧余量不用于推荐加点。" };
  } else if (busy) {
    reasonCode = "overloaded";
    adjustment = { action: "reduce", reason: input.overtimeMinutes > 0 ? "当前超出硬截止，建议减少或移动一处地点，或缩短停留后再确认。" : "这一天交通或体验强度偏高，可减少一处地点或调整区域，让节奏更轻松。" };
  } else if (dayType !== "normal") {
    reasonCode = needsLogisticsCheck ? "baggage_unknown" : "flight_day";
    adjustment = { action: "keep", reason: needsLogisticsCheck
      ? "优先完成当前安排，为酒店、行李及机场接驳保留余量。行李安排尚未明确，暂不主动建议增加景点；你仍可提出活动，再核对实际路径与截止。"
      : "本日涉及抵离与机场安排，默认保留现有余量；行李及接驳按你确认的方式核算。若仍想增加活动，请先核对新增交通、连续空档与机场截止，不自动填满。" };
  } else if (rest) {
    reasonCode = "rest_day";
    adjustment = { action: "keep", reason: "不自动填满休息日，剩余时间默认由你自由安排。" };
  } else if (input.recommendationDeclined) {
    reasonCode = "recommendation_declined";
    adjustment = { action: "keep", reason: "按你不自动推荐更多活动的选择保留余量；需要时仍可自行调整地点。" };
  } else if (!windowsVerified) {
    reasonCode = "windows_unverified";
    adjustment = { action: "keep", reason: `尚有约 ${hoursLabel(input.freeMinutes)} 未分配时间，连续空档尚待核实；如想增加活动，请先重新核算，不能仅用总余量判断能否安排。` };
  } else if (optional) {
    reasonCode = "optional_activity";
    adjustment = { action: "optional_add", reason: `本日还有约 ${hoursLabel(input.freeMinutes)} 未分配时间，最长连续空档约 ${hoursLabel(maxContinuousFreeMinutes!)}。可继续挑选感兴趣的活动，也可以保留自由安排；半日体验或多个地点仍需核对开放时间与新增交通。` };
  }
  return {
    version: 2, source: "planning_rules", basisFingerprint: input.fingerprint,
    dayType, reasonCode, canSuggestAddition: optional, needsLogisticsCheck, maxContinuousFreeMinutes,
    load: rest ? "rest" : busy ? "busy" : input.pace === "relaxed" || input.freeMinutes >= 120 ? "relaxed" : "balanced",
    summary: rest ? "本日保留为休息／自由日，由你决定如何使用时间。" : `${input.sceneCount} 处地点，体验约 ${hoursLabel(input.visitMinutes)}，交通另计；${input.outdoorCaution ? "部分地点需留意步行或室外环境。" : "停留按你的选择预留。"}`,
    adjustment,
  };
}
