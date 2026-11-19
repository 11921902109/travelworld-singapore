import { z } from "zod";

export const RecommendedDurationSchema = z.object({
  minMinutes: z.number().int().min(15).max(480),
  maxMinutes: z.number().int().min(15).max(480),
  source: z.literal("ai_suggestion"),
}).refine((value) => value.minMinutes <= value.maxMinutes);
export type RecommendedDuration = z.infer<typeof RecommendedDurationSchema>;

/** Advice remains independent from an editable visit duration. Invalid model ranges are omitted. */
export function validRecommendedDuration(value: unknown, recommendedMinutes?: number): RecommendedDuration | undefined {
  const parsed = RecommendedDurationSchema.safeParse(value);
  if (!parsed.success) return undefined;
  if (recommendedMinutes !== undefined && (recommendedMinutes < parsed.data.minMinutes || recommendedMinutes > parsed.data.maxMinutes)) return undefined;
  return parsed.data;
}

export function hoursInput(minutes: number): string {
  return String(Number((minutes / 60).toFixed(2)));
}

export function hoursLabel(minutes: number): string {
  return `${hoursInput(Math.max(0, minutes))} 小时`;
}

/** Unedited rounded display strings retain the exact original integer minutes. */
export function hoursToMinutes(value: string, originalMinutes: number, edited: boolean): number {
  if (!edited) return originalMinutes;
  if (!value.trim()) return Number.NaN;
  const hours = Number(value);
  return Number.isFinite(hours) ? Math.round(hours * 60) : Number.NaN;
}

export function outsideRecommendedDuration(minutes: number, range?: RecommendedDuration): boolean {
  return Boolean(range && (minutes < range.minMinutes || minutes > range.maxMinutes));
}

export function sceneTimeAdvice(scene: { estimatedMinutes: number; estimateSource?: string; recommendedMinutes?: number; recommendedDuration?: unknown }, selectedVisitMinutes: number) {
  const recommendedMinutes = scene.recommendedMinutes ?? (scene.estimateSource === "bailian" ? scene.estimatedMinutes : undefined);
  return {
    selectedVisitMinutes,
    ...(recommendedMinutes !== undefined ? { recommendedMinutes } : {}),
    ...(validRecommendedDuration(scene.recommendedDuration, recommendedMinutes) ? { recommendedDuration: validRecommendedDuration(scene.recommendedDuration, recommendedMinutes) } : {}),
  };
}

export function sameVisitPlaceIds(editedIds: string[], currentIds: string[]): boolean {
  return editedIds.length === currentIds.length && editedIds.every((id) => currentIds.includes(id));
}

export function durationTextInHours(text: string): string {
  return text
    .replace(/(\d+)\s*小时\s*(\d+)\s*分钟?/g, (_, hours, minutes) => hoursLabel(Number(hours) * 60 + Number(minutes)))
    .replace(/(\d+)\s*[–-]\s*(\d+)\s*分钟?/g, (_, min, max) => `${hoursInput(Number(min))}–${hoursLabel(Number(max))}`)
    .replace(/(\d+(?:\.\d+)?)\s*分钟?/g, (_, minutes) => hoursLabel(Number(minutes)));
}
