import { describe, expect, it } from "vitest";
import { isMultiSourceAgent, isSupportedAgent } from "../supported-agents.js";

describe("supported agents", () => {
  it("supports omp and no longer supports pi", () => {
    expect(isSupportedAgent("omp")).toBe(true);
    expect(isSupportedAgent("pi")).toBe(false);
  });

  it("marks omp, hermes and openclaw as multi-source", () => {
    for (const agent of ["omp", "hermes", "openclaw"]) expect(isMultiSourceAgent(agent)).toBe(true);
    for (const agent of ["claude-code", "codex", "codebuddy", "pi", "", undefined, null]) {
      expect(isMultiSourceAgent(agent)).toBe(false);
    }
  });
});
