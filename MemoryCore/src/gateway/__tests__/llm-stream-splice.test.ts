import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadGatewayConfig } from "../config.js";

const ENV_KEYS = [
  "TDAI_GATEWAY_CONFIG",
  "TDAI_LLM_STREAM",
  "TDAI_LLM_BASE_URL",
  "TDAI_LLM_API_KEY",
  "TDAI_LLM_MODEL",
  "TDAI_LLM_PROVIDER",
  "TDAI_LLM_MAX_TOKENS",
  "TDAI_LLM_TIMEOUT_MS",
] as const;

describe("top-level llm.stream is spliced onto memory.llm", () => {
  let dir: string;
  let file: string;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "llm-stream-splice-"));
    file = path.join(dir, "gw.json");
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.TDAI_GATEWAY_CONFIG = file;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("copies TDAI_LLM_STREAM=true into memory.llm.stream", () => {
    writeFileSync(file, JSON.stringify({
      llm: { baseUrl: "http://llm.test/v1", apiKey: "k", model: "m" },
    }));
    process.env.TDAI_LLM_STREAM = "true";
    expect(loadGatewayConfig().memory.llm.stream).toBe(true);
    process.env.TDAI_LLM_STREAM = "false";
    expect(loadGatewayConfig().memory.llm.stream).toBe(false);
  });

  it("leaves stream false when the variable is unset", () => {
    writeFileSync(file, JSON.stringify({
      llm: { baseUrl: "http://llm.test/v1", apiKey: "k", model: "m", stream: false },
    }));
    expect(loadGatewayConfig().memory.llm.stream).toBe(false);
  });
});
