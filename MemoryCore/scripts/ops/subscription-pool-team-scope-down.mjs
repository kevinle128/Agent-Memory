#!/usr/bin/env node
/**
 * Roll-back step for team-scoped subscription pools (SQLite metadata only).
 *
 * Run it with Core STOPPED, before you start the old image. It makes the database safe for the old
 * code, which knows no team on a pool group:
 *
 *   1. The old code creates a unique index on `source_name` alone at each start. Two teams that
 *      hold the same pool source name (`sub-claude`) would make that start fail. The script puts
 *      the old index back, only after it has proved that no source name is used twice.
 *   2. The old store refuses a write while one agent is in two groups (`agents_overlap`). The new
 *      code keeps each pooled agent in the default group too. The script removes the agents of
 *      the pool groups from the default group, as the old code kept them.
 *   3. The old Proxy takes the first pool group that holds the agent, with no team check. With
 *      pools of two teams it could send the traffic of one team on the accounts of another. So the
 *      script refuses to run while more than one team holds pool groups.
 *
 * The columns `team_id` (pool groups) and `threshold_pct` (accounts) stay. The old code reads
 * named fields only and names its insert columns, so it does not see them, and the values come
 * back at the next deploy of the new code. After the roll back, every account uses the global
 * threshold again.
 *
 * Safety:
 *   - `--dry-run` opens the database read only, prints the plan and changes nothing.
 *   - Before the first write the script copies `metadata.db`, `metadata.db-journal`, `metadata.db-wal`
 *     and `metadata.db-shm` (those that exist) to a new folder in the backup directory (mode 600) and checks each copy.
 *   - All writes run in one transaction. The transaction is rolled back when `PRAGMA quick_check`
 *     does not return `ok`.
 *   - It prints counts and ids only. It never reads or prints a token.
 *   - It is safe to run again: the second run changes nothing.
 *
 * Usage (a real run needs --backup-dir; use a folder that outlives the container):
 *   node subscription-pool-team-scope-down.mjs --db <metadata.db> --backup-dir <dir> [--dry-run]
 *
 * Exit code: 0 done, 2 refused (the message says why and nothing was changed), 1 error.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

const OLD_INDEX = "ux_iuc_source_name";
const NEW_INDEX = "ux_iuc_team_source_name";
// "-journal" is the rollback journal of a database that is not in WAL mode; a hot journal is needed
// to read a copy taken after a crash mid-transaction.
const DB_SUFFIXES = ["", "-journal", "-wal", "-shm"];

/** The database is not safe to roll back yet. Nothing was changed. */
export class DownStepRefused extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DownStepRefused";
    this.code = code;
  }
}

function parseAgents(raw) {
  try {
    const value = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

/** Read the database and work out what the step has to do. Refuses when it is not safe. */
function inspect(db) {
  const columns = db.prepare("SELECT name FROM pragma_table_info('meta_instance_upstream_config')").all().map((r) => r.name);
  if (columns.length === 0) throw new DownStepRefused("no_upstream_table", "The database has no meta_instance_upstream_config table. Is --db the Core metadata database?");
  const hasTeamColumn = columns.includes("team_id");
  const teamExpr = hasTeamColumn ? "team_id" : "''";
  const groups = db
    .prepare(`SELECT id, group_id, group_type, mode, source_name, agents, ${teamExpr} AS team_id FROM meta_instance_upstream_config ORDER BY id`)
    .all()
    .map((g) => ({ ...g, agents: parseAgents(g.agents), team_id: String(g.team_id ?? "") }));
  const pools = groups.filter((g) => g.mode === "subscription_pool");

  const poolTeams = [...new Set(pools.map((g) => g.team_id))].sort();
  if (poolTeams.length > 1) {
    throw new DownStepRefused(
      "multiple_teams_with_pools",
      `More than one team holds subscription pool groups (${poolTeams.map((t) => t || "<none>").join(", ")}). ` +
      "The old code cannot tell the teams apart and could send the traffic of one team on the accounts of another. " +
      "Remove the pools of all teams but one, then run this step again. Disabling a pool keeps its group, so only deleting a team (team/delete, which also deletes its accounts) removes it. Nothing was changed.",
    );
  }

  const bySource = new Map();
  for (const g of groups) {
    if (!g.source_name) continue;
    const list = bySource.get(g.source_name) ?? [];
    list.push(g);
    bySource.set(g.source_name, list);
  }
  const duplicates = [...bySource.entries()].filter(([, list]) => list.length > 1);
  if (duplicates.length > 0) {
    throw new DownStepRefused(
      "duplicate_source_name",
      `The source name is used more than once: ${duplicates.map(([name, list]) => `${name} (${list.length} groups, teams ${list.map((g) => g.team_id || "<none>").join("/")})`).join("; ")}. ` +
      `The old code needs a unique index on the source name, so it would not start. Rename or remove the extra group, then run this step again. Nothing was changed.`,
    );
  }

  const poolAgents = new Set(pools.flatMap((g) => g.agents));
  const defaultGroup = groups.find((g) => g.group_type === "default") ?? null;
  const agentsToRemove = defaultGroup ? defaultGroup.agents.filter((a) => poolAgents.has(a)) : [];
  const defaultAfter = defaultGroup ? defaultGroup.agents.filter((a) => !poolAgents.has(a)) : [];

  const holders = new Map();
  for (const g of groups) {
    const agents = g === defaultGroup ? defaultAfter : g.agents;
    for (const agent of new Set(agents)) holders.set(agent, [...(holders.get(agent) ?? []), g.group_id]);
  }
  const overlaps = [...holders.entries()].filter(([, ids]) => ids.length > 1);
  if (overlaps.length > 0) {
    throw new DownStepRefused(
      "agent_overlap",
      `An agent would stay in more than one group: ${overlaps.map(([agent, ids]) => `${agent} in ${ids.join(", ")}`).join("; ")}. ` +
      "The old store refuses writes in that state. Move the agent out of the extra group, then run this step again. Nothing was changed.",
    );
  }

  const indexNames = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'meta_instance_upstream_config'").all().map((r) => r.name);
  return {
    poolRows: pools.length,
    teamsWithPools: poolTeams.length,
    poolTeam: poolTeams[0] ?? null,
    defaultGroup,
    agentsToRemove,
    defaultAfter,
    oldIndexPresent: indexNames.includes(OLD_INDEX),
    newIndexPresent: indexNames.includes(NEW_INDEX),
  };
}

function stamp(now) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}${String(now.getUTCMilliseconds()).padStart(3, "0")}Z`;
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Copy the database files into a new folder and prove that each copy is equal. Returns the folder. */
function backupDatabase(dbPath, backupRoot, now) {
  const dir = path.join(backupRoot, `${stamp(now)}-team-pool-down`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const suffix of DB_SUFFIXES) {
    const source = dbPath + suffix;
    if (!fs.existsSync(source)) continue;
    const target = path.join(dir, path.basename(source));
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o600);
    if (sha256(source) !== sha256(target)) throw new Error(`backup copy differs from ${path.basename(source)}; nothing was changed`);
  }
  return dir;
}

/**
 * Run the roll-back step on one SQLite metadata database.
 * @param {{ db: string, dryRun?: boolean, backupDir?: string, now?: () => Date }} options (`backupDir` is required unless `dryRun`)
 * @returns counts of what the step changed (or would change with `dryRun`)
 */
export function runDownStep({ db: dbPath, dryRun = false, backupDir, now = () => new Date() }) {
  if (!dbPath) throw new Error("--db is required");
  if (!fs.existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  if (!dryRun && !backupDir) throw new Error("--backup-dir is required for a real run: use a folder that outlives the container, for example a mounted host folder");

  // Plan first, on a read only handle. A refusal then leaves no backup folder behind.
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  let plan;
  try {
    plan = inspect(reader);
  } finally {
    reader.close();
  }
  const sourceIndexAction = plan.oldIndexPresent && !plan.newIndexPresent ? "present" : "restore";
  const result = {
    dry_run: dryRun,
    pool_rows: plan.poolRows,
    teams_with_pools: plan.teamsWithPools,
    pool_team: plan.poolTeam,
    agents_removed: plan.agentsToRemove.length,
    agents: plan.agentsToRemove,
    source_name_index: sourceIndexAction === "present" ? "already old" : "restore",
    quick_check: "not run (dry run)",
    backup: null,
  };
  if (dryRun) return result;

  result.backup = backupDatabase(dbPath, backupDir, now());

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    try {
      // The plan is read again under the write lock, so a change between the two reads cannot slip in.
      const locked = inspect(db);
      if (locked.defaultGroup && locked.agentsToRemove.length > 0) {
        db.prepare("UPDATE meta_instance_upstream_config SET agents = ?, version = version + 1, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(locked.defaultAfter), now().toISOString(), locked.defaultGroup.id);
      }
      db.exec(`DROP INDEX IF EXISTS ${NEW_INDEX}`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${OLD_INDEX} ON meta_instance_upstream_config(source_name) WHERE source_name != ''`);
      const quick = db.prepare("PRAGMA quick_check").get().quick_check;
      if (quick !== "ok") throw new Error(`PRAGMA quick_check returned "${quick}"; the transaction was rolled back`);
      db.exec("COMMIT");
      result.quick_check = quick;
      result.agents_removed = locked.agentsToRemove.length;
      result.agents = locked.agentsToRemove;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* the transaction may be gone already */ }
      throw error;
    }
  } finally {
    db.close();
  }
  return result;
}

/** Value of an option. A missing value or another flag in its place is an error, never a value. */
function takeOptionValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--db") out.db = takeOptionValue(argv, ++i, "--db");
    else if (arg === "--backup-dir") out.backupDir = takeOptionValue(argv, ++i, "--backup-dir");
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

const USAGE = "Usage: node subscription-pool-team-scope-down.mjs --db <metadata.db> --backup-dir <dir> [--dry-run]\nStop Core before you run it. A real run needs --backup-dir.";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.db) {
      console.log(USAGE);
      process.exit(args.help ? 0 : 1);
    }
    console.log(JSON.stringify(runDownStep(args)));
  } catch (error) {
    if (error instanceof DownStepRefused) {
      console.error(`REFUSED (${error.code}): ${error.message}`);
      process.exit(2);
    }
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
