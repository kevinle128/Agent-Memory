import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDbPath } from "../db/index.js";
import { getSessionRepo } from "../db/sessionRepo.js";
import { getHookCacheRepo } from "../db/hookCacheRepo.js";

const realDbDir = path.join(os.homedir(), ".tdai-memory-proxy");

describe("test database isolation", () => {
  // The setup file points the variable at a temp file before any test code runs.
  const pathAtImport = resolveDbPath();

  it("does not point at the home directory at import time", () => {
    expect(pathAtImport.startsWith(realDbDir)).toBe(false);
  });

  it("does not point at the home directory inside a test", () => {
    expect(resolveDbPath().startsWith(realDbDir)).toBe(false);
  });

  const state = { status: "initialized" } as unknown as Parameters<ReturnType<typeof getSessionRepo>["upsert"]>[4];

  // The next two tests use the same key: each must write and read back in its own database.
  it.each(["first", "second"])("persists a session in the %s test of the file", async () => {
    const repo = getSessionRepo();
    expect(repo.constructor.name).toBe("SqliteSessionRepo");
    expect(await repo.getBySessionId("sp", "u", "claude-code", "fixed-session")).toBeNull();
    await repo.upsert("sp", "u", "claude-code", "fixed-session", state);
    expect(await repo.getBySessionId("sp", "u", "claude-code", "fixed-session")).toMatchObject({ status: "initialized" });
    expect(getHookCacheRepo().constructor.name).toBe("SqliteHookCacheRepo");
  });
});
