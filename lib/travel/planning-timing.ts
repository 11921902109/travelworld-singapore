const scopes = new Set(["board", "scenes", "flights", "stays", "schedule", "compile", "day-count", "unknown"]);
const actions = new Set(["request", "read", "poll", "resume", "search", "generate", "add", "remove", "select", "confirm", "reopen", "duration", "undo_remove", "save", "delete", "undo", "manual", "skip", "advise", "segments", "searchHotels", "quoteHotels", "selectHotel", "calculate", "updateDay", "previewMove", "applyMove", "searchAttractions", "previewAttraction", "addAttraction", "decideFreeTime", "compile", "invalid", "unknown"]);
export const PLANNING_TIMING_STEPS = ["context_read", "lease_wait", "google_lookup", "agent_wait", "calculation", "state_commit", "cache_lookup", "request_total"] as const;
export type PlanningTimingStep = typeof PLANNING_TIMING_STEPS[number];
export type PlanningTimingMetadata = { day?: number; segment?: number; version?: number; cacheHit?: boolean };
type Step = { name: PlanningTimingStep; durationMs: number; calls: number; failures: number };
export type PlanningTimingProjection = { traceId: string; scope: string; action: string; durationMs: number; statusCode?: number; steps: Step[]; metadata: PlanningTimingMetadata };
const round = (value: number) => Math.round(value * 1000) / 1000;
const whitelist = (values: Set<string>, value: unknown) => typeof value === "string" && values.has(value) ? value : "unknown";

/** Timings contain only fixed phase names and bounded operational metadata. */
export function createPlanningTiming(scopeInput: unknown, actionInput: unknown = "request") {
  const traceId = crypto.randomUUID();
  const scope = whitelist(scopes, scopeInput);
  let action = whitelist(actions, actionInput);
  const started = performance.now();
  let finished: number | undefined;
  let statusCode: number | undefined;
  let logged = false;
  const steps = new Map<PlanningTimingStep, Step>();
  const metadata: PlanningTimingMetadata = {};

  function record(name: PlanningTimingStep, durationMs: number, failed = false) {
    if (finished !== undefined || name === "request_total" || !PLANNING_TIMING_STEPS.includes(name) || !Number.isFinite(durationMs) || durationMs < 0) return;
    const existing = steps.get(name) || { name, durationMs: 0, calls: 0, failures: 0 };
    steps.set(name, { name, durationMs: existing.durationMs + durationMs, calls: existing.calls + 1, failures: existing.failures + (failed ? 1 : 0) });
  }
  async function measureAsync<T>(name: PlanningTimingStep, operation: () => Promise<T>): Promise<T> {
    const start = performance.now(); let failed = false;
    try { return await operation(); } catch (error) { failed = true; throw error; }
    finally { record(name, performance.now() - start, failed); }
  }
  function measureSync<T>(name: PlanningTimingStep, operation: () => T): T {
    const start = performance.now(); let failed = false;
    try { return operation(); } catch (error) { failed = true; throw error; }
    finally { record(name, performance.now() - start, failed); }
  }
  function annotate(value: PlanningTimingMetadata) {
    if (finished !== undefined || !value || typeof value !== "object") return;
    if (Number.isInteger(value.day) && value.day! >= 1 && value.day! <= 7) metadata.day = value.day;
    if (Number.isInteger(value.segment) && value.segment! >= 1 && value.segment! <= 14) metadata.segment = value.segment;
    if (Number.isSafeInteger(value.version) && value.version! >= 0) metadata.version = value.version;
    if (typeof value.cacheHit === "boolean") metadata.cacheHit = value.cacheHit;
  }
  function projection(): PlanningTimingProjection {
    const durationMs = round(Math.max(0, (finished ?? performance.now()) - started));
    return { traceId, scope, action, durationMs, ...(statusCode !== undefined ? { statusCode } : {}),
      steps: [...steps.values()].map((item) => ({ ...item, durationMs: round(item.durationMs) })).concat({ name: "request_total", durationMs, calls: 1, failures: statusCode !== undefined && statusCode >= 500 ? 1 : 0 }),
      metadata: { ...metadata } };
  }
  function finish(status?: number) {
    if (finished === undefined) {
      finished = performance.now();
      if (Number.isInteger(status) && status! >= 100 && status! <= 599) statusCode = status;
    }
    const summary = projection();
    if (!logged) { logged = true; console.info(JSON.stringify({ event: "travel_planning_timing", ...summary })); }
    return summary;
  }
  function response<T extends Response>(value: T): T {
    const summary = finish(value.status);
    if (value.headers.get("X-Travel-Trace-Id") === traceId) return value;
    value.headers.set("X-Travel-Trace-Id", traceId);
    const header = summary.steps.map((item) => `${item.name};dur=${item.durationMs};desc="calls=${item.calls} failures=${item.failures}"`).join(", ");
    value.headers.set("Server-Timing", value.headers.get("Server-Timing") ? `${value.headers.get("Server-Timing")}, ${header}` : header);
    return value;
  }
  return { traceId, record, measureAsync, measureSync, annotate, projection, finish, response,
    setAction(value: unknown) { if (finished === undefined) action = whitelist(actions, value); } };
}

export type PlanningTiming = ReturnType<typeof createPlanningTiming>;

export async function withPlanningTiming<T extends Response>(scope: unknown, action: unknown, handler: (timing: PlanningTiming) => Promise<T>): Promise<T> {
  const timing = createPlanningTiming(scope, action);
  try { return timing.response(await handler(timing)); }
  catch (error) { timing.finish(500); throw error; }
}
