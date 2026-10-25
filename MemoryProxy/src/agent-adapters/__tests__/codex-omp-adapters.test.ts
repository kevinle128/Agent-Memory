import { describe, expect, it } from "vitest";

import { codexAdapter } from "../codex.js";
import { ompAdapter } from "../omp.js";
import { classifyCodexRequest } from "../../pipeline/runners/codex.js";

const TITLE_META = JSON.stringify({ session_id: "s", thread_source: "thread_title", model: "gpt-5.5" });
const USER_META = JSON.stringify({ session_id: "s", thread_source: "user" });

describe("codex thread_title classification", () => {
  it("treats the terminal title request as auxiliary, from the turn-metadata header", () => {
    const headers = { originator: "codex-tui", "x-codex-turn-metadata": TITLE_META };
    expect(codexAdapter.classifyRequest({}, "/codex/default/responses", headers)).toBe("auxiliary");
    expect(classifyCodexRequest({}, "/codex/default/responses", headers)).toBe("auxiliary");
  });

  it("reads the same field from client_metadata", () => {
    const body = { client_metadata: { "x-codex-turn-metadata": TITLE_META } };
    expect(codexAdapter.classifyRequest(body, "/codex/default/responses", {})).toBe("auxiliary");
    expect(classifyCodexRequest(body, "/codex/default/responses", {})).toBe("auxiliary");
    expect(classifyCodexRequest({ client_metadata: { thread_source: "thread_title" } }, "/codex/x/responses", {})).toBe("auxiliary");
  });

  it("keeps a user turn and an unreadable header as main", () => {
    expect(codexAdapter.classifyRequest({}, "/codex/default/responses", { "x-codex-turn-metadata": USER_META })).toBe("main");
    expect(classifyCodexRequest({}, "/codex/default/responses", { "x-codex-turn-metadata": "{not json" })).toBe("main");
    expect(classifyCodexRequest({}, "/codex/default/responses", {})).toBe("main");
  });

  it("keeps the earlier auxiliary signals", () => {
    expect(classifyCodexRequest({}, "/codex/default/responses/compact", {})).toBe("auxiliary");
    expect(classifyCodexRequest({}, "/codex/default/responses", { "x-openai-memgen-request": "true" })).toBe("auxiliary");
    expect(classifyCodexRequest({ client_metadata: { thread_source: "system" } }, "/codex/default/responses", {})).toBe("auxiliary");
  });
});

describe("ompAdapter user text", () => {
  const reminder = { type: "text", text: "<system-reminder>\nToday: 2026-10-24; current working directory: '/w'.\n</system-reminder>" };

  it("drops the leading system-reminder part of an omp prompt", () => {
    expect(ompAdapter.extractUserText([reminder, { type: "text", text: "mem: status" }])).toBe("mem: status");
  });

  it("keeps a plain string and a one-part array", () => {
    expect(ompAdapter.extractUserText("hello")).toBe("hello");
    expect(ompAdapter.extractUserText([{ type: "text", text: "hello" }])).toBe("hello");
  });

  it("keeps every typed part", () => {
    expect(ompAdapter.extractUserText([reminder, { type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  });

  it("returns null when only the reminder is present", () => {
    expect(ompAdapter.extractUserText([reminder])).toBeNull();
    expect(ompAdapter.extractUserText("")).toBeNull();
  });
});
