import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { resolveConversationId, resolveOmpSessionId } from "../session-key.js";

async function probe(headers: Record<string, string>) {
  let out: { omp: string | null; conv: string | null } = { omp: null, conv: null };
  const app = new Hono();
  app.post("/", (c) => {
    out = { omp: resolveOmpSessionId(c), conv: resolveConversationId(c) };
    return c.body(null, 204);
  });
  await app.request("/", { method: "POST", headers });
  return out;
}

describe("resolveOmpSessionId", () => {
  it("reads the session_id header", async () => {
    expect((await probe({ session_id: "s-1" })).omp).toBe("s-1");
  });

  it("falls back to x-session-affinity", async () => {
    expect((await probe({ "x-session-affinity": "s-2" })).omp).toBe("s-2");
  });

  it("returns null without a session header", async () => {
    expect((await probe({})).omp).toBeNull();
  });

  it("is not part of the shared conversation id lookup", async () => {
    const r = await probe({ session_id: "s-3", "x-session-affinity": "s-3" });
    expect(r.conv).toBeNull();
  });
});

describe("resolveOmpSessionId: prompt_cache_key", () => {
  const OMP_ID = "01a16eab-0b03-708d-8d4f-4bba152cad8e";

  async function probeBody(headers: Record<string, string>, body: Record<string, unknown>) {
    let out: string | null = "unset";
    const app = new Hono();
    app.post("/", (c) => {
      out = resolveOmpSessionId(c, body);
      return c.body(null, 204);
    });
    await app.request("/", { method: "POST", headers });
    return out;
  }

  it("reads prompt_cache_key whatever the User-Agent", async () => {
    expect(await probeBody({ "user-agent": "OpenAI/JS 6.26.0" }, { prompt_cache_key: OMP_ID })).toBe(OMP_ID);
    expect(await probeBody({ "user-agent": "omp/18.6.3" }, { prompt_cache_key: OMP_ID })).toBe(OMP_ID);
  });

  it("prefers a session header", async () => {
    expect(await probeBody({ "user-agent": "omp/18.6.3", session_id: "hdr" }, { prompt_cache_key: OMP_ID })).toBe("hdr");
  });

  it("ignores a prompt_cache_key that cannot go into a shell command", async () => {
    expect(await probeBody({ "user-agent": "omp/18.6.3" }, { prompt_cache_key: "a; rm -rf ~" })).toBeNull();
    expect(await probeBody({ "user-agent": "omp/18.6.3" }, { prompt_cache_key: 42 })).toBeNull();
  });

  it("does nothing without a body", async () => {
    expect(await probe({ "user-agent": "omp/18.6.3" })).toMatchObject({ omp: null });
  });
});
