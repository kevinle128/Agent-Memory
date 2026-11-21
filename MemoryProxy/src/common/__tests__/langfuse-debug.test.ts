import { describe, expect, it } from "vitest";

import { buildRequestDebugMetadata } from "../langfuse-debug.js";

describe("buildRequestDebugMetadata headers", () => {
  const meta = (headers: Record<string, string>) =>
    buildRequestDebugMetadata({ debug: true, body: { model: "m" }, headers });

  it("redacts the value of every credential-like header", () => {
    const out = meta({
      "x-tdai-user-key": "uk-SECRET",
      "x-goog-api-key": "g-SECRET",
      "x-api-key": "a-SECRET",
      authorization: "Bearer b-SECRET",
      "x-session-token": "t-SECRET",
      "x-codebuddy-password": "p-SECRET",
      "x-auth-cookie": "c-SECRET",
      "x-client-secret": "s-SECRET",
      "x-session-id": "sid-SECRET",
    });
    expect(JSON.stringify(out)).not.toMatch(/SECRET/);
    expect(out["header_x-tdai-user-key"]).toBe("[redacted]");
    expect(out["header_x-goog-api-key"]).toBe("[redacted]");
    expect(out["header_x-session-id"]).toBe("[redacted]");
  });

  it("keeps ordinary whitelisted headers", () => {
    const out = meta({ "x-request-id": "r1", "x-codebuddy-version": "2.0", "user-agent": "ua" });
    expect(out["header_x-request-id"]).toBe("r1");
    expect(out["header_x-codebuddy-version"]).toBe("2.0");
    expect(out).not.toHaveProperty("header_user-agent");
  });
});
