/**
 * Local two-team check of team-scoped Subscription Pools (SQLite or Mongo metadata). Run it with Node 22.
 *
 *   ROOT=${TMPDIR:-/tmp}/team-pool-e2e
 *   # 1. The old Core tree (the revision before the change) and an old-shape SQLite fixture written by it:
 *   mkdir -p $ROOT/old && git archive <base-revision> MemoryCore | tar -x -C $ROOT/old
 *   ln -s $PWD/MemoryCore/node_modules $ROOT/old/MemoryCore/node_modules
 *   (cd $ROOT/old/MemoryCore && CORE_ROOT=$PWD OUT_DIR=$ROOT/fixture node --import tsx <this dir>/build-fixture.ts)
 *   # 2. The check:
 *   node run-e2e.mjs [--root $ROOT] [--only 1,2,9] [--hold]
 *   node run-e2e.mjs --backend mongo [--root $ROOT] --only 1,13,4,6,16,12     # needs `mongod` in PATH
 *
 * `--root` holds `fixture`, `old/MemoryCore` and the work directory `run` (or `run-mongo`).
 * `--hold` keeps the processes up after the checks, until the file `<root>/release` exists.
 *
 * It starts the fake provider and normal upstream, Core and Proxy on fixed ports, runs the numbered
 * checks and stops every process it started. Each check prints PASS, FAIL or NOT RUN with evidence.
 * Results go to `<work>/results.json`, processes to `<work>/processes.json`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  CORE_ROOT, PORTS, PROXY_URL, assert, assertPortsFree, check, copyFixture, core, dbExec, dbPathOf, dbQuery,
  eq, fakeLog, fakeMark, normalLog, registry, results, setUsage, sleep, startCore, startFakes, startProxy, stopAll,
  stopProcess, waitFor, waitHttp, CORE_URL, PROVIDER_URL, violations,
} from "./lib.mjs";
import { MONGO_URI, buildMongoFixture, dumpDb, openMongoDb, restoreDb, startMongo } from "./mongo-helpers.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const BACKEND = opt("backend", "sqlite");
const ROOT = path.resolve(opt("root", path.join(process.env.TMPDIR ?? os.tmpdir(), "team-pool-e2e")));
const WORK = path.resolve(opt("work", path.join(ROOT, BACKEND === "mongo" ? "run-mongo" : "run")));
const ONLY = opt("only") ? new Set(opt("only").split(",")) : null;
const want = (id) => !ONLY || ONLY.has(String(id));

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, "home"), { recursive: true });
let FIXTURE = path.resolve(opt("fixture", path.join(ROOT, "fixture")));
const OLD_CORE = path.resolve(opt("old-core", path.join(ROOT, "old/MemoryCore")));
const MONGO_ARCHIVE = path.join(WORK, "fixture.archive");
if (BACKEND === "mongo") {
  // The old-shape Mongo database is written by the old Core code, then dumped once and restored for each run.
  try {
    await assertPortsFree([PORTS.mongo]);
    await startMongo(WORK);
    FIXTURE = path.join(WORK, "fixture-mongo");
    await buildMongoFixture({ oldCoreRoot: OLD_CORE, outDir: FIXTURE, prefix: "e2efix" });
    await dumpDb(MONGO_ARCHIVE, "e2efix");
  } catch (e) {
    console.error("MONGO SETUP ERROR", e.message);
    await stopAll();
    fs.writeFileSync(path.join(WORK, "processes.json"), JSON.stringify(registry.map(({ child, ...r }) => r), null, 2));
    process.exit(2);
  }
}
const fx = JSON.parse(fs.readFileSync(path.join(FIXTURE, "fixture.json"), "utf8"));
const T = fx.teams; // A, B, C
const key = (u) => fx.users[u].user_key;
const A_TOKENS = [fx.accounts["claude-A1"].token, fx.accounts["claude-A2"].token];
const A_ACCOUNT_IDS = [fx.accounts["claude-A1"].account_id, fx.accounts["claude-A2"].account_id];
let coreSeq = 0;
let coreProc = null;

async function bootCore(dataDir, env = {}) {
  coreSeq += 1;
  const label = `${coreSeq}`;
  coreProc = startCore({ work: WORK, dataDir, label, env });
  await waitHttp(`${CORE_URL}/health`, { timeoutMs: 90000 });
  // Core answers /health before the store of the instance is open and migrated; the store opens on the
  // first metadata call. One call with the admin key makes sure that the migration has finished.
  await waitFor("the metadata store of the instance", async () => (await core("/v3/meta/auth/verify", { user_key: "sk-mem-e2e-admin" })).code === 0, { timeoutMs: 60000, intervalMs: 300 });
  return coreProc;
}
async function haltCore() { await stopProcess(coreProc); coreProc = null; }
const coreLog = (proc = coreProc) => fs.readFileSync(proc.logFile, "utf8");
const backfillLines = (proc = coreProc) => coreLog(proc).split("\n").filter((l) => l.includes("[subscription-pool] team backfill team="));

// ── Claude Code turn through the Proxy ──────────────────────────────────────────────────────

async function claudeTurn({ user, session = crypto.randomUUID(), team, agent, memoryOff = false, text = "hello" }) {
  const headers = { "content-type": "application/json", "x-tdai-user-key": key(user), "x-claude-code-session-id": session };
  if (team) headers["x-team-id"] = team;
  if (agent) headers["x-agent-id"] = agent;
  if (memoryOff) headers["x-memory-mode"] = "off";
  const providerMark = await fakeMark();
  const normalMark = (await normalLog(999999999)).total;
  const res = await fetch(`${PROXY_URL}/claude-code/default/v1/messages`, {
    method: "POST", headers,
    body: JSON.stringify({
      model: "claude-sonnet-5-5", max_tokens: 8, stream: false,
      tools: [{ name: "Bash", description: "x", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: [{ type: "text", text, cache_control: { type: "ephemeral" } }] }],
    }),
  });
  const body = await res.text();
  await sleep(150);
  const sent = (await fakeLog(providerMark)).entries.filter((e) => e.server === "provider" && e.method === "POST" && /\/v1\/messages$/.test(e.path));
  // A pool call carries an account token. A call to the provider host without one is the official
  // group of the client; a call to the normal upstream fake is the shared normal upstream.
  const provider = sent.filter((e) => e.token.startsWith("tok-fake-"));
  const official = sent.filter((e) => !e.token.startsWith("tok-fake-"));
  const normal = [...official, ...(await normalLog(normalMark)).entries.filter((e) => e.server === "normal" && e.method === "POST" && /\/messages$/.test(e.path))];
  let json = null;
  try { json = JSON.parse(body); } catch { /* text answer */ }
  const out = { status: res.status, body, json, session, headers: Object.fromEntries(res.headers.entries()), poolToken: provider[0]?.token ?? null, poolCalls: provider.length, normalCalls: normal.length, officialCalls: official.length, reply: json?.content?.[0]?.text ?? "" };
  ledger({ user, team, poolToken: out.poolToken, kind: "turn" });
  return out;
}

const teamOfToken = (token) => {
  if (A_TOKENS.includes(token) || /^tok-fake-a\d/.test(token)) return "A";
  if (/^tok-fake-b\d/.test(token)) return "B";
  if (/^tok-fake-c\d/.test(token)) return "C";
  return null;
};

/** Teams whose pool each user may use now. A removal or a team delete narrows the list. */
const ALLOWED = { a: ["A"], b: ["B"], ab: ["A", "B"], c: ["C"], z: [] };
const TEAM_OF_ID = { [T.A]: "A", [T.B]: "B", [T.C]: "C" };

/** Records a turn that got an account of a team that the user may not use, or that the header did not name. */
function ledger({ user, team, poolToken, kind }) {
  if (!poolToken) return;
  const got = teamOfToken(poolToken);
  const named = team ? TEAM_OF_ID[team] : null;
  if (!got || !(ALLOWED[user] ?? []).includes(got) || (named && got !== named)) {
    violations.push(`${kind} user=${user} header-team=${named ?? "-"} token=${poolToken} (team ${got ?? "unknown"}) allowed=${(ALLOWED[user] ?? []).join(",") || "none"}`);
  }
}

/** Usage rows of the Proxy log (JSONL), to read which account served a turn. */
function usageRows() {
  const dir = path.join(WORK, "proxy-usage-logs");
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.event === "usage") rows.push(r); } catch { /* partial line */ }
    }
  }
  return rows;
}


/** Session start form: first turn shows the asset question, the second answers it. Returns the answered turn. */
async function formTurn({ user, answer }) {
  const session = crypto.randomUUID();
  const tools = [{ name: "Bash", description: "x", input_schema: { type: "object" } }];
  const send = async (messages) => {
    const providerMark = await fakeMark();
    const res = await fetch(`${PROXY_URL}/claude-code/default/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tdai-user-key": key(user), "x-claude-code-session-id": session },
      body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 8, stream: false, tools, messages }),
    });
    const body = await res.text();
    await sleep(150);
    const sent = (await fakeLog(providerMark)).entries.filter((e) => e.server === "provider" && e.method === "POST" && /\/v1\/messages$/.test(e.path));
    const poolToken = sent.find((e) => e.token.startsWith("tok-fake-"))?.token ?? null;
    ledger({ user, team: null, poolToken, kind: "form turn" });
    return { status: res.status, body, poolToken, official: sent.filter((e) => !e.token.startsWith("tok-fake-")).length };
  };
  const first = [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }];
  const r1 = await send(first);
  const id = r1.body.match(/toolu_cc_session_init_\d+/)?.[0];
  const q = r1.body.match(/\\"question\\":\\"([^"\\]+)/)?.[1];
  assert(id && q, `no session start form in the first answer: ${r1.body.slice(0, 200)}`);
  const second = [...first,
    { role: "assistant", content: [{ type: "tool_use", id, name: "AskUserQuestion", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `Your questions have been answered: "${q}"="${answer}".` }] }];
  return { ...(await send(second)), question: q };
}

// ── Team B pool setup through the real routes (the login code is exchanged with the fake) ──

async function addPoolAccount(userKeyOfAdmin, teamId, code, threshold) {
  const started = await core("/v3/meta/subscription-pool/account/oauth-start", { team_id: teamId, provider: "claude" }, userKeyOfAdmin);
  assert(started.status === 200, `oauth-start ${started.status} ${started.text.slice(0, 200)}`);
  const state = started.data.state;
  const body = { team_id: teamId, provider: "claude", state, code: `${code}#${state}`, display_name: `Login ${code}` };
  if (threshold !== undefined) body.threshold_pct = threshold;
  const done = await core("/v3/meta/subscription-pool/account/oauth-complete", body, userKeyOfAdmin);
  assert(done.status === 200, `oauth-complete ${done.status} ${done.text.slice(0, 300)}`);
  return done.data;
}

async function poolStatus(userKey, teamId) {
  const r = await core("/v3/meta/subscription-pool/status", { team_id: teamId, provider: "claude" }, userKey);
  assert(r.status === 200, `status ${r.status} ${r.text.slice(0, 200)}`);
  return r.data;
}

/**
 * One copy of the old-shape fixture, with read access to the pool tables. SQLite: a copy of the
 * database file. Mongo: a restore of the dump into a database of its own.
 */
let CUR = null;
async function makeDataset(id, { renameToDefault = [] } = {}) {
  if (BACKEND === "sqlite") {
    const dir = path.join(WORK, `data-${id}`);
    copyFixture(FIXTURE, dir);
    if (renameToDefault.length) {
      for (const teamId of renameToDefault) dbExec(dbPathOf(dir), "UPDATE meta_teams SET name='default' WHERE team_id=?", [teamId]);
    }
    const q = (sql) => dbQuery(dir, sql);
    return {
      id, dir, env: {}, backend: "sqlite",
      async oldShape() {
        const groupCols = q("PRAGMA table_info(meta_instance_upstream_config)").map((c) => c.name);
        const accountCols = q("PRAGMA table_info(meta_upstream_subscription_account)").map((c) => c.name);
        const sha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(FIXTURE, "metadata/tdai_metadata_default/metadata.db"))).digest("hex");
        assert(sha256 === fx.sha256, "fixture file changed since it was built");
        assert(!groupCols.includes("team_id") && !accountCols.includes("threshold_pct"), "copy is not in the old shape");
        return `fixture sha256 ${sha256.slice(0, 12)}, no team_id and no threshold_pct column before the open`;
      },
      async poolRows() { return q("SELECT group_id, name, team_id, agents, enabled, source_name FROM meta_instance_upstream_config WHERE mode='subscription_pool' ORDER BY id"); },
      async accountRows() { return q("SELECT account_id, group_id, display_name, threshold_pct, status, access_token FROM meta_upstream_subscription_account ORDER BY created_at, account_id"); },
      async defaultAgents() { return JSON.parse(q("SELECT agents FROM meta_instance_upstream_config WHERE group_type='default'")[0].agents); },
      async quick() { return q("PRAGMA quick_check")[0].quick_check; },
    };
  }
  const prefix = `e2e${id}`;
  await restoreDb(MONGO_ARCHIVE, "e2efix", prefix);
  const dir = path.join(WORK, `data-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  const { client, db } = await openMongoDb(prefix);
  if (renameToDefault.length) await db.collection("meta_teams").updateMany({ team_id: { $in: renameToDefault } }, { $set: { name: "default" } });
  return {
    id, dir, backend: "mongo", prefix, client,
    env: { TDAI_METADATA_MONGO_URI: MONGO_URI, TDAI_METADATA_MONGO_DB_PREFIX: prefix },
    async oldShape() {
      const groups = await db.collection("meta_instance_upstream_config").find({}).toArray();
      const accounts = await db.collection("meta_upstream_subscription_account").find({}).toArray();
      const indexes = (await db.collection("meta_instance_upstream_config").indexes()).map((i) => i.name);
      assert(!groups.some((g) => "team_id" in g) && !accounts.some((a) => "threshold_pct" in a), "restored data is not in the old shape");
      assert(indexes.includes("ux_source_name"), `old source index missing: ${indexes}`);
      return `restored dump has no team_id and no threshold_pct field, index ux_source_name present (${indexes.join(",")})`;
    },
    async poolRows() {
      const docs = await db.collection("meta_instance_upstream_config").find({ mode: "subscription_pool" }).sort({ created_at: 1, group_id: 1 }).toArray();
      return docs.map((d) => ({ group_id: d.group_id, name: d.name, team_id: d.team_id ?? "", agents: JSON.stringify(d.agents ?? []), enabled: d.enabled ? 1 : 0, source_name: d.source_name }));
    },
    async accountRows() {
      const docs = await db.collection("meta_upstream_subscription_account").find({}).sort({ created_at: 1, account_id: 1 }).toArray();
      return docs.map((d) => ({ account_id: d.account_id, group_id: d.group_id, display_name: d.display_name, threshold_pct: d.threshold_pct, status: d.status, access_token: d.access_token }));
    },
    async defaultAgents() { return (await db.collection("meta_instance_upstream_config").findOne({ group_type: "default" })).agents; },
    async quick() { return "n/a (Mongo)"; },
  };
}
const poolRows = () => CUR.poolRows();
const accountRows = () => CUR.accountRows();
const snapshotPool = async () => JSON.stringify([await poolRows(), (await accountRows()).map((a) => ({ ...a }))]);

// ════════════════════════════════════════════════════════════════════════════════════════════

async function main() {
  await assertPortsFree([PORTS.core, PORTS.proxy, PORTS.provider, PORTS.normal]);
  startFakes(WORK);
  await waitHttp(`${PROVIDER_URL}/__log`);

  // ── Migration: three team-name cases, plus an ambiguous name ─────────────────────
  if (want(1)) {
    const variants = [
      { id: "1a", title: "team named default-team (fresh-install name)", rename: [], env: {}, expectTeam: T.A, expectGroups: 2 },
      { id: "1b", title: "team A renamed default (production name)", rename: [T.A], env: {}, expectTeam: T.A, expectGroups: 2 },
      { id: "1c", title: "TDAI_METADATA_DEFAULT_TEAM_NAME names team B", rename: [], env: { TDAI_METADATA_DEFAULT_TEAM_NAME: "team-b" }, expectTeam: T.B, expectGroups: 2 },
      { id: "1d", title: "two teams named default: no team picked, agents still restored", rename: [T.A, T.B], env: {}, expectTeam: null, expectGroups: 0 },
    ];
    for (const v of variants) {
      await check(v.id, `migration log and shape (${BACKEND}): ${v.title}`, async () => {
        CUR = await makeDataset(v.id, { renameToDefault: v.rename });
        const shape = await CUR.oldShape();
        const proc = await bootCore(CUR.dir, { ...CUR.env, ...v.env });
        const lines = backfillLines(proc);
        const rows = await poolRows();
        const quick = await CUR.quick();
        const defAgents = await CUR.defaultAgents();
        const errLines = coreLog(proc).split("\n").filter((l) => /subscription-pool/.test(l) && /(error|unassigned|ambiguous|candidates)/i.test(l));
        await haltCore();
        if (CUR.client) await CUR.client.close();
        if (BACKEND === "sqlite") eq(quick, "ok", "quick_check");
        assert(defAgents.includes("claude-code") && defAgents.includes("codex"), `default.agents lacks the pooled agents: ${defAgents}`);
        if (v.expectTeam) {
          eq(lines.length, 1, "backfill line count");
          assert(lines[0].includes(`team=${v.expectTeam}`) && lines[0].includes(`groups=${v.expectGroups}`), `line: ${lines[0]}`);
          assert(rows.every((r) => r.team_id === v.expectTeam), `pool rows: ${JSON.stringify(rows)}`);
        } else {
          eq(lines.length, 1, "backfill line count");
          assert(lines[0].includes("team=none groups=0"), `line: ${lines[0]}`);
          assert(rows.every((r) => r.team_id === ""), `pool rows must stay unassigned: ${JSON.stringify(rows)}`);
          assert(errLines.some((l) => l.includes(T.A) && l.includes(T.B)), `no error line with both candidates: ${errLines}`);
        }
        return `${shape}; log: ${lines[0] ?? errLines[0]}; default.agents=${defAgents.join(",")}; quick_check=${quick}`;
      });
    }
  }

  // ── Main run: copy of the fixture, team A renamed default, then Core and Proxy ────────────
  CUR = await makeDataset("main", { renameToDefault: [T.A] });
  await bootCore(CUR.dir, CUR.env);
  const firstCore = coreProc;
  startProxy({ work: WORK });
  await waitHttp(`${PROXY_URL}/health`);

  // Right after the migration
  if (want(13)) {
    await check(13, "every old account has threshold_pct equal to the old global value (90)", async () => {
      const rows = (await accountRows());
      assert(rows.length === 3, `account rows: ${rows.length}`);
      assert(rows.every((r) => r.threshold_pct === 90), JSON.stringify(rows.map((r) => r.threshold_pct)));
      const st = await poolStatus(key("a"), T.A);
      const api = (st.providers.find((p) => p.provider === "claude")?.accounts ?? []).map((a) => a.threshold_pct);
      assert(api.length === 2 && api.every((v) => v === 90), `status of team A: ${JSON.stringify(api)}`);
      return `db thresholds ${rows.map((r) => r.threshold_pct)}; status of team A ${api}`;
    });
  }

  if (want(2)) {
    await check(2, "Claude Code turn of a uses an account of team A's pool", async () => {
      const r = await claudeTurn({ user: "a", team: T.A, agent: fx.agents.a });
      eq(r.status, 200, "status");
      assert(A_TOKENS.includes(r.poolToken), `provider token: ${r.poolToken}; reply ${r.reply}`);
      eq(r.normalCalls, 0, "normal upstream calls");
      // The Claude Code runner writes no account id to the usage log, so the account of the Claude turn
      // is proved by the token that the provider received. A Codex turn of the same user gives the
      // usage log row with the serving account id.
      const codex = await fetch(`${PROXY_URL}/codex/default/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tdai-user-key": key("a"), authorization: "Bearer chatgpt-own", "chatgpt-account-id": "own", "session-id": crypto.randomUUID(), "x-team-id": T.A, "x-agent-id": fx.agents.a },
        body: JSON.stringify({ model: "gpt-6-sol", stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] }),
      });
      await codex.text();
      const row = await waitFor("usage log row with the serving account", async () => usageRows().find((u) => u.subscriptionAccountId), { timeoutMs: 20000, intervalMs: 500 });
      eq(row.subscriptionAccountId, fx.accounts["codex-A1"].account_id, "account id in the usage log");
      return `claude token ${r.poolToken} (team ${teamOfToken(r.poolToken)}); codex usage log subscriptionAccountId=${row.subscriptionAccountId} (account codex-A1 of team A's codex pool)`;
    });
  }
  if (want(3)) {
    await check(3, "Claude Code turn of b (team B has no pool) goes to the normal upstream", async () => {
      const r = await claudeTurn({ user: "b", team: T.B, agent: fx.agents.b });
      eq(r.status, 200, "status");
      eq(r.poolCalls, 0, "pool calls");
      eq(r.normalCalls, 1, "normal upstream calls");
      assert(!r.reply.includes("tok-fake-"), `reply ${r.reply}`);
      return `reply ${r.reply}; pool calls ${r.poolCalls}; calls that reached the normal upstream fake (the default group target) ${r.normalCalls}; calls with no account token to the provider host ${r.officialCalls}`;
    });
  }

  // Team A admin lets omp use the pool (positive control for the model list)
  await core("/v3/meta/subscription-pool/clients/update", { team_id: T.A, provider: "claude", agents: ["claude-code", "omp"] }, key("a"));

  if (want(4)) {
    await check(4, "team B enables its claude pool, adds two stub accounts, sets clients; b uses B, a still uses A", async () => {
      const en = await core("/v3/meta/subscription-pool/enable", { team_id: T.B, provider: "claude" }, key("b"));
      assert(en.status === 200, `enable ${en.status} ${en.text.slice(0, 200)}`);
      const b1 = await addPoolAccount(key("b"), T.B, "b1");
      const b2 = await addPoolAccount(key("b"), T.B, "b2");
      fx.accounts["claude-B1"] = { account_id: b1.account_id, token: "tok-fake-b1" };
      fx.accounts["claude-B2"] = { account_id: b2.account_id, token: "tok-fake-b2" };
      const cl = await core("/v3/meta/subscription-pool/clients/update", { team_id: T.B, provider: "claude", agents: ["claude-code", "omp"] }, key("b"));
      assert(cl.status === 200, `clients/update ${cl.status} ${cl.text.slice(0, 200)}`);
      const turnB = await waitFor("turn of b on a team B account", async () => {
        const r = await claudeTurn({ user: "b", team: T.B, agent: fx.agents.b });
        return teamOfToken(r.poolToken) === "B" ? r : false;
      });
      const turnA = await claudeTurn({ user: "a", team: T.A, agent: fx.agents.a });
      eq(teamOfToken(turnA.poolToken), "A", "team of the token for a");
      return `b token ${turnB.poolToken}; a token ${turnA.poolToken}`;
    });
  }


  if (want(21)) {
    await check(21, "ab chooses team B (no agent of ab there): team B is the known team; B pool on gives B's account, B pool off gives the normal upstream, never team A's pool", async () => {
      const on = await waitFor("ab turn on a team B account", async () => {
        const r = await claudeTurn({ user: "ab", team: T.B });
        return r.status === 200 && teamOfToken(r.poolToken) === "B" ? r : false;
      });
      // Pool B off: its clients are cleared first, as the rule of the pool page requires.
      const clr = await core("/v3/meta/subscription-pool/clients/update", { team_id: T.B, provider: "claude", agents: [] }, key("b"));
      const off = await core("/v3/meta/subscription-pool/disable", { team_id: T.B, provider: "claude" }, key("b"));
      assert(clr.status === 200 && off.status === 200, `disable ${clr.status}/${off.status} ${off.text.slice(0, 200)}`);
      const offTurn = await waitFor("ab turn on the normal upstream with pool B off", async () => {
        const r = await claudeTurn({ user: "ab", team: T.B });
        return r.status === 200 && r.poolToken === null ? r : false;
      });
      eq(offTurn.normalCalls, 1, "normal upstream calls with pool B off");
      // Back on for the checks that follow.
      const en = await core("/v3/meta/subscription-pool/enable", { team_id: T.B, provider: "claude" }, key("b"));
      const back = await core("/v3/meta/subscription-pool/clients/update", { team_id: T.B, provider: "claude", agents: ["claude-code", "omp"] }, key("b"));
      assert(en.status === 200 && back.status === 200, `enable ${en.status}/${back.status}`);
      await waitFor("pool B serving again", async () => teamOfToken((await claudeTurn({ user: "b", team: T.B, agent: fx.agents.b })).poolToken) === "B");
      return `pool B on: token ${on.poolToken}; pool B off: no pool token, normal upstream calls ${offTurn.normalCalls}; team A pool had usable accounts the whole time`;
    });
  }

  if (want(5)) {
    await check(5, "ab opens one session in team A and one in team B; each uses its own team's account", async () => {
      const ag = await core("/v3/meta/agent/create", { team_id: T.B, owner_user_id: fx.users.ab.user_id, name: "agent-ab-b", visibility: "team" }, key("ab"));
      assert(ag.status === 200, `agent create ${ag.status} ${ag.text.slice(0, 200)}`);
      fx.agents.abB = ag.data.agent_id;
      const ta = await claudeTurn({ user: "ab", team: T.A, agent: fx.agents.ab });
      const tb = await waitFor("ab session in team B", async () => {
        const r = await claudeTurn({ user: "ab", team: T.B, agent: fx.agents.abB });
        return r.status === 200 && r.poolToken ? r : false;
      });
      eq(teamOfToken(ta.poolToken), "A", "team of token (session A)");
      eq(teamOfToken(tb.poolToken), "B", "team of token (session B)");
      return `session A token ${ta.poolToken}; session B token ${tb.poolToken}`;
    });
  }

  // ── A member of team B calls every pool route with team A ids ─────────────────────────────────────
  if (want(6)) {
    await check(6, "b cannot use any pool route or group route with team A ids; no team A data in any body", async () => {
      const routerSrc = fs.readFileSync(path.join(CORE_ROOT, "src/metadata/router/v3-meta-router.ts"), "utf8");
      const declared = [...routerSrc.matchAll(/\$\{V3_PREFIX\}\/(subscription-pool\/[a-z/-]+)`\]/g)].map((m) => m[1]);
      const aGroup = (await poolRows()).find((r) => r.team_id === T.A && r.name.includes("claude"));
      const A1 = fx.accounts["claude-A1"].account_id;
      const bodies = {
        "subscription-pool/status": { team_id: T.A, provider: "claude" },
        "subscription-pool/enable": { team_id: T.A, provider: "claude" },
        "subscription-pool/disable": { team_id: T.A, provider: "claude" },
        "subscription-pool/clients/update": { team_id: T.A, provider: "claude", agents: [] },
        "subscription-pool/settings/update": { threshold_pct: 50 },
        "subscription-pool/account/oauth-start": { team_id: T.A, provider: "claude" },
        "subscription-pool/account/oauth-complete": { team_id: T.A, provider: "claude", state: "x", code: "zz" },
        "subscription-pool/account/update": { account_id: A1, threshold_pct: 50, enabled: false },
        "subscription-pool/account/delete": { account_id: A1 },
        "subscription-pool/account/check-usage": { account_id: A1 },
        "subscription-pool/account/redeem-reset-credit": { account_id: A1, credit_id: "x", request_id: "12345678" },
        "subscription-pool/check-all": { team_id: T.A },
      };
      const missing = declared.filter((d) => !(d in bodies));
      assert(missing.length === 0, `routes without a body in this check: ${missing}`);
      const extra = {
        "instance-upstream/groups/list": {}, "instance-upstream/groups/view": { group_id: aGroup.group_id },
        "instance-upstream/groups/update": { group_id: aGroup.group_id, group_type: "custom", name: "stolen" },
        "instance-upstream/groups/toggle": { group_id: aGroup.group_id, enabled: false },
        "instance-upstream/groups/delete": { group_id: aGroup.group_id },
        "instance-upstream/groups/source-models/update": { group_id: aGroup.group_id, models: [{ id: "claude-opus-5", enabled: false }] },
        "instance-upstream/groups/source-refresh": { group_id: aGroup.group_id },
      };
      const before = (await snapshotPool());
      const secrets = [...A_TOKENS, ...A_ACCOUNT_IDS, aGroup.group_id, "Old claude 1", "Old claude 2", "prov-claude-A1", "prov-claude-A2", "refresh-fake-claude-A"];
      const lines = [];
      const bad = [];
      for (const [route, body] of [...Object.entries(bodies), ...Object.entries(extra)]) {
        const r = await core(`/v3/meta/${route}`, body, key("b"));
        // An error may repeat the id that the caller sent; that is the caller's own input, not a leak.
        const echoed = JSON.stringify(body);
        const leak = secrets.filter((s) => !echoed.includes(s) && r.text.includes(s));
        // A real denial: 403 permission_denied, or 404 for an id that must look unknown. A schema error (400) is not a denial.
        const generic = /^instance-upstream\/groups\/(update|toggle|delete)$/.test(route);
        const denied = (r.status === 403 && /permission_denied/.test(r.text))
          || (r.status === 404 && /(account_not_found|POOL_NOT_FOUND)/.test(r.text))
          || (generic && r.status === 400 && /POOL_GROUP_TEAM_SCOPED/.test(r.text));
        // The group list routes answer 200 for any member, but their items must hold no pool row.
        const isList = route.endsWith("groups/list") || route.endsWith("groups/view");
        const poolItem = isList && /subscription_pool/.test(JSON.stringify(r.data ?? {}));
        const listOk = isList && r.status === 200 && !poolItem;
        if (leak.length || poolItem || !(denied || listOk)) bad.push(`${route}: status ${r.status} ${r.text.slice(0, 160)} leak ${leak}`);
        lines.push(`${route} -> ${r.status} ${r.reason ?? ""}`.trim());
      }
      assert(bad.length === 0, `not denied or leaked: ${bad.join(" | ")}`);
      eq((await snapshotPool()), before, "pool rows and accounts after the calls");
      // b's own team still works (positive control)
      const own = await core("/v3/meta/subscription-pool/status", { team_id: T.B, provider: "claude" }, key("b"));
      eq(own.status, 200, "status of own team");
      return `through Core directly (the Hub forwards the same body and user key); ${declared.length} pool routes found in the router, all covered, plus ${Object.keys(extra).length} group routes; database unchanged; own team status 200\n${lines.join("\n")}`;
    });
  }

  if (want(7)) {
    await check(7, "client-sources/list as b has no pool source", async () => {
      const r = await core("/v3/meta/instance-upstream/client-sources/list", {}, key("b"));
      assert(r.status === 200, `status ${r.status} ${r.text.slice(0, 200)}`);
      const names = JSON.stringify(r.data);
      assert(!/sub-claude|sub-openai|sub-antigravity/.test(names), `catalog holds a pool source: ${names.slice(0, 300)}`);
      return `catalog bytes ${names.length}; no sub-* source`;
    });
  }

  if (want(8)) {
    await check(8, "omp model list: b sees only team B pool models, a sees team A's, c sees none", async () => {
      const list = async (user) => {
        const res = await fetch(`${PROXY_URL}/omp/default/v1/models`, { headers: { "x-tdai-user-key": key(user), authorization: `Bearer ${key(user)}` } });
        const j = await res.json().catch(() => ({}));
        return { status: res.status, ids: (j.data ?? []).map((m) => m.id) };
      };
      const b = await waitFor("b model list with team B pool models", async () => {
        const r = await list("b");
        return r.ids.includes("sub-claude/claude-b-only") ? r : false;
      }, { timeoutMs: 120000 });
      const a = await list("a");
      const c = await list("c");
      assert(!b.ids.includes("sub-claude/claude-a-only"), "b sees a team A only model");
      assert(a.ids.includes("sub-claude/claude-a-only") && !a.ids.includes("sub-claude/claude-b-only"), `a list: ${a.ids.filter((i) => i.startsWith("sub-"))}`);
      assert(!c.ids.some((i) => i.startsWith("sub-claude/")), `c sees pool models: ${c.ids.filter((i) => i.startsWith("sub-"))}`);
      return `b: ${b.ids.filter((i) => i.startsWith("sub-claude/")).length} sub-claude models incl. claude-b-only, none of claude-a-only; a has claude-a-only, not claude-b-only; c has no sub-claude model`;
    });
  }

  // ── Thresholds per account ──────────────────────────────────────────────
  if (want(14)) {
    await check(14, "thresholds B1=60, B2=90 with usage 70: new sessions go to B2 only; team A admin cannot change B1/B2", async () => {
      const [B1, B2] = [fx.accounts["claude-B1"], fx.accounts["claude-B2"]];
      const u1 = await core("/v3/meta/subscription-pool/account/update", { account_id: B1.account_id, threshold_pct: 60 }, key("b"));
      const u2 = await core("/v3/meta/subscription-pool/account/update", { account_id: B2.account_id, threshold_pct: 90 }, key("b"));
      assert(u1.status === 200 && u2.status === 200, `update ${u1.status}/${u2.status} ${u1.text.slice(0, 200)}`);
      const denied = await core("/v3/meta/subscription-pool/account/update", { account_id: B1.account_id, threshold_pct: 99 }, key("a"));
      assert(denied.status >= 400 && /account_not_found/.test(denied.text), `team A admin: ${denied.status} ${denied.text.slice(0, 200)}`);
      await setUsage(B1.token, { five_hour: 70 });
      await setUsage(B2.token, { five_hour: 70 });
      const chk = await core("/v3/meta/subscription-pool/check-all", { team_id: T.B }, key("b"));
      assert(chk.status === 200, `check-all ${chk.status} ${chk.text.slice(0, 200)}`);
      const tokens = await waitFor("four sessions of team B on B2 only", async () => {
        const out = [];
        for (let i = 0; i < 4; i++) out.push((await claudeTurn({ user: "b", team: T.B, agent: fx.agents.b })).poolToken);
        return out.every((t) => t === B2.token) ? out : false;
      }, { timeoutMs: 120000 });
      const rows = (await accountRows()).filter((r) => [B1.account_id, B2.account_id].includes(r.account_id));
      return `denied for team A admin (${denied.status} account_not_found); stored thresholds ${rows.map((r) => r.threshold_pct)}; tokens of four new sessions: ${tokens.join(",")}`;
    });
  }
  if (want(15)) {
    await check(15, "System Admin changes the start value; old accounts keep theirs; a new account gets it", async () => {
      const before = (await accountRows()).map((r) => `${r.account_id}:${r.threshold_pct}`);
      const s = await core("/v3/meta/subscription-pool/settings/update", { threshold_pct: 80 }, "sk-mem-e2e-admin");
      assert(s.status === 200, `settings/update ${s.status} ${s.text.slice(0, 200)}`);
      const after = (await accountRows()).map((r) => `${r.account_id}:${r.threshold_pct}`);
      eq(after, before, "thresholds of existing accounts");
      const nb = await addPoolAccount(key("b"), T.B, "b3");
      fx.accounts["claude-B3"] = { account_id: nb.account_id, token: "tok-fake-b3" };
      const row = (await accountRows()).find((r) => r.account_id === nb.account_id);
      eq(row.threshold_pct, 80, "threshold of the new account");
      const nb4 = await addPoolAccount(key("b"), T.B, "b4", 75);
      fx.accounts["claude-B4"] = { account_id: nb4.account_id, token: "tok-fake-b4" };
      eq((await accountRows()).find((r) => r.account_id === nb4.account_id).threshold_pct, 75, "explicit threshold of the next account");
      const denied = await core("/v3/meta/subscription-pool/settings/update", { threshold_pct: 70 }, key("b"));
      assert(denied.status >= 400, `team admin changed the global start value: ${denied.status}`);
      return `existing unchanged (${before.length} accounts); new account threshold 80; explicit 75 kept; team admin refused (${denied.status})`;
    });
    // Keep team B simple for the fallback checks: B3 and B4 are removed, B1 and B2 stay.
    for (const k of ["claude-B3", "claude-B4"]) {
      if (fx.accounts[k]) await core("/v3/meta/subscription-pool/account/delete", { account_id: fx.accounts[k].account_id }, key("b"));
    }
  }

  // ── Fallback over the teams of a user ────────────────────────────────────────────────────────────────
  const resetAll = async (levels) => {
    for (const [token, usage] of Object.entries(levels)) await setUsage(token, usage);
    await core("/v3/meta/subscription-pool/check-all", {}, "sk-mem-e2e-admin");
  };
  const B_TOKENS = ["tok-fake-b1", "tok-fake-b2"];
  const in_ = (h) => new Date(Date.now() + h * 3600_000).toISOString();

  if (want(16)) {
    await check(16, "ab with x-memory-mode off: account comes from team B (newest team first), not team A", async () => {
      await resetAll(Object.fromEntries([...A_TOKENS, ...B_TOKENS].map((t) => [t, { five_hour: 10 }])));

  if (want(22)) {
    await check(22, "a answers the session start form with skip (bypass without a chosen team): the fallback picks team A's pool", async () => {
      const a = await formTurn({ user: "a", answer: "No, skip for this session" });
      eq(a.status, 200, "status");
      eq(teamOfToken(a.poolToken), "A", "team of the token");
      const ab = await waitFor("ab fallback after the skip answer on team B", async () => {
        const r = await formTurn({ user: "ab", answer: "No, skip for this session" });
        return r.status === 200 && teamOfToken(r.poolToken) === "B" ? r : false;
      }, { timeoutMs: 120000 });
      return `a: token ${a.poolToken}; ab (teams A and B, both with pools): token ${ab.poolToken}, the first team in Core order`;
    });
  }

      const tokens = await waitFor("memory-off turn of ab on team B", async () => {
        const out = [];
        for (let i = 0; i < 3; i++) out.push((await claudeTurn({ user: "ab", memoryOff: true })).poolToken);
        return out.every((t) => teamOfToken(t) === "B") ? out : false;
      }, { timeoutMs: 120000 });
      const order = (await core("/v3/meta/team/list", { user_key: key("ab") }, key("ab"))).data?.items?.map((t) => t.name);
      return `tokens ${tokens.join(",")}; Core team order for ab: ${order}`;
    });
  }
  if (want(17)) {
    await check(17, "same with every team B account at quota: account comes from team A", async () => {
      await resetAll({ "tok-fake-b1": { five_hour: 100, five_reset: in_(5) }, "tok-fake-b2": { five_hour: 100, five_reset: in_(6) } });
      const tokens = await waitFor("memory-off turn of ab on team A", async () => {
        const out = [];
        for (let i = 0; i < 3; i++) out.push((await claudeTurn({ user: "ab", memoryOff: true })).poolToken);
        return out.every((t) => teamOfToken(t) === "A") ? out : false;
      }, { timeoutMs: 120000 });
      return `tokens ${tokens.join(",")}`;
    });
  }
  if (want(18)) {
    await check(18, "same with both pools at quota: 429 with the earliest reset of the two pools", async () => {
      const aReset = Date.now() + 2 * 3600_000;
      await resetAll({ [A_TOKENS[0]]: { five_hour: 100, five_reset: new Date(aReset).toISOString() }, [A_TOKENS[1]]: { five_hour: 100, five_reset: in_(3) } });
      const r = await waitFor("429 for ab", async () => {
        const t = await claudeTurn({ user: "ab", memoryOff: true });
        return t.status === 429 ? t : false;
      }, { timeoutMs: 120000 });
      const resetText = r.body;
      // The earliest reset of the two pools is the account A1 reset (about 2 h); team B's earliest is about 5 h.
      const m = resetText.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/);
      const numMatch = resetText.match(/"(?:resets_at_ms|reset_at_ms|resets_at)"\s*:\s*(\d{9,})/);
      const num = numMatch ? Number(numMatch[1]) : NaN;
      const got = m ? Date.parse(m[0]) : num < 1e11 ? num * 1000 : num;
      assert(Number.isFinite(got), `no reset time in the 429 body: ${resetText.slice(0, 300)}`);
      assert(Math.abs(got - aReset) < 5 * 60_000, `reset ${new Date(got).toISOString()} is not the team A reset ${new Date(aReset).toISOString()}`);
      const h = r.headers;
      eq(h["x-tdai-pool-status"], "exhausted", "x-tdai-pool-status");
      assert(Number(h["retry-after"]) > 0, `retry-after: ${h["retry-after"]}`);
      assert(Math.abs(Number(h["x-tdai-pool-earliest-reset"]) * 1000 - aReset) < 5 * 60_000, `x-tdai-pool-earliest-reset: ${h["x-tdai-pool-earliest-reset"]}`);
      return `429 body: ${resetText.slice(0, 300)}; headers retry-after=${h["retry-after"]} x-tdai-pool-status=${h["x-tdai-pool-status"]} x-tdai-pool-earliest-reset=${h["x-tdai-pool-earliest-reset"]}; expected earliest ${new Date(aReset).toISOString()}`;
    });
  }
  if (want(19)) {
    await check(19, "c (team C only, no pool): memory-off turn gets 403 no_team_pool; a registered session of c uses the normal upstream", async () => {
      const off = await claudeTurn({ user: "c", memoryOff: true });
      eq(off.status, 403, "status of the memory-off turn");
      assert(/no_team_pool/.test(off.body), `body ${off.body.slice(0, 300)}`);
      eq(off.poolCalls + off.normalCalls, 0, "upstream calls of the refused turn");
      const reg = await claudeTurn({ user: "c", team: T.C, agent: fx.agents.c });
      eq(reg.status, 200, "registered turn status");
      eq(reg.normalCalls, 1, "normal upstream calls");
      return `403 body: ${off.body.slice(0, 300)}; registered turn reply ${reg.reply}`;
    });
  }
  if (want(20)) {
    await check(20, "z (no team) gets 403 no_active_team", async () => {
      const r = await claudeTurn({ user: "z" });
      eq(r.status, 403, "status");
      assert(/no_active_team/.test(r.body), `body ${r.body.slice(0, 300)}`);
      eq(r.poolCalls + r.normalCalls, 0, "upstream calls");
      return `403 body: ${r.body.slice(0, 300)}`;
    });
  }


  // Back to a normal state for the checks that follow
  await resetAll(Object.fromEntries([...A_TOKENS, ...B_TOKENS].map((t) => [t, { five_hour: 10 }])));

  // ── Account Switch ─────────────────────────────────────────────────────────────
  if (want(11)) {
    await check(11, "Account Switch as System Admin in a team A session lists only team A accounts", async () => {
      const adminAgent = (await core("/v3/meta/agent/list", { team_id: T.A, owner_user_id: fx.admin.user_id }, "sk-mem-e2e-admin")).data?.items?.[0]?.agent_id;
      assert(adminAgent, "admin agent of team A not found");
      const session = crypto.randomUUID();
      const turn = await claudeTurn({ user: "ab", session, team: T.A, agent: fx.agents.ab });
      // The System Admin session: the admin key registers a session in team A.
      const adminSession = crypto.randomUUID();
      const send = await fetch(`${PROXY_URL}/claude-code/default/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tdai-user-key": "sk-mem-e2e-admin", "x-claude-code-session-id": adminSession, "x-team-id": T.A, "x-agent-id": adminAgent },
        body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 8, stream: false, tools: [{ name: "Bash", description: "x", input_schema: { type: "object" } }], messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }] }),
      });
      await send.text();
      const bridge = async (action, body = {}, sid = adminSession, userKey) => {
        const res = await fetch(`${PROXY_URL}/subscription-bridge/v1/${action}`, { method: "POST", headers: { "content-type": "application/json", "x-conversation-id": sid, "x-tdai-service-id": "default" }, body: JSON.stringify(body) });
        return { status: res.status, json: await res.json() };
      };
      const cur = await bridge("current");
      eq(cur.status, 200, `current ${JSON.stringify(cur.json)}`);
      const acc = cur.json.data.account;
      assert(acc, `no bound account: ${JSON.stringify(cur.json)}`);
      assert(A_ACCOUNT_IDS.includes(acc.account_id), `bound account ${acc.account_id} is not a team A account`);
      // The fixture accounts have no e-mail label, so a third team A account is added through the login route.
      const a3 = await addPoolAccount(key("a"), T.A, "a3");
      await waitFor("a3 in the pool snapshot", async () => (await bridge("switch", { email: "a3@example.invalid" })).status !== 404, { timeoutMs: 90000 });
      const emailOf = (n) => `${n}@example.invalid`;
      const toB = await bridge("switch", { email: emailOf("b1") });
      assert(toB.status >= 400 && /account_not_in_pool/.test(JSON.stringify(toB.json)), `switch to a team B account: ${toB.status} ${JSON.stringify(toB.json)}`);
      const toA = await bridge("switch", { email: emailOf("a3") });
      assert(toA.status === 200 || toA.status === 409, `switch to a team A account: ${toA.status} ${JSON.stringify(toA.json)}`);
      return `current account ${acc.account_id} (team A); switch to a team B account: ${toB.status} ${toB.json.reason}; switch to team A account a3: ${toA.status} ${JSON.stringify(toA.json).slice(0, 220)}`;
    });
  }

  // ── Leaving and deleting a team ──────────────────────────────────────────
  if (want(9)) {
    await check(9, "b removed from team B: next turn gets 403 no_active_team, never the normal upstream or team A's pool", async () => {
      const existing = crypto.randomUUID();
      const reg = await claudeTurn({ user: "b", session: existing, team: T.B, agent: fx.agents.b });
      assert(reg.status === 200, `registered turn ${reg.status}`);
      const rm = await core("/v3/meta/team-member/remove", { team_id: T.B, user_id: fx.users.b.user_id }, "sk-mem-e2e-admin");
      assert(rm.status === 200, `remove ${rm.status} ${rm.text.slice(0, 200)}`);
      const started = Date.now();
      const after = await waitFor("403 no_active_team for b", async () => {
        const r = await claudeTurn({ user: "b", session: existing, team: T.B, agent: fx.agents.b });
        return r.status === 403 ? r : false;
      }, { timeoutMs: 120000, intervalMs: 5000 });
      assert(/no_active_team/.test(after.body), `body ${after.body.slice(0, 300)}`);
      // The membership list is cached for up to 60 s, so a turn before the first 403 may still use a team B
      // pool (and never another team's). From the first 403 on, b may use no pool at all.
      ALLOWED.b = [];
      const fresh = await claudeTurn({ user: "b" });
      eq(fresh.status, 403, "fresh session status");
      eq(after.poolCalls + after.normalCalls + fresh.poolCalls + fresh.normalCalls, 0, "upstream calls of the refused turns");
      return `registered session answered 403 ${Math.round((Date.now() - started) / 1000)} s after removal; body ${after.body.slice(0, 200)}; fresh session 403; no upstream call`;
    });
  }
  if (want(10)) {
    await check(10, "deleting team B removes its pool rows and accounts; team A unchanged; scheduler stops its timers", async () => {
      const aBefore = JSON.stringify([(await poolRows()).filter((r) => r.team_id === T.A), (await accountRows()).filter((r) => A_ACCOUNT_IDS.includes(r.account_id))]);
      const logMark = coreLog().length;
      const del = await core("/v3/meta/team/delete", { team_ids: [T.B] }, "sk-mem-e2e-admin");
      ALLOWED.ab = ["A"];
      assert(del.status === 200, `delete ${del.status} ${del.text.slice(0, 300)}`);
      const rowsB = (await poolRows()).filter((r) => r.team_id === T.B);
      const accB = (await accountRows()).filter((r) => /^Login b/.test(r.display_name));
      eq(rowsB.length, 0, "team B pool rows");
      eq(accB.length, 0, "team B accounts");
      const aAfter = JSON.stringify([(await poolRows()).filter((r) => r.team_id === T.A), (await accountRows()).filter((r) => A_ACCOUNT_IDS.includes(r.account_id))]);
      eq(aAfter, aBefore, "team A rows and accounts");
      assert(!JSON.stringify(del.data ?? {}).includes("tok-fake-b"), "delete answer holds a token");
      await sleep(1000);
      // The Core log has no line when a timer stops. A usage check of every account after the delete
      // must not call the provider with a team B token, which shows the accounts left the check set.
      const mark = await fakeMark();
      const all = await core("/v3/meta/subscription-pool/check-all", {}, "sk-mem-e2e-admin");
      assert(all.status === 200, `check-all ${all.status}`);
      await sleep(1500);
      const after = (await fakeLog(mark)).entries;
      assert(after.some((e) => /tok-fake-(claude-A|a\d)/.test(e.token)), "the usage check of team A did not run");
      eq(after.filter((e) => /tok-fake-b\d/.test(e.token)).length, 0, "provider calls with a team B token after the delete");
      const tail = coreLog().slice(logMark);
      return `team B pool rows 0, accounts 0; team A rows and accounts identical; delete answer ${del.text.slice(0, 160)}; check-all after the delete made ${after.length} provider calls, none with a team B token; Core log lines about the pool after the delete: ${tail.split("\n").filter((l) => /subscription-pool|scheduler/i.test(l)).length} (the scheduler logs no line when it drops a timer)`;
    });
  }

  // ── Restart twice ─────────────────────────────────────────────────────────────
  if (want(12)) {
    await check(12, "two Core restarts: no second backfill line, data unchanged", async () => {
      const first = backfillLines(firstCore).length;
      const snap = (await snapshotPool());
      const lines = [];
      for (let i = 0; i < 2; i++) {
        await haltCore();
        const p = await bootCore(CUR.dir, CUR.env);
        lines.push(backfillLines(p).length);
      }
      eq(first, 1, "backfill lines at the first start");
      eq(lines, [0, 0], "backfill lines at the restarts");
      eq((await snapshotPool()), snap, "pool rows and accounts");
      const quick = await CUR.quick();
      if (BACKEND === "sqlite") eq(quick, "ok", "quick_check");
      return `backfill lines: first start ${first}, restarts ${lines}; pool rows and account rows identical; quick_check ${quick}`;
    });
  }

}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error("RUN ERROR", e.stack ?? e);
} finally {
  if (argv.includes("--hold")) {
    const release = path.join(ROOT, "release");
    console.log(`HOLD: create ${release} to stop the processes`);
    for (let i = 0; i < 1800 && !fs.existsSync(release); i++) await sleep(1000);
    fs.rmSync(release, { force: true });
  }
  await stopAll();
  fs.writeFileSync(path.join(WORK, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(WORK, "processes.json"), JSON.stringify(registry.map(({ child, ...r }) => r), null, 2));
  const blocked = path.join(WORK, "blocked-hosts.log");
  const log = fs.existsSync(blocked) ? fs.readFileSync(blocked, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const summary = log.reduce((acc, e) => { acc[`${e.action}:${e.host}`] = (acc[`${e.action}:${e.host}`] ?? 0) + 1; return acc; }, {});
  console.log(`\nOutbound guard log: ${JSON.stringify(summary)}`);
  console.log(`Results: ${results.filter((r) => r.result === "PASS").length} pass, ${results.filter((r) => r.result === "FAIL").length} fail, ${results.filter((r) => r.result === "NOT RUN").length} not run`);
}
process.exit(failed || results.some((r) => r.result === "FAIL") ? 1 : 0);
