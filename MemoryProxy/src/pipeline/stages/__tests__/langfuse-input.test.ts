import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// Reproduce a production image without the private extension, independently
// of whether the developer's checkout has initialized the optional submodule.
vi.mock("@context-proxy/cost-guard", () => { throw new Error("optional extension unavailable"); });

import { DEFAULT_CONFIG } from "../../../config.js";
import { stageBuildLangfuseTurnContext } from "../observability.js";
import { countHumanTurns, turnTraceScope } from "../../../turnSeq.js";
import { langfuseTurnTraceId } from "../../../langfuse.js";

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

describe("Langfuse turn trace id across a client compaction", () => {
  const reminder = { type: "text", text: "<system-reminder>CLAUDE.md context</system-reminder>" };
  const prompt = (text: string) => ({ role: "user", content: [reminder, { type: "text", text }] });
  const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
  const toolCall = { role: "assistant", content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: {} }] };
  const toolResult = { role: "user", content: [{ type: "tool_result", tool_use_id: "bash-1", content: "ok" }] };
  const summary = {
    role: "user",
    content: "This session is being continued from a previous conversation that ran out of context. Summary: ...",
  };

  function traceId(messages: unknown[], lane = "main") {
    return stageBuildLangfuseTurnContext({
      config: structuredClone(DEFAULT_CONFIG),
      sessionKey: "compacted-session", keyId: "test-user",
      target: {
        model: "test-model", tags: [], turnSeq: 0, analyzerTrace: null,
        url: "http://upstream.test/v1/messages", authHeaders: null,
        bodyOverrides: null, retryTarget: null, logLine: "", logLineExtra: "",
        logMeta: {}, routedFrom: "",
      },
      protocol: "anthropic", traceTags: [], path: "/claude-code/default/v1/messages",
      headers: {}, body: { messages }, messages, lane,
      turnTraceScope: turnTraceScope(messages, lane),
    });
  }

  const beforeCompaction = [prompt("first prompt"), reply("done"), prompt("second prompt")];
  const afterCompaction = [summary, prompt("prompt after compaction")];

  it("gives turn 2 after a compaction a different trace than turn 2 before it", async () => {
    const before = await traceId(beforeCompaction);
    const after = await traceId(afterCompaction);
    expect(before.turnSeq).toBe(2);
    expect(after.turnSeq).toBe(2);
    expect(after.lf.traceId).not.toBe(before.lf.traceId);
  });

  it("keeps one trace for all tool-loop requests of a turn", async () => {
    const first = await traceId(afterCompaction);
    const loop1 = await traceId([...afterCompaction, toolCall, toolResult]);
    const loop2 = await traceId([
      // Claude Code moves cache_control onto the newest message on each request.
      { ...summary, content: [{ type: "text", text: summary.content, cache_control: { type: "ephemeral" } }] },
      afterCompaction[1], toolCall, toolResult, toolCall,
      { role: "user", content: [toolResult.content[0], { type: "text", text: "<system-reminder>todo list</system-reminder>" }] },
    ]);
    expect(loop1.lf.traceId).toBe(first.lf.traceId);
    expect(loop2.lf.traceId).toBe(first.lf.traceId);
  });

  it("does not let a compaction fork write into the next main turn's trace", async () => {
    const fork = [...beforeCompaction, reply("answer"), prompt("Respond with TEXT ONLY. Summarize the conversation.")];
    const nextMainTurn = [...beforeCompaction, reply("answer"), prompt("third prompt")];
    expect(countHumanTurns(fork, "anthropic")).toBe(countHumanTurns(nextMainTurn, "anthropic"));
    const forkTrace = await traceId(fork, "fork");
    const mainTrace = await traceId(nextMainTurn);
    expect(forkTrace.lf.traceId).not.toBe(mainTrace.lf.traceId);
    expect(forkTrace.lf.traceName).toBe("test-model / test-user [fork]");
    expect(mainTrace.lf.traceName).toBe("test-model / test-user");
  });

  it("keeps the legacy sessionKey:turnSeq trace id when no scope is given", () => {
    const legacy = createHash("sha256").update("compacted-session:3").digest("hex").slice(0, 32);
    expect(langfuseTurnTraceId("compacted-session", 3)).toBe(legacy);
    expect(langfuseTurnTraceId("compacted-session", 3, "")).toBe(legacy);
  });
});
