import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type http from "node:http";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MetadataService } from "../service/metadata-service.js";
import { handleV3MetaRoute, V3_ROUTES } from "./v3-meta-router.js";

interface Reply {
  status: number;
  body: { code: number; message?: string; data?: any };
}

describe("device setup routes", () => {
  let store: SqliteMetadataStore;
  let service: MetadataService;
  let owner: { userId: string; key: string };
  let other: { userId: string; key: string };
  let admin: { userId: string; key: string };

  async function makeUser(username: string, userType?: "system_admin") {
    const user = await store.createUser({ auth_provider: "local", external_id: username, username, user_type: userType });
    const key = (await store.getDefaultUserKey(user.user_id))!.key_value;
    return { userId: user.user_id, key };
  }

  async function call(pathname: string, key: string | null, body: unknown): Promise<Reply> {
    const headers: Record<string, string> = { "x-tdai-service-id": "default" };
    if (key) headers["x-tdai-user-key"] = key;
    let reply: Reply | undefined;
    const handled = await handleV3MetaRoute(
      { headers } as unknown as http.IncomingMessage,
      {} as http.ServerResponse,
      pathname,
      "POST",
      async <T>() => body as T,
      (_res, status, payload) => {
        reply = { status, body: payload as Reply["body"] };
      },
      { getMetadataService: () => service, logger: {} as never, getSupportedAgents: () => [] },
    );
    expect(handled).toBe(true);
    return reply!;
  }

  const upsertBody = (userId: string, over: Record<string, unknown> = {}) => ({
    user_id: userId,
    device_id: "device-1",
    client: "claude-code",
    os: "darwin",
    arch: "arm64",
    hostname: "host-1",
    hook_version: "1.0.0",
    ...over,
  });

  beforeEach(async () => {
    store = new SqliteMetadataStore(":memory:");
    await store.init();
    service = new MetadataService(store);
    owner = await makeUser("owner");
    other = await makeUser("other");
    admin = await makeUser("root", "system_admin");
  });

  afterEach(async () => {
    await store.close();
  });

  it("registers both routes", () => {
    expect(V3_ROUTES).toContain("/v3/meta/device/upsert");
    expect(V3_ROUTES).toContain("/v3/meta/device/list");
  });

  it("upserts and lists the devices of the caller", async () => {
    const up = await call("/v3/meta/device/upsert", owner.key, upsertBody(owner.userId));
    expect(up.status).toBe(200);
    expect(up.body.code).toBe(0);
    expect(up.body.data).toMatchObject({
      user_id: owner.userId, device_id: "device-1", client: "claude-code",
      os: "darwin", arch: "arm64", hostname: "host-1", hook_version: "1.0.0", status: "installed",
    });

    const list = await call("/v3/meta/device/list", owner.key, { user_id: owner.userId });
    expect(list.status).toBe(200);
    expect(list.body.data.items).toEqual([up.body.data]);
  });

  it("stores empty strings when os, arch and hostname are absent", async () => {
    const up = await call("/v3/meta/device/upsert", owner.key, {
      user_id: owner.userId, device_id: "device-2", client: "codex", hook_version: "1.0.0",
    });
    expect(up.body.data).toMatchObject({ os: "", arch: "", hostname: "" });
  });

  it("returns an empty list when the user has no device", async () => {
    const list = await call("/v3/meta/device/list", owner.key, { user_id: owner.userId });
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual({ items: [] });
  });

  it.each([
    ["empty device_id", { device_id: "" }],
    ["device_id with a space", { device_id: "dev ice" }],
    ["device_id with an underscore", { device_id: "dev_ice" }],
    ["device_id over 128 chars", { device_id: "a".repeat(129) }],
    ["empty client", { client: "" }],
    ["client with upper case", { client: "Claude" }],
    ["client with an underscore", { client: "claude_code" }],
    ["client over 32 chars", { client: "a".repeat(33) }],
    ["empty hook_version", { hook_version: "" }],
    ["hook_version over 32 chars", { hook_version: "1".repeat(33) }],
    ["hostname over 128 chars", { hostname: "h".repeat(129) }],
    ["os that is not a string", { os: 5 }],
  ])("rejects %s with 400", async (_label, over) => {
    const res = await call("/v3/meta/device/upsert", owner.key, upsertBody(owner.userId, over));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(400);
    expect(await store.listDeviceSetups(owner.userId)).toEqual([]);
  });

  it("accepts the maximum lengths", async () => {
    const res = await call("/v3/meta/device/upsert", owner.key, upsertBody(owner.userId, {
      device_id: "A".repeat(128), client: "a".repeat(32), hook_version: "1".repeat(32),
      os: "o".repeat(128), arch: "a".repeat(128), hostname: "h".repeat(128),
    }));
    expect(res.status).toBe(200);
  });

  it("denies upsert and list of another user with 403", async () => {
    const up = await call("/v3/meta/device/upsert", other.key, upsertBody(owner.userId));
    expect(up.status).toBe(403);
    expect(up.body.message).toContain("permission_denied");
    expect(await store.listDeviceSetups(owner.userId)).toEqual([]);

    await store.upsertDeviceSetup({
      user_id: owner.userId, device_id: "device-1", client: "claude-code",
      os: "", arch: "", hostname: "", hook_version: "1.0.0",
    });
    const list = await call("/v3/meta/device/list", other.key, { user_id: owner.userId });
    expect(list.status).toBe(403);
  });

  it("lets a system admin act on any user", async () => {
    const up = await call("/v3/meta/device/upsert", admin.key, upsertBody(owner.userId));
    expect(up.status).toBe(200);
    const list = await call("/v3/meta/device/list", admin.key, { user_id: owner.userId });
    expect(list.body.data.items).toHaveLength(1);
  });

  it("returns 404 for an unknown user", async () => {
    const res = await call("/v3/meta/device/list", owner.key, { user_id: "usr-nonexistent" });
    expect(res.status).toBe(404);
  });

  it("returns 401 without a user key", async () => {
    const res = await call("/v3/meta/device/list", null, { user_id: owner.userId });
    expect(res.status).toBe(401);
  });
});
