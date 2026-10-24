import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseConfig } from "../../config.js";
import { loadGatewayConfig } from "../config.js";

describe("llmCallLog config", () => {
  it("is on by default with a 30 day retention and no extra success stages", () => {
    expect(parseConfig({}).llmCallLog).toEqual({ enabled: true, recordSuccessStages: [], bodyExcerptBytes: 1024, retentionDays: 30 });
  });

  it("reads the block and bounds its numbers", () => {
    expect(parseConfig({ llmCallLog: { enabled: false, recordSuccessStages: ["scene-extraction"], bodyExcerptBytes: 99999, retentionDays: 0 } }).llmCallLog)
      .toEqual({ enabled: false, recordSuccessStages: ["scene-extraction"], bodyExcerptBytes: 8192, retentionDays: 1 });
  });
});

describe("TDAI_LLM_CALL_LOG_ENABLED", () => {
  let dir: string;
  let file: string;
  const saved = { cfg: process.env.TDAI_GATEWAY_CONFIG, sw: process.env.TDAI_LLM_CALL_LOG_ENABLED };
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "llm-call-log-cfg-"));
    file = path.join(dir, "gw.json");
    process.env.TDAI_GATEWAY_CONFIG = file;
    delete process.env.TDAI_LLM_CALL_LOG_ENABLED;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [["TDAI_GATEWAY_CONFIG", saved.cfg], ["TDAI_LLM_CALL_LOG_ENABLED", saved.sw]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it("overrides the file in both directions", () => {
    writeFileSync(file, JSON.stringify({ memory: { llmCallLog: { enabled: true } } }));
    expect(loadGatewayConfig().memory.llmCallLog.enabled).toBe(true);
    process.env.TDAI_LLM_CALL_LOG_ENABLED = "false";
    expect(loadGatewayConfig().memory.llmCallLog.enabled).toBe(false);
    writeFileSync(file, JSON.stringify({ memory: { llmCallLog: { enabled: false } } }));
    process.env.TDAI_LLM_CALL_LOG_ENABLED = "true";
    expect(loadGatewayConfig().memory.llmCallLog.enabled).toBe(true);
  });

  it("leaves the file value when the variable is unset", () => {
    writeFileSync(file, JSON.stringify({ memory: { llmCallLog: { enabled: false } } }));
    expect(loadGatewayConfig().memory.llmCallLog.enabled).toBe(false);
  });
});
