import type { SingaporeIntentResult, SingaporeTravelIntent } from "./singapore-intent";

export type IntentSlotMetaEntry = {
  source: "code" | "bailian" | "derived";
  evidence: string;
  turnId: string;
  status: "confirmed" | "cleared";
  updatedAt: string;
};

export type IntentSlotMeta = Record<string, IntentSlotMetaEntry>;

function flatten(value: unknown, prefix = "", output: Record<string, unknown> = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, output);
    }
  } else if (prefix) {
    output[prefix] = value;
  }
  return output;
}

/** Keep provenance alongside the server-owned intent, including dependent clears. */
export function updateIntentSlotMeta(options: {
  previous: IntentSlotMeta;
  before: SingaporeTravelIntent;
  result: SingaporeIntentResult;
  turnId: string;
  source: "code" | "bailian";
  message: string;
  updatedAt?: string;
}): IntentSlotMeta {
  const before = flatten(options.before);
  const after = flatten(options.result.intent);
  const accepted = new Map(options.result.acceptedChanges.map((change) => [change.field, change]));
  const next = { ...options.previous };
  const updatedAt = options.updatedAt ?? new Date().toISOString();
  for (const [field, value] of Object.entries(after)) {
    const change = accepted.get(field);
    // A user's explicit "do not recommend" can set the default false to false.
    // Retain that evidence even when the scalar value itself did not change.
    if (JSON.stringify(value) === JSON.stringify(before[field]) &&
        !(field === "allowAutomaticRecommendations" && change)) continue;
    const empty = value === null || (Array.isArray(value) && value.length === 0);
    next[field] = {
      source: change ? options.source : "derived",
      evidence: (change?.evidenceText || options.message).slice(0, 300),
      turnId: options.turnId,
      status: change?.op === "clear" || empty ? "cleared" : "confirmed",
      updatedAt,
    };
  }
  return next;
}
