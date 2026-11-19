import { buildFlightSearchQuery, flightSearchPrompt, parseFlightAgentResponse, requestedFlightDates, type FlightSearchInput, type FlightSearchJob, type FlightSearchQuery, type FlightSearchResult } from "./planning-flights";
import { commitPlanningDraft, PlanningDraftSchema, type PlanningDraftV1 } from "./planning-state";
import type { PlanningAgentTaskStep } from "./bailian";
import type { TravelFlightJobRow } from "./visit-session";
import type { PlanningTiming, PlanningTimingStep } from "./planning-timing";

const TASK_DEADLINE_MS = 8 * 60_000;
const terminal = new Set(["completed", "failed", "timed_out", "superseded"]);
type FlightJobQuery = FlightSearchQuery & { boardFingerprint: string; contextFingerprint?: string };
const measured = <T>(timing: PlanningTiming | undefined, step: PlanningTimingStep, operation: () => Promise<T>) => timing ? timing.measureAsync(step, operation) : operation();

/** A scoped retry may only replace its direction within the exact same search. */
export function mergeFlightSearchResult(previous: FlightSearchResult | undefined, incoming: FlightSearchResult, query: FlightSearchQuery, contextFingerprint: string): FlightSearchResult {
  const direction = query.direction || "both";
  if (direction !== "both" && (!previous || previous.contextFingerprint !== contextFingerprint)) throw new Error("FLIGHT_RETRY_CONTEXT_CHANGED");
  const keep = direction === "inbound" ? "outbound" : "inbound";
  const outbound = direction === "inbound" ? previous!.outbound : incoming.outbound;
  const inbound = direction === "outbound" ? previous!.inbound : incoming.inbound;
  const available = Boolean(outbound.length || inbound.length);
  const searchQuery: FlightSearchQuery = { direction: "both", originCity: query.originCity, startDate: query.startDate, endDate: query.endDate,
    outboundDates: query.outboundDates, inboundDates: query.inboundDates, travelers: query.travelers, preferences: query.preferences };
  return { ...incoming, outbound, inbound,
    status: available ? "available" : "unavailable", failureReason: available ? undefined : incoming.failureReason,
    queryOutcomes: [...(direction === "both" ? [] : previous!.queryOutcomes?.filter((item) => item.direction === keep) || []), ...(incoming.queryOutcomes || [])],
    rejected: [...(direction === "both" ? [] : previous!.rejected?.filter((item) => item.direction === keep) || []), ...(incoming.rejected || [])],
    searchLinks: [...(direction === "both" ? [] : previous!.searchLinks?.filter((item) => item.direction === keep) || []), ...(incoming.searchLinks || [])],
    searchQuery, contextFingerprint };
}

export function flightRetryBaseline(previous: FlightSearchResult, query: FlightSearchQuery, contextFingerprint: string): FlightSearchResult {
  return mergeFlightSearchResult(previous, { outbound: [], inbound: [], queriedAt: previous.queriedAt, status: "unavailable",
    travelers: query.travelers, preferences: query.preferences }, query, contextFingerprint);
}

export function flightBoardFingerprint(draft: Pick<PlanningDraftV1, "assignments" | "candidates">): string {
  const assignedIds = new Set(draft.assignments.flatMap((item) => item.orderedCandidateIds));
  return JSON.stringify({ assignments: [...draft.assignments].sort((a, b) => a.day - b.day).map((item) => ({
    day: item.day, ids: item.orderedCandidateIds, periods: Object.entries(item.periodByCandidateId || {}).sort(([a], [b]) => a.localeCompare(b)),
    purpose: (item as { dayPurpose?: unknown }).dayPurpose || "activities",
  })), durations: draft.candidates.filter((item) => assignedIds.has(String(item.placeId))).map((item) => [item.placeId, item.estimatedMinutes]).sort(([a], [b]) => String(a).localeCompare(String(b))) });
}

export function flightJobIsCurrent(job: TravelFlightJobRow, draft: PlanningDraftV1): boolean {
  let context: { boardFingerprint?: string };
  try { context = JSON.parse(job.query_json); } catch { return false; }
  return draft.stage === "flights" && draft.boardConfirmed && draft.flightSearchJob?.id === job.job_id &&
    draft.handoffId === job.handoff_id && draft.sourceIntentStateVersion === job.source_intent_state_version &&
    context.boardFingerprint === flightBoardFingerprint(draft);
}

export function publicFlightJob(job: TravelFlightJobRow): FlightSearchJob {
  let direction: FlightSearchJob["direction"] = "both";
  try { const value = JSON.parse(job.query_json).direction; if (value === "outbound" || value === "inbound") direction = value; } catch { /* Old or invalid rows retain a generic label. */ }
  const status = ["queued", "running", "completed", "failed", "timed_out", "superseded"].includes(job.status)
    ? job.status as FlightSearchJob["status"] : "failed";
  const messages: Record<FlightSearchJob["status"], string> = {
    queued: "航班查询已保存，正在等待本次规划会话可用。",
    running: job.error_code === "submission_uncertain" ? "正在确认同一次查询的提交状态；继续读取不会重复提交。"
      : job.error_code === "network" ? "连接暂时中断，正在继续读取同一次查询。" : "正在查询航班，结果会在完成后显示。",
    completed: "本次查询已完成，请查看各出发日期的实际返回状态。",
    failed: job.error_code === "configuration" ? "航班查询服务配置暂不可用。"
      : job.error_code === "requires_action" ? "查询工具需要平台端授权，暂时无法继续。"
      : job.error_code === "invalid_response" || job.error_code === "invalid_reply" ? "查询回复格式不完整，未采用候选。"
      : "本次航班查询发生错误，未把错误当作无票结果。",
    timed_out: "网站本次等待已到期；这不代表航班接口失败。可以继续读取同一次查询。",
    superseded: "旅行安排已有更新，本次旧查询不会覆盖新的规划。",
  };
  return { id: job.job_id, direction, status, message: messages[status], createdAt: new Date(job.created_at).toISOString(), deadlineAt: new Date(job.deadline_at).toISOString() };
}

export function settleFlightJob(job: TravelFlightJobRow, step: PlanningAgentTaskStep, now: number): TravelFlightJobRow {
  if (terminal.has(job.status)) return job;
  if (now >= job.deadline_at && step.status !== "completed") return { ...job, status: "timed_out", updated_at: now };
  if (step.status === "completed") {
    try {
      const query = JSON.parse(job.query_json) as FlightJobQuery;
      const result = parseFlightAgentResponse({ text: step.text, queriedAt: new Date(job.created_at).toISOString(),
        ...requestedFlightDates(query), requiredArrivalDate: query.startDate,
        travelers: query.travelers, preferences: query.preferences });
      return { ...job, status: "completed", result_json: JSON.stringify(result), error_code: null, updated_at: now };
    } catch {
      return { ...job, status: "failed", error_code: "invalid_response", updated_at: now };
    }
  }
  if (step.status === "failed") return { ...job, status: "failed", error_code: step.reason, updated_at: now };
  return { ...job, status: step.status, error_code: "retryableCode" in step ? step.retryableCode : null, updated_at: now };
}

async function hash(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function flightSearchContextFingerprint(query: FlightSearchQuery, draft: Pick<PlanningDraftV1, "assignments" | "candidates" | "handoffId" | "sourceIntentStateVersion">) {
  return hash({ ...query, direction: "both", boardFingerprint: flightBoardFingerprint(draft),
    handoffId: draft.handoffId, sourceIntentStateVersion: draft.sourceIntentStateVersion });
}

function draftInput(draft: PlanningDraftV1, changes: Partial<PlanningDraftV1>) {
  const { version: _version, updatedAt: _updatedAt, ...base } = draft;
  void _version; void _updatedAt;
  return { ...base, ...changes };
}

/** Save a durable reference first. A poll starts the remote query, once only. */
export async function createPlanningFlightJob(token: string, draft: PlanningDraftV1, input: FlightSearchInput, expectedVersion: number, turnId: string, timing?: PlanningTiming) {
  if (!/^[A-Za-z0-9_:-]{8,80}$/.test(turnId)) throw new Error("FLIGHT_JOB_INPUT_INVALID");
  const baseQuery = buildFlightSearchQuery(input);
  const boardFingerprint = flightBoardFingerprint(draft);
  const contextFingerprint = await flightSearchContextFingerprint(baseQuery, draft);
  const query: FlightJobQuery = { ...baseQuery, boardFingerprint, contextFingerprint };
  const previousQuotes = draft.flightQuotes as FlightSearchResult | undefined;
  if (baseQuery.direction !== "both" && (!previousQuotes || previousQuotes.contextFingerprint !== contextFingerprint)) {
    throw new Error("FLIGHT_RETRY_CONTEXT_CHANGED");
  }
  const digest = await hash(query);
  const { acquireTravelVisit } = await import("./visit-session");
  const lease = await measured(timing, "lease_wait", () => acquireTravelVisit(token, new AbortController().signal));
  let job: TravelFlightJobRow;
  try {
    const existing = await measured(timing, "context_read", () => lease.readFlightJob(turnId));
    if (existing && (existing.input_hash !== digest || existing.handoff_id !== draft.handoffId)) throw new Error("FLIGHT_JOB_ID_REUSED");
    if (existing && draft.flightSearchJob?.id === turnId) return { draft, job: publicFlightJob(existing) };
    if (draft.version !== expectedVersion || draft.stage !== "flights") throw new Error("FLIGHT_JOB_VERSION_CONFLICT");
    const now = Date.now();
    job = existing || { job_id: turnId, handoff_id: draft.handoffId, source_intent_state_version: draft.sourceIntentStateVersion,
      input_hash: digest, query_json: JSON.stringify(query), status: "queued", result_json: null,
      error_code: null, created_at: now, updated_at: now, deadline_at: now + TASK_DEADLINE_MS };
    await measured(timing, "state_commit", () => lease.saveFlightJob(job));
  } finally { await lease.release(); }
  const result = await measured(timing, "state_commit", () => commitPlanningDraft(token, { expectedVersion: draft.version, turnId,
    nextDraft: draftInput(draft, { flightSearchJob: publicFlightJob(job!),
      flightQuotes: baseQuery.direction === "both" ? undefined : flightRetryBaseline(previousQuotes!, baseQuery, contextFingerprint),
      // Retain an existing pair for review while retrying. No stage can advance
      // until a pair from the newly merged quotes is explicitly confirmed.
      flightSelection: baseQuery.direction === "both" ? null : draft.flightSelection }) }));
  if (!result.committed || !result.draft) throw new Error("FLIGHT_JOB_VERSION_CONFLICT");
  return { draft: result.draft, job: publicFlightJob(job!) };
}

/** Read or update task metadata under a short data lease, without network work. */
async function flightSnapshot(token: string, options: { expectedJobId?: string; resume?: boolean; step?: PlanningAgentTaskStep } = {}, timing?: PlanningTiming) {
  const { acquireTravelVisit } = await import("./visit-session");
  const lease = await measured(timing, "lease_wait", () => acquireTravelVisit(token, new AbortController().signal));
  try {
    const row = await measured(timing, "context_read", () => lease.readPlanningDraftRow());
    if (!row) return null;
    const draft = PlanningDraftSchema.parse(JSON.parse(row.draft_json));
    const id = typeof draft.flightSearchJob?.id === "string" ? draft.flightSearchJob.id : "";
    if (!id) return { draft, job: null, valid: false };
    let job = await measured(timing, "context_read", () => lease.readFlightJob(id));
    if (!job) throw new Error("FLIGHT_JOB_NOT_FOUND");
    if (options.expectedJobId && options.expectedJobId !== id) return { draft, job, valid: false };
    const [intentState, handoff] = await measured(timing, "context_read", () => Promise.all([lease.readIntentState(), lease.readPlanningHandoff()]));
    const valid = Boolean(handoff && handoff.handoff_id === draft.handoffId && handoff.source_intent_state_version === intentState.stateVersion && draft.sourceIntentStateVersion === intentState.stateVersion && flightJobIsCurrent(job, draft));
    const previous = JSON.stringify(job);
    const now = Date.now();
    if (!valid) job = { ...job, status: "superseded", updated_at: now };
    else {
      if (options.resume && job.status === "timed_out") job = { ...job, status: "running", deadline_at: now + TASK_DEADLINE_MS, updated_at: now, error_code: null };
      if (!terminal.has(job.status)) {
        if (options.step) job = timing ? timing.measureSync("calculation", () => settleFlightJob(job!, options.step!, now)) : settleFlightJob(job, options.step, now);
        else if (now >= job.deadline_at) job = { ...job, status: "timed_out", updated_at: now };
      }
    }
    if (JSON.stringify(job) !== previous) { const update = job; await measured(timing, "state_commit", () => lease.saveFlightJob(update)); }
    return { draft, job, valid };
  } finally { await lease.release(); }
}

/** Remote tool waits own an Agent lease; ordinary planning writes remain free. */
export async function pollPlanningFlightJob(token: string, resume = false, timing?: PlanningTiming) {
  let snapshot = await flightSnapshot(token, { resume }, timing);
  if (!snapshot) return null;
  if (!snapshot.job) return { draft: snapshot.draft, job: null };
  const id = snapshot.job.job_id;
  if (snapshot.valid && !terminal.has(snapshot.job.status)) {
    const { acquirePlanningAgentLease } = await import("./visit-session");
    const agentLease = await measured(timing, "lease_wait", () => acquirePlanningAgentLease(token, new AbortController().signal));
    let step: PlanningAgentTaskStep | undefined;
    try {
      // A user may edit while this poll waits for the independent Agent lock.
      const current = await flightSnapshot(token, { expectedJobId: id }, timing);
      if (!current) return null;
      snapshot = current;
      if (current.valid && current.job && !terminal.has(current.job.status)) {
        const { advancePlanningAgentTask } = await import("./bailian");
        const query = JSON.parse(current.job.query_json) as FlightSearchQuery;
        step = await measured(timing, "agent_wait", () => advancePlanningAgentTask(flightSearchPrompt(query), id, agentLease));
      }
    } finally { await agentLease.release(); }
    if (step) snapshot = await flightSnapshot(token, { expectedJobId: id, step }, timing);
  }
  if (!snapshot) return null;
  const { draft, job } = snapshot;
  if (!job) return { draft, job: null };
  const projected = publicFlightJob(job);
  if (!snapshot.valid || job.job_id !== id) return { draft: { ...draft, flightSearchJob: projected }, job: projected };
  const changes: Partial<PlanningDraftV1> = { flightSearchJob: projected };
  if (job.status === "completed" && job.result_json) {
    const query = JSON.parse(job.query_json) as FlightJobQuery;
    const incoming = JSON.parse(job.result_json) as FlightSearchResult;
    const merged = query.contextFingerprint
      ? mergeFlightSearchResult(draft.flightQuotes as FlightSearchResult | undefined, incoming, query, query.contextFingerprint)
      : incoming;
    changes.flightQuotes = { ...merged, originCity: query.originCity };
  }
  if (JSON.stringify(draft.flightSearchJob) === JSON.stringify(projected) && (job.status !== "completed" || draft.flightQuotes)) return { draft, job: projected };
  const result = await measured(timing, "state_commit", () => commitPlanningDraft(token, { expectedVersion: draft.version, turnId: `${job.job_id}:poll:${draft.version}`,
    nextDraft: draftInput(draft, changes) }));
  return { draft: result.draft, job: result.draft?.flightSearchJob || null };
}
