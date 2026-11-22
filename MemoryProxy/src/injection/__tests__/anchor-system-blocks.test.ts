import { describe, expect, it } from "vitest";

import { AnthropicAdapter } from "../adapters/anthropic.js";
import type { ProtocolAdapter } from "../adapters/interface.js";
import type { AgentProfile } from "../agents/interface.js";
import { ClaudeCodeProfile } from "../agents/claude-code/index.js";
import { CodeBuddyProfile } from "../agents/codebuddy/index.js";
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

const SKILL_HEADING = "# Session-specific guidance";
const SKILL_BODY = "Only use skills listed in the user-invocable skills section.";
const MEMORY_HEADING = "# Memory";
const MEMORY_BODY = "Persistent file-based memory.";

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

function pipeline(hooks: InjectionHook[], agentSource = "claude-code", profile: AgentProfile = new ClaudeCodeProfile()): InjectionPipeline {
  const registry = new HookRegistryImpl();
  for (const item of hooks) registry.register(item);
  const adapters = new Map<string, ProtocolAdapter>([["anthropic", new AnthropicAdapter()]]);
  return new InjectionPipeline(registry, adapters, {
    agentProfiles: new Map([[agentSource, profile]]),
  });
}

async function run(system: unknown, hooks: InjectionHook[], agentSource = "claude-code", profile?: AgentProfile) {
  return pipeline(hooks, agentSource, profile).process(
    { model: "claude", max_tokens: 8, system, messages: [{ role: "user", content: "hi" }] },
    { ...metadata, agentSource },
  );
}

/** The injected text sits against the target heading the way that relation places it. */
function expectAnchorPosition(
  text: string,
  relation: AnchorRelation,
  injected: string,
  heading: string,
  body: string,
) {
  const headingAt = text.indexOf(heading);
  const injectedAt = text.indexOf(injected);
  expect(headingAt).toBeGreaterThanOrEqual(0);
  expect(injectedAt).toBeGreaterThanOrEqual(0);
  if (relation === "before") {
    expect(text.slice(injectedAt, headingAt)).toBe(`${injected}\n`);
  } else if (relation === "inside_prepend") {
    expect(text.slice(headingAt, injectedAt + injected.length)).toBe(`${heading}\n${injected}`);
  } else {
    expect(text).toContain(`${heading}\n${body}\n${injected}`);
    expect(headingAt).toBeLessThan(injectedAt);
  }
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
    ["before", "skills", SKILL_HEADING, SKILL_BODY, "SKILL_BEFORE"],
    ["after", "skills", SKILL_HEADING, SKILL_BODY, "SKILL_AFTER"],
    ["inside_append", "skills", SKILL_HEADING, SKILL_BODY, "SKILL_INSIDE_APPEND"],
    ["inside_prepend", "skills", SKILL_HEADING, SKILL_BODY, "SKILL_INSIDE_PREPEND"],
    ["before", "memory", MEMORY_HEADING, MEMORY_BODY, "MEMORY_BEFORE"],
    ["after", "memory", MEMORY_HEADING, MEMORY_BODY, "MEMORY_AFTER"],
    ["inside_append", "memory", MEMORY_HEADING, MEMORY_BODY, "MEMORY_INSIDE_APPEND"],
    ["inside_prepend", "memory", MEMORY_HEADING, MEMORY_BODY, "MEMORY_INSIDE_PREPEND"],
  ] as const)("relation %s on %s sits against that heading", async (relation, slot, heading, body, injected) => {
    const out = await run(claudeCodeSystem(), [hook("anchor-hook", relation, slot, injected, 200)]);
    const system = out.system as SystemBlock[];

    expect(Array.isArray(system)).toBe(true);
    expect(system).toHaveLength(3);
    expect(system[0]).toEqual(billingBlock);
    expect(system[1]).toEqual(identityBlock);
    expect(system[2].cache_control).toEqual(CACHE);
    expectAnchorPosition(system[2].text, relation, injected, heading, body);
    expect(withoutInjected(system[2].text, injected)).toBe(CORE);
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
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
    expectAnchorPosition(system[2].text, "before", "SKILLS_BLOCK", SKILL_HEADING, SKILL_BODY);
    expectAnchorPosition(system[2].text, "inside_append", "MEMORY_BLOCK", MEMORY_HEADING, MEMORY_BODY);
    expect(withoutInjected(withoutInjected(system[2].text, "SKILLS_BLOCK"), "MEMORY_BLOCK")).toBe(CORE);
  });

  it("leaves a non-text system block in place, including its cache marker", async () => {
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aaaa" },
      cache_control: CACHE,
    };
    const input = [structuredClone(billingBlock), structuredClone(image), structuredClone(coreBlock)];
    const out = await run(structuredClone(input), [hook("skill-injector", "before", "skills", "BESIDE_IMAGE", 200)]);
    const system = out.system as Array<SystemBlock | typeof image>;

    expect(system).toHaveLength(3);
    expect(system[0]).toEqual(billingBlock);
    expect(system[1]).toEqual(image);
    expect((system[2] as SystemBlock).cache_control).toEqual(CACHE);
    expectAnchorPosition((system[2] as SystemBlock).text, "before", "BESIDE_IMAGE", SKILL_HEADING, SKILL_BODY);
  });

  it("edits only the first text block when two blocks contain the same heading", async () => {
    const first = `${SKILL_HEADING}\nfirst skills body`;
    const second = `${SKILL_HEADING}\nsecond skills body`;
    const firstBlock = { type: "text", text: first, cache_control: CACHE };
    const secondBlock = { type: "text", text: second, cache_control: CACHE };
    const out = await run(
      [structuredClone(billingBlock), structuredClone(firstBlock), structuredClone(secondBlock)],
      [hook("skill-injector", "before", "skills", "FIRST_ONLY", 200)],
    );
    const system = out.system as SystemBlock[];

    expect(system).toHaveLength(3);
    expect(system[0]).toEqual(billingBlock);
    expect(system[1].cache_control).toEqual(CACHE);
    expect(system[1].text.slice(0, system[1].text.indexOf(SKILL_HEADING))).toBe("FIRST_ONLY\n");
    expect(system[2]).toEqual(secondBlock);
  });

  it("keeps CodeBuddy sibling blocks while the XML anchor lands in its own block", async () => {
    const preamble = { type: "text", text: "You are CodeBuddy." };
    const skills = {
      type: "text",
      text: "<agent_skills>\nlisted skills\n</agent_skills>",
      cache_control: CACHE,
    };
    const memories = {
      type: "text",
      text: "<memories>\nknown facts\n</memories>",
      cache_control: CACHE,
    };
    const out = await run(
      [structuredClone(preamble), structuredClone(skills), structuredClone(memories)],
      [hook("skill-injector", "before", "skills", "CB_SKILL", 200)],
      "codebuddy",
      new CodeBuddyProfile(),
    );
    const system = out.system as SystemBlock[];

    expect(system).toHaveLength(3);
    expect(system[0]).toEqual(preamble);
    expect(system[2]).toEqual(memories);
    expect(system[1].cache_control).toEqual(CACHE);
    expect(system[1].text.startsWith("CB_SKILL<agent_skills>")).toBe(true);
    expect(system[1].text).toContain("listed skills");
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
