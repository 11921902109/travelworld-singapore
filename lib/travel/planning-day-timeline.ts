import { hoursLabel, type RecommendedDuration } from "./planning-duration";
import type { PlanningDayJourney, PlanningDayMilestone } from "./planning-trip";
import type { RouteLeg, TripDay, TripStop } from "./types";
import { planningLocalBlockStopId, type PlanningLocalBlock, type ScheduledPlanningLocalBlock } from "./planning-local-blocks";

export type PlanningTimelineScene = {
  candidateId: string;
  name: string;
  period: "morning" | "afternoon" | "evening";
  regularOpeningHours: string | null;
  recommendedMinutes?: number;
  recommendedDuration?: RecommendedDuration;
  selectedVisitMinutes?: number;
  durationReason?: string;
  sceneRole?: "culinary_area" | "restaurant_meal" | "attraction";
  includedMealMinutes?: number;
};

export type PlanningTimelineNode =
  | { id: string; kind: "flight"; milestone: PlanningDayMilestone }
  | { id: string; kind: "place"; label: string; stop?: TripStop; scene?: PlanningTimelineScene; milestone?: PlanningDayMilestone; displayName?: string; timingKind?: "arrival" | "departure" | "airport_process"; timingNote?: string }
  | { id: string; kind: "travel"; from: string; to: string; leg?: RouteLeg }
  | { id: string; kind: "block"; block: PlanningLocalBlock; startTime?: string; endTime?: string };

type TimelineInput = {
  scenes?: PlanningTimelineScene[];
  scheduledDay?: Pick<TripDay, "stops" | "legs">;
  journey?: PlanningDayJourney;
  transport?: { status: "complete" | "unknown"; totalMinutes: number; noOuting?: boolean };
  localBlocks?: PlanningLocalBlock[];
  scheduledLocalBlocks?: ScheduledPlanningLocalBlock[];
};

/** Saved route clocks may exceed 24:00; retain the day offset in the display. */
export function planningTimelineClock(value: string): string {
  const match = /^(\d+):([0-5]\d)$/.exec(value);
  if (!match || Number(match[1]) < 24) return value;
  const hour = Number(match[1]);
  const days = Math.floor(hour / 24);
  return `${days === 1 ? "次日" : `${days} 日后`} ${String(hour % 24).padStart(2, "0")}:${match[2]}`;
}

/** Projects the saved order only; no route, clock, or free-time calculation belongs here. */
export function buildPlanningDayTimeline(input: TimelineInput): PlanningTimelineNode[] {
  const scenes = input.scenes || [];
  const milestones = input.journey?.milestones || [];
  const activityIndex = milestones.findIndex((node) => node.role === "activity");
  const before = activityIndex < 0 ? [] : milestones.slice(0, activityIndex).filter((node) => node.role === "flight");
  const after = activityIndex < 0 ? milestones.filter((node) => node.role === "flight") : milestones.slice(activityIndex + 1).filter((node) => node.role === "flight");
  const nodes: PlanningTimelineNode[] = before.map((milestone) => ({ id: `flight:${milestone.id}`, kind: "flight", milestone }));
  const stops = (input.scheduledDay?.stops || []).filter((stop) => stop.kind !== "buffer");
  const blocks = input.localBlocks || [];
  const blockNode = (block: PlanningLocalBlock): PlanningTimelineNode => {
    const saved = input.scheduledLocalBlocks?.find((item) => item.id === block.id && item.durationMinutes === block.durationMinutes && JSON.stringify(item.anchor) === JSON.stringify(block.anchor));
    return { id: planningLocalBlockStopId(block.id), kind: "block", block, ...(saved ? { startTime: saved.startTime, endTime: saved.endTime } : {}) };
  };
  const at = (nodeId: string, placement: "before" | "after") => blocks.filter((block) => block.anchor?.nodeId === nodeId && block.anchor.placement === placement).forEach((block) => nodes.push(blockNode(block)));
  if (stops.length) {
    const sceneById = new Map(scenes.map((scene) => [scene.candidateId, scene]));
    stops.forEach((stop, index) => {
      const previous = index ? stops[index - 1] : undefined;
      const staysPut = stops.length === 2 && previous?.placeId && previous.placeId === stop.placeId
        && input.transport?.status === "complete" && input.transport.noOuting && input.transport.totalMinutes === 0;
      if (previous && previous.kind !== "buffer" && !staysPut) {
        const leg = input.scheduledDay?.legs.find((item) => item.from === previous.id && item.to === stop.id);
        nodes.push({ id: `travel:${index}:${previous.id}:${stop.id}`, kind: "travel", from: previous.name, to: stop.name, leg });
      }
      at(stop.id, "before");
      const baggage = stop.categoryLabel === "行李事务" || /^day-\d+-baggage-(deposit|collection)$/.test(stop.id);
      const scene = baggage ? undefined : sceneById.get(stop.placeId || stop.id);
      const label = baggage ? "已确认途经点" : scene ? scene.sceneRole === "restaurant_meal" ? "已选餐饮" : "地点与体验"
        : stop.kind === "hotel" ? index === 0 ? "酒店出发" : index === stops.length - 1 ? "返回酒店" : "到达酒店"
          : index === 0 ? /机场|airport/i.test(`${stop.categoryLabel || ""} ${stop.name}`) ? "离开机场" : "本日出发" : index === stops.length - 1 ? "当天终点" : "已选地点";
      const airportProcess = index === 0 && /机场|airport/i.test(`${stop.categoryLabel || ""} ${stop.name}`)
        && (input.journey?.kind === "arrival" || input.journey?.kind === "arrival_departure");
      nodes.push({ id: `place:${index}:${stop.id}`, kind: "place", label, stop, ...(scene ? { scene } : {}),
        timingKind: airportProcess ? "airport_process" : index === 0 ? "departure" : "arrival",
        ...(airportProcess ? { displayName: "入境与取行李预留结束，可离开机场",
          timingNote: `抵达后约 ${hoursLabel(input.journey?.airportProcessMinutes || 120)}用于入境检查及领取行李；这是规划预留，实际用时可能变化，赴酒店交通另计。` } : {}) });
      at(stop.id, "after");
    });
  } else {
    const hotelNodes = milestones.filter((node) => node.role === "hotel");
    const start = hotelNodes.find((node) => node.id === "hotel-start");
    const end = hotelNodes.find((node) => node.id === "hotel-return");
    nodes.push({ id: "local:start", kind: "place", label: start?.label || (before.length ? "抵达后当地出发" : "酒店出发"), ...(start ? { milestone: start } : {}) });
    scenes.forEach((scene) => nodes.push({ id: `scene:${scene.candidateId}`, kind: "place", label: scene.sceneRole === "restaurant_meal" ? "已选餐饮" : "地点与体验", scene }));
    nodes.push({ id: "local:end", kind: "place", label: end?.label || (after.length ? "前往离境机场" : "返回酒店"), ...(end ? { milestone: end } : {}) });
  }
  blocks.filter((block) => !block.anchor).forEach((block) => nodes.push(blockNode(block)));
  nodes.push(...after.map((milestone): PlanningTimelineNode => ({ id: `flight:${milestone.id}`, kind: "flight", milestone })));
  return nodes;
}

export type PlanningTimelineGroup = { id: string; label: string; nodes: PlanningTimelineNode[]; estimatedEnd?: string };

/** Groups the same saved evidence; grouping does not add handling time or create a route. */
export function buildPlanningDayTimelineGroups(input: TimelineInput): PlanningTimelineGroup[] {
  const nodes = buildPlanningDayTimeline(input);
  const groups: PlanningTimelineGroup[] = [];
  const arrival = input.journey?.kind === "arrival" || input.journey?.kind === "arrival_departure";
  let current = arrival ? "arrival" : "start";
  const labels: Record<string, string> = { arrival: "启程与抵达", start: "从酒店出发", morning: "上午游览", afternoon: "下午游览", evening: "晚间安排", return: "返店与自由安排", departure: "前往机场与返程", pending: "待放置的安排" };
  const finalStop = input.scheduledDay?.stops.filter((stop) => stop.kind !== "buffer").at(-1);
  let previousKey: string | undefined;
  const keyCounts = new Map<string, number>();
  for (const node of nodes) {
    if (node.kind === "flight") current = node.milestone.id.startsWith("inbound") ? "departure" : "arrival";
    else if (node.kind === "place" && node.scene) current = node.scene.period;
    else if (node.kind === "place" && node.stop?.id === finalStop?.id) current = node.stop?.kind === "hotel" ? "return" : "departure";
    else if (node.kind === "travel" && finalStop && node.leg?.to === finalStop.id) current = finalStop.kind === "hotel" ? "return" : "departure";
    const key = node.kind === "block" && !node.block.anchor ? "pending" : current;
    let group = groups.at(-1);
    if (!group || previousKey !== key) {
      const count = (keyCounts.get(key) || 0) + 1; keyCounts.set(key, count);
      group = { id: count === 1 ? key : `${key}-${count}`, label: labels[key] || "本日安排", nodes: [] }; groups.push(group);
    }
    previousKey = key;
    group.nodes.push(node);
    if (node.kind === "place" && node.stop?.endTime) group.estimatedEnd = node.stop.endTime;
    if (node.kind === "block" && node.endTime) group.estimatedEnd = node.endTime;
    if (node.kind === "flight" && node.milestone.localDateTime) group.estimatedEnd = node.milestone.localDateTime.replace("T", " ");
  }
  return groups;
}

type FreeAllocationMetrics = {
  bufferMinutes: number;
  personalMinutes?: number;
  freeMinutes: number;
  overtimeMinutes: number;
};

/** The unused allowance already includes unallocated period gaps. Never add them twice. */
export function planningFreeAllocation(metrics: FreeAllocationMetrics) {
  return {
    bufferMinutes: metrics.bufferMinutes,
    personalMinutes: metrics.personalMinutes || 0,
    unallocatedMinutes: metrics.freeMinutes,
    totalMinutes: metrics.bufferMinutes + (metrics.personalMinutes || 0) + metrics.freeMinutes,
    overtimeMinutes: metrics.overtimeMinutes,
  };
}

/** Only an unchanged, current, non-overtime result may supply a quick allocation. */
export function allocateRemainingToPersonal(metrics: FreeAllocationMetrics, unavailable = false): number | null {
  const minutes = (metrics.personalMinutes || 0) + metrics.freeMinutes;
  if (unavailable || metrics.overtimeMinutes > 0 || metrics.freeMinutes <= 0 || !Number.isFinite(minutes) || minutes > 480) return null;
  return minutes;
}
