import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildConfig } from "../config.js";

describe("buildConfig tdai.memory.profileScopeMode", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const configFile = (memoryYaml: string): string => {
    dir = mkdtempSync(path.join(tmpdir(), "proxy-config-"));
    const file = path.join(dir, "config.yaml");
    writeFileSync(file, `tdai:\n  memory:\n    enabled: true\n${memoryYaml}`);
    return file;
  };

  it("defaults to scoped when the key is missing", () => {
    expect(buildConfig({ configFile: configFile("") }).tdai.memory.profileScopeMode).toBe("scoped");
  });

  it("returns deny for an explicit deny value", () => {
    const file = configFile("    profileScopeMode: deny\n");
    expect(buildConfig({ configFile: file }).tdai.memory.profileScopeMode).toBe("deny");
  });

  it("returns legacy only for an explicit legacy value", () => {
    const file = configFile("    profileScopeMode: legacy\n");
    expect(buildConfig({ configFile: file }).tdai.memory.profileScopeMode).toBe("legacy");
  });

  it("honors an explicit scoped value", () => {
    const file = configFile("    profileScopeMode: scoped\n");
    expect(buildConfig({ configFile: file }).tdai.memory.profileScopeMode).toBe("scoped");
  });

  it("treats an empty value as missing", () => {
    const file = configFile("    profileScopeMode:\n");
    expect(buildConfig({ configFile: file }).tdai.memory.profileScopeMode).toBe("scoped");
  });

  it("fails closed to deny with a warning for an unrecognized value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = configFile("    profileScopeMode: legcy\n");
    expect(buildConfig({ configFile: file }).tdai.memory.profileScopeMode).toBe("deny");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unrecognized value "legcy"'));
    warn.mockRestore();
  });
});
