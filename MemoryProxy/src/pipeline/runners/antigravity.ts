/**
 * AntiGravity (agy) runner: serves the Gemini API that `agy` calls through its gateway setting and
 * forwards it to Google Cloud Code with the token of a subscription pool account.
 *
 *   GET  /antigravity/<space>[/analyse]/<key>/v1/models
 *   GET  /antigravity/<space>[/analyse]/<key>/v1beta/models
 *   POST /antigravity/<space>[/analyse]/<key>/v1beta/models/<model>:streamGenerateContent | :generateContent
 *   Any of them also accepts `/memory-off` after the key: no hook gate, session init or L0 write.
 *
 * agy sends no auth header, so the user key is a path segment. It is read here, checked like the
 * key of every other agent, and never leaves this file: logs, traces and upstream calls only see
 * `maskKeyedPath()` output.
 *
 * The request body is sent as agy built it. The one change is the Cloud Code envelope
 * `{model, project, request, requestType, userAgent, requestId}`; the response is unwrapped
 * (`{"response": X}` becomes `X`) line by line, so streaming stays live. The effort level that agy
 * moves out of the model name (`generationConfig.thinkingConfig.thinkingLevel`) is put back as a
 * `-<level>` suffix, because Cloud Code model ids keep it.
 *
 * Memory: the conversation id is `labels.cascade_id`, the same id the agy hooks report as
 * `conversationId`. The session is registered under it, the hook gate runs before anything is
 * forwarded, and the L0 row is written from the request and the unwrapped answer (no skill
 * extraction: the Gemini content shape has no skill-round support).
 */

import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";
import { verifyUserKey } from "../../auth.js";
import { apiKeyToKeyId, uuidv7 } from "../../opik.js";
import { writeLog } from "../../logger.js";
import { shouldSkipRequestHeader, preserveRequestQuery, filterResponseHeaders } from "../../common/constants.js";
import { extractUserQueryText } from "../../common/user-query-extractor.js";
import { getInstanceUpstreamConfigs, resolveForAgent, type InstanceUpstreamRow } from "../../instance-upstream-cache.js";
import {
  immediateTeamError, resolveRequestTeam, settleRequestTeam, teamIdOf, type RequestTeamError,
} from "../../subscription-pool/pool-team.js";
import { buildPoolExhaustedResponse, buildPoolUnavailableResponse } from "../../subscription-pool/exhausted-response.js";
import { isExtractionAllowed, logExtractionSkipped } from "../../extraction-gate.js";
import { withSessionProject } from "../../project-scope/session-workspace.js";
import { resolveProxyOrigin, SESSION_ID_RE } from "../../session/hook-gate-core.js";
import { runAntigravityHookGate } from "../../session/antigravity/hook-gate.js";
import { isAgySystemNotice, userRequestText } from "../../session/antigravity/user-request.js";
import { contentsToMessages, sessionInitResponse, stripSessionInitTurns } from "../../session/antigravity/session-init-text.js";
import { ANTIGRAVITY_BASE_URL, openPoolRequest, type PoolAuth } from "../../subscription-pool/pool-request.js";
import { buildTdaiClientForRequest } from "../../tdai/client.js";
import { deriveTdaiIdentity } from "../../tdai/identity.js";
import { stripAgentMessages, recordTdaiTurn } from "../../tdai/recorder.js";
import { trackWrite, withL0Retry } from "../../tdai/pending-writes.js";
import type { TdaiMessage } from "../../tdai/types.js";
import { stageAssetCapabilities } from "../stages/asset-capabilities.js";
import { stageSessionInitOrchestrate } from "../stages/session-init-orchestrate.js";

const TAG = "[antigravity]";
const AGENT = "antigravity";
const MASK = "***";

// ── Constants ────────────────────────────────────────────────────────────────

function osType(): string {
  return process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
}

/**
 * User agent that Cloud Code accepts from the AntiGravity client. Older client strings are
 * answered with UNSUPPORTED_CLIENT, so keep this in step with the agy version that was tested.
 */
export const ANTIGRAVITY_USER_AGENT =
  `antigravity/cli/1.5.13 (aidev_client; os_type=${osType()}; arch=${process.arch === "arm64" ? "arm64" : "amd64"}; ` +
  "cl=1025641825; auth_method=consumer)";

/** Model ids that Cloud Code lists but a coding client cannot use. */
const NOISE_MODEL_RE = /^(?:chat_|tab_)|-(?:disabled|tiered|sonar)$|image/i;

// ── Path ─────────────────────────────────────────────────────────────────────

export type AntigravityRoute =
  | { kind: "models-openai" | "models-gemini"; spaceId: string; accessKey: string; memoryOff: boolean }
  | { kind: "stream" | "generate"; spaceId: string; accessKey: string; memoryOff: boolean; model: string };

/**
 * An optional `/memory-off` segment after the key (`<proxy>/antigravity/<space>[/analyse]/<key>/memory-off`)
 * is the URL form of the `x-memory-mode: off` header, for agy, which cannot send headers. It is
 * matched as a whole segment, so a key that only contains the text is not affected.
 */
const PATH_RE = /^\/antigravity\/([^/]+)(?:\/analyse)?\/([^/]+)(\/memory-off)?\/(v1\/models|v1beta\/models(?:\/([^/]+))?)\/?$/;

/** Parse an agy request path. Null for any other path. */
export function parseAntigravityPath(path: string): AntigravityRoute | null {
  const match = PATH_RE.exec(path.split("?", 1)[0] ?? "");
  if (!match) return null;
  const [, spaceId, accessKey, memoryOffSegment, tail, rawModel] =
    match as unknown as [string, string, string, string | undefined, string, string | undefined];
  const memoryOff = memoryOffSegment !== undefined;
  if (tail === "v1/models") return { kind: "models-openai", spaceId, accessKey, memoryOff };
  if (!rawModel) return { kind: "models-gemini", spaceId, accessKey, memoryOff };
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawModel);
  } catch {
    return null;
  }
  const split = /^([^:]+):(streamGenerateContent|generateContent)$/.exec(decoded);
  if (!split) return null;
  return { kind: split[2] === "streamGenerateContent" ? "stream" : "generate", spaceId, accessKey, memoryOff, model: split[1]! };
}

/** The path with the user key replaced. Use this, never the raw path, wherever a path is logged. */
export function maskKeyedPath(path: string): string {
  return path.replace(/^(\/antigravity\/[^/]+(?:\/analyse)?\/)[^/?]+/, `$1${MASK}`);
}

// ── Envelope ─────────────────────────────────────────────────────────────────

/**
 * Model id for Cloud Code. agy removes the `-low|-medium|-high` suffix and sends the level as
 * `thinkingLevel`; without the suffix Google answers 404.
 */
/** Cloud Code model ids use `-low|-medium|-high`; other thinking levels stay in the request body only. */
const CLOUD_CODE_THINKING_SUFFIXES = new Set(["low", "medium", "high"]);

export function upstreamModelFor(model: string, body: Record<string, unknown>): string {
  const config = body.generationConfig as { thinkingConfig?: { thinkingLevel?: unknown } } | undefined;
  const raw = config?.thinkingConfig?.thinkingLevel;
  const level = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!level || !CLOUD_CODE_THINKING_SUFFIXES.has(level) || model.endsWith(`-${level}`)) return model;
  return `${model}-${level}`;
}

export function wrapEnvelope(
  model: string,
  project: string,
  request: Record<string, unknown>,
  requestId: string = `agent-${randomUUID()}`,
): Record<string, unknown> {
  return { model, project, request, requestType: "agent", userAgent: "antigravity", requestId };
}

/** Text of the visible (not `thought`) parts of one Gemini response. */
function responseText(response: unknown): string {
  const candidates = (response as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(candidates)) return "";
  const parts = (candidates[0] as { content?: { parts?: unknown } } | undefined)?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part: { text?: unknown; thought?: unknown }) => (part && part.thought !== true && typeof part.text === "string" ? part.text : ""))
    .join("");
}

/**
 * Rewrite one SSE line: `data: {"response": X, ...}` becomes `data: X`. Every other line is
 * returned unchanged. `text` is the visible answer text of the line.
 */
export function unwrapSseLine(line: string): { line: string; text: string } {
  const trimmed = line.replace(/\r?\n$/, "").replace(/\r$/, "");
  if (!trimmed.startsWith("data:")) return { line: trimmed, text: "" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(5).trim());
  } catch {
    return { line: trimmed, text: "" };
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "response" in parsed) {
    const inner = (parsed as { response: unknown }).response;
    return { line: `data: ${JSON.stringify(inner)}`, text: responseText(inner) };
  }
  return { line: trimmed, text: responseText(parsed) };
}

/**
 * Streaming unwrapper. Chunks can end inside a line or inside a multi-byte character, so bytes go
 * through a streaming decoder and only complete lines are rewritten. `onDone` gets the visible
 * answer text when the stream ends.
 */
export function createSseUnwrapStream(onDone?: (text: string) => void): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let carry = "";
  let text = "";
  const emit = (controller: TransformStreamDefaultController<Uint8Array>, line: string) => {
    const out = unwrapSseLine(line);
    text += out.text;
    controller.enqueue(encoder.encode(`${out.line}\n`));
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      carry += decoder.decode(chunk, { stream: true });
      let index = carry.indexOf("\n");
      while (index >= 0) {
        emit(controller, carry.slice(0, index));
        carry = carry.slice(index + 1);
        index = carry.indexOf("\n");
      }
    },
    flush(controller) {
      carry += decoder.decode();
      if (carry) emit(controller, carry);
      onDone?.(text);
    },
  });
}

// ── Model list ───────────────────────────────────────────────────────────────

export function isUsableModelId(id: string): boolean {
  return id !== "" && !NOISE_MODEL_RE.test(id);
}

/** Models of a `fetchAvailableModels` answer: `models` is an object keyed by id, or an array. */
export function modelsFromUpstream(payload: unknown): Array<{ id: string; displayName: string }> {
  const models = (payload as { models?: unknown } | null)?.models;
  type Entry = { displayName?: unknown; isInternal?: unknown } | undefined;
  const entries: Array<[unknown, Entry]> = Array.isArray(models)
    ? (models as Array<{ model?: unknown; name?: unknown; displayName?: unknown; isInternal?: unknown }>).map((m) => [
        typeof m?.model === "string" ? m.model : typeof m?.name === "string" ? m.name.replace(/^models\//, "") : undefined,
        m,
      ])
    : models && typeof models === "object"
      ? Object.entries(models as Record<string, Entry>)
      : [];
  const out: Array<{ id: string; displayName: string }> = [];
  for (const [key, value] of entries) {
    // Same filter as Core's parseAntigravityModels: internal models are not for clients.
    if (typeof key !== "string" || value?.isInternal === true || !isUsableModelId(key)) continue;
    out.push({ id: key, displayName: typeof value?.displayName === "string" && value.displayName ? value.displayName : key });
  }
  return out;
}

/** Models of the Core catalog that the pool row lists and the admin enabled. */
export function modelsFromRow(row: InstanceUpstreamRow): Array<{ id: string; displayName: string }> | null {
  const catalog = row.source_models;
  if (!Array.isArray(catalog) || catalog.length === 0) return null;
  return catalog
    .filter((m) => m.enabled === true && m.available !== false && isUsableModelId(m.id))
    .map((m) => ({ id: m.id, displayName: m.display_name || m.id }));
}

export function geminiModelList(models: Array<{ id: string; displayName: string }>): Record<string, unknown> {
  return {
    models: models.map((m) => ({
      name: `models/${m.id}`,
      displayName: m.displayName,
      supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
    })),
  };
}

export function openaiModelList(models: Array<{ id: string }>): Record<string, unknown> {
  return { object: "list", data: models.map((m) => ({ id: m.id, object: "model" })) };
}

// ── Request helpers ──────────────────────────────────────────────────────────

/** Google-style error body. agy shows `error.message`. */
function googleError(status: number, message: string, code = "INVALID_ARGUMENT"): Response {
  return new Response(JSON.stringify({ error: { code: status, message, status: code } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const gunzipAsync = promisify(gunzip);
/** Largest decompressed gzip body. A small gzip bomb must not exhaust the memory of the shared proxy. */
const MAX_GUNZIP_BYTES = 64 * 1024 * 1024;

/** Request body bytes, with a gzip body decompressed. Chunked bodies are handled by the server. */
async function readJsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    let bytes = Buffer.from(await c.req.arrayBuffer());
    if ((c.req.header("content-encoding") ?? "").toLowerCase().includes("gzip")) {
      bytes = await gunzipAsync(bytes, { maxOutputLength: MAX_GUNZIP_BYTES });
    }
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function cascadeIdOf(body: Record<string, unknown>): string | null {
  const id = (body.labels as { cascade_id?: unknown } | undefined)?.cascade_id;
  return typeof id === "string" && SESSION_ID_RE.test(id) ? id : null;
}

/** The new human text of the request, or null when the request is a tool-loop step. */
export function extractUserMessage(body: Record<string, unknown>): TdaiMessage | null {
  const contents = Array.isArray(body.contents) ? body.contents as Array<{ role?: unknown; parts?: unknown }> : [];
  for (let i = contents.length - 1; i >= 0; i--) {
    const turn = contents[i];
    if (turn?.role === "model") return null;
    if (!Array.isArray(turn?.parts)) continue;
    const parts = turn.parts as Array<{ text?: unknown; functionResponse?: unknown }>;
    if (parts.some((p) => p?.functionResponse !== undefined)) return null;
    const text = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n");
    // agy appends system notices as extra user turns after the typed one; look past them.
    if (isAgySystemNotice(text)) continue;
    const clean = stripAgentMessages(extractUserQueryText(userRequestText(text))).trim();
    return clean ? { role: "user", content: clean } : null;
  }
  return null;
}

interface Authenticated {
  route: AntigravityRoute;
  userId: string;
  keyId: string;
}

/** Parse the path and verify the path key. Returns an error response when the request cannot go on. */
async function authenticate(c: Context): Promise<Authenticated | Response> {
  const route = parseAntigravityPath(c.req.path);
  if (!route) return googleError(404, "Unknown AntiGravity endpoint.", "NOT_FOUND");
  const verify = await verifyUserKey(route.accessKey, route.spaceId);
  if (verify.rejected) {
    // Paseo rewrites any message matching /auth|sign.in|log.in/i into an agy
    // sign-in prompt. A Core outage must stay a retryable 503 and avoid those words.
    if (verify.unavailable) {
      const res = googleError(503, "Memory service temporarily unavailable. Please retry.", "UNAVAILABLE");
      res.headers.set("retry-after", "5");
      console.warn(`${TAG} verify unavailable space=${route.spaceId}: ${verify.rejectReason ?? "unknown"}`);
      return res;
    }
    console.warn(`${TAG} authentication failed space=${route.spaceId}: ${verify.rejectReason ?? "unknown"}`);
    return googleError(401, `Authentication failed: ${verify.rejectReason ?? "unknown"}`, "UNAUTHENTICATED");
  }
  const keyId = verify.userId || (route.accessKey ? apiKeyToKeyId(route.accessKey) : "unknown");
  return { route, userId: verify.userId, keyId };
}

/**
 * The pool row of the request team. A known team without an AntiGravity pool gets the 400 below,
 * because AntiGravity has no normal upstream. A null team never gets a pool.
 */
async function resolvePool(config: ProxyConfig, spaceId: string, teamId: string | null): Promise<InstanceUpstreamRow | Response> {
  const rows = await getInstanceUpstreamConfigs(config.coreSkill, spaceId, config.instanceUpstream);
  const resolution = resolveForAgent(rows, AGENT, teamId);
  if (resolution.kind === "pool") return resolution.row;
  if (resolution.kind === "blocked") return googleError(400, "The upstream group of this agent is disabled.", "FAILED_PRECONDITION");
  return googleError(
    400,
    "AntiGravity runs only on a subscription pool. Ask the instance administrator to add AntiGravity to a pool group.",
    "FAILED_PRECONDITION",
  );
}

/** Answer for a team error in the Google error shape. Pool answers keep their own shape. */
function teamErrorResponse(err: RequestTeamError): Response {
  if (err.code === "pool_exhausted") return buildPoolExhaustedResponse(err.resetAtMs ?? null, Date.now());
  if (err.code === "pool_unavailable") return buildPoolUnavailableResponse();
  const res = googleError(err.status, err.message, err.status === 403 ? "PERMISSION_DENIED" : "UNAVAILABLE");
  if (err.code === "team_list_unavailable") res.headers.set("retry-after", "5");
  return res;
}

function upstreamBaseOf(config: ProxyConfig, row: InstanceUpstreamRow): string {
  return (row.base_url || config.upstream.agents?.[AGENT]?.url || ANTIGRAVITY_BASE_URL).replace(/\/+$/, "");
}

/**
 * Client headers that are never sent to Cloud Code. The call runs with the credentials of a
 * pool account, so a client header that names other credentials or another quota project would
 * conflict with them. `cookie` belongs to the client. The proxy re-serializes the body and reads
 * the response itself, so it owns the body and response encodings.
 */
const ANTIGRAVITY_SKIP_CLIENT_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "x-goog-user-project",
  "cookie",
  "content-encoding",
  "accept-encoding",
]);

/**
 * Headers for one Cloud Code call: the other client headers, then the headers that the proxy
 * owns. The user agent is always ANTIGRAVITY_USER_AGENT, because Cloud Code answers other
 * client strings with UNSUPPORTED_CLIENT.
 */
function buildAntigravityUpstreamHeaders(
  incomingHeaders: Headers,
  accessToken: string,
  stream: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of incomingHeaders.entries()) {
    const lower = k.toLowerCase();
    if (shouldSkipRequestHeader(lower) || ANTIGRAVITY_SKIP_CLIENT_HEADERS.has(lower)) continue;
    headers[lower] = v;
  }
  headers["authorization"] = `Bearer ${accessToken}`;
  headers["content-type"] = "application/json";
  headers["user-agent"] = ANTIGRAVITY_USER_AGENT;
  if (stream) headers["accept"] = "text/event-stream";
  return headers;
}

/** One upstream call with the credentials of the selected account. The path key is never part of it. */
function accountFetch(
  config: ProxyConfig,
  url: string,
  incomingHeaders: Headers,
  makePayload: (auth: Extract<PoolAuth, { kind: "account" }> & { projectId: string }) => Record<string, unknown>,
  stream: boolean,
): (auth: PoolAuth, signal?: AbortSignal) => Promise<Response> {
  const timeoutMs = config.server?.forwardTimeoutMs ?? 600_000;
  return async (auth, signal) => {
    // The client's own login does not exist for agy, and an account without a project cannot be used.
    if (auth.kind !== "account") return googleError(401, "No pool account is available.", "UNAUTHENTICATED");
    if (!auth.projectId) {
      return googleError(409, "The pool account has no Google project. Add the account again in the pool admin panel.", "FAILED_PRECONDITION");
    }
    const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const combined = signal && timeout ? AbortSignal.any([signal, timeout]) : signal ?? timeout;
    return fetch(url, {
      method: "POST",
      headers: buildAntigravityUpstreamHeaders(incomingHeaders, auth.accessToken, stream),
      body: JSON.stringify(makePayload({ ...auth, projectId: auth.projectId })),
      ...(combined ? { signal: combined } : {}),
    });
  };
}

/** Headers for a response that is rebuilt here: no length or encoding of the upstream body. */
function clientHeaders(upstream: Headers, contentType: string): Headers {
  const out = filterResponseHeaders(upstream);
  out.set("content-type", contentType);
  return out;
}

// ── Models endpoints ─────────────────────────────────────────────────────────

export async function runAntigravityModels(c: Context, config: ProxyConfig): Promise<Response> {
  try {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { route } = auth;
    if (route.kind !== "models-gemini" && route.kind !== "models-openai") return googleError(404, "Unknown AntiGravity endpoint.", "NOT_FOUND");

    // The model list has no session. It uses the first team of the user, in the order of Core, that
    // has an enabled AntiGravity pool with a usable account. No such team gives the 400 below.
    const listTeam = await resolveRequestTeam({
      config, spaceId: route.spaceId, userId: auth.userId, userKey: route.accessKey, agentSource: AGENT,
      session: null, lcHeaders: {}, model: "", sessionInitMayRun: false,
    });
    // Only "no team pool" means the 400 below; a full, unreachable or unknown team keeps its own answer.
    if (listTeam?.kind === "error" && listTeam.code !== "no_team_pool") return teamErrorResponse(listTeam);
    const row = await resolvePool(config, route.spaceId, teamIdOf(listTeam));
    if (row instanceof Response) return row;

    let models = modelsFromRow(row);
    if (!models) {
      const pool = openPoolRequest({
        config, spaceId: route.spaceId, row, provider: "antigravity", clientHeaders: new Headers(),
        body: null, userKey: route.accessKey, bindSession: false, signal: c.req.raw.signal,
      });
      const url = `${upstreamBaseOf(config, row)}/v1internal:fetchAvailableModels`;
      const resp = await pool.send(accountFetch(config, url, c.req.raw.headers, (a) => ({ project: a.projectId }), false));
      if (resp.status !== 200) {
        console.warn(`${TAG} model list upstream status=${resp.status} space=${route.spaceId}`);
        return new Response(await resp.text(), { status: resp.status, headers: clientHeaders(resp.headers, "application/json") });
      }
      models = modelsFromUpstream(await resp.json().catch(() => null));
    }
    c.header("cache-control", "no-store");
    return c.json(route.kind === "models-openai" ? openaiModelList(models) : geminiModelList(models));
  } catch (err) {
    console.error(`${TAG} model list failed path=${maskKeyedPath(c.req.path)}: ${err instanceof Error ? err.message : "unknown"}`);
    return googleError(502, "The model list is not available.", "UNAVAILABLE");
  }
}

// ── L0 ───────────────────────────────────────────────────────────────────────

interface L0Context {
  config: ProxyConfig;
  spaceId: string;
  userId: string;
  sessionId: string;
  userKey: string;
  sessionInfo: Record<string, unknown>;
  chatMemory: boolean;
  userMessage: TdaiMessage | null;
}

/** Write the L0 row of one request. Fire and forget: a failed write never reaches the client. */
function writeL0(ctx: L0Context, assistantText: string): void {
  if (!ctx.chatMemory || (!ctx.userMessage && !assistantText.trim())) return;
  if (!isExtractionAllowed(ctx.config, "tdai-memory")) {
    logExtractionSkipped(ctx.config, "tdai-memory", ctx.sessionId);
    return;
  }
  const client = buildTdaiClientForRequest(ctx.config, ctx.spaceId);
  const base = deriveTdaiIdentity({
    sessionInfo: ctx.sessionInfo, userId: ctx.userId || null, sessionKey: ctx.sessionId, userKey: ctx.userKey,
  });
  if (!client || !base) return;
  trackWrite((async () => {
    // The project comes from the workspace that the hook reported; without it the row has none.
    const identity = await withSessionProject(base, ctx.config, {
      spaceId: ctx.spaceId, userId: ctx.userId || "anonymous", agentSource: AGENT, sessionId: ctx.sessionId,
    }) ?? base;
    await withL0Retry(() => recordTdaiTurn(client, identity, ctx.userMessage, assistantText || null, { allowAssistantOnly: true }));
  })().catch((err: unknown) => {
    console.warn(`${TAG}-l0 failed:`, err instanceof Error ? err.message : String(err));
  }));
}

// ── Generate endpoints ───────────────────────────────────────────────────────

export async function runAntigravityPipeline(c: Context, config: ProxyConfig): Promise<Response> {
  const traceId = uuidv7();
  const startTime = new Date().toISOString();
  try {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { route, userId, keyId } = auth;
    if (route.kind !== "stream" && route.kind !== "generate") return googleError(404, "Unknown AntiGravity endpoint.", "NOT_FOUND");
    const isStream = route.kind === "stream";
    const { spaceId, memoryOff } = route;

    const original = await readJsonBody(c);
    if (!original) return googleError(400, "Invalid JSON body.");
    // The turns of the session-init questions are never sent upstream. The gate still reads the
    // original history (its own answers are found by their marker); the L0 row reads the clean one.
    const body = stripSessionInitTurns(original);

    const sessionId = cascadeIdOf(body);
    const headers: Record<string, string> = {};
    for (const [k, v] of c.req.raw.headers.entries()) headers[k.toLowerCase()] = v;
    const upstreamModel = upstreamModelFor(route.model, body);

    // ── Team of the request ──
    // A pool belongs to one team. Only the main stream request runs session init, so only it may
    // wait for init to give a team. Null when no team pool serves AntiGravity in this instance.
    const teamSession = sessionId ? { keyId: `${AGENT}:${sessionId}`, agentSource: AGENT, sessionId } : null;
    const requestTeam = await resolveRequestTeam({
      config, spaceId, userId, userKey: route.accessKey, agentSource: AGENT, session: teamSession,
      lcHeaders: headers, model: upstreamModel, memoryOff,
      sessionInitMayRun: !memoryOff && config.sessionInit?.enabled === true && Boolean(sessionId) && isStream,
    });
    const requestTeamError = immediateTeamError(requestTeam);
    if (requestTeamError) return teamErrorResponse(requestTeamError);
    // A team error that waits for init leaves the pool open until init has run.
    let row: InstanceUpstreamRow | null = null;
    if (requestTeam === null || requestTeam.kind === "team") {
      const resolved = await resolvePool(config, spaceId, teamIdOf(requestTeam));
      if (resolved instanceof Response) return resolved;
      row = resolved;
    }

    // ── Hook gate: no hook report, no model answer. The body is not changed. ──
    const gate = await runAntigravityHookGate({
      config, body: original, stream: isStream, sessionId, spaceId, userId: userId || "anonymous",
      origin: resolveProxyOrigin(headers, c.req.url), memoryOff,
    });
    if (gate.action === "respond") {
      console.log(`[hook-gate] session=${sessionId} agent=${AGENT} answered locally: ${gate.reason}`);
      return gate.response;
    }

    // ── Session registration under the cascade id, so recall and L0 find the session ──
    let sessionInfo: Record<string, unknown> | null = null;
    let chatMemory = false;
    // Only the main stream request starts or continues session init: `:generateContent` calls are
    // side requests (titles, summaries) and must not trigger a question. A memory-off URL never
    // registers a session, so no L0 row is written for it either.
    if (!memoryOff && config.sessionInit?.enabled && sessionId && isStream) {
      try {
        const messages = contentsToMessages(original);
        const orchestrated = await stageSessionInitOrchestrate({
          agentSourceForState: AGENT,
          sessionKey: sessionId, userId: userId || null, spaceId,
          config: config as ProxyConfig & { sessionInit: NonNullable<ProxyConfig["sessionInit"]> },
          kernelUserKey: route.accessKey,
          headers, recoveryMessages: [],
          synthesizeMessages: () => messages,
          buildRecoverInitResult: async () => ({ messages: [] }),
          // agy cannot show a tool question, so the questions are text turns of the conversation.
          buildReqCtx: () => ({
            stream: isStream, modelId: upstreamModel, protocol: "openai" as const,
            capabilities: { askUserQuestion: false },
          }),
          buildInterceptResponse: (result) => sessionInitResponse(result, isStream),
        });
        if (!orchestrated.proceed) {
          console.log(`[session-init] session=${sessionId} agent=${AGENT} asked a question locally`);
          return orchestrated.response!;
        }
        const init = orchestrated.initResult;
        if (init && !init.bypassed && init.sessionInfo) {
          sessionInfo = init.sessionInfo as unknown as Record<string, unknown>;
          if (!sessionInfo.space_id) sessionInfo.space_id = spaceId;
          const flags = await stageAssetCapabilities({
            bypassed: false, sessionInfo, config, spaceId, userKey: route.accessKey,
            warnPrefix: `${TAG} asset-capability resolve failed:`,
          });
          chatMemory = flags?.chat_memory !== false;
        }
      } catch (err) {
        console.error(`${TAG} session-init error:`, err instanceof Error ? err.message : String(err));
      }
    }

    // ── Settle the team after session init ──
    // Init may have registered the session in another team than the first answer, or left it
    // without a team. A team error that waited for init is answered here, before any upstream call.
    const settledTeam = await settleRequestTeam({
      config, spaceId, userId, userKey: route.accessKey, first: requestTeam, session: teamSession,
    });
    if (settledTeam.error) return teamErrorResponse(settledTeam.error);
    if (row === null || settledTeam.changed) {
      const resolved = await resolvePool(config, spaceId, settledTeam.teamId);
      if (resolved instanceof Response) return resolved;
      row = resolved;
    }

    // ── Pool account, Cloud Code call ──
    const pool = openPoolRequest({
      config, spaceId, row, provider: "antigravity",
      // Empty headers: agy sends none, and a stray client login must never reach the fallback.
      clientHeaders: new Headers(),
      body: { model: upstreamModel },
      userKey: route.accessKey,
      bindSession: isStream,
      sessionId: sessionId ?? undefined,
      signal: c.req.raw.signal,
    });
    const url = preserveRequestQuery(
      `${upstreamBaseOf(config, row)}/v1internal:${isStream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
      c.req.url,
    );
    const resp = await pool.send(accountFetch(config, url, c.req.raw.headers, (a) => wrapEnvelope(upstreamModel, a.projectId, body), isStream));

    writeLog(config, {
      timestamp: startTime, event: "request", modelId: upstreamModel, keyId, sessionKey: keyId,
      upstreamUrl: url, stream: isStream, traceId,
    });
    console.log(`${TAG} space=${spaceId} session=${sessionId ?? "-"} model=${upstreamModel} account=${pool.accountId ?? "-"} status=${resp.status}`);

    const l0: L0Context | null = sessionInfo && sessionId
      ? { config, spaceId, userId, sessionId, userKey: route.accessKey, sessionInfo, chatMemory, userMessage: extractUserMessage(body) }
      : null;

    if (resp.status >= 400 || !resp.body) {
      return new Response(resp.body, { status: resp.status, headers: filterResponseHeaders(resp.headers) });
    }
    if (isStream) {
      const stream = resp.body.pipeThrough(createSseUnwrapStream((text) => { if (l0) writeL0(l0, text); }));
      return new Response(stream, { status: 200, headers: clientHeaders(resp.headers, "text/event-stream") });
    }
    const parsed = await resp.json().catch(() => null) as { response?: unknown } | null;
    const unwrapped = parsed && typeof parsed === "object" && "response" in parsed ? parsed.response : parsed;
    if (l0) writeL0(l0, responseText(unwrapped));
    return new Response(JSON.stringify(unwrapped), { status: 200, headers: clientHeaders(resp.headers, "application/json") });
  } catch (err) {
    if (c.req.raw.signal.aborted) return googleError(499, "Client closed the request.", "CANCELLED");
    console.error(`${TAG} request failed path=${maskKeyedPath(c.req.path)}: ${err instanceof Error ? err.message : "unknown"}`);
    return googleError(502, "Upstream request failed.", "UNAVAILABLE");
  }
}
