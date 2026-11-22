/**
 * Fake provider and fake normal upstream for the local check. One process, two listeners.
 *
 *   provider  (E2E_PROVIDER_PORT)  answers the provider hosts that `redirect-fetch.mjs` rewrites:
 *                                  usage, models, profile and the pool inference calls.
 *   normal    (E2E_NORMAL_PORT)    answers the shared normal upstream of a client.
 *
 * Both record each call (path, bearer token, model) at `GET /__log?since=N`.
 * `POST /__control/usage {token, five_hour, seven_day, five_reset, week_reset}` sets the usage that
 * the provider shows for one account token. `POST /__control/fail {token, status}` makes the
 * inference calls of one token fail (status 0 clears it).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, "../../../src/subscription-pool/providers/fixtures");
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(fixtureDir, name), "utf8"));
const claudeModels = readFixture("claude-models.json");
const codexModels = readFixture("codex-models.json");
const codexUsage = readFixture("codex-usage-prolite.json");
const codexCredits = readFixture("codex-reset-credits.json");

const providerPort = Number(process.env.E2E_PROVIDER_PORT);
const normalPort = Number(process.env.E2E_NORMAL_PORT);
if (!providerPort || !normalPort) throw new Error("E2E_PROVIDER_PORT and E2E_NORMAL_PORT are required");

const log = [];
const usage = new Map();
const failing = new Map();
const hours = (n) => new Date(Date.now() + n * 3600_000).toISOString();

function bearer(req) {
  const auth = String(req.headers.authorization ?? "");
  return auth.startsWith("Bearer ") ? auth.slice(7) : String(req.headers["x-api-key"] ?? "");
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}
function modelOf(body) {
  try { return JSON.parse(body).model ?? ""; } catch { return ""; }
}
function claudeReply(text, model) {
  return {
    id: "msg_fake", type: "message", role: "assistant", model: model || "claude-fake",
    content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}
function responsesReply(text, model) {
  return {
    id: "resp_fake", object: "response", status: "completed", model: model || "gpt-fake",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

async function control(req, res, url) {
  if (url.pathname === "/__log") {
    const since = Number(url.searchParams.get("since") ?? 0);
    return json(res, 200, { total: log.length, entries: log.slice(since) });
  }
  if (req.method === "POST" && url.pathname === "/__control/usage") {
    const b = JSON.parse(await readBody(req));
    usage.set(b.token, b);
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/__control/fail") {
    const b = JSON.parse(await readBody(req));
    if (b.status) failing.set(b.token, b.status); else failing.delete(b.token);
    return json(res, 200, { ok: true });
  }
  return null;
}

const provider = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://fake");
  if ((await control(req, res, url)) !== null) return;
  const [, host, ...rest] = url.pathname.split("/");
  const p = `/${rest.join("/")}`;
  const token = bearer(req);
  const body = req.method === "POST" ? await readBody(req) : "";
  const entry = { server: "provider", method: req.method, host, path: p, token, model: modelOf(body), at: Date.now() };
  log.push(entry);

  if (host === "api.anthropic.com" && p === "/api/oauth/usage") {
    const u = usage.get(token) ?? {};
    return json(res, 200, {
      five_hour: { utilization: u.five_hour ?? 10, resets_at: u.five_reset ?? hours(4) },
      seven_day: { utilization: u.seven_day ?? 10, resets_at: u.week_reset ?? hours(100) },
      cedar_ember: { eligible: false, ineligible_reason: "surface", grants: [] },
    });
  }
  if (host === "api.anthropic.com" && p === "/api/oauth/profile") {
    return json(res, 200, { account: { uuid: `uuid-${token}`, email: `${token}@example.invalid` }, organization: { uuid: "org-fake", organization_type: "claude_pro" } });
  }
  if (host === "api.anthropic.com" && p === "/v1/models") {
    // A token gives one extra model that only its own pool has, so a model list shows which pool made it.
    const owner = /claude-A\d|^tok-fake-a\d/.test(token) ? "a" : /^tok-fake-b\d/.test(token) ? "b" : "";
    const data = owner ? [...claudeModels.data, { type: "model", id: `claude-${owner}-only`, display_name: `Claude ${owner} only`, created_at: "2026-01-01T00:00:00Z" }] : claudeModels.data;
    return json(res, 200, { ...claudeModels, data, has_more: false });
  }
  if (host === "api.anthropic.com" && p.startsWith("/v1/messages")) {
    if (failing.get(token)) return json(res, failing.get(token), { type: "error", error: { type: "api_error", message: "fake failure" } });
    if (p.endsWith("/count_tokens")) return json(res, 200, { input_tokens: 1 });
    return json(res, 200, claudeReply(`fake-provider:${token}`, entry.model));
  }
  if (host === "chatgpt.com" && p === "/backend-api/wham/usage") {
    const u = usage.get(token) ?? {};
    const copy = structuredClone(codexUsage);
    copy.rate_limit.primary_window.used_percent = u.five_hour ?? 10;
    // The fixture's reset_at is a fixed date; keep the window in the future so the selector does not treat it as reset.
    copy.rate_limit.primary_window.reset_at = Math.floor(Date.parse(u.five_reset ?? hours(4)) / 1000);
    return json(res, 200, copy);
  }
  if (host === "chatgpt.com" && p === "/backend-api/wham/rate-limit-reset-credits") return json(res, 200, codexCredits);
  if (host === "chatgpt.com" && p === "/backend-api/codex/models") return json(res, 200, codexModels);
  if (host === "chatgpt.com" && p.startsWith("/backend-api/codex/responses")) {
    if (failing.get(token)) return json(res, failing.get(token), { error: { message: "fake failure" } });
    let streamed = false;
    try { streamed = JSON.parse(body).stream === true; } catch { /* not JSON */ }
    if (streamed) {
      const done = { type: "response.completed", response: { id: "resp_fake", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } };
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end(`event: response.completed\ndata: ${JSON.stringify(done)}\n\n`);
    }
    return json(res, 200, responsesReply(`fake-provider:${token}`, entry.model));
  }
  if (p.endsWith("/oauth/token")) {
    const b = JSON.parse(body || "{}");
    // A login code `x` gives the account token `tok-fake-x`. A refresh is never needed in the check.
    if (b.grant_type === "authorization_code") {
      return json(res, 200, {
        access_token: `tok-fake-${b.code}`, refresh_token: `refresh-fake-${b.code}`, expires_in: 30 * 24 * 3600,
        account: { uuid: `uuid-${b.code}`, email_address: `${b.code}@example.invalid` }, organization: { organization_type: "claude_pro" },
      });
    }
  }
  if (p.endsWith("/oauth/token")) return json(res, 400, { error: "invalid_grant", error_description: "fake provider does not refresh" });
  return json(res, 404, { error: "fake provider has no route", host, path: p });
});

const normal = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://fake");
  if ((await control(req, res, url)) !== null) return;
  const body = req.method === "POST" ? await readBody(req) : "";
  log.push({ server: "normal", method: req.method, path: url.pathname, token: bearer(req), model: modelOf(body), at: Date.now() });
  if (url.pathname.endsWith("/messages")) return json(res, 200, claudeReply("fake-normal", modelOf(body)));
  if (url.pathname.endsWith("/responses")) return json(res, 200, responsesReply("fake-normal", modelOf(body)));
  if (url.pathname.endsWith("/chat/completions")) {
    return json(res, 200, { id: "cmpl", object: "chat.completion", model: modelOf(body), choices: [{ index: 0, message: { role: "assistant", content: "fake-normal" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }
  if (url.pathname.endsWith("/models")) return json(res, 200, { object: "list", data: [] });
  return json(res, 404, { error: "fake normal upstream has no route", path: url.pathname });
});

await new Promise((r) => provider.listen(providerPort, "127.0.0.1", r));
await new Promise((r) => normal.listen(normalPort, "127.0.0.1", r));
console.log(`FAKES_READY provider=${providerPort} normal=${normalPort} pid=${process.pid}`);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { provider.close(); normal.close(); process.exit(0); });
