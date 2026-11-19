/** Pure capacity guidance; opening windows and routing remain separate checks. */
export type PlanningCapacityAssessment = {
  day: number; status: "unknown" | "fits" | "soft_overrun" | "hard_exceeded";
  availableMinutes: number | null; requiredMinutes: number | null; addedMinutes: number | null;
  baselineRemainingMinutes: number | null; lowerBound: boolean;
  deficitMinutes: number; preferredDeficitMinutes: number; remainingMinutes: number | null; message: string;
};
const minutes = (value?: string) => value && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null;
const readable = (value: number) => { const n = Math.max(0, Math.round(value)); return n >= 60 ? `${Math.floor(n / 60)} 小时${n % 60 ? ` ${n % 60} 分钟` : ""}` : `${n} 分钟`; };
export function assessPlanningCapacity(input: {
  day: number; startTime: string; preferredEndTime?: string; hardEndTime: string;
  visitMinutes: number; localBlockMinutes: number; travelMinutes?: number; baselineOccupiedMinutes?: number;
}): PlanningCapacityAssessment {
  const unknown: PlanningCapacityAssessment = { day: input.day, status: "unknown", availableMinutes: null, requiredMinutes: null, addedMinutes: null, baselineRemainingMinutes: null, lowerBound: true, deficitMinutes: 0, preferredDeficitMinutes: 0, remainingMinutes: null, message: "当前可安排时间待核算，请先核对本日依据；不会把未知余量当作 0。" };
  const start = minutes(input.startTime), end = minutes(input.hardEndTime), preferred = minutes(input.preferredEndTime);
  if (start === null || end === null || end <= start || ![input.visitMinutes, input.localBlockMinutes].every(value => Number.isFinite(value) && value >= 0)) return unknown;
  const trafficKnown = input.travelMinutes !== undefined && Number.isFinite(input.travelMinutes) && input.travelMinutes >= 0;
  const occupied = input.visitMinutes + input.localBlockMinutes + (trafficKnown ? input.travelMinutes! : 0);
  const available = end - start, deficit = Math.max(0, occupied - available);
  const preferredDeficit = preferred !== null ? Math.max(0, occupied - Math.max(0, preferred - start)) : 0;
  const baseline = input.baselineOccupiedMinutes;
  const added = baseline !== undefined && Number.isFinite(baseline) && baseline >= 0 ? occupied - baseline : null;
  const baselineRemaining = added !== null ? Math.max(0, available - baseline!) : null;
  const netChange = added === null ? "" : `按已知活动与交通总量，原可安排约 ${readable(baselineRemaining!)}；本轮全部修改净${added >= 0 ? "增" : "减"} ${readable(Math.abs(added))}。`;
  if (deficit > 0) return { day: input.day, status: "hard_exceeded", availableMinutes: available, requiredMinutes: occupied, addedMinutes: added, baselineRemainingMinutes: baselineRemaining, lowerBound: true, deficitMinutes: deficit, preferredDeficitMinutes: preferredDeficit, remainingMinutes: 0,
    message: `本日时间不足：${netChange}当前安排${trafficKnown ? "与必要交通" : "即使暂不计交通"}至少共需 ${readable(occupied)}，硬截止前可安排 ${readable(available)}，超出至少 ${readable(deficit)}。请修改本日安排；原成功结果仍保留。` };
  if (!trafficKnown) return { ...unknown, availableMinutes: available, requiredMinutes: occupied, addedMinutes: added };
  return { day: input.day, status: preferredDeficit > 0 ? "soft_overrun" : "fits", availableMinutes: available, requiredMinutes: occupied, addedMinutes: added, baselineRemainingMinutes: baselineRemaining, lowerBound: true, deficitMinutes: 0, preferredDeficitMinutes: preferredDeficit, remainingMinutes: Math.max(0, available - occupied),
    message: preferredDeficit > 0 ? `预计超过希望结束时间约 ${readable(preferredDeficit)}，仍需核对具体位置、开放和硬截止。` : "安排总量可容纳，仍需核对具体位置、开放时间和实际路线。" };
}

type Window = { start: string; latestReturn: string; preferredReturn: string; returnConstraint?: { strength: "soft" | "hard"; source?: string } };
type CapacityEstimate = { day: number; dailyWindow?: Window; effectiveWindow?: { start: string; returnBy: string }; metrics: { travelMinutes: number }; transport?: { status: string }; scenes?: Array<{ candidateId: string; selectedVisitMinutes?: number }>; localBlocks?: Array<{ durationMinutes: number }> };
type ProposedOverride = { dailyWindow?: Window; visitMinutesByPlaceId?: Record<string, number>; localBlocks?: Array<{ durationMinutes: number }>; travelTotalMinutes?: number };
export function previewPlanningCapacity(estimate: CapacityEstimate, proposed: ProposedOverride, options: { stale?: boolean } = {}): PlanningCapacityAssessment {
  const unknown = () => assessPlanningCapacity({ day: estimate.day, startTime: "", hardEndTime: "", visitMinutes: 0, localBlockMinutes: 0 });
  if (options.stale || !estimate.effectiveWindow || !estimate.scenes || estimate.scenes.some(scene => !Number.isFinite(scene.selectedVisitMinutes))) return unknown();
  const sameWindow = !proposed.dailyWindow || ["start", "latestReturn", "preferredReturn"].every(key => proposed.dailyWindow![key as keyof Window] === estimate.dailyWindow?.[key as keyof Window])
    && proposed.dailyWindow.returnConstraint?.strength === estimate.dailyWindow?.returnConstraint?.strength;
  const window = proposed.dailyWindow || estimate.dailyWindow;
  const start = sameWindow ? estimate.effectiveWindow.start : window!.start;
  const soft = window?.returnConstraint?.strength === "soft" && window.returnConstraint.source === "user";
  const extended = Math.min(1439, (minutes(start) || 0) + 1080);
  const hard = sameWindow ? estimate.effectiveWindow.returnBy : soft ? `${Math.floor(extended / 60).toString().padStart(2, "0")}:${(extended % 60).toString().padStart(2, "0")}` : window!.latestReturn;
  const visit = estimate.scenes.reduce((sum, scene) => sum + (proposed.visitMinutesByPlaceId?.[scene.candidateId] ?? scene.selectedVisitMinutes!), 0);
  const originalVisit = estimate.scenes.reduce((sum, scene) => sum + scene.selectedVisitMinutes!, 0);
  const originalBlocks = (estimate.localBlocks || []).reduce((sum, block) => sum + block.durationMinutes, 0);
  const blocks = (proposed.localBlocks || estimate.localBlocks || []).reduce((sum, block) => sum + block.durationMinutes, 0);
  const traffic = proposed.travelTotalMinutes ?? (estimate.transport?.status === "complete" ? estimate.metrics.travelMinutes : undefined);
  return assessPlanningCapacity({ day: estimate.day, startTime: start, hardEndTime: hard, preferredEndTime: window?.latestReturn,
    visitMinutes: visit, localBlockMinutes: blocks, travelMinutes: traffic,
    ...(traffic !== undefined ? { baselineOccupiedMinutes: originalVisit + originalBlocks + estimate.metrics.travelMinutes } : {}) });
}
