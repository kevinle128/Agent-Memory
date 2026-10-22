import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildConfig } from "../config.js";

describe("buildConfig auth.apiKey", () => {
  let dir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const configWithApiKey = (apiKey: string): string => {
    dir = mkdtempSync(path.join(tmpdir(), "proxy-config-"));
    const file = path.join(dir, "config.yaml");
    writeFileSync(file, `auth:\n  enabled: true\n  apiKey: "${apiKey}"\n`);
    return file;
  };

  it("expands an environment reference", () => {
    vi.stubEnv("TEST_GATEWAY_KEY", "key-from-env");
    const config = buildConfig({ configFile: configWithApiKey("${TEST_GATEWAY_KEY}") });
    expect(config.auth.apiKey).toBe("key-from-env");
  });

  it("keeps a literal key unchanged", () => {
    const config = buildConfig({ configFile: configWithApiKey("literal-key") });
    expect(config.auth.apiKey).toBe("literal-key");
  });
});
