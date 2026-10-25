import { describe, expect, it } from "vitest";

import { AGENT_SOURCES, resolveAgentAdapter, sessionKeyCandidates } from "../index.js";
import { defaultAdapter } from "../default.js";

describe("sessionKeyCandidates", () => {
  it("probes every registered agent source, including opencode and omp", () => {
    expect(sessionKeyCandidates("abc")).toEqual([
      "abc",
      "codebuddy:abc",
      "claude-code:abc",
      "codex:abc",
      "workbuddy:abc",
      "dsh:abc",
      "opencode:abc",
      "omp:abc",
    ]);
  });

  it("uses a composite key as is", () => {
    expect(sessionKeyCandidates("omp:abc")).toEqual(["omp:abc"]);
  });

  it("lists only sources that have a dedicated adapter", () => {
    for (const source of AGENT_SOURCES) {
      expect(resolveAgentAdapter(source)).not.toBe(defaultAdapter);
    }
  });
});
