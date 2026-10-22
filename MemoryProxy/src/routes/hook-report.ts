/**
 * `POST /:agent/:spaceId/v3/hook/report` — receives the client hook report.
 *
 * The Claude Code hook (SessionStart, UserPromptSubmit) posts the session's
 * working directory and git identity to `$ANTHROPIC_BASE_URL/v3/hook/report`
 * with the user key as bearer token. The hook runs before the first model
 * request, so the session is often not registered yet: the route checks the
 * user key itself (same check as the model routes) and keys the record by
 * (spaceId, userId, agentSource, sessionId).
 *
 * Side effect: the device record in Core (`/v3/meta/device/upsert`) is
 * refreshed, at most once per device per DEVICE_REFRESH_MS per process. A Core
 * failure does not fail the report.
 */

import type { Context } from "hono";

import { getMetadataClient } from "../meta/client.js";
import { stageAuth } from "../pipeline/stages/auth.js";
import type { ProxyConfig } from "../types.js";
import { buildProjectIdentity } from "../project-scope/project-key.js";
import { getSessionWorkspaceStore, type SessionWorkspace } from "../project-scope/session-workspace.js";

const TAG = "[hook-report]";
const DEVICE_REFRESH_MS = 10 * 60_000;
const MAX_FIELD = 4096;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const CLIENT_RE = /^[a-z0-9-]{1,32}$/;
const AGENT_RE = /^[a-z0-9-]+$/;

/** Validated report body. */
export interface HookReport {
  deviceId: string;
  sessionId: string;
  cwd: string;
  gitToplevel: string | null;
  gitRemote: string | null;
  hookEvent: string;
  hookVersion: string;
  client: string;
  os: string;
  arch: string;
  hostname: string;
}

/** Parse and validate the JSON body. Returns an error message for a bad body. */
export function parseHookReport(body: unknown): HookReport | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  const str = (k: string, required: boolean): string | null | undefined => {
    const v = b[k];
    if (v === undefined || v === null || v === "") return required ? undefined : null;
    if (typeof v !== "string" || v.length > MAX_FIELD) return undefined;
    return v;
  };
  const deviceId = str("device_id", true);
  if (!deviceId || !ID_RE.test(deviceId)) return "invalid device_id";
  const sessionId = str("session_id", true);
  if (!sessionId || !ID_RE.test(sessionId)) return "invalid session_id";
  const cwd = str("cwd", true);
  if (!cwd) return "invalid cwd";
  const client = str("client", true);
  if (!client || !CLIENT_RE.test(client)) return "invalid client";
  const hookVersion = str("hook_version", true);
  if (!hookVersion || hookVersion.length > 32) return "invalid hook_version";
  for (const k of ["git_toplevel", "git_remote", "hook_event", "os", "arch", "hostname"]) {
    if (str(k, false) === undefined) return `invalid ${k}`;
  }
  return {
    deviceId,
    sessionId,
    cwd,
    gitToplevel: str("git_toplevel", false) ?? null,
    gitRemote: str("git_remote", false) ?? null,
    hookEvent: (str("hook_event", false) ?? "unknown").slice(0, 64),
    hookVersion,
    client,
    os: (str("os", false) ?? "").slice(0, 128),
    arch: (str("arch", false) ?? "").slice(0, 128),
    hostname: (str("hostname", false) ?? "").slice(0, 128),
  };
}

const lastDeviceRefresh = new Map<string, number>();

/** Clear the device refresh throttle (tests). */
export function resetDeviceRefreshThrottle(): void {
  lastDeviceRefresh.clear();
}

export function createHookReportHandler(config: ProxyConfig) {
  return async (c: Context): Promise<Response> => {
    const agentSource = c.req.param("agent") ?? "";
    if (!AGENT_RE.test(agentSource)) return c.json({ error: "invalid agent" }, 400);

    const auth = await stageAuth(c);
    if (auth.rejected) return c.json({ error: "unauthorized", reason: auth.rejectReason }, 401);
    const userId = auth.userId || "anonymous";
    const spaceId = auth.spaceId || c.req.param("spaceId") || "";

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const report = parseHookReport(raw);
    if (typeof report === "string") return c.json({ error: report }, 400);

    const project = buildProjectIdentity({
      gitRemote: report.gitRemote,
      gitToplevel: report.gitToplevel,
      deviceId: report.deviceId,
    });
    const workspace: SessionWorkspace = {
      sessionId: report.sessionId,
      deviceId: report.deviceId,
      client: report.client,
      cwd: report.cwd,
      gitToplevel: report.gitToplevel,
      gitRemote: report.gitRemote,
      ...project,
      hookEvent: report.hookEvent,
      hookVersion: report.hookVersion,
      reportedAt: new Date().toISOString(),
    };

    try {
      const store = await getSessionWorkspaceStore(config);
      await store.put({ spaceId, userId, agentSource, sessionId: report.sessionId }, workspace);
    } catch (err) {
      console.warn(`${TAG} store failed session=${report.sessionId}:`, err instanceof Error ? err.message : String(err));
      return c.json({ error: "store failed" }, 500);
    }
    console.log(
      `${TAG} session=${report.sessionId} agent=${agentSource} event=${report.hookEvent} ` +
      `project=${project.projectLabel ?? "none"} hash=${project.projectHash ?? "none"}`,
    );

    refreshDevice(config, spaceId, auth.apiKey, userId, report);
    return c.body(null, 204);
  };
}

/** Fire-and-forget device record refresh, throttled per (user, device, client). */
function refreshDevice(config: ProxyConfig, spaceId: string, userKey: string, userId: string, r: HookReport): void {
  if (!config.coreSkill?.endpoint || !userKey || userId === "anonymous") return;
  const throttleKey = `${spaceId}|${userId}|${r.deviceId}|${r.client}`;
  const now = Date.now();
  const last = lastDeviceRefresh.get(throttleKey) ?? 0;
  if (now - last < DEVICE_REFRESH_MS && r.hookEvent !== "Install") return;
  lastDeviceRefresh.set(throttleKey, now);
  getMetadataClient(config.coreSkill, spaceId, userKey)
    .upsertDeviceSetup({
      user_id: userId,
      device_id: r.deviceId,
      client: r.client,
      os: r.os,
      arch: r.arch,
      hostname: r.hostname,
      hook_version: r.hookVersion,
    })
    .catch((err: unknown) => {
      lastDeviceRefresh.delete(throttleKey);
      console.warn(`${TAG} device upsert failed device=${r.deviceId}:`, err instanceof Error ? err.message : String(err));
    });
}
