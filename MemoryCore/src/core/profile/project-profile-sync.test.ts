import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeProfileRowStore } from "../storage/__contract__/fake-profile-row-store.js";
import { StorageAdapter } from "../storage/adapter.js";
import { LocalStorageBackend } from "../storage/local-backend.js";
import { ProfileRowStorageBackend } from "../storage/profile-row-backend.js";
import { createProjectScopedStorage } from "../storage/project-scoped-storage.js";
import type { IMemoryStore, ProfileRecord, ProfileSyncRecord } from "../store/types.js";
import { buildProfileStableId } from "./profile-scope.js";
import { listLocalProfiles, pullProfilesToLocal, syncLocalProfilesToStore } from "./profile-sync.js";

const A = "0123456789abcdef";
const SCOPE = "team:team-1|agent:agent-1";
const ISOLATION = { teamId: "team-1", agentId: "agent-1" };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

function row(type: "l2" | "l3", filename: string, content: string): ProfileRecord {
  return {
    id: buildProfileStableId(SCOPE, type, filename),
    type,
    filename,
    content,
    contentMd5: md5(content),
    teamId: "team-1",
    agentId: "agent-1",
    version: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

/** Profile-capable store double: a plain map behind pullProfiles / syncProfiles / deleteProfiles. */
function mapStore(initial: ProfileRecord[]) {
  const rows = new Map(initial.map((r) => [r.id, r]));
  const store = {
    isDegraded: () => false,
    pullProfiles: vi.fn(async () => [...rows.values()]),
    syncProfiles: vi.fn(async (records: ProfileSyncRecord[]) => {
      for (const { baselineVersion: _drop, ...record } of records) rows.set(record.id, record);
    }),
    deleteProfiles: vi.fn(async (ids: string[]) => {
      for (const id of ids) rows.delete(id);
    }),
  };
  return { rows, store: store as unknown as IMemoryStore, spies: store };
}

let dir: string;
let base: StorageAdapter;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "project-profile-sync-"));
  base = new StorageAdapter(new LocalStorageBackend(dir));
  vi.clearAllMocks();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("project profile rows", () => {
  it("gives a project file a different row id than a user-global file of the same name", async () => {
    await base.writeFile("scene_blocks/work.md", "root work");
    const project = createProjectScopedStorage(base, A);
    await project.writeFile("scene_blocks/work.md", "project work");
    await project.writeFile("persona.md", "project persona");

    const root = await listLocalProfiles("", base, { scope: SCOPE, isolation: ISOLATION });
    const scoped = await listLocalProfiles("", project, { scope: SCOPE, isolation: ISOLATION, projectHash: A });

    expect(root.map((p) => p.filename)).toEqual(["work.md"]);
    expect(scoped.map((p) => [p.type, p.filename]).sort()).toEqual([
      ["l2", `projects/${A}/work.md`],
      ["l3", `project_personas/${A}.md`],
    ]);
    expect(scoped.map((p) => p.id)).toEqual(expect.arrayContaining([
      buildProfileStableId(SCOPE, "l2", `projects/${A}/work.md`),
      buildProfileStableId(SCOPE, "l3", `project_personas/${A}.md`),
    ]));
    expect(scoped.some((p) => p.id === root[0].id)).toBe(false);
  });

  it("refuses a project sync without a storage adapter or with an invalid hash", async () => {
    await expect(listLocalProfiles(dir, undefined, { scope: SCOPE, projectHash: A })).rejects.toThrow(/storage adapter/);
    await expect(listLocalProfiles("", base, { scope: SCOPE, projectHash: "nope" })).rejects.toThrow(/Invalid project hash/);
  });
});

describe("pull of user-global files", () => {
  it("ignores project rows: no project persona over persona.md, no project baseline", async () => {
    const { store } = mapStore([
      row("l2", "work.md", "root work"),
      row("l3", "persona.md", "root persona"),
      row("l2", `projects/${A}/work.md`, "project work"),
      row("l3", `project_personas/${A}.md`, "project persona"),
    ]);
    await base.writeFile("persona.md", "stale root persona");

    const baseline = await pullProfilesToLocal("", store, logger, base, { scope: SCOPE, isolation: ISOLATION });

    // The pull appends the derived scene navigation to the persona body.
    expect(await base.readFile("persona.md")).toMatch(/^root persona\n/);
    expect(await base.readFile("persona.md")).not.toContain("stale");
    expect(await base.readdirNames("scene_blocks/", ".md")).toEqual(["work.md"]);
    expect([...baseline.keys()].sort()).toEqual([
      buildProfileStableId(SCOPE, "l2", "work.md"),
      buildProfileStableId(SCOPE, "l3", "persona.md"),
    ].sort());
  });

  it("keeps project rows in the store when the user-global files sync back", async () => {
    const { store, rows } = mapStore([
      row("l2", "work.md", "root work"),
      row("l2", `projects/${A}/work.md`, "project work"),
      row("l3", `project_personas/${A}.md`, "project persona"),
    ]);
    const options = { scope: SCOPE, isolation: ISOLATION };
    const baseline = await pullProfilesToLocal("", store, logger, base, options);
    await base.writeFile("scene_blocks/work.md", "root work, edited");

    await syncLocalProfilesToStore("", store, baseline, logger, base, options);

    expect(rows.get(buildProfileStableId(SCOPE, "l2", "work.md"))?.content).toBe("root work, edited");
    expect(rows.has(buildProfileStableId(SCOPE, "l2", `projects/${A}/work.md`))).toBe(true);
    expect(rows.has(buildProfileStableId(SCOPE, "l3", `project_personas/${A}.md`))).toBe(true);
  });
});

describe("pull and sync of one project", () => {
  const options = { scope: SCOPE, isolation: ISOLATION, projectHash: A };

  it("pulls only that project's rows into the project view", async () => {
    const { store } = mapStore([
      row("l2", "work.md", "root work"),
      row("l3", "persona.md", "root persona"),
      row("l2", `projects/${A}/cache.md`, "project cache"),
      row("l3", `project_personas/${A}.md`, "project persona"),
      row("l2", "projects/fedcba9876543210/other.md", "other project"),
    ]);
    const project = createProjectScopedStorage(base, A);
    await project.writeFile("scene_blocks/removed-upstream.md", "gone");

    const baseline = await pullProfilesToLocal("", store, logger, project, options);

    expect((await project.readdirNames("scene_blocks/", ".md")).sort()).toEqual(["cache.md"]);
    expect(await project.readFile("persona.md")).toMatch(/^project persona\n/);
    expect(await base.exists("persona.md")).toBe(false);
    expect(await base.exists("scene_blocks/work.md")).toBe(false);
    expect([...baseline.keys()].sort()).toEqual([
      buildProfileStableId(SCOPE, "l2", `projects/${A}/cache.md`),
      buildProfileStableId(SCOPE, "l3", `project_personas/${A}.md`),
    ].sort());
  });

  it("syncs changed project files back under prefixed filenames and leaves user-global rows alone", async () => {
    const { store, rows } = mapStore([
      row("l2", "work.md", "root work"),
      row("l3", "persona.md", "root persona"),
    ]);
    const project = createProjectScopedStorage(base, A);
    const baseline = await pullProfilesToLocal("", store, logger, project, options);
    await project.writeFile("scene_blocks/cache.md", "project cache");

    const synced = await syncLocalProfilesToStore("", store, baseline, logger, project, options);

    expect(synced.map((r) => r.filename)).toEqual([`projects/${A}/cache.md`]);
    expect(rows.get(buildProfileStableId(SCOPE, "l2", `projects/${A}/cache.md`))?.content).toBe("project cache");
    expect(rows.get(buildProfileStableId(SCOPE, "l2", "work.md"))?.content).toBe("root work");
    expect(rows.get(buildProfileStableId(SCOPE, "l3", "persona.md"))?.content).toBe("root persona");
  });
});

describe("row-view backends", () => {
  it("skip pull and sync-back for a project view, because the row is the file", async () => {
    const fake = new FakeProfileRowStore();
    const rowsAdapter = new StorageAdapter(new ProfileRowStorageBackend({ store: fake.asStore(), isolation: ISOLATION }));
    const project = createProjectScopedStorage(rowsAdapter, A);
    const { store, spies } = mapStore([]);
    const options = { scope: SCOPE, isolation: ISOLATION, projectHash: A };

    const baseline = await pullProfilesToLocal("", store, logger, project, options);
    const synced = await syncLocalProfilesToStore("", store, baseline, logger, project, options);

    expect(baseline.size).toBe(0);
    expect(synced).toEqual([]);
    expect(spies.pullProfiles).not.toHaveBeenCalled();
    expect(spies.syncProfiles).not.toHaveBeenCalled();
  });
});
