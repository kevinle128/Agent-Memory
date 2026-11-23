/**
 * Local folder report: the user key picks the user, and the table stores
 * hashes and relative paths only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSkillHarness, type SkillHarness } from "../core/skill/__contract__/skill-core-harness.js";
import {
  handleCreate,
  handleLocalInventoryList,
  handleLocalInventoryReplace,
  makeSkillRouteTable,
  type SkillRouterDeps,
} from "./skill-handlers.js";

const HASH = "a".repeat(64);
const HASH_B = "b".repeat(64);
const auth = { apiKey: "test", serviceId: "default" } as Parameters<typeof handleCreate>[1];

let h: SkillHarness;
afterEach(() => h?.dispose());

function meta(keys: Record<string, string>): SkillRouterDeps["getMetadataService"] {
  return async () => ({
    isConfiguredMemorySystemUserKey: () => false,
    verifyAuth: async (userKey: string) => {
      const userId = keys[userKey];
      if (!userId) return null;
      return { user_id: userId, user_type: "normal", username: userId, created_at: 0 };
    },
  }) as unknown as Awaited<ReturnType<NonNullable<SkillRouterDeps["getMetadataService"]>>>;
}

function deps(keys: Record<string, string>): SkillRouterDeps {
  return {
    getSkillCore: () => h.core,
    getMetadataService: meta(keys),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as SkillRouterDeps;
}

function item(over: Record<string, unknown> = {}) {
  return {
    harness: "claude",
    source: "user",
    name: "demo",
    root_kind: "claude_user",
    relative_path: "demo/SKILL.md",
    content_hash: HASH,
    ...over,
  };
}

function replaceBody(over: Record<string, unknown> = {}, row: Record<string, unknown> = {}) {
  return {
    user_key: "key-a",
    machine_id: "machine-a",
    items: [item(row)],
    ...over,
  };
}

describe("local skill inventory routes", () => {
  it("registers replace and list", () => {
    const table = makeSkillRouteTable();
    expect(table["/v3/skill/local-inventory/replace"]).toBeTypeOf("function");
    expect(table["/v3/skill/local-inventory/list"]).toBeTypeOf("function");
  });

  it("answers 401 for a wrong user key", async () => {
    h = createSkillHarness();
    const res = await handleLocalInventoryReplace(replaceBody(), auth, "r", deps({}));
    expect(res.code).toBe(401);
  });

  it("lets a user list only that user's rows", async () => {
    h = createSkillHarness();
    const keys = { "key-a": "user-a", "key-b": "user-b" };
    const saved = await handleLocalInventoryReplace(
      replaceBody({ user_key: "key-b", machine_id: "machine-b" }),
      auth, "r", deps(keys),
    );
    expect(saved.code).toBe(0);

    const asA = await handleLocalInventoryList({ user_key: "key-a" }, auth, "r", deps(keys));
    expect(asA.code).toBe(0);
    expect((asA.data as { items: unknown[] }).items).toEqual([]);

    const asB = await handleLocalInventoryList({ user_key: "key-b", machine_id: "machine-b" }, auth, "r", deps(keys));
    expect((asB.data as { items: Array<{ name: string }> }).items.map((row) => row.name)).toEqual(["demo"]);

    const spoof = await handleLocalInventoryList({ user_key: "key-a", user_id: "user-b" }, auth, "r", deps(keys));
    expect(spoof.code).toBe(40001);
  });

  it("returns the snapshot, marks an omitted folder absent, and updates the hash on the same row", async () => {
    h = createSkillHarness();
    const keys = { "key-a": "user-a" };
    const beforeSkills = (h.db.prepare("SELECT COUNT(*) AS c FROM skills").get() as { c: number }).c;

    const first = await handleLocalInventoryReplace(replaceBody({
      items: [
        item(),
        item({ name: "other", relative_path: "other/SKILL.md", content_hash: HASH_B }),
      ],
    }), auth, "r", deps(keys));
    expect(first.code).toBe(0);

    const listed = await handleLocalInventoryList({ user_key: "key-a", machine_id: "machine-a" }, auth, "r", deps(keys));
    const items = (listed.data as { items: Array<{ relative_path: string; content_hash: string; inventory_id: number }> }).items;
    expect(items.map((row) => row.relative_path)).toEqual(["demo/SKILL.md", "other/SKILL.md"]);

    const second = await handleLocalInventoryReplace(replaceBody(), auth, "r", deps(keys));
    expect(second.code).toBe(0);
    const afterOmit = await handleLocalInventoryList({ user_key: "key-a", machine_id: "machine-a" }, auth, "r", deps(keys));
    expect((afterOmit.data as { items: Array<{ relative_path: string }> }).items.map((row) => row.relative_path)).toEqual(["demo/SKILL.md"]);
    const hidden = h.db.prepare(
      "SELECT present FROM local_skill_inventory WHERE relative_path='other/SKILL.md'",
    ).get() as { present: number };
    expect(hidden.present).toBe(0);

    const keptId = (h.db.prepare(
      "SELECT inventory_id FROM local_skill_inventory WHERE relative_path='demo/SKILL.md'",
    ).get() as { inventory_id: number }).inventory_id;
    const third = await handleLocalInventoryReplace(
      replaceBody({}, { content_hash: HASH_B }),
      auth, "r", deps(keys),
    );
    expect(third.code).toBe(0);
    const updated = h.db.prepare(
      "SELECT inventory_id, content_hash, present FROM local_skill_inventory WHERE relative_path='demo/SKILL.md'",
    ).get() as { inventory_id: number; content_hash: string; present: number };
    expect(updated).toEqual({ inventory_id: keptId, content_hash: HASH_B, present: 1 });
    expect((h.db.prepare("SELECT COUNT(*) AS c FROM skills").get() as { c: number }).c).toBe(beforeSkills);
    expect((h.db.prepare("SELECT COUNT(*) AS c FROM skill_change_proposals").get() as { c: number }).c).toBe(0);
  });

  it("accepts a real folder name and returns that path unchanged", async () => {
    h = createSkillHarness();
    const keys = { "key-a": "user-a" };
    const paths = ["demo", "my-skill", "skill v2", "技能"];
    const saved = await handleLocalInventoryReplace(replaceBody({
      items: paths.map((relative_path, index) => item({
        name: `n${index}`,
        relative_path,
      })),
    }), auth, "r", deps(keys));
    expect(saved.code).toBe(0);
    const listed = await handleLocalInventoryList({ user_key: "key-a", machine_id: "machine-a" }, auth, "r", deps(keys));
    const got = (listed.data as { items: Array<{ relative_path: string }> }).items.map((row) => row.relative_path);
    expect(got).toHaveLength(paths.length);
    expect(got).toEqual(expect.arrayContaining(paths));
  });

  it("rejects a home prefix, '..', an absolute path, and '~'", async () => {
    h = createSkillHarness();
    const keys = { "key-a": "user-a" };
    const badPaths = [
      "/Users/dale/.claude/skills/demo/SKILL.md",
      "/home/dale/.claude/skills/demo/SKILL.md",
      "Users/dale/.claude/skills/demo/SKILL.md",
      "home/dale/.claude/skills/demo/SKILL.md",
      "~/skills/demo/SKILL.md",
      "../demo/SKILL.md",
      "/tmp/demo/SKILL.md",
      "C:/skills/demo/SKILL.md",
    ];
    for (const relative_path of badPaths) {
      const res = await handleLocalInventoryReplace(replaceBody({}, { relative_path }), auth, "r", deps(keys));
      expect(res.code, relative_path).toBe(40001);
    }
    expect((h.db.prepare("SELECT COUNT(*) AS c FROM local_skill_inventory").get() as { c: number }).c).toBe(0);
  });

  it("rejects a case-folded home prefix, percent-encoding, and a hidden character", async () => {
    h = createSkillHarness();
    const keys = { "key-a": "user-a" };
    const badPaths = [
      "users/x/SKILL.md",
      "HOME/x/SKILL.md",
      "Users/x",
      "%2e%2e/SKILL.md",
      "..%2f..%2fetc",
      `Users${"\u200B"}/x`,
      "．．/x",
      "\\\\server\\share\\SKILL.md",
    ];
    for (const relative_path of badPaths) {
      const res = await handleLocalInventoryReplace(replaceBody({}, { relative_path }), auth, "r", deps(keys));
      expect(res.code, relative_path).toBe(40001);
    }
    expect(() => h.store.replaceLocalSkillInventory({
      user_id: "user-a",
      machine_id: "machine-a",
      items: [item({ relative_path: "%2e%2e/x" }) as never],
    })).toThrow(/LOCAL_SKILL_PATH_REJECTED/);
    h.db.prepare(
      `INSERT INTO local_skill_inventory (
         user_id, machine_id, harness, source, name, root_kind, relative_path,
         content_hash, reported_at_ms, present
       ) VALUES ('user-a', 'machine-a', 'claude', 'user', 'demo', 'claude_user', 'Users/x', ?, 1, 1)`,
    ).run(HASH);
    const listed = await handleLocalInventoryList({ user_key: "key-a", machine_id: "machine-a" }, auth, "r", deps(keys));
    expect(JSON.stringify((listed.data as { items: unknown[] }).items)).not.toContain("Users/x");
    expect((h.db.prepare("SELECT COUNT(*) AS c FROM local_skill_inventory WHERE relative_path='Users/x'").get() as { c: number }).c).toBe(1);
  });

  it("does not store file bytes", async () => {
    h = createSkillHarness();
    const keys = { "key-a": "user-a" };
    const res = await handleLocalInventoryReplace(
      replaceBody({}, { content: "SECRET FILE BYTES", bytes: "AQID" }),
      auth, "r", deps(keys),
    );
    expect(res.code).toBe(40001);
    const columns = (h.db.prepare("PRAGMA table_info('local_skill_inventory')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).not.toContain("content");
    expect(columns).not.toContain("bytes");
    const saved = await handleLocalInventoryReplace(replaceBody(), auth, "r", deps(keys));
    expect(saved.code).toBe(0);
    const row = h.db.prepare("SELECT * FROM local_skill_inventory").get() as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain("SECRET FILE BYTES");
    expect(row.content_hash).toBe(HASH);
  });
});
