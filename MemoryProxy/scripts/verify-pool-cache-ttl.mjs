#!/usr/bin/env node
/**
 * Live check of the prompt cache TTL on a Subscription Pool route. Not a CI test.
 *
 * It sends a Claude-Code-like /v1/messages request through the proxy. The system
 * prompt has a long fixed block (about 6,000 tokens) with
 * `cache_control: {type: "ephemeral"}` and no ttl, as Claude Code sends it.
 * With `subscriptionPool.promptCacheTtl: "1h"` the proxy adds `ttl: "1h"`, so the
 * write shows in `usage.cache_creation.ephemeral_1h_input_tokens`.
 *
 * Usage:
 *   ANTHROPIC_BASE_URL=http://host:8096/claude-code/<spaceId> \
 *   ANTHROPIC_AUTH_TOKEN=<proxy user key> \
 *   node scripts/verify-pool-cache-ttl.mjs [--wait-seconds 420] [--model claude-opus-5-5] [--session-id <id>]
 *
 * Optional env: ANTHROPIC_CUSTOM_HEADERS ("Name: value" lines, as Claude Code reads it).
 *
 * Request shape. The proxy classifies Claude Code requests by shape
 * (src/common/cc-request-classifier.ts). This request has its cache marker only in
 * `system`, no tools and `thinking: {type: "disabled"}`, so it is a "sidequery":
 * no session form, no hook gate, no memory injection and no L0 write. The pool
 * still serves it. The system prompt starts with the Claude Code identity line,
 * because a subscription account rejects other requests with a 429.
 *
 * Account choice. A sidequery does not create a session binding. Without a bound
 * session the pool picks an account by round robin, and other users can move the
 * cursor during the wait. A different account has a different cache, so the second
 * request misses for a reason that is not the TTL. The script prints the
 * `anthropic-organization-id` response header of both requests and reports
 * INCONCLUSIVE when it changes. Pass `--session-id` with the id of a live Claude
 * Code session to reuse its binding. A pool with one account has no such problem.
 *
 * Each run puts a new run id at the start of the cached block, so an earlier run
 * cannot give a cache read on the first request.
 */

import { randomUUID } from "node:crypto";

const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

function parseArgs(argv) {
  const args = { waitSeconds: null, model: "claude-opus-5-5", sessionId: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--wait-seconds") {
      const n = Number(next);
      if (!Number.isFinite(n) || n < 0) throw new Error("--wait-seconds needs a number >= 0");
      args.waitSeconds = n;
      i++;
    } else if (arg === "--model") {
      if (!next) throw new Error("--model needs a value");
      args.model = next;
      i++;
    } else if (arg === "--session-id") {
      if (!next) throw new Error("--session-id needs a value");
      args.sessionId = next;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      console.log("node scripts/verify-pool-cache-ttl.mjs [--wait-seconds N] [--model ID] [--session-id ID]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function customHeaders() {
  const out = {};
  for (const line of (process.env.ANTHROPIC_CUSTOM_HEADERS ?? "").split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (name && value) out[name] = value;
  }
  return out;
}

/** About 6,000 tokens of fixed text. The run id makes the prefix new for each run. */
function cachedBlockText(runId) {
  const lines = [`Cache TTL check, run ${runId}. Read the reference lines below. They do not change.`];
  for (let i = 1; i <= 240; i++) {
    const n = String(i).padStart(4, "0");
    lines.push(`Reference line ${n}: the proxy keeps this text the same, so the prompt cache can store it (item ${n}).`);
  }
  return lines.join("\n");
}

function buildBody(model, runId) {
  return {
    model,
    max_tokens: 16,
    stream: false,
    thinking: { type: "disabled" },
    system: [
      { type: "text", text: CLAUDE_CODE_IDENTITY },
      { type: "text", text: cachedBlockText(runId), cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: "Reply with the word OK." }],
  };
}

async function send(url, headers, body) {
  const started = Date.now();
  const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON: the raw text is printed below.
  }
  if (!resp.ok || !json || typeof json.usage !== "object") {
    throw new Error(`request failed: HTTP ${resp.status} ${text.slice(0, 500)}`);
  }
  return {
    ms: Date.now() - started,
    status: resp.status,
    usage: json.usage,
    organization: resp.headers.get("anthropic-organization-id"),
    requestId: resp.headers.get("request-id") ?? resp.headers.get("x-request-id"),
  };
}

function summary(label, result) {
  const u = result.usage;
  const cc = u.cache_creation ?? {};
  return {
    request: label,
    http: result.status,
    ms: result.ms,
    organization: result.organization ?? "(not returned)",
    request_id: result.requestId ?? "(not returned)",
    input_tokens: u.input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    ephemeral_5m_input_tokens: cc.ephemeral_5m_input_tokens ?? 0,
    ephemeral_1h_input_tokens: cc.ephemeral_1h_input_tokens ?? 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = (process.env.ANTHROPIC_BASE_URL ?? "").replace(/\/+$/, "");
  const token = process.env.ANTHROPIC_AUTH_TOKEN ?? "";
  if (!base) throw new Error("ANTHROPIC_BASE_URL is not set");
  if (!token) throw new Error("ANTHROPIC_AUTH_TOKEN is not set");

  const url = `${base}/v1/messages`;
  const runId = `${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;
  const sessionId = args.sessionId ?? randomUUID();
  const headers = {
    ...customHeaders(),
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "user-agent": "claude-cli/2.1.303 (external, sdk-cli)",
    "x-claude-code-session-id": sessionId,
    authorization: `Bearer ${token}`,
  };
  const body = buildBody(args.model, runId);

  console.log(`url=${url} model=${args.model} run=${runId} session=${sessionId}${args.sessionId ? " (given)" : " (new)"}`);
  const first = summary("1", await send(url, headers, body));
  console.log(JSON.stringify(first));
  if (first.ephemeral_1h_input_tokens > 0) console.log("request 1: write used the 1h TTL");
  else if (first.cache_creation_input_tokens > 0) console.log("request 1: write used the 5m TTL (flag off, or not a subscription account)");
  else console.log("request 1: no cache write (prefix was already cached, or caching did not apply)");

  if (args.waitSeconds === null) return;

  console.log(`waiting ${args.waitSeconds}s ...`);
  await new Promise((resolve) => setTimeout(resolve, args.waitSeconds * 1000));
  const second = summary("2", await send(url, headers, body));
  console.log(JSON.stringify(second));

  const written = first.cache_creation_input_tokens;
  const read = second.cache_read_input_tokens;
  if (first.organization && second.organization && first.organization !== second.organization) {
    console.log(`INCONCLUSIVE: the requests used different accounts (${first.organization} -> ${second.organization}); use --session-id`);
    process.exitCode = 2;
    return;
  }
  if (written <= 0) {
    console.log("FAIL: request 1 wrote nothing to the cache, so there is nothing to compare");
    process.exitCode = 1;
    return;
  }
  const ok = read >= 0.9 * written;
  console.log(`${ok ? "PASS" : "FAIL"}: request 2 read ${read} of ${written} written tokens after ${args.waitSeconds}s (needs >= 90%)`);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
