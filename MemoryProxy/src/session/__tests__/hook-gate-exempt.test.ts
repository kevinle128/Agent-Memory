import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConfig, parseExemptUserIds } from "../../config.js";
import { MemoryStorage } from "../../storage/memory-storage.js";
import { SessionWorkspaceStore, setSessionWorkspaceStore } from "../../project-scope/session-workspace.js";
import { runAntigravityHookGate, type AntigravityGateParams } from "../antigravity/hook-gate.js";
import { isGateExempt, resetHookGateCache, type GateConfig } from "../hook-gate-core.js";

const CASCADE = "9f0c1a52-6b1e-4c1d-8f0a-2f4f0b7e3a11";

const cfg = (exemptUserIds?: string[], enabled = true): GateConfig => ({ hookGate: { enabled, exemptUserIds } });

function agyParams(config: GateConfig, userId: string): AntigravityGateParams {
  return {
    config,
    body: { contents: [{ role: "user", parts: [{ text: "hi" }] }], labels: { cascade_id: CASCADE } },
    stream: true,
    sessionId: CASCADE,
    spaceId: "default",
    userId,
    origin: "http://127.0.0.1:8096",
    waitMs: 0,
  };
}

describe("isGateExempt", () => {
  it("is false when no list is configured", () => {
    expect(isGateExempt(cfg(), "bot-1")).toBe(false);
    expect(isGateExempt({}, "bot-1")).toBe(false);
    expect(isGateExempt(cfg([]), "bot-1")).toBe(false);
  });

  it("is true only for a listed user", () => {
    expect(isGateExempt(cfg(["bot-1"]), "bot-1")).toBe(true);
    expect(isGateExempt(cfg(["bot-1"]), "usr-2")).toBe(false);
  });

  it("never exempts an empty or anonymous user", () => {
    const config = cfg(["anonymous", "bot-1"]);
    expect(isGateExempt(config, "anonymous")).toBe(false);
    expect(isGateExempt(config, "")).toBe(false);
    expect(isGateExempt(config, null)).toBe(false);
    expect(isGateExempt(config, undefined)).toBe(false);
  });
});

describe("runAntigravityHookGate exemption", () => {
  beforeEach(() => {
    resetHookGateCache();
    setSessionWorkspaceStore(new SessionWorkspaceStore(new MemoryStorage()));
  });
  afterEach(() => setSessionWorkspaceStore(null));

  it("passes an exempt user that has no hook report", async () => {
    const result = await runAntigravityHookGate(agyParams(cfg(["bot-1"]), "bot-1"));
    expect(result).toEqual({ action: "pass", reason: "exempt" });
  });

  it("still gates another user when a list is set", async () => {
    const result = await runAntigravityHookGate(agyParams(cfg(["bot-1"]), "usr-2"));
    expect(result).toMatchObject({ action: "respond", reason: "install-requested" });
  });

  it("gates every user when the list is empty", async () => {
    const result = await runAntigravityHookGate(agyParams(cfg([]), "bot-1"));
    expect(result).toMatchObject({ action: "respond", reason: "install-requested" });
  });
});

describe("parseExemptUserIds", () => {
  it("reads a list, trims entries and drops junk and duplicates", () => {
    expect(parseExemptUserIds([" a ", "", "  ", 7, null, "b", "a"])).toEqual(["a", "b"]);
  });

  it("reads a comma-separated string", () => {
    expect(parseExemptUserIds("a, b,,c ,")).toEqual(["a", "b", "c"]);
  });

  it("gives an empty list for anything else", () => {
    expect(parseExemptUserIds(undefined)).toEqual([]);
    expect(parseExemptUserIds("")).toEqual([]);
    expect(parseExemptUserIds({ a: 1 })).toEqual([]);
  });
});

describe("buildConfig hookGate.exemptUserIds", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const configFile = (hookGateYaml: string): string => {
    dir = mkdtempSync(path.join(tmpdir(), "proxy-config-"));
    const file = path.join(dir, "config.yaml");
    writeFileSync(file, hookGateYaml);
    return file;
  };

  it("defaults to an empty list", () => {
    expect(buildConfig({ configFile: configFile("") }).hookGate.exemptUserIds).toEqual([]);
    expect(buildConfig({ configFile: configFile("hookGate:\n  enabled: true\n") }).hookGate.exemptUserIds).toEqual([]);
  });

  it("reads a YAML list", () => {
    const file = configFile("hookGate:\n  exemptUserIds:\n    - bot-1\n    - ' bot-2 '\n    - ''\n");
    expect(buildConfig({ configFile: file }).hookGate.exemptUserIds).toEqual(["bot-1", "bot-2"]);
  });

  it("reads the comma-separated string that the compose file renders from the environment", () => {
    const file = configFile('hookGate:\n  exemptUserIds: "bot-1, bot-2"\n');
    expect(buildConfig({ configFile: file }).hookGate.exemptUserIds).toEqual(["bot-1", "bot-2"]);
    expect(buildConfig({ configFile: configFile('hookGate:\n  exemptUserIds: ""\n') }).hookGate.exemptUserIds).toEqual([]);
  });
});
