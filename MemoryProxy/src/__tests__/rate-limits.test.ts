import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createRateLimitHandlers } from "../routes/rate-limits.js";

function appWith(apiKey: string): Hono {
  const cfg = { admin: { apiKey }, rateLimit: { tpm: 1000, qpm: 100 } } as any;
  const handlers = createRateLimitHandlers(cfg);
  const app = new Hono();
  app.get("/v3/admin/rate-limits", handlers.get);
  app.put("/v3/admin/rate-limits", handlers.put);
  app.delete("/v3/admin/rate-limits", handlers.delete);
  return app;
}

describe("rate-limit admin endpoints", () => {
  it("reject GET, PUT and DELETE without a Bearer token when an admin key is set", async () => {
    const app = appWith("adminkey");
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await app.request("/v3/admin/rate-limits", { method });
      expect(res.status, method).toBe(401);
    }
  });

  it("reject a wrong Bearer token", async () => {
    const res = await appWith("adminkey").request("/v3/admin/rate-limits", {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  it("let a request with the admin key reach the handler", async () => {
    const res = await appWith("adminkey").request("/v3/admin/rate-limits", {
      headers: { Authorization: "Bearer adminkey" },
    });
    expect(res.status).not.toBe(401);
  });

  it("stay open when no admin key is configured", async () => {
    const res = await appWith("").request("/v3/admin/rate-limits");
    expect(res.status).not.toBe(401);
  });
});
