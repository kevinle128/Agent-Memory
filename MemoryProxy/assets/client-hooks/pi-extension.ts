// Agent-Memory extension for pi and oh-my-pi. Installed as ~/.pi/agent/extensions/agent-memory.ts
// (pi) or ~/.omp/agent/extensions/agent-memory.ts (omp).
//
// It sends the working directory and git identity of the session to the
// Agent-Memory proxy, like the hook.sh script does for Claude Code and Codex.
// The proxy uses them to find the project of the session.
//
// Rules for this extension:
//   - It never throws into pi, never prints, and never blocks a prompt for more
//     than REPORT_TIMEOUT_MS.
//   - It reports only to the base URL of the active model when that URL is an
//     Agent-Memory pi route (".../pi/<space>/v1"). The API key of any other
//     provider is never sent.
//
// No type import from the pi package: pi and its forks publish the types under
// different package names. Only the members used here are declared.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { hostname, arch, platform, homedir } from "node:os";
import { join } from "node:path";

const HOOK_VERSION = "1";
const REPORT_TIMEOUT_MS = 2000;
const GIT_TIMEOUT_MS = 1500;
// The proxy route of the pi agent: <origin>/pi/<space>/v1
const PI_ROUTE_RE = /^(https?:\/\/.+\/pi\/[^/]+)\/v1\/?$/;

interface PiModel {
  baseUrl?: string;
}

interface PiContext {
  cwd: string;
  model?: PiModel;
  sessionManager: { getSessionId(): string };
  modelRegistry: {
    getApiKeyAndHeaders(model: PiModel): Promise<{
      ok?: boolean;
      apiKey?: string;
      headers?: Record<string, string>;
    }>;
  };
}

interface PiApi {
  on(event: string, handler: (event: unknown, ctx: PiContext) => Promise<void> | void): void;
}

interface Workspace {
  gitToplevel: string | null;
  gitRemote: string | null;
}

/** Run git in a directory. Resolve to "" on any failure. */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(
        "git",
        ["-C", cwd, ...args],
        { timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
        (err, stdout) => resolve(err ? "" : String(stdout).trim()),
      );
    } catch {
      resolve("");
    }
  });
}

/** Remove user:token@ from a scheme://... URL. A scp-like git@host:path URL has no secret. */
export function stripUserinfo(remote: string): string {
  return remote.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/]*@/, "$1");
}

async function readWorkspace(cwd: string): Promise<Workspace> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) return { gitToplevel: null, gitRemote: null };
  let remote = await git(cwd, ["remote", "get-url", "origin"]);
  if (!remote) {
    const first = (await git(cwd, ["remote"])).split("\n")[0] ?? "";
    if (first) remote = await git(cwd, ["remote", "get-url", first]);
  }
  return { gitToplevel: top, gitRemote: remote ? stripUserinfo(remote) : null };
}

async function readDeviceId(file: string): Promise<string | null> {
  try {
    const id = (JSON.parse(await readFile(file, "utf8")) as { device_id?: unknown }).device_id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * Device id from ~/.agent-memory/device.json. Create the file when it is
 * missing, like hook.sh. The new file is linked into place, so a file that
 * another process created first is never replaced: both then read the same id.
 */
async function deviceId(): Promise<string | null> {
  const dir = join(homedir(), ".agent-memory");
  const file = join(dir, "device.json");
  const existing = await readDeviceId(file);
  if (existing) return existing;
  const id = randomUUID();
  const tmp = join(dir, `device.${process.pid}.${id.slice(0, 8)}`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(tmp, `{"device_id": "${id}", "created_at": "${new Date().toISOString()}"}\n`, { mode: 0o600 });
    await link(tmp, file).catch((err: NodeJS.ErrnoException) => {
      // EEXIST: another process won the race. Use its id.
      if (err.code !== "EEXIST") throw err;
    });
    return (await readDeviceId(file)) ?? id;
  } catch {
    return null;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/** Report URL and credentials of the active model, or null when it is not an Agent-Memory pi route. */
export async function resolveTarget(
  ctx: PiContext,
): Promise<{ url: string; headers: Record<string, string> } | null> {
  const model = ctx.model;
  const match = typeof model?.baseUrl === "string" ? PI_ROUTE_RE.exec(model.baseUrl) : null;
  if (!model || !match) return null;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (auth.ok === false) return null;
  const headers: Record<string, string> = { "content-type": "application/json", ...(auth.headers ?? {}) };
  if (auth.apiKey && !Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) {
    headers["authorization"] = `Bearer ${auth.apiKey}`;
  }
  return { url: `${match[1]}/v3/hook/report`, headers };
}

async function report(ctx: PiContext, hookEvent: string): Promise<boolean> {
  const sessionId = ctx.sessionManager.getSessionId();
  const target = await resolveTarget(ctx);
  if (!sessionId || !target) return false;
  const device = await deviceId();
  if (!device) return false;
  const ws = await readWorkspace(ctx.cwd);
  const body = {
    device_id: device,
    session_id: sessionId,
    cwd: ctx.cwd,
    git_toplevel: ws.gitToplevel,
    git_remote: ws.gitRemote,
    hook_event: hookEvent,
    hook_version: HOOK_VERSION,
    client: "pi",
    os: platform(),
    arch: arch(),
    hostname: hostname(),
  };
  const res = await fetch(target.url, {
    method: "POST",
    headers: target.headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
  });
  return res.ok;
}

export default function agentMemory(pi: PiApi): void {
  // Session and directory of the last successful report. The next prompt skips
  // the wait when nothing changed.
  let reported = "";

  const send = async (hookEvent: string, ctx: PiContext): Promise<void> => {
    try {
      const marker = `${ctx.sessionManager.getSessionId()}|${ctx.cwd}`;
      if (hookEvent === "input" && marker === reported) {
        // Already known to the proxy: refresh in the background, do not delay the prompt.
        void report(ctx, hookEvent).catch(() => undefined);
        return;
      }
      if (await report(ctx, hookEvent)) reported = marker;
    } catch {
      // A failed report means "no project" for the proxy. Never break the session.
    }
  };

  pi.on("session_start", (_event, ctx) => send("session_start", ctx));
  pi.on("input", (_event, ctx) => send("input", ctx));
}
