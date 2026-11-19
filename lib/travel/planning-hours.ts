import type { VisitWindowFailure } from "./planning-conflicts";

export type OpeningHoursAssessment =
  | { status: "open" }
  | { status: "closed"; reason: string }
  | { status: "unknown"; reason: string };

type HoursDay = { kind: "closed" | "all_day" | "ranges"; ranges: Array<[number, number]> };

export type PlanningDayPeriod = "morning" | "afternoon" | "flexible";
export type RegularVisitPlan =
  | { status: "scheduled" | "unknown"; startMinute: number; waitMinutes: number; openingWaitMinutes?: number; periodFreeMinutes?: number; openingHours: string | null; reason: string | null }
  | { status: "closed"; openingHours: string | null; reason: string; failure?: VisitWindowFailure };

const DAY_NAMES = [
  ["Sunday", "星期日", "星期天", "周日", "周天", "礼拜日", "礼拜天"],
  ["Monday", "星期一", "周一", "礼拜一"],
  ["Tuesday", "星期二", "周二", "礼拜二"],
  ["Wednesday", "星期三", "周三", "礼拜三"],
  ["Thursday", "星期四", "周四", "礼拜四"],
  ["Friday", "星期五", "周五", "礼拜五"],
  ["Saturday", "星期六", "周六", "礼拜六"],
];

function normalized(value: string): string {
  return value.replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, " ")
    .replace(/[–—−]/g, "-")
    .replace(/a\.?m\.?/gi, "AM")
    .replace(/p\.?m\.?/gi, "PM")
    .trim();
}

function dayAndBody(value: string): { day: number; body: string } | null {
  const text = normalized(value);
  for (let day = 0; day < DAY_NAMES.length; day += 1) {
    for (const label of DAY_NAMES[day]) {
      if (!text.toLowerCase().startsWith(label.toLowerCase())) continue;
      const next = text.slice(label.length, label.length + 1);
      if (/[a-z]/i.test(next)) continue;
      return { day, body: text.slice(label.length).replace(/^\s*[:：]\s*/, "").trim() };
    }
  }
  return null;
}

function timeMinutes(raw: string): number | null {
  const match = normalized(raw).match(/^(上午|下午|凌晨|中午|晚上|AM|PM)?\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return null;
  const prefix = match[1]?.toLowerCase();
  const suffix = match[4]?.toLowerCase();
  if (prefix && suffix) return null;
  const hour = Number(match[2]);
  const minute = Number(match[3] || 0);
  if (minute > 59) return null;
  const marker = prefix || suffix;
  if (marker) {
    if (hour < 1 || hour > 12) return null;
    if (marker === "am" || marker === "上午" || marker === "凌晨") return (hour % 12) * 60 + minute;
    if (marker === "pm" || marker === "下午" || marker === "晚上") return ((hour % 12) + 12) * 60 + minute;
    if (marker === "中午") return (hour === 12 ? 12 : hour) * 60 + minute;
  }
  if (hour > 24 || hour === 24 && minute !== 0) return null;
  return hour * 60 + minute;
}

const CLOCK = String.raw`(?:上午|下午|凌晨|中午|晚上|AM|PM)?\s*\d{1,2}(?::\d{2})?\s*(?:AM|PM)?`;
const RANGE = new RegExp(`(${CLOCK})\\s*(?:-|~|至|到)\\s*(${CLOCK})`, "gi");

function parseDay(body: string): HoursDay | null {
  if (/营业时间可能|营业时间有所|Hours might differ|Holiday hours|特殊营业/i.test(body)) return null;
  if (/^(?:Closed(?: all day)?|休息|休業|歇业|不营业|关闭|暂停营业)$/i.test(body)) {
    return { kind: "closed", ranges: [] };
  }
  if (/^(?:Open 24 hours|24\s*小时营业|全天营业|24小时开放)$/i.test(body)) {
    return { kind: "all_day", ranges: [[0, 1440]] };
  }
  const ranges: Array<[number, number]> = [];
  const normalizedBody = normalized(body);
  for (const match of normalizedBody.matchAll(RANGE)) {
    const left = match[1];
    const right = match[2];
    const hasMeridiem = (value: string) => /AM|PM|上午|下午|凌晨|中午|晚上/i.test(value);
    if (hasMeridiem(left) !== hasMeridiem(right)) return null;
    const start = timeMinutes(left);
    const end = timeMinutes(right);
    if (start === null || end === null || start === end) return null;
    ranges.push([start, end <= start ? end + 1440 : end]);
  }
  if (normalizedBody.replace(RANGE, "").replace(/[,，、;；\s]/g, "")) return null;
  return ranges.length ? { kind: "ranges", ranges } : null;
}

function scheduledMinutes(clock: string): number | null {
  if (!/^\d{2,3}:[0-5]\d$/.test(clock)) return null;
  const [hours, minutes] = clock.split(":").map(Number);
  return hours * 60 + minutes;
}

/** A display label for the travel date's weekday, without claiming holiday-specific hours. */
export function regularOpeningHoursLabel(weekdayDescriptions: string[], visitDate: string): string | null {
  const date = new Date(`${visitDate}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== visitDate) return null;
  for (const line of weekdayDescriptions) {
    const parsed = dayAndBody(line);
    if (parsed?.day === date.getUTCDay()) return parsed.body || null;
  }
  return null;
}

/** Find a feasible start in Google's regular weekly hours before assigning exact internal minutes. */
export function planRegularVisit(input: {
  weekdayDescriptions: string[];
  visitDate: string;
  arrivalMinute: number;
  durationMinutes: number;
  preferredPeriod?: PlanningDayPeriod;
  periodStrength?: "soft" | "hard";
}): RegularVisitPlan {
  const date = new Date(`${input.visitDate}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input.visitDate ||
      !Number.isFinite(input.arrivalMinute) || input.arrivalMinute < 0 ||
      !Number.isFinite(input.durationMinutes) || input.durationMinutes < 1) {
    return { status: "closed", openingHours: null, reason: "日期或游玩时长无效，无法核对营业时间" };
  }
  const descriptions = new Map<number, string>();
  for (const line of input.weekdayDescriptions) {
    const parsed = dayAndBody(line);
    if (parsed && !descriptions.has(parsed.day)) descriptions.set(parsed.day, parsed.body);
  }
  const weekday = date.getUTCDay();
  const todayBody = descriptions.get(weekday);
  const today = todayBody === undefined ? null : parseDay(todayBody);
  const openingHours = todayBody || null;
  const strictPeriod = input.periodStrength !== "soft";
  const periodStart = strictPeriod && input.preferredPeriod === "afternoon" ? 12 * 60 : 0;
  const earliest = Math.max(input.arrivalMinute, periodStart);
  if (!today) {
    return {
      status: "unknown", startMinute: earliest, waitMinutes: earliest - input.arrivalMinute,
      openingWaitMinutes: 0, periodFreeMinutes: earliest - input.arrivalMinute,
      openingHours: null, reason: "Google 未提供可判断的当日常规开放时间，出发前请核实",
    };
  }
  const priorBody = descriptions.get((weekday + 6) % 7);
  const prior = priorBody === undefined ? null : parseDay(priorBody);
  const spans = today.ranges.slice();
  if (prior) spans.push(...prior.ranges.filter(([, close]) => close > 1440)
    .map(([open, close]) => [open - 1440, close - 1440] as [number, number]));
  const candidates = spans.map(([open, close]) => ({ start: Math.max(earliest, open), open, close }))
    .filter(({ start, close }) => start + input.durationMinutes <= close && start + input.durationMinutes <= 1440)
    .filter(({ start }) => !strictPeriod || input.preferredPeriod !== "morning" || start < 12 * 60)
    .sort((a, b) => a.start - b.start);
  if (candidates.length) {
    const startMinute = candidates[0].start;
    const openingWaitMinutes = Math.max(0, candidates[0].open - input.arrivalMinute);
    return { status: "scheduled", startMinute, waitMinutes: startMinute - input.arrivalMinute, openingWaitMinutes,
      periodFreeMinutes: Math.max(0, startMinute - input.arrivalMinute - openingWaitMinutes), openingHours, reason: null };
  }
  const period = input.preferredPeriod === "morning" ? "上午" : input.preferredPeriod === "afternoon" ? "下午" : "当日";
  const actualClose = spans.length ? Math.max(...spans.map(([, close]) => close)) : null;
  const lastClose = actualClose === null ? null : Math.min(actualClose, 1440);
  const planningLimited = spans.some(([open, close]) => {
    const start = Math.max(earliest, open);
    return close > 1440 && start + input.durationMinutes > 1440 && (!strictPeriod || input.preferredPeriod !== "morning" || start < 720);
  });
  const latestFeasibleStart = spans.filter(([open, close]) => close - open >= input.durationMinutes)
    .map(([open, close]) => Math.min(close, 1440) - input.durationMinutes)
    .sort((a, b) => b - a)[0] ?? null;
  const unrestrictedFits = spans.some(([open, close]) => Math.max(input.arrivalMinute, open) + input.durationMinutes <= Math.min(close, 1440));
  const reasonCode: VisitWindowFailure["reasonCode"] = today.kind === "closed" ? "closed_day"
    : strictPeriod && unrestrictedFits ? "period_conflict"
    : latestFeasibleStart !== null && input.arrivalMinute > latestFeasibleStart ? "arrival_too_late" : "duration_exceeds_opening";
  return {
    status: "closed", openingHours,
    failure: { reasonCode, arrivalMinute: input.arrivalMinute, earliestVisitStart: earliest,
      visitMinutes: input.durationMinutes, openingIntervals: spans, latestFeasibleStart, closingMinute: actualClose,
      actualClosingMinute: actualClose, planningCutoffMinute: 1440, limitingBoundary: planningLimited ? "planning_day" : "opening",
      missingMinutes: lastClose === null ? null : Math.max(0, earliest + input.durationMinutes - lastClose),
      effectivePeriod: input.preferredPeriod || "flexible" },
    reason: today.kind === "closed"
      ? "Google 常规信息显示该日不开放；请换日期或地点"
      : planningLimited ? "按当前安排，无法在当天核算上限前完成；这不代表场馆在午夜闭馆"
      : reasonCode === "arrival_too_late" ? "按当前到达时间，闭馆前不足以完成当前安排的游玩时长"
      : reasonCode === "period_conflict" ? `当前安排与${period}时段要求冲突；请确认是否调整时段`
      : `${period}没有足以完成当前安排游玩时长的开放窗口；请调整日期或停留时长`,
  };
}

/** A conservative check against Google's regular weekly descriptions, not a promise for the travel date. */
export function assessRegularOpeningHours(input: {
  weekdayDescriptions: string[];
  visitDate: string;
  startTime: string;
  endTime: string;
}): OpeningHoursAssessment {
  const start = scheduledMinutes(input.startTime);
  const end = scheduledMinutes(input.endTime);
  const date = new Date(`${input.visitDate}T00:00:00Z`);
  if (start === null || end === null || end < start || end > 1440 || !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== input.visitDate) {
    return { status: "unknown", reason: "无法据现有时刻核对常规营业时间" };
  }
  const descriptions = new Map<number, string>();
  for (const line of input.weekdayDescriptions) {
    const parsed = dayAndBody(line);
    if (parsed && !descriptions.has(parsed.day)) descriptions.set(parsed.day, parsed.body);
  }
  const weekday = date.getUTCDay();
  const todayBody = descriptions.get(weekday);
  const today = todayBody === undefined ? null : parseDay(todayBody);
  if (!today) return { status: "unknown", reason: "Google 未提供可判断的当日常规营业时间" };
  const priorBody = descriptions.get((weekday + 6) % 7);
  const prior = priorBody === undefined ? null : parseDay(priorBody);
  const spans = today.ranges.slice();
  if (prior) spans.push(...prior.ranges.filter(([, close]) => close > 1440).map(([open, close]) => [open - 1440, close - 1440] as [number, number]));
  const covered = spans.some(([open, close]) => start >= open && end <= close);
  if (covered) return { status: "open" };
  if (!prior && start < 8 * 60) {
    return { status: "unknown", reason: "缺少前一日深夜营业信息，无法确认凌晨时段" };
  }
  return {
    status: "closed",
    reason: today.kind === "closed" ? "Google 常规营业信息显示该日休息" : "预计到访时段不在 Google 常规营业范围内",
  };
}
