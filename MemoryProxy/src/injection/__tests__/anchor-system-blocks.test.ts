import { describe, expect, it } from "vitest";

import { AnthropicAdapter } from "../adapters/anthropic.js";
import type { ProtocolAdapter } from "../adapters/interface.js";
import { ClaudeCodeProfile } from "../agents/claude-code/index.js";
import { InjectionPipeline } from "../pipeline.js";
import { HookRegistryImpl } from "../registry.js";
import type {
  AgentContextMetadata,
  AnchorRelation,
  ContextBlock,
  InjectionHook,
} from "../types.js";

const CACHE = { type: "ephemeral" };

/** Block [2] shape from a Claude Code system prompt: core text plus the append. */
const CORE = [
  "You are Claude Code, an AI assistant.",
  "# Harness",
  "Follow the tool rules.",
  "# Session-specific guidance",
  "Only use skills listed in the user-invocable skills section.",
  "# Memory",
  "Persistent file-based memory.",
  "# Environment",
  "Working directory: /tmp",
  "# Context management",
  "Summarize when the window fills.",
].join("\n");

const BILLING = "x-anthropic-billing-header: cc_version=2.1.325; est_cost=0";
const IDENTITY = "You are Claude, an AI assistant made by Anthropic for Claude Code.";

const billingBlock = { type: "text", text: BILLING };
const identityBlock = { type: "text", text: IDENTITY, cache_control: CACHE };
const coreBlock = { type: "text", text: CORE, cache_control: CACHE };

function claudeCodeSystem() {
  return [structuredClone(billingBlock), structuredClone(identityBlock), structuredClone(coreBlock)];
}

const metadata: AgentContextMetadata = {
  protocol: "anthropic",
  traceId: "t-anchor",
  keyId: "k1",
  modelId: "m1",
  stream: false,
  agentSource: "claude-code",
  userId: "u1",
};

function hook(id: string, relation: AnchorRelation, slot: "skills" | "memory", content: string, priority: number): InjectionHook {
  return {
    id,
    point: "system.suffix",
    priority,
    description: id,
    anchor: { slot, relation },
    execute: () => [{ type: "text", content } satisfies ContextBlock],
  };
}

function pipeline(hooks: InjectionHook[]): InjectionPipeline {
  const registry = new HookRegistryImpl();
  for (const item of hooks) registry.register(item);
  const adapters = new Map<string, ProtocolAdapter>([["anthropic", new AnthropicAdapter()]]);
  return new InjectionPipeline(registry, adapters, {
    agentProfiles: new Map([["claude-code", new ClaudeCodeProfile()]]),
  });
}

async function run(system: unknown, hooks: InjectionHook[]) {
  return pipeline(hooks).process(
    { model: "claude", max_tokens: 8, system, messages: [{ role: "user", content: "hi" }] },
    metadata,
  );
}

/** Drop the injected text and the one newline the anchor join adds beside it. */
function withoutInjected(actual: string, injected: string): string {
  const at = actual.indexOf(injected);
  expect(at).toBeGreaterThanOrEqual(0);
  let start = at;
  let end = at + injected.length;
  if (actual[end] === "\n") end += 1;
  else if (start > 0 && actual[start - 1] === "\n") start -= 1;
  return actual.slice(0, start) + actual.slice(end);
}

type SystemBlock = { type: string; text: string; cache_control?: { type: string } };

describe("anchored injection keeps sibling system blocks", () => {
  it.each([
    ["before", "SKILL_BEFORE"],
    ["inside_append", "SKILL_INSIDE_APPEND"],
    ["inside_prepend", "SKILL_INSIDE_PREPEND"],
    ["after", "SKILL_AFTER"],
  ] as const)("relation %s edits only the block that holds the anchor", async (relation, injected) => {
    const out = await run(claudeCodeSystem(), [hook("skill-injector", relation, "skills", injected, 200)]);
    const system = out.system as SystemBlock[];

    expect(Array.isArray(system)).toBe(true);
    expect(system).toHaveLength(3);
    expect(system[0]).toEqual(billingBlock);
    expect(system[1]).toEqual(identityBlock);
    expect(system[2].cache_control).toEqual(CACHE);
    expect(system[2].text).toContain(injected);
    expect(withoutInjected(system[2].text, injected)).toBe(CORE);
    expect(out.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("lands skills and memory in the core block and leaves the other blocks unchanged", async () => {
    const out = await run(claudeCodeSystem(), [
      hook("tdai-profile-memory-injector", "inside_append", "memory", "MEMORY_BLOCK", 100),
      hook("skill-injector", "before", "skills", "SKILLS_BLOCK", 200),
    ]);
    const system = out.system as SystemBlock[];

    expect(system).toHaveLength(3);
    expect(system[0]).toEqual(billingBlock);
    expect(system[1]).toEqual(identityBlock);
    expect(system[2].cache_control).toEqual(CACHE);
    expect(system[2].text).toContain("MEMORY_BLOCK");
    expect(system[2].text).toContain("SKILLS_BLOCK");
    expect(withoutInjected(withoutInjected(system[2].text, "SKILLS_BLOCK"), "MEMORY_BLOCK")).toBe(CORE);
  });

  it("falls back to the point when no block holds the anchor and appends a new block", async () => {
    const input = [
      { type: "text", text: "billing header" },
      { type: "text", text: "identity block", cache_control: CACHE },
      { type: "text", text: "core prompt with no memory heading", cache_control: CACHE },
    ];
    const out = await run(structuredClone(input), [
      hook("tdai-profile-memory-injector", "inside_append", "memory", "FALLBACK_MEMORY", 100),
    ]);
    const system = out.system as SystemBlock[];

    expect(system).toHaveLength(4);
    expect(system.slice(0, 3)).toEqual(input);
    expect(system[3]).toEqual({ type: "text", text: "FALLBACK_MEMORY" });
  });

  it("keeps a string system prompt as a string after the anchor is applied", async () => {
    const out = await run(CORE, [hook("skill-injector", "before", "skills", "STRING_SKILL", 200)]);

    expect(typeof out.system).toBe("string");
    const system = out.system as string;
    expect(system).toContain("STRING_SKILL");
    expect(withoutInjected(system, "STRING_SKILL")).toBe(CORE);
  });

  it("round-trips the core block through parse and rebuild", () => {
    const profile = new ClaudeCodeProfile();
    expect(profile.rebuild(profile.parse(CORE))).toBe(CORE);
  });
});
