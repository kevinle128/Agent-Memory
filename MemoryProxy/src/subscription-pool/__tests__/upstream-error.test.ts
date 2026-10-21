import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "../../storage/memory-storage.js";
import { MAX_ERROR_BODY_CHARS, recordPoolUpstreamError, sanitizeErrorText } from "../upstream-error.js";

afterEach(() => vi.restoreAllMocks());

describe("pool upstream error diagnostics", () => {
  const input = {
    spaceId: "test", accountId: "account-a", provider: "claude", model: "claude-test",
    status: 429, body: '{"error":{"type":"rate_limit_error","message":"Too many requests"}}',
    headers: new Headers({ "request-id": "req-upstream", "retry-after": "60", "set-cookie": "private-cookie" }),
    requestId: "req-client", secrets: ["private-token"], now: 1_790_000_000_000,
  };

  it("stores the original error message and request ids and logs the same diagnostic", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = new MemoryStorage();
    await recordPoolUpstreamError({ ...input, storage });
    const prefix = "ttl/test/subscription-pool/errors/account-a/";
    const names = await storage.listNames(prefix);
    expect(names).toHaveLength(1);
    const stored = await storage.getJSON(prefix + names[0]);
    expect(stored).toMatchObject({ status: 429, account_id: "account-a", provider: "claude", request_id: "req-client", upstream_request_id: "req-upstream", body: input.body, body_truncated: false });
    expect(JSON.stringify(stored)).not.toContain("private-cookie");
    expect(warn.mock.calls[0]?.[0]).toContain("Too many requests");
  });

  it("redacts JSON secrets, echoed tokens and plain text credentials", () => {
    const safe = sanitizeErrorText(JSON.stringify({ error: { message: "Rejected private-token Bearer unknown-token" }, access_token: "other-token", nested: { refresh_token: "refresh-secret" } }), ["private-token"]);
    expect(safe).toContain("Rejected");
    for (const secret of ["private-token", "unknown-token", "other-token", "refresh-secret"]) expect(safe).not.toContain(secret);
    expect(sanitizeErrorText('password=pass-secret api_key=key-secret Bearer abc sk-ant-test', [])).not.toMatch(/pass-secret|key-secret|Bearer abc|sk-ant-test/);
  });

  it("bounds non-JSON bodies and records truncation after redaction", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await recordPoolUpstreamError({ ...input, storage: null, body: "x".repeat(MAX_ERROR_BODY_CHARS + 100) + "private-token" });
    const record = JSON.parse(String(warn.mock.calls[0]?.[0]).replace("[subscription-pool] ", ""));
    expect(record.body).toHaveLength(MAX_ERROR_BODY_CHARS);
    expect(record.body_truncated).toBe(true);
    expect(record.original_body_bytes).toBeGreaterThan(MAX_ERROR_BODY_CHARS);
  });

  it("keeps a console diagnostic if storage fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = new MemoryStorage();
    vi.spyOn(storage, "putJSON").mockRejectedValue(new Error("secret backend detail"));
    await expect(recordPoolUpstreamError({ ...input, storage })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret backend detail");
  });
});
