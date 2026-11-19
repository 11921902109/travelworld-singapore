import { env } from "cloudflare:workers";
import { PlanningDraftSchema, PlanningHandoffSchema } from "./planning-state";

type Statement = {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number } }>;
};
type HelpScope = { tokenHash: string; handoffId: string; visitCreatedAt: number };

function database() {
  const db = (env as unknown as { DB?: { prepare(sql: string): Statement } }).DB;
  if (!db) throw new Error("Planning help storage is unavailable.");
  return db;
}

export async function readPlanningHelpSnapshot(visitToken: string, handoffId: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(visitToken));
  const tokenHash = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const row = await database().prepare(`
    SELECT v.created_at AS visit_created_at, h.handoff_json, d.draft_json
    FROM travel_agent_visits v
    JOIN travel_planning_handoffs h ON h.token_hash=v.token_hash AND h.created_at>=v.created_at
    JOIN travel_planning_drafts d ON d.token_hash=v.token_hash AND d.handoff_id=h.handoff_id
    JOIN travel_intent_states i ON i.token_hash=v.token_hash
      AND i.state_version=h.source_intent_state_version AND i.state_version=d.source_intent_state_version
    WHERE v.token_hash=? AND h.handoff_id=? AND v.expires_at>?
  `).bind(tokenHash, handoffId, Date.now()).first<{ visit_created_at: number; handoff_json: string; draft_json: string }>();
  if (!row) return null;
  return {
    tokenHash, handoffId, visitCreatedAt: row.visit_created_at,
    handoff: PlanningHandoffSchema.parse(JSON.parse(row.handoff_json)),
    draft: PlanningDraftSchema.parse(JSON.parse(row.draft_json)),
  };
}

export async function acquireHelpSession(scope: HelpScope) {
  const db = database();
  const owner = crypto.randomUUID();
  const now = Date.now();
  const key = [scope.tokenHash, scope.handoffId, scope.visitCreatedAt];
  const where = "token_hash=? AND handoff_id=? AND visit_created_at=?";
  if (Math.random() < .025) await db.prepare("DELETE FROM travel_planning_help_sessions WHERE updated_at<? AND (lease_expires_at IS NULL OR lease_expires_at<?)")
    .bind(now - 24 * 60 * 60_000, now).run();
  const claim = await db.prepare(`
    INSERT INTO travel_planning_help_sessions(token_hash,handoff_id,visit_created_at,lease_owner,lease_expires_at,updated_at)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(token_hash,handoff_id,visit_created_at) DO UPDATE SET
      lease_owner=excluded.lease_owner,lease_expires_at=excluded.lease_expires_at,updated_at=excluded.updated_at
    WHERE lease_owner IS NULL OR lease_expires_at < ?
  `).bind(...key, owner, now + 75_000, now, now).run();
  if (claim.meta?.changes !== 1) return null;
  const row = await db.prepare(`SELECT session_id FROM travel_planning_help_sessions WHERE ${where} AND lease_owner=?`)
    .bind(...key, owner).first<{ session_id: string | null }>();
  if (!row) throw new Error("Planning help session lease was lost.");
  return {
    sessionId: row.session_id,
    bind: async (sessionId: string) => {
      const result = await db.prepare(`UPDATE travel_planning_help_sessions SET session_id=?,updated_at=? WHERE ${where} AND lease_owner=? AND lease_expires_at>?`)
        .bind(sessionId, Date.now(), ...key, owner, Date.now()).run();
      if (result.meta?.changes !== 1) throw new Error("Planning help session lease was lost.");
    },
    release: async () => {
      await db.prepare(`UPDATE travel_planning_help_sessions SET lease_owner=NULL,lease_expires_at=NULL WHERE ${where} AND lease_owner=?`)
        .bind(...key, owner).run();
    },
  };
}
