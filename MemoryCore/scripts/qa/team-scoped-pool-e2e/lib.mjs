/**
 * Shared helpers of the local two-team check: tracked processes, port guard, Core and fake clients,
 * read-only database access and a small check recorder. No network call leaves the machine: the
 * Core and Proxy processes start with `redirect-fetch.mjs`.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MEMORY_ROOT = path.resolve(HERE, "../../../..");
export const CORE_ROOT = path.join(MEMORY_ROOT, "MemoryCore");
export const PROXY_ROOT = path.join(MEMORY_ROOT, "MemoryProxy");
// The Proxy refuses every Node major but 22, so the runner must run on 22 and starts its children with the same binary.
export const NODE22 = process.execPath;
if (!process.version.startsWith("v22.")) throw new Error(`run this check with Node 22 (now ${process.version}); the Proxy refuses other majors`);
export const PORTS = { core: 18420, proxy: 18096, provider: 18500, normal: 18501, mongo: 18017 };
export const GATEWAY_KEY = "e2e-gw-key";
export const CORE_URL = `http://127.0.0.1:${PORTS.core}`;
export const PROXY_URL = `http://127.0.0.1:${PORTS.proxy}`;
export const PROVIDER_URL = `http://127.0.0.1:${PORTS.provider}`;
export const NORMAL_URL = `http://127.0.0.1:${PORTS.normal}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Tracked processes ────────────────────────────────────────────────────────────────────────

export const registry = [];

/** True when something listens on the port. */
export function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

/** Refuses to start when a port has an owner. It never kills a process it did not start. */
export async function assertPortsFree(ports) {
  const busy = [];
  for (const port of ports) if (await portInUse(port)) busy.push(port);
  if (busy.length) throw new Error(`ports in use, stop their owners first (lsof -nP -iTCP:<port> -sTCP:LISTEN): ${busy.join(",")}`);
}

export function startProcess({ name, command, args, env = {}, cwd, logFile, port }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, "a");
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", out, out], detached: false });
  const entry = { name, command: [command, ...args].join(" "), pid: child.pid, port: port ?? null, logFile, startedAt: new Date().toISOString(), stoppedAt: null, exit: null };
  child.on("exit", (code, signal) => { entry.exit = signal ?? code; entry.stoppedAt = new Date().toISOString(); });
  entry.child = child;
  registry.push(entry);
  return entry;
}

export async function stopProcess(entry, timeoutMs = 15000) {
  if (!entry || entry.stoppedAt) return;
  entry.child.kill("SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (!entry.stoppedAt && Date.now() < deadline) await sleep(100);
  if (!entry.stoppedAt) {
    entry.child.kill("SIGKILL");
    entry.signalUsed = "SIGKILL";
    while (!entry.stoppedAt) await sleep(50);
  }
}

export async function stopAll() {
  for (const entry of [...registry].reverse()) await stopProcess(entry);
}

export async function waitHttp(url, { timeoutMs = 60000, ok = (r) => r.status < 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (ok(res)) return;
      last = `status ${res.status}`;
    } catch (e) { last = String(e.message ?? e); }
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${url}: ${last}`);
}

// ── Process recipes ──────────────────────────────────────────────────────────────────────────

export function startFakes(work) {
  return startProcess({
    name: "fakes", command: NODE22, args: [path.join(HERE, "fake-upstreams.mjs")], port: `${PORTS.provider},${PORTS.normal}`,
    env: { E2E_PROVIDER_PORT: String(PORTS.provider), E2E_NORMAL_PORT: String(PORTS.normal) }, logFile: path.join(work, "fakes.log"),
  });
}

export function startCore({ work, dataDir, label, env = {} }) {
  return startProcess({
    name: `core:${label}`, command: NODE22, port: PORTS.core, cwd: CORE_ROOT,
    args: ["--import", path.join(HERE, "redirect-fetch.mjs"), "--import", "tsx", path.join(HERE, "core-launcher.ts")],
    env: {
      HOME: path.join(work, "home"), CORE_ROOT, E2E_CORE_PORT: String(PORTS.core), E2E_DATA_DIR: dataDir, E2E_GATEWAY_KEY: GATEWAY_KEY,
      E2E_PROVIDER_FAKE: PROVIDER_URL, E2E_BLOCKED_LOG: path.join(work, "blocked-hosts.log"), ...env,
    },
    logFile: path.join(work, `core-${label}.log`),
  });
}

export function writeProxyConfig(work) {
  const file = path.join(work, "proxy.yaml");
  fs.writeFileSync(file, `server:
  host: 127.0.0.1
  port: ${PORTS.proxy}
upstream:
  url: ${NORMAL_URL}/v1
  apiKey: ""
log:
  file: ${path.join(work, "proxy-usage-logs")}
  level: info
  backend: console
redis:
  enabled: false
storage:
  enabled: true
  backend: memory
  fs:
    fsRoot: ${path.join(work, "proxy-state")}
auth:
  enabled: true
  url: ${CORE_URL}
  apiKey: ${GATEWAY_KEY}
coreSkill:
  endpoint: ${CORE_URL}
  serviceToken: ${GATEWAY_KEY}
sessionInit:
  enabled: true
modelSources:
  enabled: true
creditReport:
  url: ${NORMAL_URL}/credit
`);
  return file;
}

export function startProxy({ work }) {
  return startProcess({
    name: "proxy", command: NODE22, port: PORTS.proxy, cwd: PROXY_ROOT,
    args: ["--import", path.join(HERE, "redirect-fetch.mjs"), "--import", "tsx/esm", "src/index.ts", "--config", writeProxyConfig(work)],
    env: { HOME: path.join(work, "home"), E2E_PROVIDER_FAKE: PROVIDER_URL, E2E_BLOCKED_LOG: path.join(work, "blocked-hosts.log") },
    logFile: path.join(work, "proxy.log"),
  });
}

// ── Clients ──────────────────────────────────────────────────────────────────────────────────

/** Core call as one user (the Hub forwards a Panel call to Core with the same headers). */
export async function core(route, body = {}, userKey) {
  const headers = { "content-type": "application/json", authorization: `Bearer ${GATEWAY_KEY}`, "x-tdai-service-id": "default" };
  if (userKey) headers["x-tdai-user-key"] = userKey;
  const res = await fetch(`${CORE_URL}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json, text, code: json?.code, data: json?.data, reason: json?.data?.reason ?? json?.reason ?? json?.message };
}

export async function fakeLog(since = 0) {
  const res = await fetch(`${PROVIDER_URL}/__log?since=${since}`);
  return res.json();
}
export async function fakeMark() { return (await fakeLog(999999999)).total; }
export async function normalLog(since = 0) {
  const res = await fetch(`${NORMAL_URL}/__log?since=${since}`);
  return res.json();
}
export async function setUsage(token, usage) {
  await fetch(`${PROVIDER_URL}/__control/usage`, { method: "POST", body: JSON.stringify({ token, ...usage }) });
}

// ── Read-only database ───────────────────────────────────────────────────────────────────────

export function dbPathOf(dataDir) { return path.join(dataDir, "metadata", "tdai_metadata_default", "metadata.db"); }

export function dbQuery(dataDir, sql, params = []) {
  const db = new DatabaseSync(dbPathOf(dataDir), { readOnly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}

export function dbExec(dbFile, sql, params = []) {
  const db = new DatabaseSync(dbFile);
  try { return db.prepare(sql).run(...params); } finally { db.close(); }
}

// ── Check recorder ───────────────────────────────────────────────────────────────────────────

export const results = [];

/**
 * Turns whose account belongs to a team that the user may not use at that moment. A retry loop can
 * hide a wrong turn, so the turn helpers record it here and the check fails when it is not empty.
 */
export const violations = [];

export async function check(id, title, fn) {
  const startedAt = Date.now();
  try {
    const evidence = await fn();
    if (violations.length) {
      const found = violations.splice(0).join("; ");
      throw new Error(`a turn used an account of a team that the user may not use: ${found}`);
    }
    results.push({ id, title, result: "PASS", evidence: evidence ?? "", ms: Date.now() - startedAt });
    console.log(`PASS ${id} ${title}\n     ${String(evidence ?? "").split("\n").join("\n     ")}`);
  } catch (e) {
    violations.length = 0;
    results.push({ id, title, result: "FAIL", evidence: String(e.stack ?? e).split("\n").slice(0, 6).join("\n"), ms: Date.now() - startedAt });
    console.log(`FAIL ${id} ${title}\n     ${String(e.message ?? e)}`);
  }
}

export function skip(id, title, reason) {
  results.push({ id, title, result: "NOT RUN", evidence: reason, ms: 0 });
  console.log(`NOT RUN ${id} ${title}\n     ${reason}`);
}

export function assert(cond, message) { if (!cond) throw new Error(message); }
export function eq(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export async function waitFor(label, fn, { timeoutMs = 90000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
      last = "condition false";
    } catch (e) { last = e.message; }
    await sleep(intervalMs);
  }
  throw new Error(`timeout (${timeoutMs} ms) waiting for ${label}: ${last}`);
}

export function copyFixture(fixtureDir, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(fixtureDir, dest, { recursive: true });
  const walk = (p) => { fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o755 : 0o644); if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f)); };
  walk(dest);
}
