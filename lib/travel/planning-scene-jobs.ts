import { env } from "cloudflare:workers";
import { advanceSceneDiscovery, initialSceneDiscoveryState, resumeSceneDiscovery, type SceneDiscoveryState, type SceneDiscoveryStatus } from "./planning-scene-discovery";
import { commitPlanningDraft, type PlanningDraftV1, type PlanningHandoffV1 } from "./planning-state";
import { readPlanningSceneContext, PlanningSceneCandidateSchema } from "./planning-scenes";
import { mergePlanningCandidatePool, selectedPlanningPlaceIds } from "./planning-place-selection";
import type { PlanningTiming } from "./planning-timing";

const DEADLINE_MS = 8 * 60_000;
const COLUMN_LIST = "job_id,handoff_id,source_intent_state_version,input_hash,query_json,status,result_json,error_code,created_at,updated_at,deadline_at";
type Statement = { bind(...values: unknown[]): Statement; first<T>(): Promise<T | null>; run(): Promise<{ meta?: { changes?: number } }> };
type Database = { prepare(sql: string): Statement };
export type SceneDiscoveryJob = {
  id: string; status: SceneDiscoveryStatus; stage: SceneDiscoveryState["phase"];
  message: string; canResume: boolean; verifiedCount: number; pendingCount: number;
  createdAt: string; deadlineAt: string; errorCode?: string; sourceErrorCode?: string;
  submissionState?: "preparing" | "submitted" | "uncertain"; agentStage?: string;
};
export type SceneJobRow = {
  job_id: string; handoff_id: string; source_intent_state_version: number; input_hash: string; query_json: string;
  status: SceneDiscoveryStatus; result_json: string; error_code: string | null; created_at: number; updated_at: number; deadline_at: number;
};
type Query = { contextFingerprint: string; replaceUnselected: boolean; preservePlaceIds?: string[] };
function database(): Database { const db = (env as unknown as { DB?: Database }).DB; if (!db) throw new Error("Scene task storage unavailable."); return db; }
async function hash(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function visitHash(token: string) { if (!/^[0-9a-f-]{36}$/i.test(token)) throw new Error("Invalid visit token."); return hash(token); }
const bodyInput = (draft: PlanningDraftV1, changes: Partial<PlanningDraftV1>) => { const { version: _v, updatedAt: _t, ...base } = draft; void _v; void _t; return { ...base, ...changes }; };
const stateOf = (row: SceneJobRow) => JSON.parse(row.result_json) as SceneDiscoveryState;
const queryOf = (row: SceneJobRow) => JSON.parse(row.query_json) as Query;
const active = (row: SceneJobRow) => row.status === "queued" || row.status === "running";
async function readJob(tokenHash: string, id: string) { return database().prepare(`SELECT ${COLUMN_LIST} FROM travel_planning_scene_jobs WHERE token_hash=? AND job_id=?`).bind(tokenHash, id).first<SceneJobRow>(); }
export function sceneDiscoveryContext(handoff: PlanningHandoffV1) { return hash(JSON.stringify({ handoff })); }

export function publicSceneDiscoveryJob(row: SceneJobRow): SceneDiscoveryJob {
  const state = stateOf(row);
  const canResume = !["completed", "superseded"].includes(row.status) && !["invalid_suggestions", "invalid_assessments", "no_eligible_places"].includes(row.error_code || "");
  const progress = state.agentProgress;
  const submissionState = progress?.submitted === true ? "submitted" : progress?.submitted === "unknown" ? "uncertain" : "preparing";
  const phaseMessage = ["verify", "popular_search"].includes(state.phase) ? "正在核实本次地点，完成后显示候选。"
    : submissionState === "uncertain" ? "提示词是否提交成功尚未确认，正在核对原消息；不会重复发送。"
      : submissionState === "submitted" && progress?.stage !== "completed" ? "百炼已接收本轮提示词，正在等待地点建议。"
        : "准备向百炼提交本轮地点要求。";
  const failureMessage = ["agent_http_401", "agent_http_403"].includes(progress?.code || "") ? "百炼认证或访问权限校验失败，本次查询已暂停；请检查服务配置后重试。"
    : progress?.code === "agent_http_429" ? "百炼暂时限制请求频率或额度，本次查询已暂停；请稍后重试。"
    : row.error_code === "storage_failed" ? "规划状态读取或保存失败，本次查询已暂停；已确认的旅行条件仍保留。"
    : row.error_code === "session_unavailable" ? "百炼会话暂不可用，本轮查询已暂停；可以稍后继续读取。"
      : row.error_code === "read_failed" ? "提示词已提交，读取百炼回复失败；请继续读取原任务，不会重复发送。"
        : row.error_code === "submission_failed" ? "本轮提示词未成功提交，查询已暂停；请稍后重试本次任务。"
          : submissionState === "uncertain" ? "本轮提示词提交结果暂不确定；请继续核对原任务，不会直接重复发送。"
            : "本次地点整理暂不可用；旅行条件已保留，可继续读取或稍后重试。";
  const message = row.status === "completed" ? "本次地点整理已完成。"
    : row.status === "superseded" ? "旅行条件或当前阶段已更新，本次旧结果不会覆盖新的安排。"
      : row.status === "timed_out" ? row.error_code === "response_wait_timeout" ? "本轮回复等待已达 120 秒，原任务仍保留；可继续读取，无需重新发送。" : "本次地点整理尚未完成，已保留旅行条件；可以继续读取本次结果。"
        : row.status === "partial" ? row.error_code === "google_verification" ? "部分地点尚未核实，已保留可用候选；可继续核实本次结果。" : `已保留核实候选。${failureMessage}`
          : row.status === "failed" ? row.error_code === "invalid_suggestions" || row.error_code === "invalid_assessments" ? "地点建议内容暂不完整，本次未采用未核实内容。"
            : row.error_code === "no_eligible_places" ? "本次未找到符合当前要求的可用地点，可调整偏好或搜索具体名称。"
              : row.error_code === "google_verification" ? "地点建议已保留，Google 核实暂未完成，可继续核实本次结果。"
                : row.error_code === "configuration" ? "百炼地点规划服务尚未配置完整；旅行条件已保留，请配置恢复后继续读取。"
                : failureMessage
            : phaseMessage;
  return { id: row.job_id, status: row.status, stage: state.phase,
    message: row.error_code === "google_verification" && state.lastFailure ? `${message} ${state.lastFailure.message}` : message, canResume,
    verifiedCount: state.candidates.length, pendingCount: state.lookups.filter((item) => item.status === "pending" || item.status === "failed").length,
    createdAt: new Date(row.created_at).toISOString(), deadlineAt: new Date(row.deadline_at).toISOString(),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_code === "google_verification" && state.lastFailure ? { sourceErrorCode: state.lastFailure.code } : progress?.code ? { sourceErrorCode: progress.code } : {}),
    submissionState, ...(progress?.stage ? { agentStage: progress.stage } : {}) };
}

function projectJob(draft: PlanningDraftV1, row: SceneJobRow) {
  if (draft.sceneDiscoveryJob?.id !== row.job_id) return { draft, job: draft.sceneDiscoveryJob || null };
  const job = publicSceneDiscoveryJob(row);
  return { draft: { ...draft, sceneDiscoveryJob: job }, job };
}

async function currentJob(token: string, supplied?: { handoff: PlanningHandoffV1; draft: PlanningDraftV1 }) {
  const context = supplied || await readPlanningSceneContext(token, new AbortController().signal);
  const id = String(context.draft.sceneDiscoveryJob?.id || "");
  const tokenHash = await visitHash(token);
  const row = id ? await readJob(tokenHash, id) : null;
  return { ...context, row, tokenHash };
}

export async function createPlanningSceneJob(token: string, draft: PlanningDraftV1, handoff: PlanningHandoffV1,
  input: { expectedVersion: number; turnId: string; restart?: boolean; replaceUnselected?: boolean; preservePlaceIds?: string[] }, timing?: PlanningTiming) {
  if (draft.stage !== "places") throw new Error("SCENE_JOB_VERSION_CONFLICT");
  const tokenHash = await visitHash(token);
  const contextFingerprint = await sceneDiscoveryContext(handoff);
  let existing = draft.sceneDiscoveryJob?.id ? await readJob(tokenHash, String(draft.sceneDiscoveryJob.id)) : null;
  if (!input.restart && existing && existing.input_hash === contextFingerprint && existing.handoff_id === draft.handoffId) {
    return { draft: { ...draft, sceneDiscoveryJob: publicSceneDiscoveryJob(existing) }, job: publicSceneDiscoveryJob(existing) };
  }
  const jobId = `scene_${(await hash(`${draft.handoffId}:${contextFingerprint}:${input.restart ? input.turnId : "initial"}`)).slice(0, 40)}`;
  existing = await readJob(tokenHash, jobId);
  if (existing && draft.sceneDiscoveryJob?.id === jobId) return { draft: { ...draft, sceneDiscoveryJob: publicSceneDiscoveryJob(existing) }, job: publicSceneDiscoveryJob(existing) };
  if (draft.version !== input.expectedVersion || draft.stage !== "places") throw new Error("SCENE_JOB_VERSION_CONFLICT");
  const now = Date.now();
  const row: SceneJobRow = existing || { job_id: jobId, handoff_id: draft.handoffId,
    source_intent_state_version: draft.sourceIntentStateVersion, input_hash: contextFingerprint,
    query_json: JSON.stringify({ contextFingerprint, replaceUnselected: Boolean(input.replaceUnselected), preservePlaceIds: input.preservePlaceIds || [] }),
    status: "queued", result_json: JSON.stringify(initialSceneDiscoveryState()), error_code: null,
    created_at: now, updated_at: now, deadline_at: now + DEADLINE_MS };
  await database().prepare("DELETE FROM travel_planning_scene_jobs WHERE updated_at<?").bind(now - 24 * 60 * 60_000).run();
  await database().prepare("INSERT OR IGNORE INTO travel_planning_scene_jobs(token_hash,job_id,handoff_id,source_intent_state_version,input_hash,query_json,status,result_json,error_code,created_at,updated_at,deadline_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(tokenHash, row.job_id, row.handoff_id, row.source_intent_state_version, row.input_hash, row.query_json, row.status, row.result_json, row.error_code, row.created_at, row.updated_at, row.deadline_at).run();
  const job = publicSceneDiscoveryJob(await readJob(tokenHash, jobId) || row);
  const commit = await commitPlanningDraft(token, { expectedVersion: draft.version, turnId: `${jobId}:create`, nextDraft: bodyInput(draft, { sceneDiscoveryJob: job }) }, timing);
  if (!commit.committed || !commit.draft) throw new Error("SCENE_JOB_VERSION_CONFLICT");
  return { draft: commit.draft, job };
}

export async function sceneJobIsCurrent(row: SceneJobRow, draft: PlanningDraftV1, handoff: PlanningHandoffV1) {
  return draft.stage === "places" && draft.sceneDiscoveryJob?.id === row.job_id && draft.handoffId === row.handoff_id
    && draft.sourceIntentStateVersion === row.source_intent_state_version && row.input_hash === await sceneDiscoveryContext(handoff);
}

/** Merge only new verified results, preserving choices edited while the remote model was working. */
async function publishCandidates(token: string, row: SceneJobRow, timing?: PlanningTiming) {
  for (let retry = 0; retry < 2; retry++) {
    const context = await currentJob(token);
    if (!await sceneJobIsCurrent(row, context.draft, context.handoff)) return null;
    const state = stateOf(row);
    const selected = selectedPlanningPlaceIds(context.draft);
    const existing = context.draft.candidates.flatMap((item) => { const parsed = PlanningSceneCandidateSchema.safeParse(item); return parsed.success ? [parsed.data] : []; });
    // A previous successful draft commit may have been followed by a worker exit
    // before the separate job checkpoint. The persisted projection is its receipt.
    const receipt = context.draft.sceneDiscoveryJob;
    const alreadyDelivered = receipt?.id === row.job_id && receipt.status === row.status && receipt.stage === state.phase && receipt.verifiedCount === state.candidates.length;
    const fresh = alreadyDelivered ? [] : state.candidates.filter((item) => !state.publishedIds.includes(item.placeId));
    const protectedIds = [...new Set([...selected, ...(queryOf(row).preservePlaceIds || []), ...context.draft.assignments.flatMap((item) => item.orderedCandidateIds)])];
    const candidates = fresh.length ? mergePlanningCandidatePool(existing, fresh, protectedIds, queryOf(row).replaceUnselected) : existing;
    const job = publicSceneDiscoveryJob(row);
    if (!fresh.length && JSON.stringify(context.draft.sceneDiscoveryJob) === JSON.stringify(job)) return context.draft;
    const commit = await commitPlanningDraft(token, { expectedVersion: context.draft.version, turnId: `${row.job_id}:merge:${context.draft.version}`,
      nextDraft: bodyInput(context.draft, { candidates, selectedPlaceIds: selected, sceneDiscoveryJob: job,
        selectionReason: candidates.length ? `已找到 ${candidates.length} 处 Google 核实的地点。先选择想去的地点，再决定哪天去。` : context.draft.selectionReason }) }, timing);
    if (commit.committed && commit.draft) return commit.draft;
  }
  return null;
}

/** One short poll, guarded by a job lease. No permanent background process is assumed. */
export async function pollPlanningSceneJob(token: string, resume = false, timing?: PlanningTiming, supplied?: { handoff: PlanningHandoffV1; draft: PlanningDraftV1 }) {
  let context = await currentJob(token, supplied);
  let row = context.row;
  if (!row) return { draft: context.draft, job: null };
  const owner = crypto.randomUUID();
  const now = Date.now();
  const claimed = await database().prepare("UPDATE travel_planning_scene_jobs SET poll_owner=?,poll_expires_at=? WHERE token_hash=? AND job_id=? AND (poll_owner IS NULL OR poll_expires_at<?)")
    .bind(owner, now + 90_000, context.tokenHash, row.job_id, now).run();
  if (!claimed.meta?.changes) return projectJob(context.draft, row);
  try {
    row = await readJob(context.tokenHash, row.job_id) || row;
    if (!await sceneJobIsCurrent(row, context.draft, context.handoff)) row = { ...row, status: "superseded", updated_at: Date.now() };
    else {
      if (resume && publicSceneDiscoveryJob(row).canResume) row = { ...row, status: "running", result_json: JSON.stringify(resumeSceneDiscovery(stateOf(row))), error_code: null, deadline_at: Date.now() + DEADLINE_MS };
      if (active(row) && Date.now() >= row.deadline_at) row = { ...row, status: "timed_out" };
      if (active(row)) {
        const initial = stateOf(row);
        let advanced;
        try { advanced = await advanceSceneDiscovery(initial, context.handoff, row.job_id, {
          agent: async (message, turnId) => {
            const { acquirePlanningAgentLease } = await import("./visit-session");
            const { advancePlanningAgentTask } = await import("./bailian");
            const lease = await acquirePlanningAgentLease(token, new AbortController().signal);
            try {
              // The Agent lease checks handoff identity before every mutation.
              // A newer job is checked again before publishing; no full reread is needed here.
              const current = await readJob(context.tokenHash, row!.job_id);
              const activeDraftJob = await database().prepare("SELECT draft_json FROM travel_planning_drafts WHERE token_hash=?").bind(context.tokenHash).first<{ draft_json: string }>();
              if (!current || !activeDraftJob || !await sceneJobIsCurrent(row!, JSON.parse(activeDraftJob.draft_json) as PlanningDraftV1, context.handoff)) return { status: "failed", reason: "stale_handoff" };
              // Await inside try: returning the Promise directly would run finally
              // and release the Agent lock before the asynchronous submission reads it.
              return await (timing ? timing.measureAsync("agent_wait", () => advancePlanningAgentTask(message, turnId, lease, { retryRejected: resume })) : advancePlanningAgentTask(message, turnId, lease, { retryRejected: resume }));
            } finally { await lease.release(); }
          },
          search: async (query, maxResults) => {
            const { searchSingaporePlaces } = await import("./google-maps");
            const lookup = () => searchSingaporePlaces({ query, maxResults, languageCode: "zh-CN" });
            return timing ? timing.measureAsync("google_lookup", lookup) : lookup();
          },
        }); } catch {
          console.warn("Scene Agent setup failed", { stage: "planning_lease", code: "SCENE_AGENT_SETUP_FAILED" });
          advanced = { state: { ...initial, agentProgress: { turnId: `${row.job_id}:setup`, stage: "planning_lease", submitted: initial.agentProgress?.submitted ?? false, reason: "storage_failed", code: "SCENE_AGENT_SETUP_FAILED", retryable: true } }, status: "failed" as const, errorCode: "storage_failed" };
        }
        row = { ...row, status: advanced.status, error_code: advanced.errorCode, result_json: JSON.stringify(advanced.state), updated_at: Date.now() };
      }
    }
    context = await currentJob(token);
    if (!await sceneJobIsCurrent(row, context.draft, context.handoff)) row = { ...row, status: "superseded", updated_at: Date.now() };
    const persisted = await database().prepare("UPDATE travel_planning_scene_jobs SET status=?,result_json=?,error_code=?,updated_at=?,deadline_at=? WHERE token_hash=? AND job_id=? AND poll_owner=?")
      .bind(row.status, row.result_json, row.error_code, row.updated_at, row.deadline_at, context.tokenHash, row.job_id, owner).run();
    if (!persisted.meta?.changes) return { draft: context.draft, job: null };
    if (["completed", "partial"].includes(row.status) && row.status !== "superseded") {
      const draft = await publishCandidates(token, row, timing);
      if (draft) {
        const state = stateOf(row);
        state.publishedIds = [...new Set([...state.publishedIds, ...state.candidates.map((item) => item.placeId)])];
        row.result_json = JSON.stringify(state);
        await database().prepare("UPDATE travel_planning_scene_jobs SET result_json=? WHERE token_hash=? AND job_id=? AND poll_owner=?").bind(row.result_json, context.tokenHash, row.job_id, owner).run();
        return { draft, job: publicSceneDiscoveryJob(row) };
      }
    }
    return projectJob(context.draft, row);
  } finally {
    await database().prepare("UPDATE travel_planning_scene_jobs SET poll_owner=NULL,poll_expires_at=NULL WHERE token_hash=? AND job_id=? AND poll_owner=?").bind(context.tokenHash, row.job_id, owner).run();
  }
}

/** Recover status on refresh without submitting a new model turn. */
export async function readPlanningSceneJob(token: string, supplied?: { handoff: PlanningHandoffV1; draft: PlanningDraftV1 }) {
  const context = await currentJob(token, supplied);
  if (!context.row) return { draft: context.draft, job: null };
  const valid = await sceneJobIsCurrent(context.row, context.draft, context.handoff);
  const row = valid ? context.row : { ...context.row, status: "superseded" as const };
  return projectJob(context.draft, row);
}
