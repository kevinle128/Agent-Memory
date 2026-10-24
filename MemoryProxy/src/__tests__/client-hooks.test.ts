// Tests for the client hook scripts in assets/client-hooks.
// The vitest config only collects tests under src/, so this file lives here.
// Each test runs the real bash scripts against a temporary HOME and a local
// HTTP server. The real ~/.claude and ~/.agent-memory are never touched.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = fileURLToPath(new URL("../../assets/client-hooks/", import.meta.url));
const HOOK_SH = path.join(HOOKS_DIR, "hook.sh");
const INSTALL_SH = path.join(HOOKS_DIR, "install.sh");

interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface FakeProxy {
  origin: string;
  requests: Recorded[];
  setReportStatus(status: number): void;
  close(): Promise<void>;
}

async function startFakeProxy(): Promise<FakeProxy> {
  const requests: Recorded[] = [];
  let reportStatus = 200;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rec: Recorded = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      if (req.method === "GET" && req.url === "/setup/hook.sh") {
        res.writeHead(200, { "content-type": "text/x-shellscript" });
        res.end(fs.readFileSync(HOOK_SH));
        return;
      }
      requests.push(rec);
      res.writeHead(reportStatus, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    setReportStatus: (s) => {
      reportStatus = s;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Run a command asynchronously: the fake proxy runs in this process, so a
// synchronous spawn would block it.
function run(
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; input?: string; cwd?: string },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env, cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.input ?? "");
  });
}

function hasTool(name: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${name}`]).status === 0;
}

const HAS_GIT = hasTool("git");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let proxy: FakeProxy;
let home: string;
let work: string;
const tmpDirs: string[] = [];

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  proxy = await startFakeProxy();
});

afterAll(async () => {
  await proxy.close();
});

beforeEach(() => {
  proxy.requests.length = 0;
  proxy.setReportStatus(200);
  home = mkTmp("am-home-");
  work = mkTmp("am-work-");
});

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

// A clean environment: no connection variables leak in from the developer shell.
function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...extra };
  for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "AGENT_MEMORY_HOOK_STRICT"]) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}

function connEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return baseEnv({
    ANTHROPIC_BASE_URL: `${proxy.origin}/claude-code/default`,
    ANTHROPIC_AUTH_TOKEN: "sk-mem-test-token",
    ...extra,
  });
}

function runHook(stdin: object, env: NodeJS.ProcessEnv, client?: string): Promise<RunResult> {
  return run("bash", client ? [HOOK_SH, client] : [HOOK_SH], { env, input: JSON.stringify(stdin) });
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, env: { ...process.env, HOME: home } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(r.stderr)}`);
}

function makeRepo(remoteUrl: string | null): { top: string; sub: string } {
  const top = mkTmp("am-repo-");
  git(top, "init", "-q");
  if (remoteUrl) git(top, "remote", "add", "origin", remoteUrl);
  const sub = path.join(top, "pkg", "inner");
  fs.mkdirSync(sub, { recursive: true });
  return { top: fs.realpathSync(top), sub };
}

function readDeviceId(): string {
  const raw = fs.readFileSync(path.join(home, ".agent-memory", "device.json"), "utf8");
  return (JSON.parse(raw) as { device_id: string }).device_id;
}

// JSON tools to cover. The sed fallback exists for the hook only.
const HOOK_TOOLS = ["jq", "python3", "node", "sed"].filter((t) => t === "sed" || hasTool(t));
const INSTALL_TOOLS = ["jq", "python3", "node"].filter(hasTool);

describe("hook.sh", () => {
  it("prints nothing and exits 0 when the proxy is unreachable", async () => {
    // Port 1 is closed: the connection is refused at once.
    const env = connEnv({ ANTHROPIC_BASE_URL: "http://127.0.0.1:1/claude-code/default" });
    const r = await runHook({ session_id: "s1", cwd: work, hook_event_name: "SessionStart" }, env);
    expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("exits 0 silently when no base URL or token is known", async () => {
    const r = await runHook({ session_id: "s1", cwd: work }, baseEnv());
    expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(proxy.requests).toHaveLength(0);
  });

  it("reads the connection settings from ~/.claude/settings.json", async () => {
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: `${proxy.origin}/claude-code/default/`, ANTHROPIC_AUTH_TOKEN: "from-settings" },
      }),
    );
    const r = await runHook({ session_id: "s9", cwd: work, hook_event_name: "SessionStart" }, baseEnv());
    expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(proxy.requests).toHaveLength(1);
    expect(proxy.requests[0].url).toBe("/claude-code/default/v3/hook/report");
    expect(proxy.requests[0].headers.authorization).toBe("Bearer from-settings");
  });

  describe.each(HOOK_TOOLS)("with the %s JSON tool", (tool) => {
    it.skipIf(!HAS_GIT)("posts the session, git identity and device id", async () => {
      const { top, sub } = makeRepo("https://user:secret-token@example.com/org/repo.git");
      const env = connEnv({ AGENT_MEMORY_JSON_TOOL: tool });
      const r = await runHook({ session_id: "sess-1", cwd: sub, hook_event_name: "UserPromptSubmit", extra: 1 }, env);
      expect(r).toEqual({ code: 0, stdout: "", stderr: "" });

      expect(proxy.requests).toHaveLength(1);
      const req = proxy.requests[0];
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/claude-code/default/v3/hook/report");
      expect(req.headers.authorization).toBe("Bearer sk-mem-test-token");
      expect(req.headers["content-type"]).toBe("application/json");

      const body = JSON.parse(req.body) as Record<string, unknown>;
      expect(body).toMatchObject({
        session_id: "sess-1",
        cwd: sub,
        git_toplevel: top,
        git_remote: "https://example.com/org/repo.git",
        hook_event: "UserPromptSubmit",
        hook_version: "1",
        client: "claude-code",
        os: os.platform(),
        arch: expect.any(String),
      });
      expect(String(body.device_id)).toMatch(UUID_RE);
      expect(body.device_id).toBe(readDeviceId());
      expect(typeof body.hostname).toBe("string");
      expect(req.body).not.toContain("secret-token");
    });

    it("sends null git fields for a directory outside a git repository", async () => {
      const env = connEnv({ AGENT_MEMORY_JSON_TOOL: tool });
      const r = await runHook({ session_id: "s2", cwd: work, hook_event_name: "SessionStart" }, env, "other-client");
      expect(r.code).toBe(0);
      const body = JSON.parse(proxy.requests[0].body) as Record<string, unknown>;
      expect(body.git_toplevel).toBeNull();
      expect(body.git_remote).toBeNull();
      expect(body.cwd).toBe(work);
      expect(body.client).toBe("other-client");
    });

    it("escapes quotes and backslashes in the working directory", async () => {
      const odd = path.join(work, 'a "quoted" b\\c dir');
      fs.mkdirSync(odd);
      const env = connEnv({ AGENT_MEMORY_JSON_TOOL: tool });
      await runHook({ session_id: "s3", cwd: odd, hook_event_name: "SessionStart" }, env);
      const body = JSON.parse(proxy.requests[0].body) as Record<string, unknown>;
      expect(body.cwd).toBe(odd);
    });
  });

  it.skipIf(!HAS_GIT)("keeps a scp-like remote and falls back to the first remote name", async () => {
    const top = mkTmp("am-repo-");
    git(top, "init", "-q");
    git(top, "remote", "add", "upstream", "git@example.com:org/repo.git");
    await runHook({ session_id: "s4", cwd: top, hook_event_name: "SessionStart" }, connEnv());
    const body = JSON.parse(proxy.requests[0].body) as Record<string, unknown>;
    expect(body.git_remote).toBe("git@example.com:org/repo.git");
  });

  it("creates device.json with mode 0600 and reuses the id", async () => {
    const env = connEnv();
    await runHook({ session_id: "s5", cwd: work, hook_event_name: "SessionStart" }, env);
    const dir = path.join(home, ".agent-memory");
    const file = path.join(dir, "device.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);

    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { device_id: string; created_at: string };
    expect(parsed.device_id).toMatch(UUID_RE);
    expect(parsed.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    await runHook({ session_id: "s6", cwd: work, hook_event_name: "UserPromptSubmit" }, env);
    expect(proxy.requests).toHaveLength(2);
    const ids = proxy.requests.map((q) => (JSON.parse(q.body) as { device_id: string }).device_id);
    expect(ids[0]).toBe(parsed.device_id);
    expect(ids[1]).toBe(parsed.device_id);
    expect(fs.readdirSync(dir)).toEqual(["device.json"]);
  });

  it("strict mode exits 1 with one stderr line on HTTP 500", async () => {
    proxy.setReportStatus(500);
    const env = connEnv({ AGENT_MEMORY_HOOK_STRICT: "1" });
    const r = await runHook({ session_id: "s7", cwd: work, hook_event_name: "Install" }, env);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toContain("HTTP 500");
  });

  it("strict mode exits 0 on HTTP 200", async () => {
    const env = connEnv({ AGENT_MEMORY_HOOK_STRICT: "1" });
    const r = await runHook({ session_id: "s8", cwd: work, hook_event_name: "Install" }, env);
    expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("non-strict mode exits 0 on HTTP 500", async () => {
    proxy.setReportStatus(500);
    const r = await runHook({ session_id: "s10", cwd: work, hook_event_name: "Install" }, connEnv());
    expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});

// --- installer -------------------------------------------------------------

const OWN_SETTINGS = () => ({
  env: {
    ANTHROPIC_BASE_URL: `${proxy.origin}/claude-code/default`,
    ANTHROPIC_AUTH_TOKEN: "sk-mem-test-token",
    ANTHROPIC_MODEL: "model-x",
  },
  model: "opus",
  permissions: { allow: ["Bash(ls)"] },
  hooks: {
    SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo unrelated" }] }],
    Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
  },
});

function settingsPath(): string {
  return path.join(home, ".claude", "settings.json");
}

function writeSettings(doc: unknown): void {
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(doc, null, 2) + "\n");
}

interface HookGroup {
  hooks: Array<{ command: string }>;
}

interface SettingsDoc {
  env?: Record<string, string>;
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

function readSettings(): SettingsDoc {
  return JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as SettingsDoc;
}

function listBackups(): string[] {
  return fs
    .readdirSync(path.join(home, ".claude"))
    .filter((f) => f.startsWith("settings.json.agent-memory-backup-"));
}

function hookCmd(): string {
  return `${home}/.agent-memory/hook.sh claude-code`;
}

// Run the installer the same way as the documented one-liner: the script
// arrives on stdin of "bash -s --".
function runInstaller(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<RunResult> {
  return run("bash", ["-s", "--", ...args], { env, input: fs.readFileSync(INSTALL_SH, "utf8"), cwd });
}

function countOurs(groups: HookGroup[] | undefined): number {
  if (!groups) return 0;
  return groups.flatMap((g) => g.hooks).filter((h) => h.command === hookCmd()).length;
}

describe.each(INSTALL_TOOLS)("install.sh with the %s JSON tool", (tool) => {
  const toolEnv = (extra: Record<string, string> = {}) => baseEnv({ AGENT_MEMORY_JSON_TOOL: tool, ...extra });

  it("installs the hook, device id, both entries and a backup, keeping other settings", async () => {
    const original = OWN_SETTINGS();
    writeSettings(original);
    const r = await runInstaller([], toolEnv());
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");

    const hook = path.join(home, ".agent-memory", "hook.sh");
    expect(fs.readFileSync(hook, "utf8")).toBe(fs.readFileSync(HOOK_SH, "utf8"));
    expect(fs.statSync(hook).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(home, ".agent-memory")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(home, ".agent-memory", "device.json")).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.join(home, ".agent-memory")).sort()).toEqual(["device.json", "hook.sh"]);

    expect(r.stdout).toBe(`Agent-Memory hooks installed (device ${readDeviceId()}).\n`);

    const settings = readSettings();
    const ours = { hooks: [{ type: "command", command: hookCmd(), timeout: 5 }] };
    expect(settings.hooks!.SessionStart).toEqual([...original.hooks.SessionStart, ours]);
    expect(settings.hooks!.UserPromptSubmit).toEqual([ours]);
    expect(settings.hooks!.Stop).toEqual(original.hooks.Stop);
    expect(settings.env).toEqual(original.env);
    expect(settings.model).toBe("opus");
    expect(settings.permissions).toEqual(original.permissions);

    const backups = listBackups();
    expect(backups).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(home, ".claude", backups[0]), "utf8"))).toEqual(original);
  });

  it("changes nothing on a second install", async () => {
    writeSettings(OWN_SETTINGS());
    await runInstaller([], toolEnv());
    const afterFirst = fs.readFileSync(settingsPath(), "utf8");
    const id = readDeviceId();

    const r = await runInstaller([], toolEnv());
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`Agent-Memory hooks installed (device ${id}).\n`);
    expect(fs.readFileSync(settingsPath(), "utf8")).toBe(afterFirst);
    expect(listBackups()).toHaveLength(1);
    expect(readDeviceId()).toBe(id);
    const settings = readSettings();
    expect(countOurs(settings.hooks!.SessionStart)).toBe(1);
    expect(countOurs(settings.hooks!.UserPromptSubmit)).toBe(1);
  });

  it("creates settings.json when it is missing and takes the URL from --base-url", async () => {
    const r = await runInstaller(["--base-url", `${proxy.origin}/claude-code/default`], toolEnv());
    expect(r.code).toBe(0);
    const settings = readSettings();
    expect(countOurs(settings.hooks!.SessionStart)).toBe(1);
    expect(countOurs(settings.hooks!.UserPromptSubmit)).toBe(1);
    expect(fs.statSync(settingsPath()).mode & 0o777).toBe(0o600);
  });

  it("fails with a clear message when no base URL is known", async () => {
    const r = await runInstaller([], toolEnv());
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("--base-url");
    expect(fs.existsSync(path.join(home, ".agent-memory", "hook.sh"))).toBe(false);
  });

  it("does not touch a settings.json that is not valid JSON", async () => {
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(settingsPath(), "{ not json");
    const r = await runInstaller(["--base-url", proxy.origin], toolEnv());
    expect(r.code).toBe(1);
    expect(fs.readFileSync(settingsPath(), "utf8")).toBe("{ not json");
  });

  it("--session sends an Install report with the session id", async () => {
    writeSettings(OWN_SETTINGS());
    const r = await runInstaller(["--session", "sid-install-1"], toolEnv(), work);
    expect(r.code).toBe(0);
    expect(proxy.requests).toHaveLength(1);
    const req = proxy.requests[0];
    expect(req.url).toBe("/claude-code/default/v3/hook/report");
    expect(req.headers.authorization).toBe("Bearer sk-mem-test-token");
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      session_id: "sid-install-1",
      cwd: fs.realpathSync(work),
      hook_event: "Install",
      client: "claude-code",
    });
    expect(body.device_id).toBe(readDeviceId());
  });

  it("--session exits 1 when the server returns 500", async () => {
    proxy.setReportStatus(500);
    writeSettings(OWN_SETTINGS());
    const r = await runInstaller(["--session", "sid-install-2"], toolEnv(), work);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("HTTP 500");
    expect(r.stdout).not.toContain("installed");
  });

  it("--uninstall removes only our entries and hook.sh, keeping device.json", async () => {
    const original = OWN_SETTINGS();
    writeSettings(original);
    await runInstaller([], toolEnv());
    const id = readDeviceId();

    const r = await runInstaller(["--uninstall"], toolEnv());
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(r.stdout).toContain("removed");

    expect(readSettings()).toEqual(original);
    expect(fs.existsSync(path.join(home, ".agent-memory", "hook.sh"))).toBe(false);
    expect(readDeviceId()).toBe(id);
    // One backup from the install and one from the uninstall.
    expect(listBackups()).toHaveLength(2);
  });

  it("--uninstall drops the hooks key when only our entries existed", async () => {
    const original = { env: OWN_SETTINGS().env };
    writeSettings(original);
    await runInstaller([], toolEnv());
    expect(readSettings().hooks).toBeDefined();
    await runInstaller(["--uninstall"], toolEnv());
    expect(readSettings()).toEqual(original);
  });

  it("--uninstall leaves settings.json alone when our hook is not in it", async () => {
    const original = OWN_SETTINGS();
    writeSettings(original);
    const before = fs.readFileSync(settingsPath(), "utf8");
    const r = await runInstaller(["--uninstall"], toolEnv());
    expect(r.code).toBe(0);
    expect(fs.readFileSync(settingsPath(), "utf8")).toBe(before);
    expect(listBackups()).toHaveLength(0);
  });
});
