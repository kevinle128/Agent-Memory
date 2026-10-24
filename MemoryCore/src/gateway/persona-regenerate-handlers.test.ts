import { beforeEach, describe, expect, it, vi } from "vitest";

import type { L3GenerationReport, L3JevExecutionContext } from "../core/persona/jev-gate.js";
import type { StorageAdapter } from "../core/storage/adapter.js";
import type { IMemoryStore } from "../core/store/types.js";
import {
  makePersonaRegenerateRouteTable,
  resetActivePersonaRegenerationsForTest,
  type PersonaRegenerateDeps,
} from "./persona-regenerate-handlers.js";
import type { V2AuthContext } from "./v2-schemas.js";

const routes = makePersonaRegenerateRouteTable();
const regenerate = routes["/v3/persona/regenerate"];
const auth = { apiKey: "k", serviceId: "inst-1" } as V2AuthContext;
const A = "0123456789abcdef";
const logger = { warn: vi.fn(), error: vi.fn() };

// ── regenerate ──────────────────────────────────────────────

function report(over: Partial<L3GenerationReport> = {}): L3GenerationReport {
  return { scope: "user-global", outcome: "generated", generationId: "mg_run", ...over };
}

function regenDeps(run: PersonaRegenerateDeps["runPersonaRegeneration"], extra: Partial<PersonaRegenerateDeps> = {}): PersonaRegenerateDeps {
  return {
    getStore: () => ({}) as IMemoryStore,
    getStorage: () => ({}) as StorageAdapter,
    logger,
    runPersonaRegeneration: run,
    ...extra,
  };
}

const body = { team_id: "team-1", agent_id: "agent-1", reason: "root cause check" };

describe("POST /v3/persona/regenerate", () => {
  beforeEach(() => {
    resetActivePersonaRegenerationsForTest();
    vi.clearAllMocks();
  });

  it("returns a pass with the backup key, generation id and judge row ids", async () => {
    let seen: L3JevExecutionContext | undefined;
    const res = await regenerate(body, auth, "r", regenDeps(async ({ context }) => {
      seen = context;
      context.onBackupMade?.(".backup/persona-manual/persona-1.md");
      context.onGenerationSettled?.(report({
        generationId: context.forceRegenerate!.generationId,
        scopeCheck: { result: "passed", judge_attempts: 1, judge_record_ids: ["psc_1"] },
      }));
    }));
    expect(res.code).toBe(0);
    expect(res.data).toMatchObject({
      status: "completed", outcome: "pass", scope: "user-global", persona_kept: false,
      backup_key: ".backup/persona-manual/persona-1.md", judge_record_ids: ["psc_1"],
    });
    expect((res.data as { generation_id: string }).generation_id).toMatch(/^mg_/);
    expect(seen).toMatchObject({ teamId: "team-1", agentId: "agent-1", forceRegenerate: { reason: "root cause check" } });
    expect(seen!.forceRegenerate!.generationId).toBe((res.data as { generation_id: string }).generation_id);
  });

  it("returns the leaks of a rejected rewrite", async () => {
    const res = await regenerate(body, auth, "r", regenDeps(async ({ context }) => {
      context.onGenerationSettled?.(report({ scopeCheck: { result: "rejected", reason: "judge-leaks", leaks: ["Remotion"], judge_attempts: 2, judge_record_ids: ["a", "b"] } }));
    }));
    expect(res.data).toMatchObject({ outcome: "leaks", leaks: ["Remotion"], judge_record_ids: ["a", "b"] });
  });

  it("returns a technical failure with the previous persona kept", async () => {
    const res = await regenerate(body, auth, "r", regenDeps(async ({ context }) => {
      context.onGenerationSettled?.(report({ outcome: "judge_failed", scopeCheck: { result: "judge_failed", reason: "judge-timeout", error_kind: "timeout", judge_attempts: 1, judge_record_ids: ["a"] } }));
    }));
    expect(res.data).toMatchObject({ outcome: "technical_failure", persona_kept: true });
  });

  it("reports a failed run with its message", async () => {
    const res = await regenerate(body, auth, "r", regenDeps(async () => { throw new Error("LLM down"); }));
    expect(res.code).toBe(0);
    expect(res.data).toMatchObject({ status: "completed", outcome: "failed", error_message: "LLM down" });
  });

  it("takes the project path when project_hash is given", async () => {
    let seen: L3JevExecutionContext | undefined;
    const res = await regenerate({ ...body, project_hash: A }, auth, "r", regenDeps(async ({ context }) => {
      seen = context;
      context.onGenerationSettled?.(report({ scope: "project", projectHash: A }));
    }));
    expect(seen!.forceRegenerate!.projectHash).toBe(A);
    expect(res.data).toMatchObject({ scope: "project", project_hash: A, outcome: "generated" });
  });

  it("refuses a second call for the same agent while one runs, and accepts one after", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const deps = regenDeps(async ({ context }) => {
      await gate;
      context.onGenerationSettled?.(report());
    });
    const first = regenerate(body, auth, "r1", deps);
    await new Promise((r) => setTimeout(r, 10));
    const second = await regenerate(body, auth, "r2", deps);
    expect(second.code).toBe(409);
    expect(second.message ?? "").toContain("PERSONA_REGENERATION_BUSY");
    // Another agent is not blocked.
    const other = await regenerate({ ...body, agent_id: "agent-2" }, auth, "r3", regenDeps(async () => {}));
    expect(other.code).toBe(0);
    finish();
    expect((await first).code).toBe(0);
    expect((await regenerate(body, auth, "r4", regenDeps(async () => {}))).code).toBe(0);
  });

  it("refuses when another node holds the agent lock, and releases its own lock", async () => {
    const calls: string[] = [];
    const backend = (acquired: boolean) => ({
      acquireLock: async (key: string) => { calls.push(`acquire ${key}`); return acquired; },
      releaseLock: async (key: string) => { calls.push(`release ${key}`); return true; },
    });
    const busy = await regenerate(body, auth, "r", regenDeps(async () => {}, { stateBackend: backend(false) }));
    expect(busy.code).toBe(409);
    expect(calls).toEqual(["acquire pipeline:{inst-1:team-1:agent-1}"]);

    calls.length = 0;
    const ok = await regenerate(body, auth, "r", regenDeps(async () => {}, { stateBackend: backend(true) }));
    expect(ok.code).toBe(0);
    expect(calls).toEqual(["acquire pipeline:{inst-1:team-1:agent-1}", "release pipeline:{inst-1:team-1:agent-1}"]);
  });

  it("releases the lock when the run fails", async () => {
    const release = vi.fn(async () => true);
    const deps = regenDeps(async () => { throw new Error("x"); }, { stateBackend: { acquireLock: async () => true, releaseLock: release } });
    await regenerate(body, auth, "r", deps);
    expect(release).toHaveBeenCalledTimes(1);
    expect((await regenerate(body, auth, "r", regenDeps(async () => {}))).code).toBe(0);
  });

  it("answers running when the wait ends first, and keeps the lock until the run ends", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const release = vi.fn(async () => true);
    const deps = regenDeps(async ({ context }) => {
      context.onBackupMade?.("k1");
      await gate;
    }, { stateBackend: { acquireLock: async () => true, releaseLock: release } });
    const res = await regenerate({ ...body, timeout_ms: 1_000 }, auth, "r", deps);
    expect(res.data).toMatchObject({ status: "running", backup_key: "k1", lookup: { path: "/v3/llm-call/list" } });
    expect(release).not.toHaveBeenCalled();
    expect((await regenerate(body, auth, "r2", deps)).code).toBe(409);
    finish();
    await new Promise((r) => setTimeout(r, 10));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("validates the body", async () => {
    const deps = regenDeps(async () => {});
    expect((await regenerate({}, auth, "r", deps)).code).toBe(400);
    expect((await regenerate({ ...body, reason: "" }, auth, "r", deps)).code).toBe(400);
    expect((await regenerate({ ...body, project_hash: "../etc" }, auth, "r", deps)).code).toBe(400);
    expect((await regenerate({ ...body, timeout_ms: 5 }, auth, "r", deps)).code).toBe(400);
    expect((await regenerate({ ...body, other: 1 }, auth, "r", deps)).code).toBe(400);
  });

  it("answers 429 without credit and 503 without a runner", async () => {
    const noCredit = await regenerate(body, auth, "r", regenDeps(async () => {}, { checkCreditAllowed: async () => false }));
    expect(noCredit.code).toBe(429);
    const noRunner = await regenerate(body, auth, "r", regenDeps(undefined));
    expect(noRunner.code).toBe(503);
  });
});
