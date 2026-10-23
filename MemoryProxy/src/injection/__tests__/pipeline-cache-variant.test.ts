import { describe, expect, it, vi } from "vitest";

import type { HookCacheEntry, HookCacheRepo } from "../../db/hookCacheRepo.js";
import { AnthropicAdapter } from "../adapters/anthropic.js";
import type { ProtocolAdapter } from "../adapters/interface.js";
import { InjectionPipeline } from "../pipeline.js";
import { prewarmAll } from "../prewarm.js";
import { HookRegistryImpl } from "../registry.js";
import type { AgentContextMetadata, ContextBlock, InjectionHook, PrewarmInput } from "../types.js";
import { hookCacheId } from "../types.js";

/** In-memory cache for one session: the key is the cache id the caller passes. */
class MemoryHookCache implements HookCacheRepo {
  readonly entries = new Map<string, ContextBlock[]>();
  put(_s: string, _u: string, _a: string, _sid: string, hookId: string, blocks: ContextBlock[]): void {
    this.entries.set(hookId, blocks);
  }
  putMany(_s: string, _u: string, _a: string, _sid: string, entries: HookCacheEntry[]): void {
    for (const e of entries) this.entries.set(e.hookId, e.blocks);
  }
  async get(_s: string, _u: string, _a: string, _sid: string, hookId: string): Promise<ContextBlock[] | null> {
    return this.entries.get(hookId) ?? null;
  }
  async getAllForSession(): Promise<HookCacheEntry[]> {
    return [...this.entries].map(([hookId, blocks]) => ({ hookId, blocks }));
  }
  clearBySession(): void {
    this.entries.clear();
  }
}

const text = (content: string): ContextBlock => ({ type: "text", content });

function makeHook(execute: () => ContextBlock[], cacheVariant?: string): InjectionHook {
  return {
    id: "profile",
    point: "system.suffix",
    priority: 50,
    description: "test hook",
    cacheStrategy: "session_init",
    ...(cacheVariant ? { cacheVariant } : {}),
    execute,
  } as InjectionHook;
}

function makePipeline(hook: InjectionHook, cache: HookCacheRepo): InjectionPipeline {
  const registry = new HookRegistryImpl();
  registry.register(hook);
  const adapters = new Map<string, ProtocolAdapter>([["anthropic", new AnthropicAdapter()]]);
  return new InjectionPipeline(registry, adapters, { hookCacheRepo: cache });
}

const metadata: AgentContextMetadata = {
  protocol: "anthropic",
  traceId: "t1",
  keyId: "k1",
  modelId: "m1",
  stream: false,
  agentSource: "claude-code",
  userId: "u1",
  custom: { session: { session_id: "s1" } },
} as AgentContextMetadata;

const body = () => ({ system: "base prompt", messages: [{ role: "user", content: "hi" }] });

describe("hookCacheId", () => {
  it("returns the bare id without a variant", () => {
    expect(hookCacheId({ id: "profile" })).toBe("profile");
  });

  it("appends the variant", () => {
    expect(hookCacheId({ id: "profile", cacheVariant: "deny:v2" })).toBe("profile::deny:v2");
  });
});

describe("session_init cache with cacheVariant", () => {
  it("never serves a block cached under the bare id once a variant is declared", async () => {
    const cache = new MemoryHookCache();
    cache.entries.set("profile", [text("LEGACY_PROJECT_FACTS")]);
    const execute = vi.fn(() => [text("USER_GLOBAL_ONLY")]);

    const out = JSON.stringify(await makePipeline(makeHook(execute, "deny:v2"), cache).process(body(), metadata));

    expect(out).toContain("USER_GLOBAL_ONLY");
    expect(out).not.toContain("LEGACY_PROJECT_FACTS");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("self-heals under the variant id on a miss", async () => {
    const cache = new MemoryHookCache();
    await makePipeline(makeHook(() => [text("fresh")], "deny:v2"), cache).process(body(), metadata);
    expect(cache.entries.get("profile::deny:v2")).toEqual([text("fresh")]);
    expect(cache.entries.has("profile")).toBe(false);
  });

  it("serves the block cached under the variant id without executing the hook", async () => {
    const cache = new MemoryHookCache();
    cache.entries.set("profile::deny:v2", [text("CACHED_VARIANT")]);
    const execute = vi.fn(() => [text("fresh")]);

    const out = JSON.stringify(await makePipeline(makeHook(execute, "deny:v2"), cache).process(body(), metadata));

    expect(out).toContain("CACHED_VARIANT");
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps reading the bare id for a hook without a variant", async () => {
    const cache = new MemoryHookCache();
    cache.entries.set("profile", [text("BARE_CACHED")]);
    const out = JSON.stringify(await makePipeline(makeHook(() => [text("fresh")]), cache).process(body(), metadata));
    expect(out).toContain("BARE_CACHED");
  });
});

describe("prewarm with cacheVariant", () => {
  it("writes prewarmed blocks under the variant id", async () => {
    const cache = new MemoryHookCache();
    const hook = { ...makeHook(() => []), cacheVariant: "deny:v2", prewarm: () => [text("prewarmed")] } as InjectionHook;
    const registry = new HookRegistryImpl();
    registry.register(hook);
    const input = {
      keyId: "k1",
      userId: "u1",
      agentSource: "claude-code",
      sessionInfo: { session_id: "s1" },
      agentDetail: null,
      taskDetail: null,
    } as unknown as PrewarmInput;

    const result = await prewarmAll(registry, cache, input);

    expect(result.cachedHookIds).toEqual(["profile"]);
    expect(cache.entries.get("profile::deny:v2")).toEqual([text("prewarmed")]);
  });
});

/** A hook whose cache id depends on the project in `metadata.custom`, like the profile injector in scoped mode. */
function makeProjectHook(execute: (custom: Record<string, unknown> | undefined) => ContextBlock[]): InjectionHook {
  const variantOf = (custom: Record<string, unknown> | undefined) => `scoped:v1:${(custom?.projectHash as string | undefined) ?? "none"}`;
  return {
    id: "profile",
    point: "system.suffix",
    priority: 50,
    description: "project hook",
    cacheStrategy: "session_init",
    cacheVariant: variantOf(undefined),
    cacheVariantFor: variantOf,
    execute: (ctx) => execute(ctx.metadata.custom),
    prewarm: () => [text("PREWARMED_NO_PROJECT")],
  } as InjectionHook;
}

const metadataWith = (projectHash?: string): AgentContextMetadata => ({
  ...metadata,
  custom: { session: { session_id: "s1" }, ...(projectHash ? { projectHash } : {}) },
});

describe("hookCacheId with cacheVariantFor", () => {
  it("prefers the per-request variant and falls back to the static one", () => {
    const hook = makeProjectHook(() => []);
    expect(hookCacheId(hook, { projectHash: "aaaaaaaaaaaaaaaa" })).toBe("profile::scoped:v1:aaaaaaaaaaaaaaaa");
    expect(hookCacheId(hook)).toBe("profile::scoped:v1:none");
    expect(hookCacheId({ id: "profile", cacheVariant: "deny:v2" }, { projectHash: "aaaaaaaaaaaaaaaa" })).toBe("profile::deny:v2");
  });
});

describe("session_init cache keyed by project", () => {
  it("does not reuse a block prewarmed without a project once the project is known", async () => {
    const cache = new MemoryHookCache();
    const hook = makeProjectHook((custom) => [text(`LIVE_${custom?.projectHash ?? "none"}`)]);
    const registry = new HookRegistryImpl();
    registry.register(hook);
    await prewarmAll(registry, cache, {
      keyId: "k1", userId: "u1", agentSource: "claude-code",
      sessionInfo: { session_id: "s1" }, agentDetail: null, taskDetail: null,
    } as unknown as PrewarmInput);
    expect(cache.entries.get("profile::scoped:v1:none")).toEqual([text("PREWARMED_NO_PROJECT")]);
    const pipeline = makePipeline(hook, cache);

    const before = JSON.stringify(await pipeline.process(body(), metadataWith()));
    const after = JSON.stringify(await pipeline.process(body(), metadataWith("aaaaaaaaaaaaaaaa")));

    expect(before).toContain("PREWARMED_NO_PROJECT");
    expect(after).toContain("LIVE_aaaaaaaaaaaaaaaa");
    expect(after).not.toContain("PREWARMED_NO_PROJECT");
    expect(cache.entries.get("profile::scoped:v1:aaaaaaaaaaaaaaaa")).toEqual([text("LIVE_aaaaaaaaaaaaaaaa")]);
  });

  it("renders the blocks of the new project when the project changes mid-session, and reuses each cached block", async () => {
    const cache = new MemoryHookCache();
    const execute = vi.fn((custom: Record<string, unknown> | undefined) => [text(`LIVE_${custom?.projectHash}`)]);
    const pipeline = makePipeline(makeProjectHook(execute), cache);

    const a1 = JSON.stringify(await pipeline.process(body(), metadataWith("aaaaaaaaaaaaaaaa")));
    const b = JSON.stringify(await pipeline.process(body(), metadataWith("bbbbbbbbbbbbbbbb")));
    const a2 = JSON.stringify(await pipeline.process(body(), metadataWith("aaaaaaaaaaaaaaaa")));

    expect(a1).toContain("LIVE_aaaaaaaaaaaaaaaa");
    expect(b).toContain("LIVE_bbbbbbbbbbbbbbbb");
    expect(b).not.toContain("LIVE_aaaaaaaaaaaaaaaa");
    expect(a2).toContain("LIVE_aaaaaaaaaaaaaaaa");
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
