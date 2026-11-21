/**
 * Builds a metadata database in the shape of the build before team-scoped pools, by running the
 * OLD Core code (a `git archive` of the base revision) against an empty directory.
 *
 *   CORE_ROOT=<old MemoryCore dir> OUT_DIR=<empty dir> node --import tsx build-fixture.ts
 *
 * It writes `<OUT_DIR>/metadata/tdai_metadata_default/metadata.db` and `<OUT_DIR>/fixture.json`
 * (ids, user keys, account tokens). The tokens are fake. No network call is made.
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The old Core tree is loaded by path at run time, so its types are not known here; the values are
// read back and checked below, so `any` is used on purpose for the old store and service.
const root = process.env.CORE_ROOT;
const out = process.env.OUT_DIR;
if (!root || !out) throw new Error("CORE_ROOT and OUT_DIR are required");
if (fs.existsSync(out) && fs.readdirSync(out).length > 0) throw new Error(`OUT_DIR is not empty: ${out}`);

const load = <T>(rel: string) => import(pathToFileURL(path.join(root, rel)).href) as Promise<T>;
const { SqliteMetadataStore } = await load<any>("src/metadata/store/sqlite-adapter.ts");
const { createMetadataStore } = await load<any>("src/metadata/store/factory.ts");
const mongoUri = process.env.MONGO_URI;
const mongoPrefix = process.env.MONGO_DB_PREFIX ?? "e2efix";
const { MetadataService } = await load<any>("src/metadata/service/metadata-service.ts");
const { DEFAULT_SUPPORTED_AGENTS_FALLBACK } = await load<any>("src/metadata/default-supported-agents.ts");

const dbDir = path.join(out, "metadata", "tdai_metadata_default");
fs.mkdirSync(dbDir, { recursive: true });
const dbPath = path.join(dbDir, "metadata.db");

const store = mongoUri
  ? await createMetadataStore({ backend: "mongodb", mongoUri, mongoTransactions: true, storeCacheMaxInstances: 4, mongoDbPrefix: mongoPrefix }, "default")
  : (() => { const sqlite = new SqliteMetadataStore(dbPath); sqlite.init(); return sqlite; })();
const svc = new MetadataService(store, "default");
const agents = DEFAULT_SUPPORTED_AGENTS_FALLBACK;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Users and teams. The init-admin call creates the team named `default-team` (team A).
const admin = await svc.initAdminUser({ username: "e2e-admin", user_key: "sk-mem-e2e-admin" });
const teamsA = (await svc.listTeamsByUser(admin.user_id)).items;
const teamA = teamsA.find((t: any) => t.name === "default-team");
if (!teamA) throw new Error("init-admin did not create default-team");

const users: Record<string, { user_id: string; user_key: string }> = {};
for (const name of ["a", "b", "ab", "c", "z"]) {
  const key = `sk-mem-e2e-${name}`;
  const u = await svc.createNormalUserWithKey({ username: `e2e-${name}`, user_key: key });
  users[name] = { user_id: u.user_id, user_key: key };
}
await sleep(15);
// The admin owns teams B and C, so the System Admin can remove members and delete a team; `b` and `c` are team admins.
const teamB = await svc.createTeam({ name: "team-b", owner_user_id: admin.user_id });
await sleep(15);
const teamC = await svc.createTeam({ name: "team-c", owner_user_id: admin.user_id });
await svc.addTeamMember({ team_id: teamB.team_id, user_id: users.b.user_id, role: "admin" });
await svc.addTeamMember({ team_id: teamC.team_id, user_id: users.c.user_id, role: "admin" });
await svc.addTeamMember({ team_id: teamA.team_id, user_id: users.a.user_id, role: "admin" });
await svc.addTeamMember({ team_id: teamA.team_id, user_id: users.ab.user_id, role: "member" });
await svc.addTeamMember({ team_id: teamB.team_id, user_id: users.ab.user_id, role: "member" });
// An agent is visible only to its owner, so each user that needs a registered session owns one.
// User `ab` has an agent in team A only: the form check of a team without an agent needs that.
const agents_: Record<string, string> = {};
for (const [user, team] of [["a", teamA], ["ab", teamA], ["b", teamB], ["c", teamC]] as const) {
  const agent = await svc.createAgent({
    team_id: team.team_id, owner_user_id: users[user].user_id, name: `agent-${user}`, visibility: "team", status: "active",
  });
  agents_[user] = agent.agent_id;
}

// Pool state of the old build: one claude pool and one codex pool. A pooled client lives only in
// its pool row, not in the default group. The global threshold is not the default 95.
await svc.updateSubscriptionPoolSettings(90);
await svc.enableSubscriptionPool("claude", agents);
await svc.enableSubscriptionPool("codex", agents);
await svc.updateClientSources({ agent: "claude-code", sources: ["sub-claude"] }, agents);
await svc.updateClientSources({ agent: "codex", sources: ["sub-openai"] }, agents);

const groups = await store.listInstanceUpstreamGroups(undefined, agents);
const claudeGroup = groups.find((g: any) => g.mode === "subscription_pool" && g.name.includes("claude"));
const codexGroup = groups.find((g: any) => g.mode === "subscription_pool" && g.name.includes("codex"));
if (!claudeGroup || !codexGroup) throw new Error("pool groups missing");
const expires = Date.now() + 30 * 24 * 3600 * 1000;
const accounts: Record<string, { account_id: string; token: string }> = {};
async function addAccount(key: string, group: any, provider: string, n: number) {
  const token = `tok-fake-${key}`;
  const { account } = await store.upsertSubscriptionAccountByProviderId({
    group_id: group.group_id,
    provider,
    provider_account_id: `prov-${key}`,
    display_name: `Old ${provider} ${n}`,
    access_token: token,
    refresh_token: `refresh-fake-${key}`,
    token_expires_at: expires,
  });
  accounts[key] = { account_id: account.account_id, token };
}
await addAccount("claude-A1", claudeGroup, "claude", 1);
await addAccount("claude-A2", claudeGroup, "claude", 2);
await addAccount("codex-A1", codexGroup, "codex", 1);

const after = await store.listInstanceUpstreamGroups(undefined, agents);
const summary = {
  admin,
  users,
  teams: { A: teamA.team_id, B: teamB.team_id, C: teamC.team_id },
  agents: agents_,
  groups: after.map((g: any) => ({ group_id: g.group_id, type: g.group_type, mode: g.mode, name: g.name, agents: g.agents, source_name: g.source_name })),
  accounts,
  globalThreshold: 90,
};
await store.close();

// Shape of the data: the old build has no team_id and no threshold_pct on the pool tables.
let shape: Record<string, unknown>;
if (mongoUri) {
  const { MongoClient } = createRequire(path.join(root, "package.json"))("mongodb");
  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(`${mongoPrefix}_default`);
  const groups = await db.collection("meta_instance_upstream_config").find({}).toArray();
  const accountDocs = await db.collection("meta_upstream_subscription_account").find({}).toArray();
  const indexes = (await db.collection("meta_instance_upstream_config").indexes()).map((i: any) => i.name);
  shape = {
    groupHasTeamId: groups.some((g: any) => "team_id" in g),
    accountHasThreshold: accountDocs.some((a: any) => "threshold_pct" in a),
    oldSourceIndex: indexes.includes("ux_source_name"),
    newSourceIndex: indexes.some((n: string) => n.includes("team_source_name")),
    indexes,
  };
  await client.close();
} else {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const raw = new DatabaseSync(dbPath);
  raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const cols = (t: string) => (raw.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name);
  const indexes = (raw.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as any[]).map((i) => i.name);
  shape = {
    groupHasTeamId: cols("meta_instance_upstream_config").includes("team_id"),
    accountHasThreshold: cols("meta_upstream_subscription_account").includes("threshold_pct"),
    oldSourceIndex: indexes.includes("ux_iuc_source_name"),
    newSourceIndex: indexes.includes("ux_iuc_team_source_name"),
    quickCheck: (raw.prepare("PRAGMA quick_check").get() as any).quick_check,
  };
  raw.close();
}
if (shape.groupHasTeamId || shape.accountHasThreshold || !shape.oldSourceIndex || shape.newSourceIndex) {
  throw new Error(`fixture is not in the old shape: ${JSON.stringify(shape)}`);
}
const sha256 = mongoUri ? "" : createHash("sha256").update(fs.readFileSync(dbPath)).digest("hex");
fs.writeFileSync(path.join(out, "fixture.json"), JSON.stringify({ ...summary, shape, sha256 }, null, 2));
console.log(JSON.stringify({ shape, sha256, groups: summary.groups }, null, 2));
