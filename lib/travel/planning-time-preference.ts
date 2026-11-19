type Meta = Record<string, { status?: string; source?: string; evidence?: string }>;
export function planningReturnConstraint(meta: Meta = {}): { strength: "soft" | "hard"; source: "user" | "legacy"; evidence?: string } {
  const entry = [meta.latestReturnTime, meta.dailyEndTime, meta.preferredReturnTime]
    .find((item) => item?.status === "confirmed" && item.source !== "derived" && item.evidence?.trim());
  if (!entry?.evidence) return { strength: "hard", source: "legacy" };
  const evidence = entry.evidence.slice(0, 300);
  if (/最晚|必须|不晚于|不能晚于|一定要|no later|must|latest/i.test(evidence)) return { strength: "hard", source: "user", evidence };
  if (/大概|希望|尽量|左右|大约|约\s*\d|around|prefer|approximately/i.test(evidence)) return { strength: "soft", source: "user", evidence };
  return { strength: "hard", source: "legacy", evidence };
}
