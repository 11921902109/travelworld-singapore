import { z } from "zod";
import { PlanningLocalBlockSchema } from "./planning-local-blocks";
export { PlanningLocalBlockSchema, effectivePlanningLocalBlocks } from "./planning-local-blocks";
export type { PlanningLocalBlock, ScheduledPlanningLocalBlock } from "./planning-local-blocks";

export const PlanningBaggageSchema = z.object({
  mode: z.enum(["undecided", "carry", "hotel", "other"]),
  handlingMinutes: z.number().int().min(5).max(120).optional(),
  placeId: z.string().trim().min(1).max(255).optional(),
  // Authoritative Google projection is filled by the server, not accepted from a form.
  storagePlace: z.object({
    placeId: z.string().min(1).max(255), name: z.string().min(1).max(255), address: z.string().max(600),
    location: z.object({ lat: z.number().min(1.12).max(1.5), lng: z.number().min(103.55).max(104.15) }),
    openingHours: z.array(z.string().max(250)).max(14).optional(),
  }).optional(),
}).superRefine((value, context) => {
  if (["hotel", "other"].includes(value.mode) && value.handlingMinutes === undefined)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["handlingMinutes"], message: "请填写每次寄存／取物需要的分钟数（5–120 分钟）。" });
  if (value.mode === "other" && !value.placeId)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["placeId"], message: "请搜索并选择实际寄存地点，不能只输入一个名称。" });
});

const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const PlanningTimeOverrideSchema = z.object({
  day: z.number().int().min(1).max(7),
  dailyWindow: z.object({ start: clock, preferredReturn: clock, latestReturn: clock,
    returnConstraint: z.object({ strength: z.enum(["soft", "hard"]), source: z.enum(["user", "legacy"]), evidence: z.string().max(300).optional() }).optional(),
  }).refine(
    (value) => value.start < value.preferredReturn && value.preferredReturn <= value.latestReturn,
    "返店时间须晚于出发，最晚返店不得早于期望返店。",
  ).refine((value) => {
    const minute = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
    return minute(value.latestReturn) - minute(value.start) <= 18 * 60;
  }, "每天的行动时段最多为 18 小时，请缩短出发与最晚返店之间的时间。").optional(),
  visitMinutesByPlaceId: z.record(z.number().int().min(15).max(480)).optional(),
  includedMealMinutesByPlaceId: z.record(z.number().int().min(0).max(240)).optional(),
  extraMealReserveMinutes: z.number().int().min(0).max(480).optional(),
  personalActivities: z.array(z.object({ name: z.string().trim().min(1).max(80), minutes: z.number().int().min(0).max(480) })).max(10).optional(),
  extraBufferMinutes: z.number().int().min(0).max(240).optional(),
  travelTotalMinutes: z.number().int().min(0).max(720).optional(),
  baggage: PlanningBaggageSchema.optional(),
  localBlocks: z.array(PlanningLocalBlockSchema).max(30).optional(),
});
export type PlanningTimeOverride = z.infer<typeof PlanningTimeOverrideSchema>;

export function flightDayWindowLocks(day: number, totalDays: number, flightMode?: unknown) {
  const hasFlight = flightMode === "manual" || flightMode === "quoted";
  return { start: hasFlight && day === 1, end: hasFlight && day === totalDays };
}

export function routeOwnedTimeOverride<T extends Record<string, unknown>>(value?: T): Omit<T, "travelTotalMinutes"> | undefined {
  if (!value || !Object.hasOwn(value, "travelTotalMinutes")) return value;
  const { travelTotalMinutes: _history, ...rest } = value;
  return Object.keys(rest).length > 1 ? rest : undefined;
}

/** A new explicit end replaces the two legacy targets without discarding their old values on read. */
export function singleEndPlanningWindow(window: NonNullable<PlanningTimeOverride["dailyWindow"]>, end: string) {
  return {
    ...window, preferredReturn: end, latestReturn: end,
    returnConstraint: {
      strength: window.returnConstraint?.strength || "hard" as const,
      source: "user" as const,
      evidence: "用户在本日时间偏好中明确设置结束时间",
    },
  };
}

export function mergePlanningTimeOverride(previous: PlanningTimeOverride | undefined, submitted: PlanningTimeOverride): PlanningTimeOverride | undefined {
  const merged = PlanningTimeOverrideSchema.parse({
    ...previous, ...submitted,
    ...(previous?.visitMinutesByPlaceId || submitted.visitMinutesByPlaceId ? { visitMinutesByPlaceId: { ...previous?.visitMinutesByPlaceId, ...submitted.visitMinutesByPlaceId } } : {}),
    ...(previous?.includedMealMinutesByPlaceId || submitted.includedMealMinutesByPlaceId ? { includedMealMinutesByPlaceId: { ...previous?.includedMealMinutesByPlaceId, ...submitted.includedMealMinutesByPlaceId } } : {}),
  });
  if (submitted.localBlocks !== undefined) {
    delete merged.extraMealReserveMinutes;
    delete merged.extraBufferMinutes;
    delete merged.personalActivities;
    // A verified old storage point (or explicitly chosen hotel collection) is
    // route evidence, separate from the migrated handling-time block. Keep it
    // when the new editor saves labels; localBlocks prevents a second time debit.
    if (merged.baggage?.mode !== "hotel" && !(merged.baggage?.mode === "other" && merged.baggage.storagePlace?.placeId === merged.baggage.placeId)) delete merged.baggage;
  }
  return Object.keys(merged).length > 1 ? merged : undefined;
}

/** Exact integer allocation: rounding never creates or loses travel minutes. */
export function distributeTravelMinutes(total: number, references: number[]): number[] {
  if (!Number.isInteger(total) || total < 0 || references.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("INVALID_TRAVEL_TOTAL");
  if (!references.length) return [];
  const sum = references.reduce((a, b) => a + b, 0);
  const weights = references.map((value) => sum ? value / sum : 1 / references.length);
  const exact = weights.map((weight) => weight * total);
  const result = exact.map(Math.floor);
  let remainder = total - result.reduce((a, b) => a + b, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - result[index] })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of order) { if (remainder-- <= 0) break; result[index] += 1; }
  return result;
}

export function timeBalance(start: number, deadline: number, occupied: number) {
  return { freeMinutes: Math.max(0, deadline - start - occupied), overtimeMinutes: Math.max(0, occupied - (deadline - start)) };
}
