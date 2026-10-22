import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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

  it("defaults to deny when the key is missing", () => {
    expect(buildConfig({ configFile: configFile("") }).tdai.memory.profileScopeMode).toBe("deny");
  });

  it("returns legacy only for an explicit legacy value", () => {
    const file = configFile("    profileScopeMode: legacy\n");
    expect(buildConfig({ configFile: file }).tdai.memory.profileScopeMode).toBe("legacy");
  });

  it("falls back to deny for an unknown value", () => {
    const file = configFile("    profileScopeMode: legcy\n");
    expect(buildConfig({ configFile: file }).tdai.memory.profileScopeMode).toBe("deny");
  });
});
