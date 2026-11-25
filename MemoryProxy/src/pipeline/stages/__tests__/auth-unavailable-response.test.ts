import { Hono } from "hono";
import type { Context } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyUserKey = vi.hoisted(() => vi.fn());
vi.mock("../../../auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../auth.js")>();
  return { ...actual, verifyUserKey: (...args: unknown[]) => verifyUserKey(...args) };
});

import { handleModels } from "../../../modelsHandler.js";
import { runAnthropicPipeline } from "../../runners/anthropic.js";
import { runCodexPipeline } from "../../runners/codex.js";
import { runOpenaiChatPipeline } from "../../runners/openai-chat.js";
import { runUtilityPipeline } from "../../runners/utility.js";
import { runWorkbuddyPipeline } from "../../runners/workbuddy.js";
import { createHookRecallHandler } from "../../../routes/hook-recall.js";
import { createHookReportHandler } from "../../../routes/hook-report.js";
import type { ProxyConfig } from "../../../types.js";
import { stageAuth } from "../auth.js";

const MESSAGE = "Memory service temporarily unavailable. Please retry.";
const config = { hookRecall: { enabled: false } } as unknown as ProxyConfig;

type Runner = (c: Context) => Response | Promise<Response>;

function mount(method: "GET" | "POST", pattern: string, run: Runner): Hono {
  const app = new Hono();
  if (method === "GET") app.get(pattern, (c) => run(c));
  else app.post(pattern, (c) => run(c));
  return app;
}

function request(method: "GET" | "POST", pattern: string, url: string, run: Runner): Promise<Response> {
  return Promise.resolve(mount(method, pattern, run).request(url, {
    method,
    headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
    ...(method === "POST" ? { body: "{}" } : {}),
  }));
}

const routes: Array<{ name: string; method: "GET" | "POST"; pattern: string; url: string; run: Runner; shape: "anthropic" | "openai" | "hook" }> = [
  { name: "anthropic", method: "POST", pattern: "/claude-code/:spaceId/v1/messages", url: "/claude-code/sp/v1/messages", run: (c) => runAnthropicPipeline(c, config), shape: "anthropic" },
  { name: "openai-chat", method: "POST", pattern: "/codebuddy/:spaceId/v1/chat/completions", url: "/codebuddy/sp/v1/chat/completions", run: (c) => runOpenaiChatPipeline(c, config), shape: "openai" },
  { name: "codex", method: "POST", pattern: "/codex/:spaceId/v1/responses", url: "/codex/sp/v1/responses", run: (c) => runCodexPipeline(c, config), shape: "openai" },
  { name: "workbuddy", method: "POST", pattern: "/workbuddy/:spaceId/v1/responses", url: "/workbuddy/sp/v1/responses", run: (c) => runWorkbuddyPipeline(c, config), shape: "openai" },
  { name: "utility", method: "POST", pattern: "/claude-code/:spaceId/v1/messages/count_tokens", url: "/claude-code/sp/v1/messages/count_tokens", run: (c) => runUtilityPipeline(c, config), shape: "openai" },
  { name: "models", method: "GET", pattern: "/omp/:spaceId/v1/models", url: "/omp/sp/v1/models", run: (c) => handleModels(c, config), shape: "openai" },
  { name: "hook-recall", method: "POST", pattern: "/:agent/:spaceId/v3/hook/recall", url: "/claude-code/sp/v3/hook/recall", run: (c) => createHookRecallHandler(config)(c), shape: "hook" },
  { name: "hook-report", method: "POST", pattern: "/:agent/:spaceId/v3/hook/report", url: "/claude-code/sp/v3/hook/report", run: (c) => createHookReportHandler(config)(c), shape: "hook" },
];

describe("stageAuth unavailable flag", () => {
  beforeEach(() => {
    verifyUserKey.mockReset();
  });

  it("copies unavailable only when MemoryCore could not answer", async () => {
    const app = new Hono();
    app.post("/claude-code/:spaceId/probe", async (c) => c.json(await stageAuth(c, "bearer-first")));
    verifyUserKey.mockResolvedValueOnce({ userId: "", rejected: true, rejectReason: "auth service timeout (5000ms)", unavailable: true });
    const down = await app.request("/claude-code/sp/probe", { method: "POST", headers: { authorization: "Bearer sk-test" } });
    expect(await down.json()).toMatchObject({ rejected: true, unavailable: true });

    verifyUserKey.mockResolvedValueOnce({ userId: "", rejected: true, rejectReason: "invalid user_key" });
    const denied = await app.request("/claude-code/sp/probe", { method: "POST", headers: { authorization: "Bearer sk-test" } });
    const body = await denied.json() as { rejected: boolean; unavailable?: boolean };
    expect(body.rejected).toBe(true);
    expect(body.unavailable).toBeUndefined();
  });
});

describe("runners answer 503 when verify is unavailable and 401 when the key is refused", () => {
  beforeEach(() => {
    verifyUserKey.mockReset();
  });

  for (const route of routes) {
    it(`${route.name} returns 503 without an auth phrase when Core is down`, async () => {
      verifyUserKey.mockResolvedValue({ userId: "", rejected: true, rejectReason: "auth service timeout (5000ms)", unavailable: true });
      const res = await request(route.method, route.pattern, route.url, route.run);
      const body = await res.json() as { error?: unknown; type?: string };
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      if (route.shape === "anthropic") {
        expect(body).toEqual({ type: "error", error: { type: "api_error", message: MESSAGE } });
      } else if (route.shape === "hook") {
        expect(body).toEqual({ error: "service_unavailable", reason: "auth service timeout (5000ms)" });
      } else {
        expect(body).toEqual({ error: MESSAGE });
      }
      expect(JSON.stringify(body.error)).not.toMatch(/auth|sign.in|log.in/i);
    });

    it(`${route.name} keeps 401 when the key is refused`, async () => {
      verifyUserKey.mockResolvedValue({ userId: "", rejected: true, rejectReason: "invalid user_key" });
      const res = await request(route.method, route.pattern, route.url, route.run);
      const body = await res.json() as { error?: unknown; type?: string };
      expect(res.status).toBe(401);
      expect(res.headers.get("retry-after")).toBeNull();
      if (route.shape === "anthropic") {
        expect(body).toEqual({
          type: "error",
          error: { type: "authentication_error", message: "Authentication failed: invalid user_key" },
        });
      } else if (route.shape === "hook") {
        expect(body).toEqual({ error: "unauthorized", reason: "invalid user_key" });
      } else {
        expect(body).toEqual({ error: "Authentication failed: invalid user_key" });
      }
    });
  }
});
