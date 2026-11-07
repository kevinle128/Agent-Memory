/**
 * Recall log of the client hook recall endpoint (`routes/hook-recall.ts`).
 *
 * One row per recall request: who asked, which session and project, the query,
 * every candidate with its score and the decision about it, the injected text,
 * the token estimate, the latency and the outcome. Admins read the rows through
 * `GET /v3/admin/hook-recall-log`. Rows older than RETENTION_MS are deleted at
 * start and once a day.
 *
 * The table lives in the proxy SQLite file: `storage.sqlite.dbPath` when the
 * storage backend is sqlite (that file is on the data volume), else the
 * default proxy DB path (`db/index.ts:resolveDbPath`). This module opens its
 * own connection to the file. It does not change the journal mode of a file
 * that another module owns.
 *
 * When SQLite is not available, the log is off: writes are dropped with one
 * warning and reads report that the log is unavailable. Recall still works.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type Database from "better-sqlite3";

import type { ProxyConfig } from "../types.js";
import { resolveDbPath } from "./index.js";

const TAG = "[hook-recall-log]";
const _require = createRequire(import.meta.url);

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS hook_recall_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      INTEGER NOT NULL,
  space_id        TEXT NOT NULL,
  team_id         TEXT,
  user_id         TEXT NOT NULL,
  agent_id        TEXT,
  agent_source    TEXT NOT NULL,
  client          TEXT,
  session_id      TEXT NOT NULL,
  project_hash    TEXT,
  project_label   TEXT,
  query           TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  injected_text   TEXT,
  injected_count  INTEGER NOT NULL DEFAULT 0,
  tokens          INTEGER NOT NULL DEFAULT 0,
  latency_ms      INTEGER NOT NULL,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_hook_recall_log_created ON hook_recall_log(created_at);
CREATE INDEX IF NOT EXISTS idx_hook_recall_log_user ON hook_recall_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_hook_recall_log_session ON hook_recall_log(session_id, created_at);
`;

/** Result of one recall request. */
export type RecallOutcome =
  | "injected"
  | "empty"
  | "no_session"
  | "no_project"
  | "timeout"
  | "error";

/** What the endpoint did with one candidate. */
export type CandidateDecision = "injected" | "below_min_score" | "over_budget" | "scope_blocked";

export interface RecallCandidate {
  id: string;
  agentId: string;
  type?: string;
  score?: number;
  projectHash?: string;
  decision: CandidateDecision;
  /** First characters of the memory, for the audit view. */
  preview: string;
}

export interface RecallLogRow {
  createdAt: number;
  spaceId: string;
  teamId: string | null;
  userId: string;
  agentId: string | null;
  agentSource: string;
  client: string | null;
  sessionId: string;
  projectHash: string | null;
  projectLabel: string | null;
  query: string;
  outcome: RecallOutcome;
  candidates: RecallCandidate[];
  injectedText: string | null;
  injectedCount: number;
  tokens: number;
  latencyMs: number;
  error: string | null;
}

export interface RecallLogQuery {
  limit: number;
  offset: number;
  userId?: string;
  agentId?: string;
  sessionId?: string;
  outcome?: string;
  /** Only rows created at or after this time (ms epoch). */
  since?: number;
}

export interface RecallLogEntry extends RecallLogRow {
  id: number;
}

export class HookRecallLog {
  private readonly insertStmt: Database.Statement;
  private readonly cleanupStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA_SQL);
    this.insertStmt = db.prepare(
      `INSERT INTO hook_recall_log (created_at, space_id, team_id, user_id, agent_id, agent_source, client,
         session_id, project_hash, project_label, query, outcome, candidates_json, injected_text,
         injected_count, tokens, latency_ms, error)
       VALUES (@createdAt, @spaceId, @teamId, @userId, @agentId, @agentSource, @client,
         @sessionId, @projectHash, @projectLabel, @query, @outcome, @candidatesJson, @injectedText,
         @injectedCount, @tokens, @latencyMs, @error)`,
    );
    this.cleanupStmt = db.prepare("DELETE FROM hook_recall_log WHERE created_at < ?");
  }

  insert(row: RecallLogRow): void {
    const { candidates, ...rest } = row;
    this.insertStmt.run({ ...rest, candidatesJson: JSON.stringify(candidates) });
  }

  /** Delete rows older than the retention time. Returns the number of deleted rows. */
  cleanup(now = Date.now()): number {
    return this.cleanupStmt.run(now - RETENTION_MS).changes;
  }

  list(q: RecallLogQuery): { items: RecallLogEntry[]; total: number } {
    const where: string[] = [];
    const args: Record<string, unknown> = {};
    if (q.userId) { where.push("user_id = @userId"); args.userId = q.userId; }
    if (q.agentId) { where.push("agent_id = @agentId"); args.agentId = q.agentId; }
    if (q.sessionId) { where.push("session_id = @sessionId"); args.sessionId = q.sessionId; }
    if (q.outcome) { where.push("outcome = @outcome"); args.outcome = q.outcome; }
    if (q.since !== undefined) { where.push("created_at >= @since"); args.since = q.since; }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM hook_recall_log ${clause}`).get(args) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT * FROM hook_recall_log ${clause} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`)
      .all({ ...args, limit: q.limit, offset: q.offset }) as Array<Record<string, unknown>>;
    return { items: rows.map(toEntry), total };
  }
}

function toEntry(r: Record<string, unknown>): RecallLogEntry {
  let candidates: RecallCandidate[] = [];
  try {
    const parsed = JSON.parse(String(r.candidates_json ?? "[]"));
    if (Array.isArray(parsed)) candidates = parsed as RecallCandidate[];
  } catch {
    // A row with a damaged candidate list still shows its other fields.
  }
  const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    id: Number(r.id),
    createdAt: Number(r.created_at),
    spaceId: String(r.space_id ?? ""),
    teamId: strOrNull(r.team_id),
    userId: String(r.user_id ?? ""),
    agentId: strOrNull(r.agent_id),
    agentSource: String(r.agent_source ?? ""),
    client: strOrNull(r.client),
    sessionId: String(r.session_id ?? ""),
    projectHash: strOrNull(r.project_hash),
    projectLabel: strOrNull(r.project_label),
    query: String(r.query ?? ""),
    outcome: String(r.outcome ?? "") as RecallOutcome,
    candidates,
    injectedText: strOrNull(r.injected_text),
    injectedCount: Number(r.injected_count ?? 0),
    tokens: Number(r.tokens ?? 0),
    latencyMs: Number(r.latency_ms ?? 0),
    error: strOrNull(r.error),
  };
}

let instance: HookRecallLog | null = null;
let openFailed = false;
let cleanupTimer: NodeJS.Timeout | null = null;

/** Path of the SQLite file that holds the log. */
export function recallLogDbPath(config: Pick<ProxyConfig, "storage">): string {
  const p = config.storage?.backend === "sqlite" ? config.storage.sqlite?.dbPath?.trim() : "";
  return p || resolveDbPath();
}

/** The process-wide log, or null when SQLite cannot be opened. */
export function getHookRecallLog(config: Pick<ProxyConfig, "storage">): HookRecallLog | null {
  if (instance) return instance;
  if (openFailed) return null;
  const dbPath = recallLogDbPath(config);
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    const SqliteCtor = _require("better-sqlite3") as typeof Database;
    const db = new SqliteCtor(dbPath);
    // Wait a short time for a lock: the writer runs off the request path, but a
    // long wait still blocks the event loop.
    db.pragma("busy_timeout = 500");
    instance = new HookRecallLog(db);
    return instance;
  } catch (err) {
    openFailed = true;
    console.warn(`${TAG} log disabled, cannot open ${dbPath}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Write one row. Never throws: a log failure must not fail the recall. */
export function writeRecallLog(config: Pick<ProxyConfig, "storage">, row: RecallLogRow): void {
  try {
    getHookRecallLog(config)?.insert(row);
  } catch (err) {
    console.warn(`${TAG} write failed session=${row.sessionId}:`, err instanceof Error ? err.message : String(err));
  }
}

function runCleanup(config: Pick<ProxyConfig, "storage">): void {
  try {
    const n = getHookRecallLog(config)?.cleanup() ?? 0;
    if (n > 0) console.log(`${TAG} deleted ${n} rows older than 30 days`);
  } catch (err) {
    console.warn(`${TAG} cleanup failed:`, err instanceof Error ? err.message : String(err));
  }
}

/** Delete old rows now and then once a day. The timer does not keep the process alive. */
export function startHookRecallLogCleanup(config: Pick<ProxyConfig, "storage">): void {
  if (cleanupTimer) return;
  runCleanup(config);
  cleanupTimer = setInterval(() => runCleanup(config), CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}
