import { env } from "cloudflare:workers";

const VISIT_TTL_MS = 12 * 60 * 60_000;
const LEASE_TTL_MS = 100_000;
const LEASE_WAIT_MS = 30_000;
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type VisitRow = {
  session_id: string | null;
  planning_session_id: string | null;
  planning_intent_version: number | null;
  created_at: number;
};
type IntentStateRow = { state_version: number; result_json: string | null; slot_meta_json: string };
export type TravelPlanningHandoffRow = {
  handoff_id: string;
  source_intent_state_version: number;
  handoff_json: string;
  created_at: number;
  updated_at: number;
};
export type TravelPlanningDraftRow = {
  version: number;
  handoff_id: string;
  source_intent_state_version: number;
  draft_json: string;
};
export type TravelPlanningDraftTurn = { input_hash: string; draft_version: number; response_json: string };
export type TravelFlightJobRow = {
  job_id: string;
  handoff_id: string;
  source_intent_state_version: number;
  input_hash: string;
  query_json: string;
  status: string;
  result_json: string | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
  deadline_at: number;
};
export type TravelIntentState = {
  stateVersion: number;
  resultJson: string | null;
  slotMetaJson: string;
};
export type TravelIntentTurn = {
  input_hash: string;
  state_version: number;
  response_json: string;
};
export type TravelIntentCommit = {
  turnId: string;
  inputHash: string;
  expectedStateVersion: number;
  resultJson: string;
  slotMetaJson: string;
};
export type TravelAgentTurn = {
  session_id: string;
  input_hash: string;
  status: "reserved" | "submitted" | "completed" | "uncertain" | "rejected";
  input_event_id: string | null;
  input_created_at: string | null;
  reply_text: string | null;
  created_at: number;
};
type RunResult = { meta?: { changes?: number } };
type Statement = {
  bind(...values: unknown[]): Statement;
  run(): Promise<RunResult>;
  first<T>(): Promise<T | null>;
};
type VisitDatabase = {
  prepare(query: string): Statement;
  // Cloudflare D1 runs a batch in one transaction and rolls all statements
  // back if any statement fails.
  batch(statements: Statement[]): Promise<RunResult[]>;
};

export type TravelVisitLease = {
  sessionId: string | null;
  bindSession(sessionId: string): Promise<void>;
  planningSessionId: string | null;
  planningIntentVersion: number | null;
  bindPlanningSession(sessionId: string, sourceIntentStateVersion: number): Promise<void>;
  readPlanningHandoff(): Promise<TravelPlanningHandoffRow | null>;
  commitPlanningHandoff(input: {
    handoffId: string;
    sourceIntentStateVersion: number;
    handoffJson: string;
    initialDraftJson: string;
  }): Promise<void>;
  readPlanningDraftRow(): Promise<TravelPlanningDraftRow | null>;
  findPlanningDraftTurn(turnId: string): Promise<TravelPlanningDraftTurn | null>;
  readFlightJob(jobId: string): Promise<TravelFlightJobRow | null>;
  saveFlightJob(job: TravelFlightJobRow): Promise<void>;
  commitPlanningDraftRow(input: {
    turnId: string;
    inputHash: string;
    expectedVersion: number;
    handoffId: string;
    sourceIntentStateVersion: number;
    draftJson: string;
  }): Promise<{ committed: true; version: number } | { committed: false; state: TravelPlanningDraftRow | null }>;
  commitPlanningDayChange(input: {
    turnId: string;
    inputHash: string;
    expectedIntentStateVersion: number;
    expectedDraftVersion: number;
    expectedHandoffId: string;
    resultJson: string;
    slotMetaJson: string;
    handoffId: string;
    handoffJson: string;
    draftJson: string;
  }): Promise<void>;
  renew(): Promise<void>;
  findTurn(turnId: string): Promise<TravelAgentTurn | null>;
  reserveTurn(turnId: string, sessionId: string, inputHash: string): Promise<TravelAgentTurn>;
  markTurnSubmitted(turnId: string, eventId: string, createdAt: string): Promise<void>;
  markTurnComplete(turnId: string, replyText: string): Promise<void>;
  markTurnUncertain(turnId: string): Promise<void>;
  /** Only use after a deterministic upstream rejection, never after uncertain acceptance. */
  markTurnRejected?(turnId: string): Promise<void>;
  /** Explicit retry may clear a rejected reservation; submitted/uncertain turns remain protected. */
  clearRejectedTurn?(turnId: string): Promise<void>;
  readIntentState(): Promise<TravelIntentState>;
  findIntentTurn(turnId: string): Promise<TravelIntentTurn | null>;
  commitIntentTurn(commit: TravelIntentCommit): Promise<
    { committed: true; stateVersion: number } | { committed: false; state: TravelIntentState }
  >;
  /** One short SQL-only operation under a shared data lease; never perform HTTP in this callback. */
  withPlanningTurnData?<T>(operation: (data: TravelVisitLease) => Promise<T>): Promise<T>;
  release(): Promise<void>;
};

export class PlanningAgentHandoffChangedError extends Error {
  constructor() { super("Planning agent handoff was replaced."); this.name = "PlanningAgentHandoffChangedError"; }
}

function visitDb(): VisitDatabase {
  const db = (env as unknown as { DB?: VisitDatabase }).DB;
  if (!db) throw new Error("Travel visit storage is unavailable.");
  return db;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function readTravelVisitToken(request: Request): string | null {
  const token = request.headers.get("x-travel-visit")?.trim() || "";
  return TOKEN_PATTERN.test(token) ? token : null;
}

/**
 * D1's conditional UPDATE is the cross-Worker lease. A queued request cannot
 * send a second message while another request is still using the same Agent.
 */
export async function acquireTravelVisit(token: string, signal: AbortSignal, expectedVisitCreatedAt?: number): Promise<TravelVisitLease> {
  if (!TOKEN_PATTERN.test(token)) throw new Error("Invalid travel visit token.");
  const db = visitDb();
  const tokenHash = await hashToken(token);
  const owner = crypto.randomUUID();
  const startedAt = Date.now();

  while (!signal.aborted && Date.now() - startedAt < LEASE_WAIT_MS) {
    const now = Date.now();
    if (expectedVisitCreatedAt === undefined && Math.random() < 0.01) {
      // Turn replies can contain traveller details. Keep recovery data only a
      // little longer than the visit TTL, then remove expired mappings too.
      await db.batch([
        ["travel_agent_turns", "created_at"], ["travel_intent_turns", "created_at"],
        ["travel_intent_states", "updated_at"], ["travel_planning_draft_turns", "created_at"],
        ["travel_planning_drafts", "updated_at"], ["travel_planning_handoffs", "updated_at"],
        ["travel_planning_flight_jobs", "updated_at"], ["travel_planning_hotel_jobs", "updated_at"],
        ["travel_planning_agent_locks", "expires_at"], ["travel_agent_visits", "expires_at"],
      ].map(([table, column]) => db.prepare(`DELETE FROM ${table} WHERE ${column} < ?${table === "travel_agent_visits" ? " AND lease_owner IS NULL" : ""}`)
        .bind(now - 24 * 60 * 60_000)));
    }
    if (expectedVisitCreatedAt === undefined) {
      await db.prepare(
        "INSERT OR IGNORE INTO travel_agent_visits (token_hash, session_id, lease_owner, lease_expires_at, created_at, last_active_at, expires_at) VALUES (?, NULL, NULL, NULL, ?, ?, ?)",
      ).bind(tokenHash, now, now, now + VISIT_TTL_MS).run();

      // An expired tab can retain sessionStorage after browser restore. Its old
      // Agent must not be silently revived after the server-side TTL.
      await db.prepare(
        "UPDATE travel_agent_visits SET session_id = NULL, planning_session_id = NULL, planning_intent_version = NULL, lease_owner = NULL, lease_expires_at = NULL, created_at = ?, last_active_at = ?, expires_at = ? WHERE token_hash = ? AND expires_at < ? AND (lease_owner IS NULL OR lease_expires_at < ?)",
      ).bind(now, now, now + VISIT_TTL_MS, tokenHash, now, now).run();
    }

    const claim = await db.prepare(
      expectedVisitCreatedAt === undefined
        ? "UPDATE travel_agent_visits SET lease_owner = ?, lease_expires_at = ?, last_active_at = ?, expires_at = ? WHERE token_hash = ? AND (lease_owner IS NULL OR lease_expires_at < ?)"
        : "UPDATE travel_agent_visits SET lease_owner = ?, lease_expires_at = ?, last_active_at = ?, expires_at = ? WHERE token_hash = ? AND (lease_owner IS NULL OR lease_expires_at < ?) AND created_at = ? AND expires_at > ?",
    ).bind(owner, now + LEASE_TTL_MS, now, now + VISIT_TTL_MS, tokenHash, now, ...(expectedVisitCreatedAt === undefined ? [] : [expectedVisitCreatedAt, now])).run();

    if ((claim.meta?.changes ?? 0) === 1) {
      const row = await db.prepare(
        "SELECT session_id, planning_session_id, planning_intent_version, created_at FROM travel_agent_visits WHERE token_hash = ? AND lease_owner = ?",
      ).bind(tokenHash, owner).first<VisitRow>();
      if (!row) throw new Error("Travel visit lease was lost.");
      // A restored browser tab may keep its token after the visit TTL. Once
      // the expired visit is reset above, its old turn IDs must not reopen the
      // former Agent Session or collide with a new turn in this visit.
      if (expectedVisitCreatedAt === undefined) {
        await db.batch([
          "travel_agent_turns", "travel_intent_turns", "travel_intent_states", "travel_planning_draft_turns",
          "travel_planning_drafts", "travel_planning_handoffs", "travel_planning_flight_jobs",
        ].map((table) => db.prepare(`DELETE FROM ${table} WHERE token_hash = ? AND created_at < ?`).bind(tokenHash, row.created_at)));
      }
      const visitCreatedAt = row.created_at;
      let released = false;
      async function readIntentState(): Promise<TravelIntentState> {
        const timestamp = Date.now();
        await db.prepare(
          "INSERT OR IGNORE INTO travel_intent_states (token_hash, state_version, result_json, slot_meta_json, last_turn_id, last_input_hash, created_at, updated_at) VALUES (?, 0, NULL, '{}', NULL, NULL, ?, ?)",
        ).bind(tokenHash, visitCreatedAt, timestamp).run();
        const state = await db.prepare(
          "SELECT s.state_version, s.result_json, s.slot_meta_json FROM travel_intent_states s JOIN travel_agent_visits v ON v.token_hash = s.token_hash WHERE s.token_hash = ? AND v.lease_owner = ? AND v.lease_expires_at > ?",
        ).bind(tokenHash, owner, timestamp).first<IntentStateRow>();
        if (!state) throw new Error("Travel visit lease was lost.");
        return { stateVersion: state.state_version, resultJson: state.result_json, slotMetaJson: state.slot_meta_json };
      }
      const lease: TravelVisitLease = {
        sessionId: row.session_id,
        planningSessionId: row.planning_session_id,
        planningIntentVersion: row.planning_intent_version,
        async readFlightJob(jobId) {
          return db.prepare("SELECT j.job_id, j.handoff_id, j.source_intent_state_version, j.input_hash, j.query_json, j.status, j.result_json, j.error_code, j.created_at, j.updated_at, j.deadline_at FROM travel_planning_flight_jobs j JOIN travel_agent_visits v ON v.token_hash = j.token_hash WHERE j.token_hash = ? AND j.job_id = ? AND v.lease_owner = ? AND v.lease_expires_at > ?")
            .bind(tokenHash, jobId, owner, Date.now()).first<TravelFlightJobRow>();
        },
        async saveFlightJob(job) {
          const result = await db.prepare("INSERT INTO travel_planning_flight_jobs (token_hash, job_id, handoff_id, source_intent_state_version, input_hash, query_json, status, result_json, error_code, created_at, updated_at, deadline_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM travel_agent_visits WHERE token_hash = ? AND lease_owner = ? AND lease_expires_at > ? ON CONFLICT(token_hash, job_id) DO UPDATE SET status = excluded.status, result_json = excluded.result_json, error_code = excluded.error_code, updated_at = excluded.updated_at, deadline_at = excluded.deadline_at WHERE travel_planning_flight_jobs.input_hash = excluded.input_hash AND travel_planning_flight_jobs.handoff_id = excluded.handoff_id")
            .bind(tokenHash, job.job_id, job.handoff_id, job.source_intent_state_version, job.input_hash, job.query_json, job.status, job.result_json, job.error_code, job.created_at, job.updated_at, job.deadline_at, tokenHash, owner, Date.now()).run();
          if ((result.meta?.changes ?? 0) !== 1) throw new Error("Flight job lease or identity was lost.");
        },
        async bindSession(sessionId: string) {
          const result = await db.prepare(
            "UPDATE travel_agent_visits SET session_id = ?, last_active_at = ? WHERE token_hash = ? AND lease_owner = ?",
          ).bind(sessionId, Date.now(), tokenHash, owner).run();
          if ((result.meta?.changes ?? 0) !== 1) throw new Error("Travel visit lease was lost.");
          lease.sessionId = sessionId;
        },
        async bindPlanningSession(sessionId: string, sourceIntentStateVersion: number) {
          const result = await db.prepare(
            "UPDATE travel_agent_visits SET planning_session_id = ?, last_active_at = ? WHERE token_hash = ? AND lease_owner = ? AND planning_intent_version = ? AND lease_expires_at > ?",
          ).bind(sessionId, Date.now(), tokenHash, owner, sourceIntentStateVersion, Date.now()).run();
          if ((result.meta?.changes ?? 0) !== 1) throw new Error("Planning visit lease or handoff version was lost.");
          lease.planningSessionId = sessionId;
        },
        async readPlanningHandoff() {
          return db.prepare(
            "SELECT h.handoff_id, h.source_intent_state_version, h.handoff_json, h.created_at, h.updated_at FROM travel_planning_handoffs h JOIN travel_agent_visits v ON v.token_hash = h.token_hash WHERE h.token_hash = ? AND v.lease_owner = ? AND v.lease_expires_at > ? AND h.created_at >= v.created_at",
          ).bind(tokenHash, owner, Date.now()).first<TravelPlanningHandoffRow>();
        },
        async commitPlanningHandoff(input) {
          if (!Number.isInteger(input.sourceIntentStateVersion) || input.sourceIntentStateVersion < 1 ||
              !input.handoffId.trim() || !input.handoffJson.trim() || !input.initialDraftJson.trim()) {
            throw new Error("Invalid planning handoff.");
          }
          const existing = await lease.readPlanningHandoff();
          if (existing) {
            if (existing.source_intent_state_version > input.sourceIntentStateVersion) {
              throw new Error("A newer planning handoff already exists.");
            }
            if (existing.source_intent_state_version === input.sourceIntentStateVersion) {
              if (existing.handoff_json !== input.handoffJson) throw new Error("Planning handoff changed without an intent version change.");
              return;
            }
          }
          await lease.renew();
          const now = Date.now();
          const results = await db.batch([
            db.prepare(
              "UPDATE travel_agent_visits SET planning_session_id = NULL, planning_intent_version = ?, last_active_at = ? WHERE token_hash = ? AND lease_owner = ? AND lease_expires_at > ?",
            ).bind(input.sourceIntentStateVersion, now, tokenHash, owner, now),
            db.prepare(
              "INSERT INTO travel_planning_handoffs (token_hash, handoff_id, source_intent_state_version, handoff_json, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM travel_agent_visits WHERE token_hash = ? AND lease_owner = ? AND lease_expires_at > ?) ON CONFLICT(token_hash) DO UPDATE SET handoff_id = excluded.handoff_id, source_intent_state_version = excluded.source_intent_state_version, handoff_json = excluded.handoff_json, created_at = excluded.created_at, updated_at = excluded.updated_at",
            ).bind(tokenHash, input.handoffId, input.sourceIntentStateVersion, input.handoffJson, now, now,
              tokenHash, owner, now),
            db.prepare(
              "INSERT INTO travel_planning_drafts (token_hash, version, handoff_id, source_intent_state_version, draft_json, last_turn_id, last_input_hash, created_at, updated_at) SELECT ?, 0, ?, ?, ?, NULL, NULL, ?, ? WHERE EXISTS (SELECT 1 FROM travel_agent_visits WHERE token_hash = ? AND lease_owner = ? AND lease_expires_at > ?) ON CONFLICT(token_hash) DO UPDATE SET version = 0, handoff_id = excluded.handoff_id, source_intent_state_version = excluded.source_intent_state_version, draft_json = excluded.draft_json, last_turn_id = NULL, last_input_hash = NULL, created_at = excluded.created_at, updated_at = excluded.updated_at",
            ).bind(tokenHash, input.handoffId, input.sourceIntentStateVersion, input.initialDraftJson, now, now,
              tokenHash, owner, now),
            db.prepare("DELETE FROM travel_planning_draft_turns WHERE token_hash = ? AND EXISTS (SELECT 1 FROM travel_agent_visits WHERE token_hash = ? AND lease_owner = ? AND lease_expires_at > ?)")
              .bind(tokenHash, tokenHash, owner, now),
          ]);
          if ((results[0]?.meta?.changes ?? 0) !== 1) throw new Error("Planning visit lease was lost.");
          lease.planningSessionId = null;
          lease.planningIntentVersion = input.sourceIntentStateVersion;
        },
        async readPlanningDraftRow() {
          return db.prepare(
            "SELECT d.version, d.handoff_id, d.source_intent_state_version, d.draft_json FROM travel_planning_drafts d JOIN travel_agent_visits v ON v.token_hash = d.token_hash WHERE d.token_hash = ? AND v.lease_owner = ? AND v.lease_expires_at > ? AND d.created_at >= v.created_at",
          ).bind(tokenHash, owner, Date.now()).first<TravelPlanningDraftRow>();
        },
        async findPlanningDraftTurn(turnId: string) {
          return db.prepare(
            "SELECT t.input_hash, t.draft_version, t.response_json FROM travel_planning_draft_turns t JOIN travel_agent_visits v ON v.token_hash = t.token_hash WHERE t.token_hash = ? AND t.turn_id = ? AND v.lease_owner = ? AND v.lease_expires_at > ? AND t.created_at >= v.created_at",
          ).bind(tokenHash, turnId, owner, Date.now()).first<TravelPlanningDraftTurn>();
        },
        async commitPlanningDraftRow(input) {
          if (!input.turnId.trim() || !/^[0-9a-f]{64}$/i.test(input.inputHash) ||
              !Number.isInteger(input.expectedVersion) || input.expectedVersion < 0 ||
              !Number.isInteger(input.sourceIntentStateVersion) || input.sourceIntentStateVersion < 1) {
            throw new Error("Invalid planning draft commit.");
          }
          const nextVersion = input.expectedVersion + 1;
          const now = Date.now();
          const results = await db.batch([
            db.prepare(
              "UPDATE travel_planning_drafts SET version = ?, draft_json = ?, last_turn_id = ?, last_input_hash = ?, updated_at = ? WHERE token_hash = ? AND version = ? AND handoff_id = ? AND source_intent_state_version = ? AND NOT EXISTS (SELECT 1 FROM travel_planning_draft_turns WHERE token_hash = ? AND turn_id = ?) AND EXISTS (SELECT 1 FROM travel_agent_visits WHERE token_hash = ? AND lease_owner = ? AND lease_expires_at > ?)",
            ).bind(nextVersion, input.draftJson, input.turnId, input.inputHash, now, tokenHash,
              input.expectedVersion, input.handoffId, input.sourceIntentStateVersion, tokenHash,
              input.turnId, tokenHash, owner, now),
            db.prepare(
              "INSERT INTO travel_planning_draft_turns (token_hash, turn_id, input_hash, draft_version, response_json, created_at) SELECT ?, ?, ?, ?, ?, ? FROM travel_planning_drafts WHERE token_hash = ? AND version = ? AND last_turn_id = ? AND last_input_hash = ? AND NOT EXISTS (SELECT 1 FROM travel_planning_draft_turns WHERE token_hash = ? AND turn_id = ?)",
            ).bind(tokenHash, input.turnId, input.inputHash, nextVersion, input.draftJson, now,
              tokenHash, nextVersion, input.turnId, input.inputHash, tokenHash, input.turnId),
          ]);
          const changed = results[0]?.meta?.changes ?? 0;
          const logged = results[1]?.meta?.changes ?? 0;
          if (changed === 1 && logged === 1) return { committed: true, version: nextVersion };
          if (changed === 0 && logged === 0) return { committed: false, state: await lease.readPlanningDraftRow() };
          throw new Error("Planning draft and turn log diverged.");
        },
        async commitPlanningDayChange(input) {
          if (!input.turnId.trim() || !/^[0-9a-f]{64}$/i.test(input.inputHash) ||
              !Number.isInteger(input.expectedIntentStateVersion) || input.expectedIntentStateVersion < 1 ||
              !Number.isInteger(input.expectedDraftVersion) || input.expectedDraftVersion < 0 ||
              !input.expectedHandoffId.trim() || !input.handoffId.trim()) {
            throw new Error("Invalid planning day change.");
          }
          await lease.renew();
          const now = Date.now();
          const nextIntentVersion = input.expectedIntentStateVersion + 1;
          // D1 batch is a transaction. Guard inserts deliberately violate the
          // NOT NULL token_hash constraint if any preceding CAS did not apply,
          // so the intent, handoff and draft can never be saved partially.
          const results = await db.batch([
            db.prepare(
              "UPDATE travel_intent_states SET state_version = ?, result_json = ?, slot_meta_json = ?, last_turn_id = ?, last_input_hash = ?, updated_at = ? WHERE token_hash = ? AND state_version = ? AND EXISTS (SELECT 1 FROM travel_agent_visits WHERE token_hash = ? AND lease_owner = ? AND lease_expires_at > ?)",
            ).bind(nextIntentVersion, input.resultJson, input.slotMetaJson, input.turnId, input.inputHash, now,
              tokenHash, input.expectedIntentStateVersion, tokenHash, owner, now),
            db.prepare(
              "INSERT INTO travel_intent_turns (token_hash, turn_id, input_hash, state_version, response_json, created_at) VALUES (CASE WHEN EXISTS (SELECT 1 FROM travel_intent_states WHERE token_hash = ? AND state_version = ? AND last_turn_id = ? AND last_input_hash = ?) THEN ? ELSE NULL END, ?, ?, ?, ?, ?)",
            ).bind(tokenHash, nextIntentVersion, input.turnId, input.inputHash, tokenHash,
              input.turnId, input.inputHash, nextIntentVersion, input.resultJson, now),
            db.prepare(
              "UPDATE travel_agent_visits SET planning_session_id = NULL, planning_intent_version = ?, last_active_at = ? WHERE token_hash = ? AND lease_owner = ? AND lease_expires_at > ?",
            ).bind(nextIntentVersion, now, tokenHash, owner, now),
            db.prepare(
              "INSERT INTO travel_planning_handoffs (token_hash, handoff_id, source_intent_state_version, handoff_json, created_at, updated_at) VALUES (CASE WHEN EXISTS (SELECT 1 FROM travel_agent_visits WHERE token_hash = ? AND lease_owner = ? AND lease_expires_at > ? AND planning_intent_version = ?) THEN ? ELSE NULL END, ?, ?, ?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET handoff_id = excluded.handoff_id, source_intent_state_version = excluded.source_intent_state_version, handoff_json = excluded.handoff_json, created_at = excluded.created_at, updated_at = excluded.updated_at",
            ).bind(tokenHash, owner, now, nextIntentVersion, tokenHash,
              input.handoffId, nextIntentVersion, input.handoffJson, now, now),
            db.prepare(
              "UPDATE travel_planning_drafts SET version = 0, handoff_id = ?, source_intent_state_version = ?, draft_json = ?, last_turn_id = ?, last_input_hash = ?, updated_at = ? WHERE token_hash = ? AND version = ? AND handoff_id = ? AND source_intent_state_version = ? AND EXISTS (SELECT 1 FROM travel_planning_handoffs WHERE token_hash = ? AND handoff_id = ? AND source_intent_state_version = ?)",
            ).bind(input.handoffId, nextIntentVersion, input.draftJson, input.turnId, input.inputHash, now,
              tokenHash, input.expectedDraftVersion, input.expectedHandoffId, input.expectedIntentStateVersion,
              tokenHash, input.handoffId, nextIntentVersion),
            db.prepare(
              "INSERT INTO travel_planning_draft_turns (token_hash, turn_id, input_hash, draft_version, response_json, created_at) VALUES (CASE WHEN EXISTS (SELECT 1 FROM travel_planning_drafts WHERE token_hash = ? AND version = 0 AND handoff_id = ? AND source_intent_state_version = ? AND last_turn_id = ? AND last_input_hash = ?) THEN ? ELSE NULL END, ?, ?, 0, ?, ?)",
            ).bind(tokenHash, input.handoffId, nextIntentVersion, input.turnId, input.inputHash, tokenHash,
              input.turnId, input.inputHash, input.draftJson, now),
          ]);
          if (results.some((result) => (result.meta?.changes ?? 0) !== 1)) {
            throw new Error("Planning day change transaction did not update every state.");
          }
          lease.planningSessionId = null;
          lease.planningIntentVersion = nextIntentVersion;
        },
        async renew() {
          const now = Date.now();
          const result = await db.prepare(
            "UPDATE travel_agent_visits SET lease_expires_at = ?, last_active_at = ?, expires_at = ? WHERE token_hash = ? AND lease_owner = ? AND lease_expires_at > ?",
          ).bind(now + LEASE_TTL_MS, now, now + VISIT_TTL_MS, tokenHash, owner, now).run();
          if ((result.meta?.changes ?? 0) !== 1) throw new Error("Travel visit lease was lost.");
        },
        async findTurn(turnId: string) {
          return db.prepare(
            "SELECT session_id, input_hash, status, input_event_id, input_created_at, reply_text, created_at FROM travel_agent_turns WHERE token_hash = ? AND turn_id = ?",
          ).bind(tokenHash, turnId).first<TravelAgentTurn>();
        },
        async reserveTurn(turnId: string, sessionId: string, inputHash: string) {
          const timestamp = Date.now();
          await db.prepare(
            "INSERT OR IGNORE INTO travel_agent_turns (token_hash, turn_id, session_id, input_hash, status, input_event_id, input_created_at, reply_text, created_at, updated_at) VALUES (?, ?, ?, ?, 'reserved', NULL, NULL, NULL, ?, ?)",
          ).bind(tokenHash, turnId, sessionId, inputHash, timestamp, timestamp).run();
          const turn = await db.prepare(
            "SELECT session_id, input_hash, status, input_event_id, input_created_at, reply_text, created_at FROM travel_agent_turns WHERE token_hash = ? AND turn_id = ?",
          ).bind(tokenHash, turnId).first<TravelAgentTurn>();
          if (!turn || turn.input_hash !== inputHash) throw new Error("Travel turn ID was reused for different input.");
          return turn;
        },
        async markTurnSubmitted(turnId: string, eventId: string, createdAt: string) {
          await db.prepare(
            "UPDATE travel_agent_turns SET status = 'submitted', input_event_id = ?, input_created_at = ?, updated_at = ? WHERE token_hash = ? AND turn_id = ?",
          ).bind(eventId, createdAt, Date.now(), tokenHash, turnId).run();
        },
        async markTurnComplete(turnId: string, replyText: string) {
          await db.prepare(
            "UPDATE travel_agent_turns SET status = 'completed', reply_text = ?, updated_at = ? WHERE token_hash = ? AND turn_id = ?",
          ).bind(replyText, Date.now(), tokenHash, turnId).run();
        },
        async markTurnUncertain(turnId: string) {
          await db.prepare(
            "UPDATE travel_agent_turns SET status = 'uncertain', updated_at = ? WHERE token_hash = ? AND turn_id = ? AND status = 'reserved'",
          ).bind(Date.now(), tokenHash, turnId).run();
        },
        async markTurnRejected(turnId: string) {
          const now = Date.now();
          await db.prepare("UPDATE travel_agent_turns SET status='rejected',updated_at=? WHERE token_hash=? AND turn_id=? AND status IN ('reserved','uncertain') AND input_event_id IS NULL AND input_created_at IS NULL AND created_at>=? AND EXISTS(SELECT 1 FROM travel_agent_visits v WHERE v.token_hash=? AND v.lease_owner=? AND v.lease_expires_at>? AND v.created_at=?)")
            .bind(now, tokenHash, turnId, visitCreatedAt, tokenHash, owner, now, visitCreatedAt).run();
        },
        async clearRejectedTurn(turnId: string) {
          const now = Date.now();
          await db.prepare("DELETE FROM travel_agent_turns WHERE token_hash=? AND turn_id=? AND status='rejected' AND input_event_id IS NULL AND input_created_at IS NULL AND created_at>=? AND EXISTS(SELECT 1 FROM travel_agent_visits v WHERE v.token_hash=? AND v.lease_owner=? AND v.lease_expires_at>? AND v.created_at=?)")
            .bind(tokenHash, turnId, visitCreatedAt, tokenHash, owner, now, visitCreatedAt).run();
        },
        readIntentState,
        async findIntentTurn(turnId: string) {
          if (!turnId.trim()) throw new Error("Invalid intent turn ID.");
          return db.prepare(
            "SELECT t.input_hash, t.state_version, t.response_json FROM travel_intent_turns t JOIN travel_agent_visits v ON v.token_hash = t.token_hash WHERE t.token_hash = ? AND t.turn_id = ? AND v.lease_owner = ? AND v.lease_expires_at > ?",
          ).bind(tokenHash, turnId, owner, Date.now()).first<TravelIntentTurn>();
        },
        async commitIntentTurn(commit) {
          if (!commit.turnId.trim() || !/^[0-9a-f]{64}$/i.test(commit.inputHash) ||
              !Number.isSafeInteger(commit.expectedStateVersion) || commit.expectedStateVersion < 0) {
            throw new Error("Invalid intent commit metadata.");
          }
          const now = Date.now();
          const nextVersion = commit.expectedStateVersion + 1;
          const updates = await db.batch([
            db.prepare(
              "UPDATE travel_intent_states SET state_version = ?, result_json = ?, slot_meta_json = ?, last_turn_id = ?, last_input_hash = ?, updated_at = ? WHERE token_hash = ? AND state_version = ? AND NOT EXISTS (SELECT 1 FROM travel_intent_turns WHERE token_hash = ? AND turn_id = ?) AND EXISTS (SELECT 1 FROM travel_agent_visits WHERE token_hash = ? AND lease_owner = ? AND lease_expires_at > ?)",
            ).bind(nextVersion, commit.resultJson, commit.slotMetaJson, commit.turnId, commit.inputHash, now,
              tokenHash, commit.expectedStateVersion, tokenHash, commit.turnId, tokenHash, owner, now),
            db.prepare(
              "INSERT INTO travel_intent_turns (token_hash, turn_id, input_hash, state_version, response_json, created_at) SELECT ?, ?, ?, ?, ?, ? FROM travel_intent_states WHERE token_hash = ? AND state_version = ? AND last_turn_id = ? AND last_input_hash = ? AND NOT EXISTS (SELECT 1 FROM travel_intent_turns WHERE token_hash = ? AND turn_id = ?)",
            ).bind(tokenHash, commit.turnId, commit.inputHash, nextVersion, commit.resultJson, now,
              tokenHash, nextVersion, commit.turnId, commit.inputHash, tokenHash, commit.turnId),
          ]);
          const changed = updates[0]?.meta?.changes ?? 0;
          const logged = updates[1]?.meta?.changes ?? 0;
          if (changed === 1 && logged === 1) return { committed: true, stateVersion: nextVersion };
          if (changed === 0 && logged === 0) {
            return { committed: false, state: await readIntentState() };
          }
          throw new Error("Intent state and turn log diverged.");
        },
        async release() {
          if (released) return;
          released = true;
          await db.prepare(
            "UPDATE travel_agent_visits SET lease_owner = NULL, lease_expires_at = NULL, last_active_at = ? WHERE token_hash = ? AND lease_owner = ?",
          ).bind(Date.now(), tokenHash, owner).run();
        },
      };
      return lease;
    }
    if (expectedVisitCreatedAt !== undefined) {
      const current = await db.prepare("SELECT created_at, expires_at FROM travel_agent_visits WHERE token_hash = ?")
        .bind(tokenHash).first<{ created_at: number; expires_at: number }>();
      if (!current || current.created_at !== expectedVisitCreatedAt || current.expires_at <= Date.now()) throw new PlanningAgentHandoffChangedError();
    }
    await delay(250);
  }
  throw new Error(signal.aborted ? "Travel visit request timed out." : "Travel visit is busy; retry shortly.");
}

/**
 * Serialize remote planning turns independently from short planning-data edits.
 * Each adapter method briefly claims the existing data lease. No data lease is
 * held while Bailian or its suppliers are working on a remote HTTP request.
 */
export async function acquirePlanningAgentLease(token: string, signal: AbortSignal): Promise<TravelVisitLease> {
  const initial = await acquireTravelVisit(token, signal);
  const snapshot = { sessionId: initial.sessionId, planningSessionId: initial.planningSessionId, planningIntentVersion: initial.planningIntentVersion };
  await initial.release();
  const db = visitDb(); const tokenHash = await hashToken(token); const owner = crypto.randomUUID();
  const started = Date.now();
  let visitCreatedAt: number | null = null;
  while (!signal.aborted && Date.now() - started < LEASE_WAIT_MS) {
    const now = Date.now();
    const claim = await db.prepare("INSERT INTO travel_planning_agent_locks (token_hash, owner, expires_at, visit_created_at) SELECT token_hash, ?, ?, created_at FROM travel_agent_visits WHERE token_hash = ? AND expires_at > ? ON CONFLICT(token_hash) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at, visit_created_at = excluded.visit_created_at WHERE travel_planning_agent_locks.expires_at < ? OR travel_planning_agent_locks.visit_created_at <> excluded.visit_created_at")
      .bind(owner, now + LEASE_TTL_MS, tokenHash, now, now).run();
    if ((claim.meta?.changes ?? 0) === 1) {
      const lock = await db.prepare("SELECT visit_created_at FROM travel_planning_agent_locks WHERE token_hash = ? AND owner = ?").bind(tokenHash, owner).first<{ visit_created_at: number }>();
      if (!lock) throw new Error("Planning agent lease was lost.");
      visitCreatedAt = lock.visit_created_at; break;
    }
    await delay(250);
  }
  if (visitCreatedAt === null) throw new Error("Planning agent is busy; retry the same task.");
  let released = false;
  let planningIdentity: { handoffId: string | null; version: number | null } | undefined;
  async function assertPlanningIdentity() {
    const now = Date.now();
    const row = await db.prepare("SELECT v.planning_intent_version, h.handoff_id, h.source_intent_state_version, s.state_version FROM travel_agent_visits v JOIN travel_planning_agent_locks a ON a.token_hash=v.token_hash AND a.owner=? AND a.expires_at>? AND a.visit_created_at=v.created_at LEFT JOIN travel_planning_handoffs h ON h.token_hash = v.token_hash AND h.created_at >= v.created_at LEFT JOIN travel_intent_states s ON s.token_hash = v.token_hash AND s.created_at >= v.created_at WHERE v.token_hash = ? AND v.created_at = ? AND v.expires_at > ?")
      .bind(owner, now, tokenHash, visitCreatedAt, now).first<{ planning_intent_version: number | null; handoff_id: string | null; source_intent_state_version: number | null; state_version: number | null }>();
    if (!row) throw new Error("Planning agent lease was lost.");
    const identity = { handoffId: row.handoff_id, version: row.planning_intent_version };
    if (row.handoff_id && (row.source_intent_state_version !== row.planning_intent_version || row.state_version !== row.planning_intent_version)) throw new PlanningAgentHandoffChangedError();
    if (planningIdentity && (identity.handoffId !== planningIdentity.handoffId || identity.version !== planningIdentity.version || planningIdentity.version !== null && row.state_version !== planningIdentity.version)) throw new PlanningAgentHandoffChangedError();
    planningIdentity ??= identity;
  }
  async function renew(checkIdentity = true) {
    if (released || signal.aborted) throw new Error("Planning agent lease was lost.");
    const now = Date.now();
    const result = await db.prepare("UPDATE travel_planning_agent_locks SET expires_at = ? WHERE token_hash = ? AND owner = ? AND expires_at > ? AND EXISTS (SELECT 1 FROM travel_agent_visits v WHERE v.token_hash = ? AND v.created_at = ? AND v.expires_at > ?)")
      .bind(now + LEASE_TTL_MS, tokenHash, owner, now, tokenHash, visitCreatedAt, now).run();
    if ((result.meta?.changes ?? 0) !== 1) throw new Error("Planning agent lease was lost.");
    if (checkIdentity && planningIdentity) await assertPlanningIdentity();
  }
  async function withPlanningData<T>(operation: (lease: TravelVisitLease) => Promise<T>): Promise<T> {
    // The initial acquisition already cleaned old-generation data. This path
    // can only claim that same live generation; it cannot recreate a visit.
    await renew(false);
    const data = await acquireTravelVisit(token, signal, visitCreatedAt!);
    try {
      await assertPlanningIdentity();
      const value = await operation(data);
      agent.sessionId = data.sessionId; agent.planningSessionId = data.planningSessionId; agent.planningIntentVersion = data.planningIntentVersion;
      return value;
    } finally { await data.release(); }
  }
  const agent: TravelVisitLease = {
    ...snapshot,
    withPlanningTurnData: withPlanningData,
    bindSession: (id) => withPlanningData((lease) => lease.bindSession(id)),
    bindPlanningSession: (id, version) => withPlanningData((lease) => lease.bindPlanningSession(id, version)),
    readPlanningHandoff: () => withPlanningData((lease) => lease.readPlanningHandoff()),
    commitPlanningHandoff: (input) => withPlanningData((lease) => lease.commitPlanningHandoff(input)),
    readPlanningDraftRow: () => withPlanningData((lease) => lease.readPlanningDraftRow()),
    findPlanningDraftTurn: (id) => withPlanningData((lease) => lease.findPlanningDraftTurn(id)),
    readFlightJob: (id) => withPlanningData((lease) => lease.readFlightJob(id)),
    saveFlightJob: (job) => withPlanningData((lease) => lease.saveFlightJob(job)),
    commitPlanningDraftRow: (input) => withPlanningData((lease) => lease.commitPlanningDraftRow(input)),
    commitPlanningDayChange: (input) => withPlanningData((lease) => lease.commitPlanningDayChange(input)),
    renew,
    findTurn: (id) => withPlanningData((lease) => lease.findTurn(id)),
    reserveTurn: (id, session, hash) => withPlanningData((lease) => lease.reserveTurn(id, session, hash)),
    markTurnSubmitted: (id, event, created) => withPlanningData((lease) => lease.markTurnSubmitted(id, event, created)),
    markTurnComplete: (id, reply) => withPlanningData((lease) => lease.markTurnComplete(id, reply)),
    markTurnUncertain: (id) => withPlanningData((lease) => lease.markTurnUncertain(id)),
    markTurnRejected: (id) => withPlanningData((lease) => lease.markTurnRejected!(id)),
    clearRejectedTurn: (id) => withPlanningData((lease) => lease.clearRejectedTurn!(id)),
    readIntentState: () => withPlanningData((lease) => lease.readIntentState()),
    findIntentTurn: (id) => withPlanningData((lease) => lease.findIntentTurn(id)),
    commitIntentTurn: (input) => withPlanningData((lease) => lease.commitIntentTurn(input)),
    release: async () => {
      if (released) return; released = true;
      await db.prepare("DELETE FROM travel_planning_agent_locks WHERE token_hash = ? AND owner = ?").bind(tokenHash, owner).run();
    },
  };
  try {
    await withPlanningData(async () => undefined);
    return agent;
  } catch (error) { await agent.release(); throw error; }
}
