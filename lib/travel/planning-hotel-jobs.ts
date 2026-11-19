import { env } from "cloudflare:workers";
import { hotelBatchLookupPrompt, parseHotelBatchReply, type HotelCommerceCandidate } from "./flyai";
import { extractJsonObject } from "./singapore-intent";
import { commitPlanningDraft, type PlanningDraftV1, type PlanningHandoffV1 } from "./planning-state";
import { readPlanningSceneContext } from "./planning-scenes";
import { assessHotelBudget, hotelBudgetAcknowledgementKey } from "./hotel-budget";
import { cnyPriceLabel } from "./cny-price";
import type { PlanningAgentTaskStep } from "./bailian";
import type { TravelCommerce } from "./types";
import type { PlanningTiming, PlanningTimingStep } from "./planning-timing";

const DEADLINE_MS = 8 * 60_000;
const terminal = new Set(["completed", "failed", "timed_out", "superseded"]);
export type HotelQuoteJob = {
  id: string; startDay: number; placeIds: string[];
  kind?: "discovery";
  searchId?: string;
  resultCounts?: { total: number; priced: number; linkOnly: number; unavailable: number; failed: number; unverifiedPrice?: number };
  status: "queued" | "running" | "completed" | "failed" | "timed_out" | "superseded";
  message: string; createdAt: string; deadlineAt: string;
};
type Candidate = HotelCommerceCandidate & { commerce?: TravelCommerce | null; quoteStatus?: string; quoteJobId?: string };
type Segment = {
  id: string; startDay: number; area: string; checkInDate: string; checkOutDate: string;
  hotelSearchId?: string;
  budgetPerNight?: { amount: number; currency: string } | null; budgetAcknowledgement?: string; budgetReviewRequired?: boolean;
  hotel?: { placeId: string }; hotelCandidates?: Candidate[];
};
export type HotelJobQuery = {
  segmentId: string; startDay: number; area: string; checkInDate: string; checkOutDate: string;
  searchId?: string;
  travelers: PlanningHandoffV1["travelers"]; hotels: HotelCommerceCandidate[];
};
export type HotelJobRow = {
  job_id: string; handoff_id: string; source_intent_state_version: number; input_hash: string; query_json: string;
  status: string; result_json: string | null; error_code: string | null; created_at: number; updated_at: number; deadline_at: number;
};
type Statement = { bind(...values: unknown[]): Statement; first<T>(): Promise<T | null>; run(): Promise<{ meta?: { changes?: number } }> };
type Database = { prepare(sql: string): Statement };
function db(): Database { const database = (env as unknown as { DB?: Database }).DB; if (!database) throw new Error("Hotel quote storage unavailable."); return database; }
async function digest(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function tokenHash(token: string) { if (!/^[0-9a-f-]{36}$/i.test(token)) throw new Error("Invalid visit token."); return digest(token); }
async function readJob(hash: string, id: string) { return db().prepare("SELECT job_id,handoff_id,source_intent_state_version,input_hash,query_json,status,result_json,error_code,created_at,updated_at,deadline_at FROM travel_planning_hotel_jobs WHERE token_hash=? AND job_id=?").bind(hash, id).first<HotelJobRow>(); }
function draftInput(draft: PlanningDraftV1, changes: Partial<PlanningDraftV1>) { const { version: _v, updatedAt: _t, ...base } = draft; void _v; void _t; return { ...base, ...changes }; }
function phase<T>(timing: PlanningTiming | undefined, name: PlanningTimingStep, operation: () => Promise<T>) { return timing ? timing.measureAsync(name, operation) : operation(); }

export function hotelJobQuery(handoff: PlanningHandoffV1, draft: PlanningDraftV1, startDay: number, placeIds?: string[]): HotelJobQuery {
  const segment = (draft.staySegments as Segment[] | undefined)?.find((item) => item.startDay === startDay);
  if (!segment) throw new Error("HOTEL_QUOTE_SEGMENT_MISSING");
  const requested = [...new Set(placeIds || segment.hotelCandidates?.map((item) => item.placeId) || [])];
  if (!requested.length || requested.length > 5 || requested.some((id) => !segment.hotelCandidates?.some((item) => item.placeId === id))) throw new Error("HOTEL_QUOTE_CANDIDATE_MISSING");
  return { segmentId: segment.id, startDay, area: segment.area, checkInDate: segment.checkInDate, checkOutDate: segment.checkOutDate,
    ...(segment.hotelSearchId ? { searchId: segment.hotelSearchId } : {}),
    travelers: handoff.travelers, hotels: requested.sort().map((placeId) => {
      const item = segment.hotelCandidates!.find((hotel) => hotel.placeId === placeId)!;
      return { placeId, name: item.name, address: item.address || "" };
    }) };
}

/** Version changes from selecting a hotel do not invalidate unchanged quote conditions. */
export function hotelJobIsCurrent(job: HotelJobRow, draft: PlanningDraftV1, handoff: PlanningHandoffV1): boolean {
  if (!["stays", "route", "complete"].includes(draft.stage) || !draft.boardConfirmed || draft.hotelQuoteJob?.id !== job.job_id ||
    draft.handoffId !== job.handoff_id || draft.sourceIntentStateVersion !== job.source_intent_state_version || handoff.sourceIntentStateVersion !== job.source_intent_state_version) return false;
  try {
    const query = JSON.parse(job.query_json) as HotelJobQuery & { kind?: "discovery" };
    if (query.kind === "discovery") return false;
    return JSON.stringify(hotelJobQuery(handoff, draft, query.startDay, query.hotels.map((hotel) => hotel.placeId))) === JSON.stringify(query);
  } catch { return false; }
}

/** A current remote batch must be read/resumed, never silently replaced. */
export async function currentActiveHotelQuoteJob(token: string, context: { handoff: PlanningHandoffV1; draft: PlanningDraftV1 }, timing?: PlanningTiming): Promise<HotelQuoteJob | null> {
  const id = typeof context.draft.hotelQuoteJob?.id === "string" ? context.draft.hotelQuoteJob.id : "";
  if (!id) return null;
  const row = await phase(timing, "cache_lookup", async () => readJob(await tokenHash(token), id));
  return row && ["queued", "running", "timed_out"].includes(row.status) && hotelJobIsCurrent(row, context.draft, context.handoff) ? publicHotelJob(row) : null;
}

export function publicHotelJob(row: HotelJobRow): HotelQuoteJob {
  const query = JSON.parse(row.query_json) as HotelJobQuery & { kind?: "discovery" };
  // V36 discovery jobs did not contain Google hotel IDs. Retire them on read
  // so stale tabs can release the old job without a supplier call or draft reset.
  if (query.kind === "discovery") return {
    id: row.job_id, status: "superseded", startDay: query.startDay, placeIds: [],
    ...(query.searchId ? { searchId: query.searchId } : {}),
    message: "住宿搜索流程已更新，请重新搜索本段酒店与价格。已选酒店仍保留。",
    createdAt: new Date(row.created_at).toISOString(), deadlineAt: new Date(row.deadline_at).toISOString(),
  };
  const status = ["queued", "running", "completed", "failed", "timed_out", "superseded"].includes(row.status) ? row.status as HotelQuoteJob["status"] : "failed";
  const messages: Record<HotelQuoteJob["status"], string> = {
    queued: "正在查询本段酒店与参考价，请稍候。", running: "正在查询本段酒店与参考价，请稍候。",
    completed: "本次酒店价格查询已返回，价格或链接按各家实际结果展示。", failed: row.error_code === "requires_action" ? "报价工具需要平台授权，请稍后重试。" : "本次报价暂未完成，酒店候选和已有选择仍保留。",
    timed_out: "本次等待已到期，可以继续读取同一次报价。", superseded: "住宿条件已有变化，旧报价不会覆盖当前安排。",
  };
  let resultCounts: HotelQuoteJob["resultCounts"];
  if (status === "completed" && row.result_json) {
    try {
      const quotes = JSON.parse(row.result_json) as Record<string, TravelCommerce | null>;
      resultCounts = { total: query.hotels.length, priced: 0, linkOnly: 0, unavailable: 0, failed: 0 };
      for (const hotel of query.hotels) {
        const quote = quotes[hotel.placeId];
        if (quote?.status === "available" && cnyPriceLabel(quote.price)) resultCounts.priced++;
        else if (quote?.status === "available" && quote.bookingUrl) resultCounts.linkOnly++;
        else if (quote?.status === "available" && quote.price) resultCounts.unverifiedPrice = (resultCounts.unverifiedPrice || 0) + 1;
        else if (quote?.status === "unavailable") resultCounts.unavailable++;
        else resultCounts.failed++;
      }
    } catch { /* malformed persisted data is not reported as successful prices */ }
  }
  const message = resultCounts ? `本批 ${resultCounts.total} 家酒店已处理：${resultCounts.priced} 家有参考价、${resultCounts.linkOnly} 家仅详情链接、${resultCounts.unavailable} 家未匹配到报价、${resultCounts.failed} 家查询失败${resultCounts.unverifiedPrice ? `、${resultCounts.unverifiedPrice} 家人民币参考价待核实` : ""}。` : messages[status];
  return { id: row.job_id, status, startDay: query.startDay, placeIds: query.hotels.map((item) => item.placeId),
    ...(query.searchId ? { searchId: query.searchId } : {}), ...(resultCounts ? { resultCounts } : {}),
    message, createdAt: new Date(row.created_at).toISOString(), deadlineAt: new Date(row.deadline_at).toISOString() };
}

export function settleHotelJob(row: HotelJobRow, step: PlanningAgentTaskStep, now: number): HotelJobRow {
  if (terminal.has(row.status)) return row;
  if (now >= row.deadline_at && step.status !== "completed") return { ...row, status: "timed_out", updated_at: now };
  if (step.status === "completed") {
    try {
      const payload = extractJsonObject(step.text) as { results?: unknown };
      if (!payload || !Array.isArray(payload.results)) throw new Error("Invalid hotel quote reply.");
      const query = JSON.parse(row.query_json) as HotelJobQuery;
      const quotes = parseHotelBatchReply(step.text, new Date(now).toISOString(), query.hotels);
      return { ...row, status: "completed", result_json: JSON.stringify(Object.fromEntries(quotes)), error_code: null, updated_at: now };
    } catch { return { ...row, status: "failed", error_code: "invalid_response", updated_at: now }; }
  }
  if (step.status === "failed") return { ...row, status: "failed", error_code: step.reason, updated_at: now };
  return { ...row, status: step.status, error_code: "retryableCode" in step ? step.retryableCode : null, updated_at: now };
}

/** Merge only quoted commodity fields into the newest segment, preserving selection and route state. */
export function mergeHotelQuoteResult(draft: PlanningDraftV1, query: HotelJobQuery, jobId: string, quotes: Record<string, TravelCommerce | null>) {
  let needsReview = false;
  const staySegments = (draft.staySegments as Segment[] | undefined)?.map((segment) => {
    if (segment.id !== query.segmentId) return segment;
    const requested = new Set(query.hotels.map((item) => item.placeId));
    const hotelCandidates = segment.hotelCandidates?.map((hotel) => {
      if (!requested.has(hotel.placeId)) return hotel;
      const commerce = quotes[hotel.placeId] || null;
      return { ...hotel, commerce, quoteStatus: commerce?.status === "available" ? "available" : commerce?.status === "unavailable" ? "unavailable" : "failed", quoteJobId: jobId };
    });
    const selected = hotelCandidates?.find((hotel) => hotel.placeId === segment.hotel?.placeId);
    needsReview = Boolean(selected && assessHotelBudget(segment.budgetPerNight, selected.commerce).status === "over_budget" &&
      segment.budgetAcknowledgement !== hotelBudgetAcknowledgementKey(segment, selected));
    return { ...segment, hotelCandidates, ...(needsReview ? { budgetReviewRequired: true } : {}) };
  });
  return { staySegments: staySegments as unknown as Array<Record<string, unknown>>, reviewRequired: needsReview ? [...new Set([...(draft.reviewRequired || []), "住宿预算"])] : draft.reviewRequired };
}

export async function createHotelQuoteJob(token: string, context: { handoff: PlanningHandoffV1; draft: PlanningDraftV1 }, input: { startDay: number; placeIds?: string[]; expectedVersion: number; turnId: string }, timing?: PlanningTiming) {
  const { draft, handoff } = context;
  if (!/^[A-Za-z0-9_:-]{8,70}$/.test(input.turnId) || draft.stage !== "stays") throw new Error("HOTEL_QUOTE_INPUT_INVALID");
  const query = hotelJobQuery(handoff, draft, input.startDay, input.placeIds);
  const inputHash = await digest(JSON.stringify(query));
  const hash = await tokenHash(token);
  const existing = await phase(timing, "cache_lookup", () => readJob(hash, input.turnId));
  if (existing && (existing.input_hash !== inputHash || existing.handoff_id !== draft.handoffId || existing.source_intent_state_version !== draft.sourceIntentStateVersion)) throw new Error("HOTEL_QUOTE_ID_REUSED");
  if (existing && draft.hotelQuoteJob?.id === input.turnId) return { draft, job: publicHotelJob(existing) };
  const activeId = typeof draft.hotelQuoteJob?.id === "string" ? draft.hotelQuoteJob.id : "";
  const active = activeId ? await phase(timing, "cache_lookup", () => readJob(hash, activeId)) : null;
  if (active && (!terminal.has(active.status) || active.status === "timed_out") && hotelJobIsCurrent(active, draft, handoff)) {
    if (active.input_hash === inputHash) return { draft, job: publicHotelJob(active) };
    throw new Error("HOTEL_QUOTE_ALREADY_RUNNING");
  }
  if (draft.version !== input.expectedVersion) throw new Error("HOTEL_QUOTE_VERSION_CONFLICT");
  const now = Date.now();
  const row: HotelJobRow = existing || { job_id: input.turnId, handoff_id: draft.handoffId, source_intent_state_version: draft.sourceIntentStateVersion,
    input_hash: inputHash, query_json: JSON.stringify(query), status: "queued", result_json: null, error_code: null, created_at: now, updated_at: now, deadline_at: now + DEADLINE_MS };
  await db().prepare("INSERT OR IGNORE INTO travel_planning_hotel_jobs(token_hash,job_id,handoff_id,source_intent_state_version,input_hash,query_json,status,result_json,error_code,created_at,updated_at,deadline_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(hash, row.job_id, row.handoff_id, row.source_intent_state_version, row.input_hash, row.query_json, row.status, row.result_json, row.error_code, row.created_at, row.updated_at, row.deadline_at).run();
  const result = await phase(timing, "state_commit", () => commitPlanningDraft(token, { expectedVersion: draft.version, turnId: input.turnId,
    nextDraft: draftInput(draft, { hotelQuoteJob: publicHotelJob(row) }) }, timing));
  if (!result.committed) throw new Error("HOTEL_QUOTE_VERSION_CONFLICT");
  return { draft: result.draft, job: publicHotelJob(row) };
}

async function saveAdvancedJob(hash: string, row: HotelJobRow, owner: string) {
  return db().prepare("UPDATE travel_planning_hotel_jobs SET status=?,result_json=?,error_code=?,updated_at=?,deadline_at=?,poll_owner=NULL,poll_expires_at=NULL WHERE token_hash=? AND job_id=? AND poll_owner=?")
    .bind(row.status, row.result_json, row.error_code, row.updated_at, row.deadline_at, hash, row.job_id, owner).run();
}

export async function pollHotelQuoteJob(token: string, resume = false, initialContext?: { handoff: PlanningHandoffV1; draft: PlanningDraftV1 }, timing?: PlanningTiming) {
  let context = initialContext || await phase(timing, "context_read", () => readPlanningSceneContext(token, new AbortController().signal, timing));
  const id = typeof context.draft.hotelQuoteJob?.id === "string" ? context.draft.hotelQuoteJob.id : "";
  if (!id) return { draft: context.draft, job: null };
  const hash = await tokenHash(token);
  let row = await readJob(hash, id);
  if (!row) throw new Error("HOTEL_QUOTE_JOB_MISSING");
  const owner = crypto.randomUUID();
  const now = Date.now();
  const claim = await db().prepare("UPDATE travel_planning_hotel_jobs SET poll_owner=?,poll_expires_at=? WHERE token_hash=? AND job_id=? AND (poll_owner IS NULL OR poll_expires_at<?)")
    .bind(owner, now + 90_000, hash, id, now).run();
  if ((claim.meta?.changes || 0) !== 1) return { draft: context.draft, job: publicHotelJob(row) };
  try {
    if (!hotelJobIsCurrent(row, context.draft, context.handoff)) row = { ...row, status: "superseded", updated_at: now };
    if (resume && row.status === "timed_out") row = { ...row, status: "running", deadline_at: now + DEADLINE_MS, updated_at: now };
    if (!terminal.has(row.status)) {
      if (now >= row.deadline_at) row = { ...row, status: "timed_out", updated_at: now };
      else {
        const { acquirePlanningAgentLease } = await import("./visit-session");
        const { advancePlanningAgentTask } = await import("./bailian");
        const lease = await phase(timing, "lease_wait", () => acquirePlanningAgentLease(token, new AbortController().signal));
        try {
          const latest = await phase(timing, "context_read", () => readPlanningSceneContext(token, new AbortController().signal, timing));
          if (!hotelJobIsCurrent(row, latest.draft, latest.handoff)) row = { ...row, status: "superseded", updated_at: Date.now() };
          else {
            const query = JSON.parse(row.query_json) as HotelJobQuery;
            const activeRow = row;
            const step = await phase(timing, "agent_wait", () => advancePlanningAgentTask(hotelBatchLookupPrompt({ hotels: query.hotels, checkInDate: query.checkInDate,
              checkOutDate: query.checkOutDate, travelers: query.travelers.total }), `hquote:${activeRow.job_id}`, lease));
            row = settleHotelJob(row, step, Date.now());
          }
        } finally { await lease.release(); }
      }
    }
    const saved = await phase(timing, "state_commit", () => saveAdvancedJob(hash, row!, owner));
    if ((saved.meta?.changes || 0) !== 1) {
      const authoritative = await readJob(hash, id);
      if (!authoritative) throw new Error("HOTEL_QUOTE_JOB_MISSING");
      row = authoritative;
    }
  } finally {
    await db().prepare("UPDATE travel_planning_hotel_jobs SET poll_owner=NULL,poll_expires_at=NULL WHERE token_hash=? AND job_id=? AND poll_owner=?").bind(hash, id, owner).run();
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    context = await phase(timing, "context_read", () => readPlanningSceneContext(token, new AbortController().signal, timing));
    if (context.draft.hotelQuoteJob?.id !== id) return { draft: context.draft, job: context.draft.hotelQuoteJob || null };
    if (!hotelJobIsCurrent(row, context.draft, context.handoff)) {
      row = { ...row, status: "superseded", updated_at: Date.now() };
      await db().prepare("UPDATE travel_planning_hotel_jobs SET status='superseded',updated_at=? WHERE token_hash=? AND job_id=?").bind(row.updated_at, hash, id).run();
    }
    const projected = publicHotelJob(row);
    const changes = { hotelQuoteJob: projected, ...(row.status === "completed" && row.result_json ? mergeHotelQuoteResult(context.draft, JSON.parse(row.query_json), id, JSON.parse(row.result_json))
      : row.status === "failed" ? mergeHotelQuoteResult(context.draft, JSON.parse(row.query_json), id, {}) : {}) };
    if (JSON.stringify(context.draft.hotelQuoteJob) === JSON.stringify(projected) && (!changes.staySegments || JSON.stringify(changes.staySegments) === JSON.stringify(context.draft.staySegments))) return { draft: context.draft, job: projected };
    const currentDraft = context.draft;
    const result = await phase(timing, "state_commit", () => commitPlanningDraft(token, { expectedVersion: currentDraft.version, turnId: `hquote:${id}:v${currentDraft.version}`,
      nextDraft: draftInput(currentDraft, changes) }, timing));
    if (result.committed) return { draft: result.draft, job: projected };
  }
  return { draft: context.draft, job: context.draft.hotelQuoteJob || null };
}
