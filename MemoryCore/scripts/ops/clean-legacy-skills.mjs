#!/usr/bin/env node
/**
 * One-time cleanup of skills made before skills had a scope.
 *
 * - Template skills (code-review, unit-test, api-docs): a template that the
 *   extractor changed is set back to its first version, then every template is
 *   marked as a global template.
 * - Every other skill that is global + extracted and was created before
 *   CUTOFF_MS is deleted. Skills created after the cutoff (project skills made
 *   by the new extractor) are never selected.
 *
 * All changes go through the Core skill API (rollback, mark-template, delete),
 * so files, assets and search indexes stay consistent.
 *
 * Safety:
 *   - DRY_RUN=1 (default) only prints the plan.
 *   - Calls run in batches of BATCH (default 10). After each batch the script
 *     checks Core health. It stops at the first error or when one call takes
 *     longer than MAX_CALL_MS (default 2000).
 *
 * Usage (inside a container that can read the Core database and reach Core):
 *   DB=/data/tdai-memory/vectors.db CORE=http://memory-core:8420 CUTOFF_MS=<epoch ms> \
 *   TOKEN_FILE=/tmp/t DRY_RUN=0 node clean-legacy-skills.mjs
 * The token is read from TOKEN_FILE and never printed.
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const DB = process.env.DB ?? "/data/tdai-memory/vectors.db";
const CORE = process.env.CORE ?? "http://memory-core:8420";
const SERVICE_ID = process.env.SERVICE_ID ?? "default";
const CUTOFF_MS = Number(process.env.CUTOFF_MS);
const DRY_RUN = process.env.DRY_RUN !== "0";
const BATCH = Number(process.env.BATCH ?? 10);
const MAX_CALL_MS = Number(process.env.MAX_CALL_MS ?? 2000);
const TEMPLATES = ["code-review", "unit-test", "api-docs"];

if (!Number.isFinite(CUTOFF_MS) || CUTOFF_MS <= 0) throw new Error("CUTOFF_MS is required");
const token = fs.readFileSync(process.env.TOKEN_FILE ?? "/tmp/t", "utf8").trim();

const db = new DatabaseSync(DB, { readOnly: true });
const heads = db.prepare(
  "select skill_id, name, version, team_id, owner_agent_id, user_id, scope, origin, created_at_ms, content_hash from skills where is_head = 1",
).all();
const firstHash = db.prepare("select content_hash from skills where skill_id = ? and version = 1");
for (const h of heads) h.first_hash = firstHash.get(h.skill_id)?.content_hash ?? h.content_hash;
db.close();

const templates = heads.filter((h) => TEMPLATES.includes(h.name));
/** A template whose current content differs from its first version (the extractor changed it). */
function changedTemplate(t) { return t.content_hash !== t.first_hash; }
const toDelete = heads.filter((h) =>
  !TEMPLATES.includes(h.name) && h.scope === "global" && h.origin === "extracted" && h.created_at_ms < CUTOFF_MS);
const kept = heads.length - templates.length - toDelete.length;

console.log(JSON.stringify({
  heads: heads.length, templates: templates.length, templatesChanged: templates.filter(changedTemplate).length,
  templatesToMark: templates.filter((t) => t.origin !== "template").length,
  toDelete: toDelete.length, kept, dryRun: DRY_RUN,
}));
if (DRY_RUN) process.exit(0);

async function call(path, body) {
  const t0 = Date.now();
  const res = await fetch(`${CORE}/v3/skill/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-tdai-service-id": SERVICE_ID, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (typeof json.code !== "number") throw new Error(`${path}: Core answered HTTP ${res.status} without an envelope (route missing?)`);
  const ms = Date.now() - t0;
  if (json.code !== 0) throw new Error(`${path} ${body.skill_id} failed: code=${json.code} ${json.message}`);
  if (ms > MAX_CALL_MS) throw new Error(`${path} ${body.skill_id} took ${ms} ms (limit ${MAX_CALL_MS})`);
  return { json, ms };
}

async function healthy() {
  const res = await fetch(`${CORE}/health`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Core health ${res.status}`);
}

const ids = (h) => ({ team_id: h.team_id, agent_id: h.owner_agent_id, user_id: h.user_id });
const reason = "Clean up skills made before skills had a scope";
let done = 0;
let maxMs = 0;

async function inBatches(items, fn, label) {
  for (let i = 0; i < items.length; i += BATCH) {
    for (const item of items.slice(i, i + BATCH)) {
      const { ms } = await fn(item);
      maxMs = Math.max(maxMs, ms);
      done++;
    }
    await healthy();
    console.log(`${label}: ${Math.min(i + BATCH, items.length)}/${items.length} done, max call ${maxMs} ms`);
  }
}

// Templates first: restore changed ones, then mark all as templates.
await inBatches(templates.filter(changedTemplate), (t) =>
  call("rollback", { ...ids(t), skill_id: t.skill_id, target_version: 1, expected_version: t.version, reason }), "restore templates");
await inBatches(templates.filter((t) => t.origin !== "template"), (t) => call("mark-template", { ...ids(t), skill_id: t.skill_id, reason }), "mark templates");
await inBatches(toDelete, (h) =>
  call("delete", { ...ids(h), skill_id: h.skill_id, expected_version: h.version }), "delete legacy skills");

console.log(JSON.stringify({ calls: done, maxCallMs: maxMs }));
