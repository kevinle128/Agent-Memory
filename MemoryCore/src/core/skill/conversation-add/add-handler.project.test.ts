import { describe, expect, it } from "vitest";

import type { StorageAdapter } from "../../storage/adapter.js";
import { SkillBufferStorage } from "./buffer-storage.js";
import { LocalSkillAgentTaskQueue } from "./agent-task-queue.js";
import { SkillTriggerService } from "./trigger-service.js";
import { SkillConversationAddHandler, type AddConversationInput, type BufferProject } from "./add-handler.js";
import { applyOversizeStrategy } from "./oversize-strategy.js";

const PROJECT_A: BufferProject = { projectKey: "github.com/acme/alpha", projectHash: "aaaaaaaaaaaaaaaa", projectName: "acme/alpha" };
const PROJECT_B: BufferProject = { projectKey: "github.com/acme/beta", projectHash: "bbbbbbbbbbbbbbbb", projectName: "acme/beta" };

/** In-memory file store with the three calls the buffer uses. */
function memoryStorage(): StorageAdapter {
  const files = new Map<string, string>();
  return {
    readFile: async (key: string) => files.get(key) ?? null,
    writeFile: async (key: string, data: string) => { files.set(key, data); },
    exists: async (key: string) => files.has(key),
  } as unknown as StorageAdapter;
}

function setup(thresholds: { toolCallThreshold?: number; bytesThreshold?: number } = {}) {
  const buffer = new SkillBufferStorage({ storage: memoryStorage() });
  const queue = new LocalSkillAgentTaskQueue();
  const trigger = new SkillTriggerService({ buffer, queue });
  const handler = new SkillConversationAddHandler({
    buffer,
    trigger,
    thresholds: { toolCallThreshold: 100, bytesThreshold: 10_000_000, ...thresholds },
  });
  const session = { instance_id: "i1", space_id: "sp", user_id: "u", team_id: "t", agent_id: "a", session_id: "s1" };
  const agent = { instance_id: "i1", space_id: "sp", user_id: "u", team_id: "t", agent_id: "a" };
  const add = (text: string, project?: BufferProject, extra: Partial<AddConversationInput> = {}) =>
    handler.handle({
      ...session,
      messages: [{ role: "user", content: text }, { role: "assistant", content: `re: ${text}` }],
      ...(project ? { project } : {}),
      ...extra,
    });
  return { buffer, session, agent, add };
}

describe("skill buffer rounds with a project", () => {
  it("stores the project on every message of the round", async () => {
    const { buffer, session, add } = setup();
    await add("first", PROJECT_A);
    const { messages } = await buffer.readCurrent(session);
    expect(messages).toHaveLength(2);
    for (const m of messages) {
      expect(m).toMatchObject({
        project_key: PROJECT_A.projectKey,
        project_hash: PROJECT_A.projectHash,
        project_name: PROJECT_A.projectName,
      });
    }
  });

  it("marks a round without a project with an empty hash", async () => {
    const { buffer, session, add } = setup();
    await add("first");
    const { messages } = await buffer.readCurrent(session);
    expect(messages.every((m) => m.project_hash === "")).toBe(true);
    expect(messages.some((m) => "project_key" in m)).toBe(false);
  });

  it("keeps rounds of the same project in one buffer", async () => {
    const { buffer, session, agent, add } = setup();
    expect((await add("one", PROJECT_A)).status).toBe("ok");
    expect((await add("two", PROJECT_A)).status).toBe("ok");
    expect((await buffer.readCurrent(session)).messages).toHaveLength(4);
    expect((await buffer.readTasks(agent)).tasks).toHaveLength(0);
  });

  it("closes the buffer as its own task when the project changes", async () => {
    const { buffer, session, agent, add } = setup();
    await add("one", PROJECT_A);
    await add("two", PROJECT_A);
    const res = await add("three", PROJECT_B);

    expect(res.status).toBe("archived");
    expect(res.archived?.reason).toBe("project_changed");

    const tasks = (await buffer.readTasks(agent)).tasks;
    expect(tasks).toHaveLength(1);
    const archived = await buffer.readArchive(tasks[0]!.archive_key);
    expect(archived?.messages).toHaveLength(4);
    expect(new Set(archived?.messages.map((m) => m.project_hash))).toEqual(new Set([PROJECT_A.projectHash]));

    const current = (await buffer.readCurrent(session)).messages;
    expect(current).toHaveLength(2);
    expect(new Set(current.map((m) => m.project_hash))).toEqual(new Set([PROJECT_B.projectHash]));
  });

  it("splits when a round without a project follows a project, and the other way round", async () => {
    const { buffer, agent, add } = setup();
    await add("one", PROJECT_A);
    await add("two");
    await add("three", PROJECT_A);
    const tasks = (await buffer.readTasks(agent)).tasks;
    expect(tasks).toHaveLength(2);
    const first = await buffer.readArchive(tasks[0]!.archive_key);
    const second = await buffer.readArchive(tasks[1]!.archive_key);
    expect(first?.messages.map((m) => m.project_hash)).toEqual([PROJECT_A.projectHash, PROJECT_A.projectHash]);
    expect(second?.messages.map((m) => m.project_hash)).toEqual(["", ""]);
  });

  it("keeps both archives when the new round also reaches a threshold", async () => {
    const { buffer, session, agent, add } = setup();
    await add("one", PROJECT_A);
    // A large round of another project: the old buffer is closed, then the
    // new round is archived on its own because it passes the size threshold.
    const res = await add("two", PROJECT_B, { messages: [{ role: "user", content: "x".repeat(50_000) }] });
    expect(res.archived?.reason).toBe("compressed");
    const tasks = (await buffer.readTasks(agent)).tasks;
    expect(tasks).toHaveLength(2);
    expect(new Set(tasks.map((t) => t.archive_key)).size).toBe(2);
    const first = await buffer.readArchive(tasks[0]!.archive_key);
    const second = await buffer.readArchive(tasks[1]!.archive_key);
    expect(new Set(first?.messages.map((m) => m.project_hash))).toEqual(new Set([PROJECT_A.projectHash]));
    expect(new Set(second?.messages.map((m) => m.project_hash))).toEqual(new Set([PROJECT_B.projectHash]));
    expect((await buffer.readCurrent(session)).messages).toHaveLength(0);
  });

  it("keeps the project on the placeholder of a truncated buffer", () => {
    const stamped = Array.from({ length: 40 }, (_, i) => ({
      role: "user",
      content: `${"y".repeat(2000)}-${i}`,
      project_hash: PROJECT_A.projectHash,
      project_key: PROJECT_A.projectKey,
    }));
    const out = applyOversizeStrategy(stamped, { chunkMaxBytes: 20_000, headKeepBytes: 5_000, tailKeepBytes: 5_000 });
    expect(out.truncated).toBe(true);
    expect(new Set(out.messages.map((m) => m.project_hash))).toEqual(new Set([PROJECT_A.projectHash]));
  });
});
