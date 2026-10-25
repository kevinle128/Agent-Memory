// Tests for the Codex and omp parts of the client hook files in assets/client-hooks.
// Each test runs the real scripts against a temporary HOME and a local HTTP
// server. A fake `codex` command stands in for `codex app-server`. The real
// ~/.codex, ~/.omp and ~/.agent-memory are never touched.
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
const PI_EXTENSION = path.join(HOOKS_DIR, "pi-extension.ts");

interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let origin = "";
let server: http.Server;
const requests: Recorded[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/setup/hook.sh") {
        res.writeHead(200).end(fs.readFileSync(HOOK_SH));
        return;
      }
      if (req.method === "GET" && req.url === "/setup/pi-extension.ts") {
        res.writeHead(200).end(fs.readFileSync(PI_EXTENSION));
        return;
      }
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
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

const tmpDirs: string[] = [];
let home: string;
let work: string;
let fakeBin: string;

function mkTmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

// A fake `codex`. On `app-server` it answers the hooks/list request: it reports
// the hooks whose command is in config.toml, "trusted" when the file holds a
// trusted_hash, and one error when the file holds the text BREAK-THE-CONFIG.
const FAKE_CODEX = `#!/usr/bin/env bash
[ "$1" = "app-server" ] || exit 1
[ -z "$FAKE_CODEX_ENV_LOG" ] || echo "CODEX_HOME=\${CODEX_HOME-<unset>}" >> "$FAKE_CODEX_ENV_LOG"
cfg="\${CODEX_HOME:-$HOME/.codex}/config.toml"
while IFS= read -r line; do
  case "$line" in
    *'"id":2'*)
      hooks=""
      errors=""
      if grep -q BREAK-THE-CONFIG "$cfg"; then errors='{"path":"x","message":"bad config"}'; fi
      status=untrusted
      if grep -q trusted_hash "$cfg"; then status=trusted; fi
      i=0
      for ev in session_start user_prompt_submit; do
        cmd=$(grep -m1 '^command = ' "$cfg" | sed -E 's/^command = "(.*)"$/\\1/')
        [ -z "$FAKE_CODEX_NO_HOOKS" ] || cmd=""
        [ -n "$cmd" ] || continue
        [ -z "$hooks" ] || hooks="$hooks,"
        hooks="$hooks{\\"key\\":\\"$cfg:$ev:0:0\\",\\"command\\":\\"$cmd\\",\\"currentHash\\":\\"sha256:hash-$ev\\",\\"trustStatus\\":\\"$status\\"}"
        i=$((i + 1))
      done
      printf '{"id":2,"result":{"data":[{"cwd":"/","hooks":[%s],"warnings":[],"errors":[%s]}]}}\\n' "$hooks" "$errors"
      exit 0
      ;;
  esac
done
`;

beforeEach(() => {
  requests.length = 0;
  home = mkTmp("am-home-");
  work = mkTmp("am-work-");
  fakeBin = mkTmp("am-bin-");
  fs.writeFileSync(path.join(fakeBin, "codex"), FAKE_CODEX, { mode: 0o755 });
});

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...extra };
  for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CODEX_HOME", "PI_CODING_AGENT_DIR"]) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}

// PATH with the fake codex first.
const withFakeCodex = () => baseEnv({ PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` });

// PATH without any directory that holds a real `codex`.
function withoutCodex(): NodeJS.ProcessEnv {
  const dirs = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((d) => d && !fs.existsSync(path.join(d, "codex")));
  return baseEnv({ PATH: dirs.join(path.delimiter) });
}

function runInstaller(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return run("bash", ["-s", "--", ...args], { env, input: fs.readFileSync(INSTALL_SH, "utf8"), cwd: work });
}

function runHook(stdin: object, env: NodeJS.ProcessEnv, client: string): Promise<RunResult> {
  return run("bash", [HOOK_SH, client], { env, input: JSON.stringify(stdin) });
}

const codexConfigPath = () => path.join(home, ".codex", "config.toml");
const USER_CONFIG = `# user config
model = "gpt-x"
model_provider = "team-proxy"

[model_providers.team-proxy]
name = "TDAI team-proxy"
wire_api = "responses"
base_url = "{ORIGIN}/codex/default"
experimental_bearer_token = "sk-mem-codex"
`;

function writeCodexConfig(content = USER_CONFIG): void {
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(codexConfigPath(), content.replaceAll("{ORIGIN}", origin));
}

const backups = (dir: string, file: string) => fs.readdirSync(dir).filter((f) => f.startsWith(`${file}.agent-memory-backup-`));

describe("hook.sh for codex", () => {
  it("reports to the active provider with the bearer token and prints nothing", async () => {
    writeCodexConfig();
    const r = await runHook({ session_id: "s1", cwd: work, hook_event_name: "SessionStart" }, baseEnv(), "codex");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/codex/default/v3/hook/report");
    expect(requests[0].headers.authorization).toBe("Bearer sk-mem-codex");
    const body = JSON.parse(requests[0].body) as Record<string, unknown>;
    expect(body).toMatchObject({ session_id: "s1", cwd: work, client: "codex", hook_event: "SessionStart" });
  });

  it("sends the x-tdai-user-key header for a provider with its own login", async () => {
    writeCodexConfig(USER_CONFIG.replace(
      'experimental_bearer_token = "sk-mem-codex"',
      'requires_openai_auth = true\nhttp_headers = { "x-tdai-user-key" = "sk-mem-own" }',
    ));
    const r = await runHook({ session_id: "s2", cwd: work, hook_event_name: "UserPromptSubmit" }, baseEnv(), "codex");
    expect(r.code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers["x-tdai-user-key"]).toBe("sk-mem-own");
    expect(requests[0].headers.authorization).toBeUndefined();
  });

  it("reads the token from the env var named by env_key", async () => {
    writeCodexConfig(USER_CONFIG.replace('experimental_bearer_token = "sk-mem-codex"', 'env_key = "AM_TEST_CODEX_KEY"'));
    await runHook({ session_id: "s3", cwd: work }, baseEnv({ AM_TEST_CODEX_KEY: "sk-from-env" }), "codex");
    expect(requests[0].headers.authorization).toBe("Bearer sk-from-env");
  });

  it("sends nothing when the active provider is not an Agent-Memory Codex route", async () => {
    writeCodexConfig(USER_CONFIG.replace("/codex/default", "/v1"));
    const r = await runHook({ session_id: "s4", cwd: work }, baseEnv(), "codex");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(requests).toHaveLength(0);
  });

  it("exits 0 silently when there is no Codex config", async () => {
    const r = await runHook({ session_id: "s5", cwd: work }, baseEnv(), "codex");
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
    expect(requests).toHaveLength(0);
  });

  it("posts to the Codex route when base_url ends in /v1 or holds the cost-guard marker", async () => {
    for (const suffix of ["/v1", "/cost-guard", "/cost-guard/v1"]) {
      requests.length = 0;
      writeCodexConfig(USER_CONFIG.replace("/codex/default", `/codex/default${suffix}`));
      await runHook({ session_id: "s7", cwd: work }, baseEnv(), "codex");
      expect(requests.map((r) => r.url)).toEqual(["/codex/default/v3/hook/report"]);
    }
    requests.length = 0;
    writeCodexConfig(USER_CONFIG.replace("/codex/default", "/cost-guard/codex/default"));
    await runHook({ session_id: "s7", cwd: work }, baseEnv(), "codex");
    expect(requests.map((r) => r.url)).toEqual(["/codex/default/v3/hook/report"]);
  });

  it("reads the key from the env var named in an inline env_http_headers", async () => {
    writeCodexConfig(USER_CONFIG.replace(
      'experimental_bearer_token = "sk-mem-codex"',
      'env_http_headers = { "x-tdai-user-key" = "AM_TEST_HDR" }',
    ));
    await runHook({ session_id: "s8", cwd: work }, baseEnv({ AM_TEST_HDR: "sk-from-header-env" }), "codex");
    expect(requests).toHaveLength(1);
    expect(requests[0].headers["x-tdai-user-key"]).toBe("sk-from-header-env");
    // The variable name is never sent as the key.
    expect(JSON.stringify(requests[0].headers)).not.toContain("AM_TEST_HDR");
  });

  it("sends nothing when the env var of env_http_headers is not set", async () => {
    writeCodexConfig(USER_CONFIG.replace(
      'experimental_bearer_token = "sk-mem-codex"',
      'env_http_headers = { "x-tdai-user-key" = "AM_TEST_UNSET_VAR" }',
    ));
    await runHook({ session_id: "s8", cwd: work }, baseEnv(), "codex");
    expect(requests).toHaveLength(0);
  });

  it("reads the http_headers and env_http_headers subtables of the provider", async () => {
    const base = USER_CONFIG.replace('experimental_bearer_token = "sk-mem-codex"\n', "");
    writeCodexConfig(`${base}\n[model_providers.team-proxy.http_headers]\n"x-tdai-user-key" = "sk-sub-literal"\n`);
    await runHook({ session_id: "s9", cwd: work }, baseEnv(), "codex");
    expect(requests[0].headers["x-tdai-user-key"]).toBe("sk-sub-literal");

    requests.length = 0;
    writeCodexConfig(`${base}\n[model_providers.team-proxy.env_http_headers]\nx-tdai-user-key = "AM_TEST_SUB_ENV"\n`);
    await runHook({ session_id: "s9", cwd: work }, baseEnv({ AM_TEST_SUB_ENV: "sk-sub-env" }), "codex");
    expect(requests[0].headers["x-tdai-user-key"]).toBe("sk-sub-env");
  });

  it("uses the provider of the active profile", async () => {
    writeCodexConfig(`profile = "work"\n${USER_CONFIG.replace("/codex/default", "/v1")}
[model_providers.other]
base_url = "{ORIGIN}/codex/team2"
experimental_bearer_token = "sk-mem-other"

[profiles.work]
model_provider = "other"
`);
    await runHook({ session_id: "s10", cwd: work }, baseEnv(), "codex");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/codex/team2/v3/hook/report");
    expect(requests[0].headers.authorization).toBe("Bearer sk-mem-other");
  });

  it("prefers the x-tdai-user-key header over the bearer token, like the proxy", async () => {
    writeCodexConfig(USER_CONFIG.replace(
      'experimental_bearer_token = "sk-mem-codex"',
      'experimental_bearer_token = "sk-mem-codex"\nhttp_headers = { "x-tdai-user-key" = "sk-mem-header" }',
    ));
    await runHook({ session_id: "s11", cwd: work }, baseEnv(), "codex");
    expect(requests[0].headers["x-tdai-user-key"]).toBe("sk-mem-header");
    expect(requests[0].headers.authorization).toBeUndefined();
  });

  it("honors CODEX_HOME", async () => {
    const codexHome = mkTmp("am-codexhome-");
    fs.writeFileSync(path.join(codexHome, "config.toml"), USER_CONFIG.replaceAll("{ORIGIN}", origin));
    await runHook({ session_id: "s6", cwd: work }, baseEnv({ CODEX_HOME: codexHome }), "codex");
    expect(requests).toHaveLength(1);
  });
});

describe("install.sh --client codex", () => {
  it("adds the hooks and the trust state, keeps the user config and makes one backup", async () => {
    writeCodexConfig();
    const r = await runInstaller(["--client", "codex"], withFakeCodex());
    expect(r.code).toBe(0);
    const text = fs.readFileSync(codexConfigPath(), "utf8");
    // Both blocks sit after the top-level keys and before the first table, where
    // Codex does not append its own tables.
    const first = text.indexOf("[model_providers.team-proxy]");
    expect(text.startsWith('# user config\nmodel = "gpt-x"\nmodel_provider = "team-proxy"\n\n\n# >>> agent-memory hooks >>>')).toBe(true);
    expect(text.indexOf("# <<< agent-memory hook trust <<<")).toBeLessThan(first);
    expect(text.slice(first)).toBe(USER_CONFIG.replaceAll("{ORIGIN}", origin).slice(USER_CONFIG.indexOf("[model_providers.team-proxy]")));
    expect(fs.readFileSync(path.join(home, ".agent-memory", "codex-hooks.block"), "utf8")).toContain("# >>> agent-memory hooks >>>");
    expect(fs.readFileSync(path.join(home, ".agent-memory", "codex-trust.block"), "utf8")).toContain("trusted_hash");
    const cmd = `${home}/.agent-memory/hook.sh codex`;
    expect(text.split(`command = "${cmd}"`)).toHaveLength(3);
    expect(text).toContain("[[hooks.SessionStart]]");
    expect(text).toContain("[[hooks.UserPromptSubmit]]");
    expect(text).toContain(`[hooks.state."${codexConfigPath()}:session_start:0:0"]`);
    expect(text).toContain('trusted_hash = "sha256:hash-user_prompt_submit"');
    expect(backups(path.join(home, ".codex"), "config.toml")).toHaveLength(1);
    expect(fs.statSync(path.join(home, ".agent-memory", "hook.sh")).mode & 0o111).not.toBe(0);
  });

  it("changes nothing and makes no backup on a second install", async () => {
    writeCodexConfig();
    await runInstaller(["--client", "codex"], withFakeCodex());
    const first = fs.readFileSync(codexConfigPath(), "utf8");
    fs.rmSync(path.join(home, ".codex", fs.readdirSync(path.join(home, ".codex")).find((f) => f.includes("backup")) as string));
    const r = await runInstaller(["--client", "codex"], withFakeCodex());
    expect(r.code).toBe(0);
    expect(fs.readFileSync(codexConfigPath(), "utf8")).toBe(first);
    expect(backups(path.join(home, ".codex"), "config.toml")).toHaveLength(0);
  });

  it("creates config.toml when it is missing and takes the URL from --base-url", async () => {
    const r = await runInstaller(["--client", "codex", "--base-url", `${origin}/codex/default`], withFakeCodex());
    expect(r.code).toBe(0);
    expect(fs.readFileSync(codexConfigPath(), "utf8")).toContain("[[hooks.SessionStart]]");
  });

  it("runs codex with the caller's CODEX_HOME, so trust keys match a normal codex run", async () => {
    // Codex resolves the config path in each hook key differently when
    // CODEX_HOME is set, so the installer must not set it on its own.
    writeCodexConfig();
    const log = path.join(work, "codex-env.log");
    const r = await runInstaller(["--client", "codex"], { ...withFakeCodex(), FAKE_CODEX_ENV_LOG: log });
    expect(r.code).toBe(0);
    const lines = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(new Set(lines)).toEqual(new Set(["CODEX_HOME=<unset>"]));
  });

  it("adds the hooks without trust and says so when the codex command is missing", async () => {
    writeCodexConfig();
    const r = await runInstaller(["--client", "codex"], withoutCodex());
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("/hooks");
    const text = fs.readFileSync(codexConfigPath(), "utf8");
    expect(text).toContain("[[hooks.SessionStart]]");
    expect(text).not.toContain("trusted_hash");
  });

  it("restores the config and fails when Codex cannot load the new config", async () => {
    // The fake reports an error when the config holds this text.
    writeCodexConfig(`${USER_CONFIG}\n# BREAK-THE-CONFIG\n`);
    const before = fs.readFileSync(codexConfigPath(), "utf8");
    const r = await runInstaller(["--client", "codex"], withFakeCodex());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("restored");
    expect(fs.readFileSync(codexConfigPath(), "utf8")).toBe(before);
  });

  it("does not add a second entry when the hook is already in the config by hand", async () => {
    const cmd = `${home}/.agent-memory/hook.sh codex`;
    writeCodexConfig(`${USER_CONFIG}\n[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "${cmd}"\n`);
    await runInstaller(["--client", "codex"], withFakeCodex());
    expect(fs.readFileSync(codexConfigPath(), "utf8").split(`command = "${cmd}"`)).toHaveLength(2);
  });

  const trustHeader = (suffix: string) => `[hooks.state."${codexConfigPath()}:${suffix}"]`;
  const configText = () => fs.readFileSync(codexConfigPath(), "utf8");
  const LATER_TABLES = '[mcp_servers.foo]\ncommand = "foo"\n\n[projects."/work/demo"]\ntrust_level = "trusted"\n';

  it("keeps tables that Codex adds after the install, through a second install and an uninstall", async () => {
    writeCodexConfig();
    await runInstaller(["--client", "codex"], withFakeCodex());
    fs.appendFileSync(codexConfigPath(), `\n${LATER_TABLES}`);
    const r = await runInstaller(["--client", "codex"], withFakeCodex());
    expect(r.code).toBe(0);
    expect(configText()).toContain(LATER_TABLES);
    const u = await runInstaller(["--client", "codex", "--uninstall"], withFakeCodex());
    expect(u.code).toBe(0);
    expect(configText()).toBe(`${USER_CONFIG.replaceAll("{ORIGIN}", origin)}\n${LATER_TABLES}`);
  });

  it("keeps a trust table that Codex writes next to our block but outside it", async () => {
    writeCodexConfig();
    await runInstaller(["--client", "codex"], withFakeCodex());
    const foreign = '[hooks.state."/other/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:foreign"\n';
    fs.writeFileSync(codexConfigPath(), configText().replace("# <<< agent-memory hook trust <<<\n", `# <<< agent-memory hook trust <<<\n${foreign}`));
    expect((await runInstaller(["--client", "codex"], withFakeCodex())).code).toBe(0);
    expect(configText()).toContain(foreign);
    expect((await runInstaller(["--client", "codex", "--uninstall"], withFakeCodex())).code).toBe(0);
    expect(configText()).toContain(foreign);
    expect(configText()).not.toContain("agent-memory");
  });

  it.each([
    ["install", ["--client", "codex"]],
    ["uninstall", ["--client", "codex", "--uninstall"]],
  ])("%s refuses and changes nothing when a table was added inside the trust block", async (_name, args) => {
    writeCodexConfig();
    await runInstaller(["--client", "codex"], withFakeCodex());
    const foreign = '[hooks.state."/other/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:foreign"\n';
    fs.writeFileSync(codexConfigPath(), configText().replace("# <<< agent-memory hook trust <<<", `${foreign}# <<< agent-memory hook trust <<<`));
    const before = configText();
    const r = await runInstaller(args, withFakeCodex());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Nothing was changed");
    expect(r.stderr).toContain("/other/hooks.json:stop:0:0");
    expect(configText()).toBe(before);
  });

  it.each([
    ["install", ["--client", "codex"]],
    ["uninstall", ["--client", "codex", "--uninstall"]],
  ])("%s refuses and changes nothing when an end marker is missing", async (_name, args) => {
    writeCodexConfig();
    await runInstaller(["--client", "codex"], withFakeCodex());
    fs.writeFileSync(codexConfigPath(), `${configText().replace("# <<< agent-memory hooks <<<\n", "")}\n${LATER_TABLES}`);
    const before = configText();
    const r = await runInstaller(args, withFakeCodex());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("broken hooks block");
    expect(configText()).toBe(before);
    expect(configText()).toContain(LATER_TABLES);
  });

  it("refuses when a begin marker is repeated", async () => {
    writeCodexConfig();
    await runInstaller(["--client", "codex"], withFakeCodex());
    fs.appendFileSync(codexConfigPath(), "\n# >>> agent-memory hook trust >>>\n");
    const before = configText();
    const r = await runInstaller(["--client", "codex", "--uninstall"], withFakeCodex());
    expect(r.code).toBe(1);
    expect(configText()).toBe(before);
  });

  it("refuses a changed hooks block when the saved copy is gone", async () => {
    writeCodexConfig();
    await runInstaller(["--client", "codex"], withFakeCodex());
    fs.rmSync(path.join(home, ".agent-memory", "codex-hooks.block"));
    fs.writeFileSync(codexConfigPath(), configText().replace("# <<< agent-memory hooks <<<", '[mcp_servers.inside]\ncommand = "x"\n# <<< agent-memory hooks <<<'));
    const before = configText();
    const r = await runInstaller(["--client", "codex", "--uninstall"], withFakeCodex());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("mcp_servers.inside");
    expect(configText()).toBe(before);
  });

  it("restores the config and fails when Codex does not list the hooks", async () => {
    writeCodexConfig();
    const before = configText();
    const r = await runInstaller(["--client", "codex"], { ...withFakeCodex(), FAKE_CODEX_NO_HOOKS: "1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("restored");
    expect(configText()).toBe(before);
  });

  it("--uninstall removes a trust table that Codex wrote itself, when HOME has a space", async () => {
    home = mkTmp("am home with space-");
    const userTrust = `${trustHeader("session_start:0:0")}\ntrusted_hash = "sha256:by-user"\n`;
    writeCodexConfig(`${USER_CONFIG}\n${userTrust}`);
    expect((await runInstaller(["--client", "codex"], withFakeCodex())).code).toBe(0);
    const r = await runInstaller(["--client", "codex", "--uninstall"], withFakeCodex());
    expect(r.code).toBe(0);
    expect(configText()).not.toContain("sha256:by-user");
    expect(configText()).not.toContain("agent-memory");
  });

  it("--uninstall removes only our blocks and hook.sh", async () => {
    writeCodexConfig();
    await runInstaller(["--client", "codex"], withFakeCodex());
    const r = await runInstaller(["--client", "codex", "--uninstall"], withFakeCodex());
    expect(r.code).toBe(0);
    expect(fs.readFileSync(codexConfigPath(), "utf8")).toBe(USER_CONFIG.replaceAll("{ORIGIN}", origin));
    expect(fs.existsSync(path.join(home, ".agent-memory", "hook.sh"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".agent-memory", "device.json"))).toBe(true);
  });

  it("--uninstall keeps hook.sh while the Claude Code settings still use it", async () => {
    writeCodexConfig();
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `${origin}/claude-code/default` } }));
    await runInstaller(["--client", "claude-code"], withFakeCodex());
    await runInstaller(["--client", "codex"], withFakeCodex());
    await runInstaller(["--client", "codex", "--uninstall"], withFakeCodex());
    expect(fs.existsSync(path.join(home, ".agent-memory", "hook.sh"))).toBe(true);
    expect(fs.readFileSync(codexConfigPath(), "utf8")).not.toContain("agent-memory");
  });

  it("--session sends an Install report through the Codex provider", async () => {
    writeCodexConfig();
    const r = await runInstaller(["--client", "codex", "--session", "sess-codex-1"], withFakeCodex());
    expect(r.code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/codex/default/v3/hook/report");
    expect(JSON.parse(requests[0].body)).toMatchObject({ session_id: "sess-codex-1", client: "codex", hook_event: "Install" });
  });
});

const OMP_ROUTE = () => `${origin}/omp/default/v1`;

describe("install.sh --client pi (retired)", () => {
  it("exits with an error that names omp and changes nothing", async () => {
    const r = await runInstaller(["--client", "pi"], baseEnv());
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("pi is no longer supported");
    expect(r.stderr).toContain("--client omp");
    expect(fs.existsSync(path.join(home, ".pi"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".agent-memory"))).toBe(false);
  });

  it("--uninstall still removes the extension of an earlier pi install", async () => {
    const ext = path.join(home, ".pi", "agent", "extensions", "agent-memory.ts");
    fs.mkdirSync(path.dirname(ext), { recursive: true });
    fs.writeFileSync(ext, "// old");
    const r = await runInstaller(["--client", "pi", "--uninstall"], baseEnv());
    expect(r.code).toBe(0);
    expect(fs.existsSync(ext)).toBe(false);
  });
});

// ── install.sh --client omp ──────────────────────────────────────────────────

const ompDir = () => path.join(home, ".omp", "agent");
const ompRoute = () => `${origin}/omp/default/v1`;
const piRoute = () => `${origin}/pi/default/v1`;
const ompModelsPath = (file = "models.yml") => path.join(ompDir(), file);
const OMP_KEY = "sk-mem-omp-secret-key";

function ompYaml(provider: string, extra = ""): string {
  return [
    "providers:",
    "  am-proxy:",
    `    baseUrl: ${ompRoute()}`,
    `    apiKey: ${provider}`,
    "    api: openai-completions",
    ...(extra ? [extra] : []),
    "    models:",
    "      - id: m1",
    "  other:",
    "    baseUrl: https://api.example.com/v1",
    "    apiKey: OTHER_KEY",
    "",
  ].join("\n");
}

function writeOmpModels(content: string, file = "models.yml"): void {
  fs.mkdirSync(ompDir(), { recursive: true });
  fs.writeFileSync(ompModelsPath(file), content);
}

const readOmpModels = (file = "models.yml") => fs.readFileSync(ompModelsPath(file), "utf8");
const FLAG = "    compat:\n      supportsPromptCacheKey: true\n";

describe("install.sh --client omp", () => {
  it("stops with an instruction when there is no models file and no --base-url", async () => {
    const r = await runInstaller(["--client", "omp"], baseEnv());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("models.yml");
    expect(r.stderr).toContain("supportsPromptCacheKey");
    expect(fs.existsSync(path.join(ompDir(), "extensions", "agent-memory.ts"))).toBe(false);
  });

  it("installs the extension and explains when the models file is missing but --base-url is given", async () => {
    const r = await runInstaller(["--client", "omp", "--base-url", ompRoute()], baseEnv());
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("models.yml does not exist");
    expect(fs.readFileSync(path.join(ompDir(), "extensions", "agent-memory.ts"), "utf8")).toBe(fs.readFileSync(PI_EXTENSION, "utf8"));
  });

  it("leaves a file without a proxy provider alone and says so", async () => {
    const doc = "providers:\n  other:\n    baseUrl: https://api.example.com/v1\n    apiKey: X\n";
    writeOmpModels(doc);
    const r = await runInstaller(["--client", "omp", "--base-url", origin], baseEnv());
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("no provider");
    expect(readOmpModels()).toBe(doc);
    expect(backups(ompDir(), "models.yml")).toHaveLength(0);
  });

  it("sets the flag on the proxy provider only, with one backup, and installs the extension", async () => {
    const before = ompYaml("AM_KEY");
    writeOmpModels(before);
    const r = await runInstaller(["--client", "omp"], baseEnv());
    expect(r.code).toBe(0);
    const text = readOmpModels();
    expect(text.split("supportsPromptCacheKey")).toHaveLength(2);
    expect(text.replace(FLAG, "")).toBe(before);
    expect(text).toContain(FLAG);
    expect(backups(ompDir(), "models.yml")).toHaveLength(1);
    expect(fs.existsSync(path.join(ompDir(), "extensions", "agent-memory.ts"))).toBe(true);
  });

  it("flips a flag that is false and adds the key to an existing compat block", async () => {
    writeOmpModels(ompYaml("K", "    compat:\n      supportsStore: false\n      supportsPromptCacheKey: false # old"));
    await runInstaller(["--client", "omp"], baseEnv());
    expect(readOmpModels()).toContain("      supportsPromptCacheKey: true\n");
    expect(readOmpModels()).not.toContain("false # old");
    writeOmpModels(ompYaml("K", "    compat:\n      supportsStore: false"));
    await runInstaller(["--client", "omp"], baseEnv());
    expect(readOmpModels()).toContain("    compat:\n      supportsPromptCacheKey: true\n      supportsStore: false");
  });

  it("does not rewrite the file or make a backup when the flag is already set", async () => {
    const doc = ompYaml("K", "    compat:\n      supportsPromptCacheKey: true # keep");
    writeOmpModels(doc);
    const r = await runInstaller(["--client", "omp"], baseEnv());
    expect(r.code).toBe(0);
    expect(readOmpModels()).toBe(doc);
    expect(backups(ompDir(), "models.yml")).toHaveLength(0);
  });

  it("makes no second backup and changes nothing on a second run", async () => {
    writeOmpModels(ompYaml("K"));
    await runInstaller(["--client", "omp"], baseEnv());
    const first = readOmpModels();
    const r = await runInstaller(["--client", "omp"], baseEnv());
    expect(r.code).toBe(0);
    expect(readOmpModels()).toBe(first);
    expect(backups(ompDir(), "models.yml")).toHaveLength(1);
  });

  it("keeps a file with trailing blank lines byte for byte when nothing changes", async () => {
    const doc = ompYaml("K", "    compat:\n      supportsPromptCacheKey: true") + "\n\n\n";
    writeOmpModels(doc);
    await runInstaller(["--client", "omp"], baseEnv());
    expect(readOmpModels()).toBe(doc);
    expect(backups(ompDir(), "models.yml")).toHaveLength(0);
  });

  it("does not edit an inline compat value and tells the user", async () => {
    const doc = ompYaml("K", "    compat: { supportsStore: false }");
    writeOmpModels(doc);
    const r = await runInstaller(["--client", "omp"], baseEnv());
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("not in block style");
    expect(readOmpModels()).toBe(doc);
  });

  it("reads models.yaml when models.yml does not exist", async () => {
    writeOmpModels(ompYaml("K"), "models.yaml");
    const r = await runInstaller(["--client", "omp"], baseEnv());
    expect(r.code).toBe(0);
    expect(readOmpModels("models.yaml")).toContain("supportsPromptCacheKey: true");
  });

  it("refuses a file with CRLF line endings and leaves it alone", async () => {
    const doc = ompYaml("K").replaceAll("\n", "\r\n");
    writeOmpModels(doc);
    const r = await runInstaller(["--client", "omp"], baseEnv());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("CRLF");
    expect(readOmpModels()).toBe(doc);
  });

  it("honors PI_CODING_AGENT_DIR", async () => {
    const dir = mkTmp("am-ompdir-");
    fs.writeFileSync(path.join(dir, "models.yml"), ompYaml("K"));
    const r = await runInstaller(["--client", "omp"], baseEnv({ PI_CODING_AGENT_DIR: dir }));
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(dir, "extensions", "agent-memory.ts"))).toBe(true);
  });

  const sessionReports = () => requests.filter((q) => q.url.endsWith("/v3/hook/report"));

  it("--session reports through the omp route with an apiKey that is an environment variable, and never prints the key", async () => {
    writeOmpModels(ompYaml("AM_E2E_KEY"));
    const r = await runInstaller(["--client", "omp", "--session", "01a16eab-0b03-708d-8d4f-4bba152cad8e"], baseEnv({ AM_E2E_KEY: OMP_KEY }));
    expect(r.code).toBe(0);
    const reports = sessionReports();
    expect(reports).toHaveLength(1);
    expect(reports[0].url).toBe("/omp/default/v3/hook/report");
    expect(reports[0].headers.authorization).toBe(`Bearer ${OMP_KEY}`);
    expect(JSON.parse(reports[0].body)).toMatchObject({ session_id: "01a16eab-0b03-708d-8d4f-4bba152cad8e", client: "omp", hook_event: "Install" });
    expect(r.stdout + r.stderr).not.toContain(OMP_KEY);
  });

  it("--session reports with a literal apiKey, and never prints the key", async () => {
    writeOmpModels(ompYaml(OMP_KEY));
    const r = await runInstaller(["--client", "omp", "--session", "sid-1"], baseEnv());
    expect(r.code).toBe(0);
    expect(sessionReports()[0].headers.authorization).toBe(`Bearer ${OMP_KEY}`);
    expect(r.stdout + r.stderr).not.toContain(OMP_KEY);
  });

  it("--session refuses an apiKey that is a command and sends no report", async () => {
    writeOmpModels(ompYaml('"!op read op://dev/key"'));
    const r = await runInstaller(["--client", "omp", "--session", "sid-1"], baseEnv());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("command");
    expect(sessionReports()).toHaveLength(0);
  });

  describe("a baseUrl on the retired pi route", () => {
    const withPi = () => ompYaml("K").replace(ompRoute(), piRoute());

    it("moves /pi/ to /omp/ after an equal backup, and prints the count and the backup path", async () => {
      const before = withPi();
      writeOmpModels(before);
      const r = await runInstaller(["--client", "omp", "--base-url", origin], baseEnv());
      expect(r.code).toBe(0);
      const copies = backups(ompDir(), "models.yml");
      expect(copies).toHaveLength(1);
      expect(fs.readFileSync(path.join(ompDir(), copies[0]), "utf8")).toBe(before);
      const after = readOmpModels();
      expect(after).toContain(`baseUrl: ${ompRoute()}`);
      expect(after.replace(FLAG, "")).toBe(before.replace(piRoute(), ompRoute()));
      expect(r.stdout).toContain("Moved 1 baseUrl line(s)");
      expect(r.stdout).toContain(path.join(ompDir(), copies[0]));
    });

    it("changes nothing and makes no new backup on a second run", async () => {
      writeOmpModels(withPi());
      await runInstaller(["--client", "omp", "--base-url", origin], baseEnv());
      const first = readOmpModels();
      const r = await runInstaller(["--client", "omp", "--base-url", origin], baseEnv());
      expect(r.code).toBe(0);
      expect(readOmpModels()).toBe(first);
      expect(backups(ompDir(), "models.yml")).toHaveLength(1);
      expect(r.stdout).not.toContain("Moved");
    });

    it("makes no backup for a file without a /pi/ route", async () => {
      const doc = ompYaml("K", "    compat:\n      supportsPromptCacheKey: true");
      writeOmpModels(doc);
      const r = await runInstaller(["--client", "omp", "--base-url", origin], baseEnv());
      expect(r.code).toBe(0);
      expect(readOmpModels()).toBe(doc);
      expect(backups(ompDir(), "models.yml")).toHaveLength(0);
    });

    it("moves only the path after the origin of a proxy baseUrl line", async () => {
      const doc = withPi()
        + "  third:\n    baseUrl: https://api.example.com/pi/x\n    note: " + piRoute() + "\n"
        + "  fourth:\n    baseUrl: https://api.example.com/pi/x/v1\n";
      writeOmpModels(doc);
      const r = await runInstaller(["--client", "omp", "--base-url", origin], baseEnv());
      expect(r.code).toBe(0);
      const after = readOmpModels();
      expect(after).toContain("baseUrl: https://api.example.com/pi/x\n");
      expect(after).toContain("baseUrl: https://api.example.com/pi/x/v1\n");
      expect(after).toContain(`note: ${piRoute()}`);
      expect(after).toContain(`baseUrl: ${ompRoute()}`);
    });

    it("leaves a pi route of a foreign origin alone, with and without --base-url", async () => {
      const foreign = "https://other-proxy.example.com/pi/default/v1";
      const doc = withPi() + `  foreign:\n    baseUrl: ${foreign}\n`;
      writeOmpModels(doc);
      const given = await runInstaller(["--client", "omp", "--base-url", origin], baseEnv());
      expect(given.code).toBe(0);
      expect(readOmpModels()).toContain(`baseUrl: ${foreign}\n`);
      expect(readOmpModels()).toContain(`baseUrl: ${ompRoute()}`);

      writeOmpModels(doc);
      const before = backups(ompDir(), "models.yml").length;
      const bare = await runInstaller(["--client", "omp"], baseEnv());
      expect(bare.stdout + bare.stderr).toContain("--base-url");
      expect(readOmpModels().replace(FLAG, "")).toBe(doc.replace(FLAG, ""));
      expect(backups(ompDir(), "models.yml").length).toBe(before);
    });

    it("makes the --session report go to /omp/ after the move", async () => {
      writeOmpModels(withPi().replace("apiKey: K", `apiKey: ${OMP_KEY}`));
      const r = await runInstaller(["--client", "omp", "--session", "sid-1", "--base-url", origin], baseEnv());
      expect(r.code).toBe(0);
      expect(sessionReports()[0].url).toBe("/omp/default/v3/hook/report");
    });
  });

  it("--uninstall removes the extension and leaves the models file alone", async () => {
    writeOmpModels(ompYaml("K"));
    await runInstaller(["--client", "omp"], baseEnv());
    const before = readOmpModels();
    const r = await runInstaller(["--client", "omp", "--uninstall"], baseEnv());
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(ompDir(), "extensions", "agent-memory.ts"))).toBe(false);
    expect(readOmpModels()).toBe(before);
  });
});

describe("omp extension", () => {
  type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;
  const handlers = new Map<string, Handler>();
  const pi = { on: (name: string, h: Handler) => void handlers.set(name, h) };
  let savedHome: string | undefined;

  const ctxFor = (baseUrl: string, cwd: string) => ({
    cwd,
    model: { baseUrl },
    sessionManager: { getSessionId: () => "01a16c9a-989c-730e-b265-ca0e2582933c" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-mem-pi", headers: { "x-extra": "1" } }) },
  });

  beforeEach(async () => {
    handlers.clear();
    savedHome = process.env.HOME;
    process.env.HOME = home;
    const mod = (await import(PI_EXTENSION)) as { default: (api: typeof pi) => void };
    mod.default(pi);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it("registers session_start and input handlers", () => {
    expect([...handlers.keys()].sort()).toEqual(["input", "session_start"]);
  });

  it("posts the workspace of the session to the omp route with the model credentials", async () => {
    const repo = mkTmp("am-pirepo-");
    spawnSync("git", ["init", "-q"], { cwd: repo });
    spawnSync("git", ["remote", "add", "origin", "https://user:tok@git.example.com/vtc/demo.git"], { cwd: repo });
    await handlers.get("session_start")?.({ reason: "startup" }, ctxFor(OMP_ROUTE(), repo));
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/omp/default/v3/hook/report");
    expect(requests[0].headers.authorization).toBe("Bearer sk-mem-pi");
    expect(requests[0].headers["x-extra"]).toBe("1");
    const body = JSON.parse(requests[0].body) as Record<string, unknown>;
    expect(body).toMatchObject({
      session_id: "01a16c9a-989c-730e-b265-ca0e2582933c",
      cwd: repo,
      git_toplevel: repo,
      git_remote: "https://git.example.com/vtc/demo.git",
      hook_event: "session_start",
      client: "omp",
      hook_version: "1",
    });
    expect(typeof body.device_id).toBe("string");
    const device = JSON.parse(fs.readFileSync(path.join(home, ".agent-memory", "device.json"), "utf8")) as { device_id: string };
    expect(body.device_id).toBe(device.device_id);
  });

  it("sends null git fields outside a git repository and reports the input event", async () => {
    await handlers.get("input")?.({ text: "hi", source: "interactive" }, ctxFor(OMP_ROUTE(), work));
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0].body)).toMatchObject({ git_toplevel: null, git_remote: null, hook_event: "input" });
  });

  it("sends nothing when the active model is not an Agent-Memory omp route", async () => {
    await handlers.get("session_start")?.({}, ctxFor("https://api.openai.com/v1", work));
    expect(requests).toHaveLength(0);
  });

  it("never throws when the proxy is unreachable", async () => {
    await expect(
      handlers.get("session_start")?.({}, ctxFor("http://127.0.0.1:1/omp/default/v1", work)),
    ).resolves.toBeUndefined();
  });
});
