/**
 * Preload for the Core and Proxy processes of the local check (`node --import`).
 *
 * Calls to a provider host go to the local fake instead. Every other host that is not loopback is
 * refused and written to the blocked-host log, so no request of the check can leave the machine.
 *
 * Env: E2E_PROVIDER_FAKE (base URL of the fake), E2E_BLOCKED_LOG (file for refused hosts).
 */
import fs from "node:fs";

const fake = process.env.E2E_PROVIDER_FAKE;
const blockedLog = process.env.E2E_BLOCKED_LOG;
if (!fake) throw new Error("E2E_PROVIDER_FAKE is required");

const PROVIDER_HOSTS = new Set([
  "api.anthropic.com",
  "platform.claude.com",
  "claude.com",
  "chatgpt.com",
  "auth.openai.com",
  "daily-cloudcode-pa.googleapis.com",
]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const original = globalThis.fetch;

function record(entry) {
  if (blockedLog) fs.appendFileSync(blockedLog, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
}

globalThis.fetch = async function guardedFetch(input, init) {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw);
  if (LOOPBACK.has(url.hostname)) return original(input, init);
  if (PROVIDER_HOSTS.has(url.hostname)) {
    const target = `${fake}/${url.hostname}${url.pathname}${url.search}`;
    record({ action: "redirected", host: url.hostname, path: url.pathname });
    return original(input instanceof Request ? new Request(target, input) : target, init);
  }
  record({ action: "blocked", host: url.hostname, path: url.pathname });
  throw new Error(`e2e guard: outbound host not allowed: ${url.hostname}`);
};
