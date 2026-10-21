import { describe, expect, it, vi } from "vitest";

// Reproduce a production image without the private extension, independently
// of whether the developer's checkout has initialized the optional submodule.
vi.mock("@context-proxy/cost-guard", () => { throw new Error("optional extension unavailable"); });

import { DEFAULT_CONFIG } from "../../../config.js";
import { stageBuildLangfuseTurnContext } from "../observability.js";

describe("Langfuse trace input without cost-guard", () => {
  async function context(messages: unknown[]) {
    return stageBuildLangfuseTurnContext({
      config: structuredClone(DEFAULT_CONFIG),
      sessionKey: "test-session", keyId: "test-user",
      target: {
        model: "test-model", tags: [], turnSeq: 1, analyzerTrace: null,
        url: "http://upstream.test/v1/messages", authHeaders: null,
        bodyOverrides: null, retryTarget: null, logLine: "", logLineExtra: "",
        logMeta: {}, routedFrom: "",
      },
      protocol: "anthropic", traceTags: [], path: "/claude-code/default/v1/messages",
      headers: {}, body: { messages }, messages,
      preResolvedTurnSeq: 1,
    });
  }

  it("sets the trace's human input even when the optional extension is absent", async () => {
    const { lf } = await context([{ role: "user", content: [
      { type: "text", text: "<system-reminder>IDE context</system-reminder>" },
      { type: "text", text: "Please describe this image" },
      { type: "image", source: { type: "base64", data: "test-image" } },
    ] }]);
    expect(lf.userQuery).toBe("Please describe this image");
  });

  it("retains turn identity without replacing input with tool-result contents", async () => {
    const initial = await context([{ role: "user", content: "Read this image" }]);
    const continuation = await context([
      { role: "user", content: "Read this image" },
      { role: "assistant", content: [{ type: "tool_use", id: "read-1", name: "Read" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "tool output" }] },
    ]);
    expect(initial.lf.userQuery).toBe("Read this image");
    expect(continuation.lf.traceId).toBe(initial.lf.traceId);
    expect(continuation.lf.userQuery).toBe("");
  });
});
