import { beforeEach, describe, expect, it, vi } from "vitest";

const metricSend = vi.fn();
vi.mock("../../report/kafka-metric-producer.js", () => ({
  metricProducer: { send: (...args: unknown[]) => metricSend(...args) },
}));

import type { StorageAdapter } from "../../storage/adapter.js";
import type { ExtractedCandidate, ISkillExtractor } from "../queue/types.js";
import { SkillBufferStorage } from "./buffer-storage.js";
import { LocalSkillAgentTaskQueue } from "./agent-task-queue.js";
import { SkillTriggerService } from "./trigger-service.js";
import { SkillConversationExtractWorker, type TaskProjectLabelLookup } from "./extract-worker.js";
import { classifyProjectLabels, resolveBufferedProject } from "./task-project.js";

const HASH_A = "aaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbb";

function memoryStorage(): StorageAdapter {
  const files = new Map<string, string>();
  return {
    readFile: async (key: string) => files.get(key) ?? null,
    writeFile: async (key: string, data: string) => { files.set(key, data); },
    exists: async (key: string) => files.has(key),
  } as unknown as StorageAdapter;
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const session = { instance_id: "i1", space_id: "sp", user_id: "u", team_id: "t", agent_id: "a", session_id: "s1" };
const agent = { instance_id: "i1", space_id: "sp", user_id: "u", team_id: "t", agent_id: "a" };

/** One buffered message as a current proxy writes it. */
const labeled = (hash: string, key = hash ? `key-${hash}` : "", name = hash ? `acme/${hash.slice(0, 1)}` : "") => ({
  role: "user",
  content: "work",
  project_hash: hash,
  ...(key ? { project_key: key } : {}),
  ...(name ? { project_name: name } : {}),
});
/** One buffered message from before project labels existed. */
const legacy = () => ({ role: "user", content: "old work" });

function setup(opts: {
  mode?: "chat" | "code";
  lookup?: TaskProjectLabelLookup;
  sink?: boolean;
} = {}) {
  const buffer = new SkillBufferStorage({ storage: memoryStorage() });
  const queue = new LocalSkillAgentTaskQueue();
  const trigger = new SkillTriggerService({ buffer, queue });
  const extract = vi.fn(async (_input: Parameters<ISkillExtractor["extract"]>[0]) => ({
    candidates: [{ action: "create", name: "made" } as ExtractedCandidate],
  }));
  const applyCandidates = vi.fn(async () => {});
  const worker = new SkillConversationExtractWorker({
    workerId: "w1",
    buffer,
    queue,
    extractor: { extract },
    sink: { applyCandidates },
    logger,
    extractLockRenewIntervalMs: 0,
    failureRequeueSleepMs: 0,
    getPromptMode: opts.mode ? () => opts.mode! : undefined,
    lookupProjectLabels: opts.lookup,
  });
  const archive = (messages: Array<Record<string, unknown>>) =>
    trigger.archive({ session, bufferAtTrigger: { messages } });
  return { buffer, extract, applyCandidates, worker, archive };
}

beforeEach(() => {
  metricSend.mockReset();
});

describe("task project resolution", () => {
  it("accepts a buffer whose rounds all name the same project", () => {
    const r = resolveBufferedProject([labeled(HASH_A), labeled(HASH_A)]);
    expect(r).toEqual({ kind: "project", project: { projectKey: `key-${HASH_A}`, projectHash: HASH_A, projectName: "acme/a" } });
  });

  it("says none for a buffer of rounds without a project", () => {
    expect(resolveBufferedProject([labeled(""), labeled("")])).toEqual({ kind: "none" });
  });

  it("says mixed for two projects, or a project next to no project", () => {
    expect(resolveBufferedProject([labeled(HASH_A), labeled(HASH_B)])).toEqual({ kind: "mixed" });
    expect(resolveBufferedProject([labeled(HASH_A), labeled("")])).toEqual({ kind: "mixed" });
  });

  it("says unlabeled when any message predates project labels", () => {
    expect(resolveBufferedProject([legacy(), labeled(HASH_A)])).toEqual({ kind: "unlabeled" });
  });

  it("classifies L0 labels with the same rule", () => {
    expect(classifyProjectLabels([])).toEqual({ kind: "none" });
    expect(classifyProjectLabels([{ projectKey: "k", projectHash: HASH_A }, { projectKey: "k", projectHash: HASH_A }]).kind).toBe("project");
    expect(classifyProjectLabels([{ projectKey: "k", projectHash: HASH_A }, {}]).kind).toBe("mixed");
  });
});

describe("extract worker project gate in code mode", () => {
  it("drops a task without a project and calls no model", async () => {
    const { worker, buffer, extract, applyCandidates, archive } = setup({ mode: "code" });
    await archive([labeled(""), labeled("")]);
    const res = await worker.consumeAgent(agent);

    expect(extract).not.toHaveBeenCalled();
    expect(applyCandidates).not.toHaveBeenCalled();
    expect(res.dropped).toHaveLength(1);
    expect(res.processedTaskIds).toHaveLength(0);
    expect((await buffer.readTasks(agent)).tasks).toHaveLength(0);
    expect(metricSend).toHaveBeenCalledWith(expect.objectContaining({ metric: "skill.extract.dropped_no_project" }));
  });

  it("drops a task of mixed projects with its own reason", async () => {
    const { worker, buffer, extract, archive } = setup({ mode: "code" });
    await archive([labeled(HASH_A), labeled(HASH_B)]);
    const res = await worker.consumeAgent(agent);

    expect(extract).not.toHaveBeenCalled();
    expect(res.dropped).toHaveLength(1);
    expect((await buffer.readTasks(agent)).tasks).toHaveLength(0);
    expect(metricSend).toHaveBeenCalledWith(expect.objectContaining({ metric: "skill.extract.dropped_mixed_project" }));
  });

  it("extracts a task of one project and passes the project to the extractor", async () => {
    const { worker, buffer, extract, applyCandidates, archive } = setup({ mode: "code" });
    await archive([labeled(HASH_A), labeled(HASH_A)]);
    const res = await worker.consumeAgent(agent);

    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0]![0].project).toEqual({
      project_key: `key-${HASH_A}`,
      project_hash: HASH_A,
      project_name: "acme/a",
    });
    expect(applyCandidates).toHaveBeenCalledTimes(1);
    expect(res.processedTaskIds).toHaveLength(1);
    expect(res.dropped).toHaveLength(0);
    expect((await buffer.readTasks(agent)).tasks).toHaveLength(0);
    expect(metricSend).not.toHaveBeenCalled();
  });

  it("places an old buffered task from the L0 rows of its session", async () => {
    const lookup = vi.fn<TaskProjectLabelLookup>(async () => [
      { projectKey: "key-a", projectHash: HASH_A, projectName: "acme/a" },
      { projectKey: "key-a", projectHash: HASH_A, projectName: "acme/a" },
    ]);
    const { worker, extract, archive } = setup({ mode: "code", lookup });
    const archived = await archive([legacy(), legacy()]);
    await worker.consumeAgent(agent);

    expect(lookup).toHaveBeenCalledTimes(1);
    const query = lookup.mock.calls[0]![0];
    expect(query.task.session_id).toBe("s1");
    expect(query.endMs).toBe(archived.archivedAtMs);
    expect(query.endMs - query.startMs).toBe(24 * 60 * 60 * 1000);
    expect(extract.mock.calls[0]![0].project).toMatchObject({ project_hash: HASH_A, project_name: "acme/a" });
  });

  it("drops an old buffered task when L0 shows several projects or none", async () => {
    const mixed = setup({
      mode: "code",
      lookup: async () => [{ projectKey: "a", projectHash: HASH_A }, { projectKey: "b", projectHash: HASH_B }],
    });
    await mixed.archive([legacy()]);
    await mixed.worker.consumeAgent(agent);
    expect(mixed.extract).not.toHaveBeenCalled();
    expect(metricSend).toHaveBeenCalledWith(expect.objectContaining({ metric: "skill.extract.dropped_mixed_project" }));

    metricSend.mockReset();
    const none = setup({ mode: "code", lookup: async () => [] });
    await none.archive([legacy()]);
    await none.worker.consumeAgent(agent);
    expect(none.extract).not.toHaveBeenCalled();
    expect(metricSend).toHaveBeenCalledWith(expect.objectContaining({ metric: "skill.extract.dropped_no_project" }));
  });

  it("drops an old buffered task when no L0 lookup exists", async () => {
    const { worker, extract, archive } = setup({ mode: "code" });
    await archive([legacy()]);
    await worker.consumeAgent(agent);
    expect(extract).not.toHaveBeenCalled();
  });

  it("does not use L0 for a buffer that is labeled as having no project", async () => {
    const lookup = vi.fn<TaskProjectLabelLookup>(async () => [{ projectKey: "a", projectHash: HASH_A }]);
    const { worker, extract, archive } = setup({ mode: "code", lookup });
    await archive([labeled("")]);
    await worker.consumeAgent(agent);
    expect(lookup).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
  });

  it("keeps the task for a retry when the L0 lookup fails", async () => {
    const { worker, buffer, extract, archive } = setup({
      mode: "code",
      lookup: async () => { throw new Error("503 store unavailable"); },
    });
    await archive([legacy()]);
    await worker.consumeAgent(agent);
    expect(extract).not.toHaveBeenCalled();
    expect((await buffer.readTasks(agent)).tasks).toHaveLength(1);
  });
});

describe("extract worker in chat mode", () => {
  it.each([
    ["without a project", [labeled(""), labeled("")]],
    ["with mixed projects", [labeled(HASH_A), labeled(HASH_B)]],
    ["buffered before labels", [legacy()]],
  ])("extracts a task %s and passes no project", async (_name, messages) => {
    const lookup = vi.fn<TaskProjectLabelLookup>(async () => []);
    const { worker, extract, archive } = setup({ mode: "chat", lookup });
    await archive(messages);
    await worker.consumeAgent(agent);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0]![0]).not.toHaveProperty("project");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("behaves as chat mode when no mode is given", async () => {
    const { worker, extract, archive } = setup();
    await archive([labeled("")]);
    await worker.consumeAgent(agent);
    expect(extract).toHaveBeenCalledTimes(1);
  });
});

describe("extractor errors", () => {
  it("treats an extractor that cannot be built as a transient failure", async () => {
    const { classifyError, ExtractorUnavailableError } = await import("./extract-worker.js");
    // The message looks like a schema error, which alone would be permanent.
    expect(classifyError(new ExtractorUnavailableError("config schema validation failed (400)"))).toBe("transient");
  });

  it("places a task as mixed when only part of the L0 rows could be read", () => {
    // An unknown label for the unread rows makes the unanimity rule disagree.
    const labels = [
      { projectKey: `key-${HASH_A}`, projectHash: HASH_A },
      { projectKey: "", projectHash: "" },
    ];
    expect(classifyProjectLabels(labels).kind).toBe("mixed");
  });
});
