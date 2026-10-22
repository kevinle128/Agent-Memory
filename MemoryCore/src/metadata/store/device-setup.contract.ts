/**
 * Contract tests for the device setup methods of IMetadataStore.
 * The same cases run on SQLite and on MongoDB.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { IMetadataStore } from "./interface.js";
import type { UpsertDeviceSetupInput } from "../types.js";

let userSeq = 0;

async function createUserId(store: IMetadataStore): Promise<string> {
  userSeq += 1;
  const user = await store.createUser({
    auth_provider: "local",
    external_id: `device-ext-${userSeq}`,
    username: `device-user-${userSeq}`,
  });
  return user.user_id;
}

function deviceInput(userId: string, over: Partial<UpsertDeviceSetupInput> = {}): UpsertDeviceSetupInput {
  return {
    user_id: userId,
    device_id: "device-1",
    client: "claude-code",
    os: "darwin",
    arch: "arm64",
    hostname: "host-1",
    hook_version: "1.0.0",
    ...over,
  };
}

/** Time stamps have millisecond resolution. A short pause gives a different last_seen_at. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

export function runDeviceSetupContract(
  name: string,
  makeStore: () => Promise<IMetadataStore>,
  teardown: (store: IMetadataStore) => Promise<void>,
): void {
  describe(`device setup contract: ${name}`, () => {
    let store: IMetadataStore;

    beforeEach(async () => {
      store = await makeStore();
      await store.init();
    });

    afterEach(async () => {
      await teardown(store);
    });

    it("inserts a new row with status installed and equal installed_at and last_seen_at", async () => {
      const userId = await createUserId(store);
      const row = await store.upsertDeviceSetup(deviceInput(userId));
      expect(row).toEqual({
        user_id: userId,
        device_id: "device-1",
        client: "claude-code",
        os: "darwin",
        arch: "arm64",
        hostname: "host-1",
        hook_version: "1.0.0",
        status: "installed",
        installed_at: expect.any(String),
        last_seen_at: row.installed_at,
      });
      expect(new Date(row.installed_at).toISOString()).toBe(row.installed_at);
      expect(await store.listDeviceSetups(userId)).toEqual([row]);
    });

    it("keeps installed_at and refreshes the other fields on a second upsert", async () => {
      const userId = await createUserId(store);
      const first = await store.upsertDeviceSetup(deviceInput(userId));
      await tick();
      const second = await store.upsertDeviceSetup(deviceInput(userId, {
        os: "linux", arch: "x64", hostname: "host-2", hook_version: "1.1.0",
      }));
      expect(second).toMatchObject({
        os: "linux", arch: "x64", hostname: "host-2", hook_version: "1.1.0",
        status: "installed", installed_at: first.installed_at,
      });
      expect(second.last_seen_at > first.last_seen_at).toBe(true);
      expect(await store.listDeviceSetups(userId)).toHaveLength(1);
    });

    it("stores an empty string for os, arch and hostname", async () => {
      const userId = await createUserId(store);
      const row = await store.upsertDeviceSetup(deviceInput(userId, { os: "", arch: "", hostname: "" }));
      expect(row).toMatchObject({ os: "", arch: "", hostname: "" });
    });

    it("treats the same device_id with another client as a separate row", async () => {
      const userId = await createUserId(store);
      await store.upsertDeviceSetup(deviceInput(userId, { client: "claude-code" }));
      await store.upsertDeviceSetup(deviceInput(userId, { client: "codex", hook_version: "2.0.0" }));
      const rows = await store.listDeviceSetups(userId);
      expect(rows.map((r) => r.client).sort()).toEqual(["claude-code", "codex"]);
      expect(rows.find((r) => r.client === "codex")?.hook_version).toBe("2.0.0");
      expect(rows.find((r) => r.client === "claude-code")?.hook_version).toBe("1.0.0");
    });

    it("treats the same device_id and client for another user as a separate row", async () => {
      const u1 = await createUserId(store);
      const u2 = await createUserId(store);
      await store.upsertDeviceSetup(deviceInput(u1));
      await store.upsertDeviceSetup(deviceInput(u2, { hostname: "other-host" }));
      expect((await store.listDeviceSetups(u1)).map((r) => r.hostname)).toEqual(["host-1"]);
      expect((await store.listDeviceSetups(u2)).map((r) => r.hostname)).toEqual(["other-host"]);
    });

    it("lists the newest last_seen_at first", async () => {
      const userId = await createUserId(store);
      await store.upsertDeviceSetup(deviceInput(userId, { device_id: "device-a" }));
      await tick();
      await store.upsertDeviceSetup(deviceInput(userId, { device_id: "device-b" }));
      await tick();
      await store.upsertDeviceSetup(deviceInput(userId, { device_id: "device-c" }));
      expect((await store.listDeviceSetups(userId)).map((r) => r.device_id))
        .toEqual(["device-c", "device-b", "device-a"]);

      // A new report moves the oldest device to the front.
      await tick();
      await store.upsertDeviceSetup(deviceInput(userId, { device_id: "device-a" }));
      expect((await store.listDeviceSetups(userId)).map((r) => r.device_id))
        .toEqual(["device-a", "device-c", "device-b"]);
    });

    it("returns an empty list when the user has no device", async () => {
      const userId = await createUserId(store);
      expect(await store.listDeviceSetups(userId)).toEqual([]);
      expect(await store.listDeviceSetups("usr-nonexistent")).toEqual([]);
    });

    it("keeps one row when two reports for a new key run at the same time", async () => {
      const userId = await createUserId(store);
      await Promise.all([
        store.upsertDeviceSetup(deviceInput(userId)),
        store.upsertDeviceSetup(deviceInput(userId, { hook_version: "1.0.1" })),
      ]);
      expect(await store.listDeviceSetups(userId)).toHaveLength(1);
    });
  });
}
