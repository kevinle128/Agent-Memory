// Tests for the AntiGravity (agy) part of the client hook files in assets/client-hooks.
// Each test runs the real scripts against a temporary HOME and a local HTTP server.
// The real ~/.gemini, ~/.zshrc, ~/.bashrc and ~/.agent-memory are never touched.
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

const KEY = "sk-mem-agy";
const INJECT = '{"injectSteps":[{"ephemeralMessage":"remembered: use pnpm"}]}';

let origin = "";
let server: http.Server;
const requests: Recorded[] = [];
// The answer of the mocked recall route: a status and a body.
let recallAnswer: { status: number; body: string } = { status: 200, body: INJECT };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/setup/hook.sh") {
        res.writeHead(200).end(fs.readFileSync(HOOK_SH));
        return;
      }
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (req.url?.endsWith("/v3/hook/recall")) {
        res.writeHead(recallAnswer.status, { "content-type": "application/json" }).end(recallAnswer.body);
        return;
      }
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; input?: string; cwd?: string }): Promise<RunResult> {
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

const HOOK_TOOLS = ["jq", "python3", "node", "sed"].filter((t) => t === "sed" || hasTool(t));
const INSTALL_TOOLS = ["jq", "python3", "node"].filter(hasTool);

const tmpDirs: string[] = [];
let home: string;
let work: string;

function mkTmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  requests.length = 0;
  recallAnswer = { status: 200, body: INJECT };
  home = mkTmp("am-home-");
  work = mkTmp("am-work-");
});

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SHELL: "/bin/zsh", ...extra };
  for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CODEX_HOME", "AGY_LLM_GATEWAY_URL", "AGENT_MEMORY_KEY"]) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}

function runInstaller(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return run("bash", ["-s", "--", ...args], { env, input: fs.readFileSync(INSTALL_SH, "utf8"), cwd: work });
}

function runHook(stdin: object, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return run("bash", [HOOK_SH, "antigravity"], { env, input: JSON.stringify(stdin) });
}

const gatewayUrl = () => `${origin}/antigravity/default/${KEY}`;
const hooksPath = () => path.join(home, ".gemini", "config", "hooks.json");
const zshrc = () => path.join(home, ".zshrc");
const bashrc = () => path.join(home, ".bashrc");
const urlFile = () => path.join(home, ".agent-memory", "antigravity.url");
const hookFile = () => path.join(home, ".agent-memory", "hook.sh");
const readHooks = () => JSON.parse(fs.readFileSync(hooksPath(), "utf8")) as Record<string, Record<string, unknown>>;
const BEGIN = "# >>> agent-memory: antigravity gateway >>>";
const END = "# <<< agent-memory: antigravity gateway <<<";
const backups = (dir: string, file: string) => fs.readdirSync(dir).filter((f) => f.startsWith(`${file}.agent-memory-backup-`));

const agyStdin = (over: Record<string, unknown> = {}) => ({
  conversationId: "conv-1",
  workspacePaths: [work, "/other"],
  transcriptPath: "/tmp/t.jsonl",
  modelName: "gemini-3.8-flash-medium",
  lastUserInput: "How do I build this?",
  hookEventName: "SessionStart",
  ...over,
});

describe.each(INSTALL_TOOLS)("install.sh --client antigravity with the %s JSON tool", (tool) => {
  const env = (extra: Record<string, string> = {}) => baseEnv({ AGENT_MEMORY_JSON_TOOL: tool, ...extra });

  it("creates hooks.json with both events, the URL file and the profile block", async () => {
    const r = await runInstaller(["--client", "antigravity", "--base-url", gatewayUrl()], env());
    expect(r.code, r.stderr).toBe(0);
    const hooks = readHooks();
    const cmd = `${hookFile()} antigravity`;
    expect(hooks["agent-memory"]).toEqual({
      SessionStart: [{ type: "command", command: cmd, timeout: 5 }],
      PreInvocation: [{ type: "command", command: cmd, timeout: 10 }],
    });
    expect(fs.statSync(hookFile()).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(urlFile(), "utf8").trim()).toBe(gatewayUrl());
    expect(fs.statSync(urlFile()).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(zshrc(), "utf8")).toBe(`${BEGIN}\nexport AGY_LLM_GATEWAY_URL='${gatewayUrl()}'\n${END}\n`);
    expect(r.stdout).toContain("/hooks");
    expect(fs.existsSync(bashrc())).toBe(false);
  });

  it("writes to ~/.bashrc when the shell is not zsh", async () => {
    const r = await runInstaller(["--client", "antigravity", "--base-url", gatewayUrl()], env({ SHELL: "/bin/bash" }));
    expect(r.code, r.stderr).toBe(0);
    expect(fs.readFileSync(bashrc(), "utf8")).toContain(`export AGY_LLM_GATEWAY_URL='${gatewayUrl()}'`);
    expect(fs.existsSync(zshrc())).toBe(false);
  });

  it("builds the URL from a base route and --key, and keeps an /analyse segment", async () => {
    const r = await runInstaller(["--client", "antigravity", "--base-url", `${origin}/antigravity/team-a`, "--key", KEY], env());
    expect(r.code, r.stderr).toBe(0);
    expect(fs.readFileSync(urlFile(), "utf8").trim()).toBe(`${origin}/antigravity/team-a/${KEY}`);
    const r2 = await runInstaller(["--client", "antigravity", "--base-url", `${origin}/antigravity/team-a/analyse/${KEY}`], env());
    expect(r2.code, r2.stderr).toBe(0);
    expect(fs.readFileSync(urlFile(), "utf8").trim()).toBe(`${origin}/antigravity/team-a/analyse/${KEY}`);
  });

  it("takes the key from AGENT_MEMORY_KEY and the URL from AGY_LLM_GATEWAY_URL", async () => {
    const r = await runInstaller(["--client", "antigravity", "--base-url", `${origin}/antigravity/default`], env({ AGENT_MEMORY_KEY: KEY }));
    expect(r.code, r.stderr).toBe(0);
    expect(fs.readFileSync(urlFile(), "utf8").trim()).toBe(gatewayUrl());
    fs.rmSync(path.join(home, ".agent-memory"), { recursive: true });
    const r2 = await runInstaller(["--client", "antigravity"], env({ AGY_LLM_GATEWAY_URL: gatewayUrl() }));
    expect(r2.code, r2.stderr).toBe(0);
    expect(fs.readFileSync(urlFile(), "utf8").trim()).toBe(gatewayUrl());
  });

  it("installs from the short gate command: base route plus AGENT_MEMORY_KEY, no session", async () => {
    const r = await runInstaller(["--client", "antigravity", "--base-url", `${origin}/antigravity/default`], env({ AGENT_MEMORY_KEY: KEY }));
    expect(r.code, r.stderr).toBe(0);
    expect(fs.readFileSync(urlFile(), "utf8").trim()).toBe(gatewayUrl());
    expect(readHooks()["agent-memory"]).toBeDefined();
    expect(r.stdout + r.stderr).not.toContain(KEY);
  });

  it("asks for the key on the terminal when none is given, and never prints it", async () => {
    const tty = path.join(mkTmp("am-tty-"), "tty");
    fs.writeFileSync(tty, `${KEY}\n`);
    const r = await runInstaller(["--client", "antigravity", "--base-url", `${origin}/antigravity/default`], env({ AGENT_MEMORY_TTY: tty }));
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("user key");
    expect(fs.readFileSync(urlFile(), "utf8").trim()).toBe(gatewayUrl());
    expect(r.stdout + r.stderr).not.toContain(KEY);
  });

  it("reuses the key of an earlier install of the same proxy and space, but not of another space", async () => {
    expect((await runInstaller(["--client", "antigravity", "--base-url", gatewayUrl()], env())).code).toBe(0);
    const same = await runInstaller(["--client", "antigravity", "--base-url", `${origin}/antigravity/default`], env({ AGENT_MEMORY_TTY: "/nonexistent" }));
    expect(same.code, same.stderr).toBe(0);
    const other = await runInstaller(["--client", "antigravity", "--base-url", `${origin}/antigravity/other`], env({ AGENT_MEMORY_TTY: "/nonexistent" }));
    expect(other.code).toBe(1);
    expect(other.stderr).toContain("no key");
  });

  it("fails with a clear message and changes nothing when there is no key or URL", async () => {
    const noKey = await runInstaller(["--client", "antigravity", "--base-url", `${origin}/antigravity/default`], env({ AGENT_MEMORY_TTY: "/nonexistent" }));
    expect(noKey.code).toBe(1);
    expect(noKey.stderr).toContain("no key");
    expect(noKey.stderr).toContain("--key");
    const noUrl = await runInstaller(["--client", "antigravity"], env());
    expect(noUrl.code).toBe(1);
    expect(noUrl.stderr).toContain("no gateway URL");
    expect(fs.existsSync(hooksPath())).toBe(false);
    expect(fs.existsSync(zshrc())).toBe(false);
  });

  it("is idempotent: a second install changes no file and makes no backup", async () => {
    const args = ["--client", "antigravity", "--base-url", gatewayUrl()];
    await runInstaller(args, env());
    const before = [hooksPath(), zshrc(), urlFile()].map((f) => fs.readFileSync(f, "utf8"));
    const r = await runInstaller(args, env());
    expect(r.code, r.stderr).toBe(0);
    expect([hooksPath(), zshrc(), urlFile()].map((f) => fs.readFileSync(f, "utf8"))).toEqual(before);
    expect(backups(path.dirname(hooksPath()), "hooks.json")).toHaveLength(0);
    expect(fs.readdirSync(home).filter((f) => f.includes("agent-memory-backup"))).toHaveLength(0);
    expect(Object.keys(readHooks())).toEqual(["agent-memory"]);
  });

  it("keeps the other hooks and the user's profile lines, with one backup of each file", async () => {
    fs.mkdirSync(path.dirname(hooksPath()), { recursive: true });
    const other = { enabled: false, SessionStart: [{ type: "command", command: "echo hi", timeout: 3 }] };
    fs.writeFileSync(hooksPath(), JSON.stringify({ mine: other }, null, 2));
    fs.writeFileSync(zshrc(), "export FOO=1\n");
    const r = await runInstaller(["--client", "antigravity", "--base-url", gatewayUrl()], env());
    expect(r.code, r.stderr).toBe(0);
    const hooks = readHooks();
    expect(hooks.mine).toEqual(other);
    expect(Object.keys(hooks["agent-memory"]).sort()).toEqual(["PreInvocation", "SessionStart"]);
    expect(backups(path.dirname(hooksPath()), "hooks.json")).toHaveLength(1);
    expect(backups(home, ".zshrc")).toHaveLength(1);
    expect(fs.readFileSync(zshrc(), "utf8").startsWith("export FOO=1\n\n" + BEGIN)).toBe(true);
  });

  it("replaces the profile block when the URL changes, and rewrites the hook command", async () => {
    await runInstaller(["--client", "antigravity", "--base-url", gatewayUrl()], env());
    const next = `${origin}/antigravity/other/${KEY}2`;
    const r = await runInstaller(["--client", "antigravity", "--base-url", next], env());
    expect(r.code, r.stderr).toBe(0);
    const text = fs.readFileSync(zshrc(), "utf8");
    expect(text.split(BEGIN)).toHaveLength(2);
    expect(text).toContain(`'${next}'`);
    expect(text).not.toContain(gatewayUrl());
    expect(fs.readFileSync(urlFile(), "utf8").trim()).toBe(next);
  });

  it("refuses an invalid hooks.json and leaves it alone", async () => {
    fs.mkdirSync(path.dirname(hooksPath()), { recursive: true });
    fs.writeFileSync(hooksPath(), "{not json");
    const r = await runInstaller(["--client", "antigravity", "--base-url", gatewayUrl()], env());
    expect(r.code).toBe(1);
    expect(fs.readFileSync(hooksPath(), "utf8")).toBe("{not json");
  });

  it("--uninstall removes only our entry, our profile block and the URL file", async () => {
    fs.mkdirSync(path.dirname(hooksPath()), { recursive: true });
    const other = { SessionStart: [{ type: "command", command: "echo hi", timeout: 3 }] };
    fs.writeFileSync(hooksPath(), JSON.stringify({ mine: other }, null, 2));
    fs.writeFileSync(zshrc(), "export FOO=1\n");
    await runInstaller(["--client", "antigravity", "--base-url", gatewayUrl()], env());
    const r = await runInstaller(["--client", "antigravity", "--uninstall"], env());
    expect(r.code, r.stderr).toBe(0);
    expect(readHooks()).toEqual({ mine: other });
    expect(fs.readFileSync(zshrc(), "utf8")).toBe("export FOO=1\n");
    expect(fs.existsSync(urlFile())).toBe(false);
    // Nothing else uses hook.sh, so it goes too.
    expect(fs.existsSync(hookFile())).toBe(false);
  });

  it("--uninstall on a machine without an install changes nothing", async () => {
    const r = await runInstaller(["--client", "antigravity", "--uninstall"], env());
    expect(r.code, r.stderr).toBe(0);
    expect(fs.existsSync(hooksPath())).toBe(false);
  });

  it("--session sends an Install report with the gateway key", async () => {
    const r = await runInstaller(["--client", "antigravity", "--base-url", gatewayUrl(), "--session", "sess-install"], env());
    expect(r.code, r.stderr).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/antigravity/default/v3/hook/report");
    expect(requests[0].headers["x-tdai-user-key"]).toBe(KEY);
    expect(JSON.parse(requests[0].body)).toMatchObject({ session_id: "sess-install", client: "antigravity" });
    expect(r.stdout).not.toContain(KEY);
  });
});

describe.each(HOOK_TOOLS)("hook.sh for antigravity with the %s JSON tool", (tool) => {
  const env = (extra: Record<string, string> = {}) =>
    baseEnv({ AGENT_MEMORY_JSON_TOOL: tool, AGY_LLM_GATEWAY_URL: gatewayUrl(), ...extra });

  it("SessionStart sends the mapped report and prints {}", async () => {
    const r = await runHook(agyStdin(), env());
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("{}\n");
    expect(r.stderr).toBe("");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/antigravity/default/v3/hook/report");
    expect(requests[0].headers["x-tdai-user-key"]).toBe(KEY);
    expect(JSON.parse(requests[0].body)).toMatchObject({
      session_id: "conv-1",
      cwd: work,
      client: "antigravity",
      hook_event: "SessionStart",
      hook_version: "3",
    });
    expect(JSON.parse(requests[0].body)).not.toHaveProperty("prompt");
  });

  it("PreInvocation number 0 calls recall and prints the injectSteps JSON", async () => {
    const r = await runHook(agyStdin({ hookEventName: "PreInvocation", invocationNum: 0, initialNumSteps: 0 }), env());
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${INJECT}\n`);
    const urls = requests.map((q) => q.url).sort();
    expect(urls).toEqual(["/antigravity/default/v3/hook/recall", "/antigravity/default/v3/hook/report"]);
    const recall = requests.find((q) => q.url.endsWith("/recall")) as Recorded;
    expect(JSON.parse(recall.body)).toMatchObject({
      session_id: "conv-1",
      hook_event: "PreInvocation",
      prompt: "How do I build this?",
    });
  });

  it("PreInvocation number 1 only reports and prints {}", async () => {
    const r = await runHook(agyStdin({ hookEventName: "PreInvocation", invocationNum: 1 }), env());
    expect(r.stdout).toBe("{}\n");
    expect(requests.map((q) => q.url)).toEqual(["/antigravity/default/v3/hook/report"]);
  });

  it("PreInvocation number 0 with an empty prompt does not call recall", async () => {
    const r = await runHook(agyStdin({ hookEventName: "PreInvocation", invocationNum: 0, lastUserInput: "" }), env());
    expect(r.stdout).toBe("{}\n");
    expect(requests.map((q) => q.url)).toEqual(["/antigravity/default/v3/hook/report"]);
  });

  it("prints {} when recall answers with something that is not an injectSteps object", async () => {
    recallAnswer = { status: 200, body: '{"hookSpecificOutput":{"additionalContext":"x"}}' };
    const r1 = await runHook(agyStdin({ hookEventName: "PreInvocation", invocationNum: 0 }), env());
    expect(r1.stdout).toBe("{}\n");
    recallAnswer = { status: 500, body: INJECT };
    const r2 = await runHook(agyStdin({ hookEventName: "PreInvocation", invocationNum: 0 }), env());
    expect(r2.stdout).toBe("{}\n");
  });

  it("AGENT_MEMORY_RECALL=0 turns recall off", async () => {
    const r = await runHook(agyStdin({ hookEventName: "PreInvocation", invocationNum: 0 }), env({ AGENT_MEMORY_RECALL: "0" }));
    expect(r.stdout).toBe("{}\n");
    expect(requests.map((q) => q.url)).toEqual(["/antigravity/default/v3/hook/report"]);
  });

  it("handles an /analyse segment before the key and posts to the plain route", async () => {
    const r = await runHook(agyStdin(), env({ AGY_LLM_GATEWAY_URL: `${origin}/antigravity/default/analyse/${KEY}` }));
    expect(r.stdout).toBe("{}\n");
    expect(requests[0].url).toBe("/antigravity/default/v3/hook/report");
    expect(requests[0].headers["x-tdai-user-key"]).toBe(KEY);
  });

  it("falls back to $PWD when workspacePaths is missing", async () => {
    const r = await run("bash", [HOOK_SH, "antigravity"], {
      env: env(),
      cwd: work,
      input: JSON.stringify({ conversationId: "c2", hookEventName: "SessionStart" }),
    });
    expect(r.stdout).toBe("{}\n");
    expect(JSON.parse(requests[0].body)).toMatchObject({ session_id: "c2", cwd: work });
  });

  it("reads the gateway URL from the installer file when the environment has none", async () => {
    fs.mkdirSync(path.join(home, ".agent-memory"), { recursive: true });
    fs.writeFileSync(urlFile(), `${gatewayUrl()}\n`);
    const e = env();
    delete e.AGY_LLM_GATEWAY_URL;
    const r = await runHook(agyStdin(), e);
    expect(r.stdout).toBe("{}\n");
    expect(requests[0].headers["x-tdai-user-key"]).toBe(KEY);
  });

  it("prints exactly {} and sends nothing when no gateway URL is known", async () => {
    const e = env();
    delete e.AGY_LLM_GATEWAY_URL;
    const r = await runHook(agyStdin(), e);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("{}\n");
    expect(requests).toHaveLength(0);
  });

  it("prints exactly one {} when the proxy is unreachable", async () => {
    const r = await runHook(agyStdin(), env({ AGY_LLM_GATEWAY_URL: `http://127.0.0.1:1/antigravity/default/${KEY}` }));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("{}\n");
  });

  it("prints {} on empty stdin", async () => {
    const r = await run("bash", [HOOK_SH, "antigravity"], { env: env(), input: "" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("{}\n");
  });
});
