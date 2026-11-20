// Tests for the Windows path of the AntiGravity (agy) installer. There is no Windows here,
// so AGENT_MEMORY_FAKE_WINDOWS=1 (a test-only switch of install.sh) selects the Windows
// branch, and a fake `cygpath` on PATH maps the temp HOME and a fake Git root to Windows paths.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = fileURLToPath(new URL("../../assets/client-hooks/", import.meta.url));
const INSTALL_SH = path.join(HOOKS_DIR, "install.sh");
const HOOK_SH = path.join(HOOKS_DIR, "hook.sh");
const KEY = "sk-mem-agy";
let GATEWAY = "";
let server: http.Server;

// The installer downloads hook.sh from the proxy origin.
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/setup/hook.sh") res.writeHead(200).end(fs.readFileSync(HOOK_SH));
    else res.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  GATEWAY = `http://127.0.0.1:${(server.address() as AddressInfo).port}/antigravity/default/${KEY}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// The fake maps: "/" -> the Windows Git root, $HOME/... -> the Windows home, the Windows Git
// root -> its backing directory (cygpath -u), anything else unchanged. Backslashes in the
// Windows form come from the slashes of the Unix path.
const FAKE_CYGPATH = `#!/bin/sh
mode="$1"; p="$2"
if [ "$mode" = "-w" ]; then
  if [ "$p" = "/" ]; then printf '%s\\n' "$FAKE_GIT_WIN"; exit 0; fi
  case "$p" in
    "$HOME"*) rest=$(printf '%s' "\${p#"$HOME"}" | tr '/' '\\\\'); printf '%s%s\\n' "$FAKE_HOME_WIN" "$rest"; exit 0 ;;
  esac
  printf '%s\\n' "$p"; exit 0
fi
if [ "$mode" = "-u" ]; then
  case "$p" in
    "$FAKE_GIT_WIN"*) rest=$(printf '%s' "\${p#"$FAKE_GIT_WIN"}" | tr '\\\\' '/'); printf '%s%s\\n' "$FAKE_GIT_DIR" "$rest"; exit 0 ;;
  esac
  printf '%s\\n' "$p"; exit 0
fi
exit 1
`;

const tmpDirs: string[] = [];
let home: string;
let work: string;
let fakeBin: string;
let gitDir: string;

function mkTmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  home = mkTmp("am-home-");
  work = mkTmp("am-work-");
  fakeBin = mkTmp("am-fakebin-");
  gitDir = mkTmp("am-gitroot-");
  fs.mkdirSync(path.join(gitDir, "bin"));
  fs.writeFileSync(path.join(gitDir, "bin", "bash.exe"), "");
  fs.writeFileSync(path.join(fakeBin, "cygpath"), FAKE_CYGPATH, { mode: 0o755 });
});

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function winEnv(opts: { tool: string; homeWin?: string; gitWin?: string; fake?: boolean }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    SHELL: "/bin/zsh",
    AGENT_MEMORY_JSON_TOOL: opts.tool,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    FAKE_HOME_WIN: opts.homeWin ?? "C:\\Users\\Admin",
    FAKE_GIT_WIN: opts.gitWin ?? "C:\\Git",
    FAKE_GIT_DIR: gitDir,
  };
  if (opts.fake !== false) env.AGENT_MEMORY_FAKE_WINDOWS = "1";
  for (const k of ["AGY_LLM_GATEWAY_URL", "AGENT_MEMORY_KEY"]) delete env[k];
  return env;
}

function installer(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-s", "--", ...args], { env, cwd: work });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(fs.readFileSync(INSTALL_SH, "utf8"));
  });
}

const hasTool = (name: string) => spawnSync("sh", ["-c", `command -v ${name}`]).status === 0;
const TOOLS = ["jq", "python3", "node"].filter(hasTool);

const install = (env: NodeJS.ProcessEnv) => installer(["--client", "antigravity", "--base-url", GATEWAY], env);
const hooksPath = () => path.join(home, ".gemini", "config", "hooks.json");
const launcherPath = () => path.join(home, ".agent-memory", "hook.cmd");
const readEntry = () => (JSON.parse(fs.readFileSync(hooksPath(), "utf8")) as Record<string, Record<string, Array<{ command: string }>>>)["agent-memory"];

describe.each(TOOLS)("install.sh --client antigravity on Windows with the %s JSON tool", (tool) => {
  it("writes the backslash hook.cmd command and a CRLF launcher with a quoted bash path", async () => {
    const r = await install(winEnv({ tool }));
    expect(r.code, r.stderr).toBe(0);
    const cmd = "C:\\Users\\Admin\\.agent-memory\\hook.cmd antigravity";
    const entry = readEntry();
    expect(entry.SessionStart[0].command).toBe(cmd);
    expect(entry.PreInvocation[0].command).toBe(cmd);

    const launcher = fs.readFileSync(launcherPath(), "utf8");
    // hook.sh goes by its POSIX path, so its $0 matches "$AM_DIR/hook.sh" and self_update runs.
    const hookPosix = path.join(home, ".agent-memory", "hook.sh");
    expect(launcher).toBe(`@echo off\r\n"C:\\Git\\bin\\bash.exe" "${hookPosix}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
    // hook.sh keeps LF endings.
    expect(fs.readFileSync(path.join(home, ".agent-memory", "hook.sh"), "utf8")).not.toContain("\r");
    expect(r.stdout).toContain("Restart agy");
    expect(r.stdout).toContain(launcherPath());
    expect(r.stdout + r.stderr).not.toContain(KEY);
  });

  it("quotes only the path when the Windows path has spaces", async () => {
    const r = await install(winEnv({ tool, homeWin: "C:\\Users\\Test User", gitWin: "C:\\Program Files\\Git" }));
    expect(r.code, r.stderr).toBe(0);
    expect(readEntry().SessionStart[0].command).toBe('"C:\\Users\\Test User\\.agent-memory\\hook.cmd" antigravity');
    expect(fs.readFileSync(launcherPath(), "utf8")).toContain(`"C:\\Program Files\\Git\\bin\\bash.exe" "${path.join(home, ".agent-memory", "hook.sh")}" %*\r\n`);
  });

  it("falls back to the bash on PATH when Git's bin\\bash.exe is missing", async () => {
    fs.rmSync(path.join(gitDir, "bin", "bash.exe"));
    const r = await install(winEnv({ tool }));
    expect(r.code, r.stderr).toBe(0);
    const launcher = fs.readFileSync(launcherPath(), "utf8");
    expect(launcher.split("\r\n")[1]).toMatch(/^".*bash" "[^"]*\/\.agent-memory\/hook\.sh" %\*$/);
  });

  it("replaces an old bare .sh entry and keeps the other hooks", async () => {
    fs.mkdirSync(path.dirname(hooksPath()), { recursive: true });
    const old = `C:/Users/Admin/.agent-memory/hook.sh antigravity`;
    const mine = { SessionStart: [{ type: "command", command: "echo hi", timeout: 3 }] };
    fs.writeFileSync(
      hooksPath(),
      JSON.stringify({
        mine,
        "agent-memory": {
          SessionStart: [{ type: "command", command: old, timeout: 5 }],
          PreInvocation: [{ type: "command", command: old, timeout: 10 }],
        },
      }),
    );
    const r = await install(winEnv({ tool }));
    expect(r.code, r.stderr).toBe(0);
    const doc = JSON.parse(fs.readFileSync(hooksPath(), "utf8"));
    expect(doc.mine).toEqual(mine);
    expect(doc["agent-memory"].SessionStart[0].command).toBe("C:\\Users\\Admin\\.agent-memory\\hook.cmd antigravity");
    expect(doc["agent-memory"].PreInvocation[0].command).toBe("C:\\Users\\Admin\\.agent-memory\\hook.cmd antigravity");
  });

  it("is idempotent on a second install", async () => {
    await install(winEnv({ tool }));
    const before = [hooksPath(), launcherPath()].map((f) => fs.readFileSync(f, "utf8"));
    const r = await install(winEnv({ tool }));
    expect(r.code, r.stderr).toBe(0);
    expect([hooksPath(), launcherPath()].map((f) => fs.readFileSync(f, "utf8"))).toEqual(before);
  });

  it("--uninstall removes hook.cmd, hook.sh and our entry, also for an old bare .sh entry", async () => {
    await install(winEnv({ tool }));
    const r = await installer(["--client", "antigravity", "--uninstall"], winEnv({ tool }));
    expect(r.code, r.stderr).toBe(0);
    expect(fs.existsSync(launcherPath())).toBe(false);
    expect(fs.existsSync(path.join(home, ".agent-memory", "hook.sh"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(hooksPath(), "utf8"))).toEqual({});

    fs.writeFileSync(
      hooksPath(),
      JSON.stringify({ "agent-memory": { SessionStart: [{ type: "command", command: "C:/x/.agent-memory/hook.sh antigravity" }] } }),
    );
    const r2 = await installer(["--client", "antigravity", "--uninstall"], winEnv({ tool }));
    expect(r2.code, r2.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(hooksPath(), "utf8"))).toEqual({});
  });

  it("another client's uninstall keeps hook.sh while the agy entry still uses the launcher", async () => {
    await install(winEnv({ tool }));
    const r = await installer(["--client", "codex", "--uninstall"], winEnv({ tool }));
    expect(r.code, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(home, ".agent-memory", "hook.sh"))).toBe(true);
  });

  it("without the Windows switch the command and output stay the POSIX form and no hook.cmd is written", async () => {
    const r = await install(winEnv({ tool, fake: false }));
    expect(r.code, r.stderr).toBe(0);
    expect(readEntry().SessionStart[0].command).toBe(`${path.join(home, ".agent-memory", "hook.sh")} antigravity`);
    expect(fs.existsSync(launcherPath())).toBe(false);
    expect(r.stdout).toContain("Open a new shell, run agy");
  });
});
