import { z } from "zod";

export const PlanningLocalBlockSchema = z.object({
  id: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/),
  day: z.number().int().min(1).max(7),
  kind: z.enum(["meal", "rest", "custom"]),
  title: z.string().trim().min(1).max(80),
  details: z.string().trim().max(600).optional(),
  durationMinutes: z.number().int().min(1).max(480),
  anchor: z.object({ nodeId: z.string().trim().min(1).max(255), placement: z.enum(["before", "after"]) }).optional(),
  source: z.enum(["user", "legacy"]).default("user"),
}).superRefine((value, context) => {
  if (value.source === "user" && !value.anchor) context.addIssue({ code: z.ZodIssueCode.custom, path: ["anchor"], message: "请为新安排选择时间轴位置。" });
});
export type PlanningLocalBlock = z.infer<typeof PlanningLocalBlockSchema>;
export type ScheduledPlanningLocalBlock = PlanningLocalBlock & { startTime: string; endTime: string };

type LegacyOverride = {
  day: number;
  localBlocks?: PlanningLocalBlock[];
  extraMealReserveMinutes?: number;
  extraBufferMinutes?: number;
  personalActivities?: Array<{ name: string; minutes: number }>;
  baggage?: { mode: string; handlingMinutes?: number };
};

/** Explicit old saved quantities become one pending-position block, never a new default. */
export function effectivePlanningLocalBlocks(override?: LegacyOverride, options: { departure?: boolean } = {}): PlanningLocalBlock[] {
  if (!override) return [];
  if (override.localBlocks !== undefined) return override.localBlocks;
  const blocks: PlanningLocalBlock[] = [];
  const add = (id: string, kind: PlanningLocalBlock["kind"], title: string, durationMinutes?: number) => {
    if (durationMinutes && Number.isInteger(durationMinutes) && durationMinutes > 0) blocks.push({ id: `legacy-${override.day}-${id}`, day: override.day, kind, title, durationMinutes, source: "legacy" });
  };
  add("meal", "meal", "吃饭", override.extraMealReserveMinutes);
  add("rest", "rest", "休息", override.extraBufferMinutes);
  (override.personalActivities || []).forEach((item, i) => add(`personal-${i}`, "custom", item.name, item.minutes));
  if (override.baggage?.mode === "other") {
    add("baggage-deposit", "custom", "已保存的寄存操作（待放置）", override.baggage.handlingMinutes);
    add("baggage-collection", "custom", "已保存的取物操作（待放置）", override.baggage.handlingMinutes);
  } else if (override.baggage?.mode === "hotel" && options.departure !== false) {
    add("baggage", "custom", "已保存的取物操作（待放置）", override.baggage.handlingMinutes);
  }
  return blocks;
}

export function planningLocalBlockStopId(id: string) { return `local-block-${id}`; }

export function validatePlanningLocalBlocks(blocks: PlanningLocalBlock[], day: number, stops: Array<{ id: string }>) {
  const allowed = new Set(stops.map((stop) => stop.id));
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.day !== day || ids.has(block.id)) throw new Error("本日安排的日期或编号不正确，请重新读取后调整。");
    ids.add(block.id);
    if (!block.anchor) {
      if (block.source !== "legacy") throw new Error("请为新安排选择时间轴位置。");
      continue;
    }
    if (!allowed.has(block.anchor.nodeId)) throw new Error("本日安排的位置已失效，请重新选择实际节点。");
    if (block.anchor.nodeId.endsWith("-airport-arrival") && block.anchor.placement === "before") throw new Error("抵达新加坡并完成入境前不能添加当地安排。");
    if (block.anchor.nodeId.endsWith("-airport-departure") && block.anchor.placement === "after") throw new Error("当地安排须在抵达离境机场前完成；机场准备窗口不重复占用当地余量。");
  }
}
