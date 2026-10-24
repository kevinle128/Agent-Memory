import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { resolveConversationId, resolvePiSessionId } from "../session-key.js";

async function probe(headers: Record<string, string>) {
  let out: { pi: string | null; conv: string | null } = { pi: null, conv: null };
  const app = new Hono();
  app.post("/", (c) => {
    out = { pi: resolvePiSessionId(c), conv: resolveConversationId(c) };
    return c.body(null, 204);
  });
  await app.request("/", { method: "POST", headers });
  return out;
}

describe("resolvePiSessionId", () => {
  it("reads the session_id header", async () => {
    expect((await probe({ session_id: "s-1" })).pi).toBe("s-1");
  });

  it("falls back to x-session-affinity", async () => {
    expect((await probe({ "x-session-affinity": "s-2" })).pi).toBe("s-2");
  });

  it("returns null without a session header", async () => {
    expect((await probe({})).pi).toBeNull();
  });

  it("is not part of the shared conversation id lookup", async () => {
    const r = await probe({ session_id: "s-3", "x-session-affinity": "s-3" });
    expect(r.conv).toBeNull();
  });
});
