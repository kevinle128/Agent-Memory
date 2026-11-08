import type { AgentContext, AnchorTarget, CacheStrategy, ContextBlock, InjectionHook, HookPriority, PrewarmInput } from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { TdaiClient } from "../../tdai/client.js";
import type { ProfileScopeMode, TdaiMemoryConfig } from "../../tdai/types.js";
import { getProjectHash, getProjectName, getTdaiIdentity } from "../../tdai/identity.js";
import { resolveProfileScopeMode } from "../../tdai/profile-scope-mode.js";
import type { CoreSkillConfig } from "../../types.js";
import { getMetadataClient } from "../../meta/client.js";
import { resolveFixedAssetCtxs, type FixedAssetCtx } from "./tdai-fixed-asset.js";

export class TdaiProfileMemoryInjector implements InjectionHook {
  id = "tdai-profile-memory-injector";
  point = "system.suffix" as const;
  anchor: AnchorTarget = { slot: "memory", relation: "inside_append" };
  priority: HookPriority = HOOK_PRIORITY.MEMORY + 10;
  description = "Inject TDAI L3 (persona) + L2 scene index (path-only, agent reads via tool)";
  /** L2/L3 profile snapshot is injected once after session registration, like skill listing. */
  cacheStrategy: CacheStrategy = "session_init";
  /**
   * Scoped modes get their own cache id, so blocks cached in "legacy" mode are
   * not served again after the switch, also in running sessions. "legacy"
   * keeps the earlier id. In "scoped" mode this is the id for a session without
   * a known project, which is also the id that prewarm writes.
   */
  cacheVariant: string | undefined;

  /**
   * @param baseConfig  starter TdaiClient config; per-request `serviceId` will
   *   be overridden with `session.space_id` in `renderBlocksForContext`. This
   *   config's `serviceId` acts as a fallback when no `space_id` is present.
   * @param coreSkillCfg  kernel gateway config for MetadataClient (fixed-asset
   *   agent resolution).
   */
  constructor(
    private baseConfig: TdaiMemoryConfig,
    private coreSkillCfg: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "serviceId" | "timeoutMs"> | null = null,
  ) {
    const mode = this.scopeMode();
    this.cacheVariant = mode === "legacy" ? undefined : mode === "scoped" ? scopedCacheVariant(undefined) : `${mode}:v2`;
  }

  /**
   * The project of the session is part of the cache id in "scoped" mode. A
   * session that reports its project after the first request, or changes it
   * later, then misses the cache and renders the blocks of the new project,
   * and a block prewarmed before the report (no project) is not reused.
   */
  cacheVariantFor(custom: Record<string, unknown> | undefined): string | undefined {
    return this.scopeMode() === "scoped" ? scopedCacheVariant(getProjectHash(custom)) : this.cacheVariant;
  }

  private scopeMode(): ProfileScopeMode {
    return resolveProfileScopeMode(this.baseConfig.profileScopeMode);
  }

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const caps = ctx.metadata.custom?.assetCapabilities as { chat_memory?: boolean } | undefined;
    if (caps?.chat_memory === false) return [];
    return this.renderBlocksForContext(ctx);
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    if (input.assetCapabilities?.chat_memory === false) return [];
    return this.renderBlocksForContext(createPrewarmAgentContext(input));
  }

  private async renderBlocksForContext(ctx: AgentContext): Promise<ContextBlock[]> {
    const identity = getTdaiIdentity(ctx.metadata.custom);
    if (!identity) return [];

    const session = (ctx.metadata.custom as any)?.session as { user_key?: string; space_id?: string } | undefined;
    const userKey = session?.user_key;
    const spaceId = session?.space_id ?? "";
    const mc = this.coreSkillCfg && userKey
      ? getMetadataClient(this.coreSkillCfg, spaceId, userKey)
      : null;
    const ctxs = await resolveFixedAssetCtxs(ctx, identity, mc);

    // Build a per-request TdaiClient with the correct tenant. Falls back to
    // baseConfig.serviceId (config value) when spaceId is empty.
    const client = new TdaiClient({
      ...this.baseConfig,
      serviceId: spaceId || this.baseConfig.serviceId,
    });

    const mode = this.scopeMode();
    if (mode === "deny") {
      const l3Groups = await Promise.all(ctxs.map((c) => loadAgentProfile(client, c, { withL2: false })));
      return renderUserGlobalBlocks(this.id, l3Groups, "deny");
    }
    if (mode === "scoped") {
      // The project comes from the identity that the runner built from the hook
      // report. It is never derived from request text.
      const projectHash = getProjectHash(ctx.metadata.custom);
      const [l3Groups, projectGroups] = await Promise.all([
        Promise.all(ctxs.map((c) => loadAgentProfile(client, c, { withL2: false }))),
        projectHash
          ? Promise.all(ctxs.map((c) => loadAgentProfile(client, c, { withL2: true, projectHash })))
          : Promise.resolve([] as AgentProfileBundle[]),
      ]);
      return renderScopedBlocks(this.id, l3Groups, projectHash, projectGroups, getProjectName(ctx.metadata.custom));
    }

    const groups = await Promise.all(ctxs.map((c) => loadAgentProfile(client, c)));

    const hasAnything = groups.some((g) => g.l3 || g.l2Entries.length > 0);
    if (!hasAnything) {
      return [{
        type: "text",
        content: MEMORY_TOOLS_GUIDE,
        metadata: { source: this.id, agentCount: 0, l3Count: 0, l2Count: 0, mode: "tools-only" },
      }];
    }

    const lines: string[] = [
      "<tdai_profile_memory>",
      "The following is the long-term working memory that TDAI maintains for the current agent (own + imported sections; for L2 only the index is given, so read the full text with tools when needed):",
    ];

    let l2TotalCount = 0;
    let l3Count = 0;
    for (const g of groups) {
      if (!g.l3 && g.l2Entries.length === 0) continue;
      const tag = g.ctx.isSelf ? "self" : "imported_from";
      lines.push(
        `<agent name=${JSON.stringify(g.ctx.agentName)} role=${JSON.stringify(tag)} agent_id=${JSON.stringify(g.ctx.agentId)}>`,
      );
      if (g.l3?.content) {
        l3Count++;
        lines.push("<l3_core_memory>", truncate(g.l3.content, 6000), "</l3_core_memory>");
      }
      if (g.l2Entries.length > 0) {
        lines.push("<l2_scene_index>");
        for (const e of g.l2Entries) {
          l2TotalCount++;
          if (e.summary) {
            lines.push(`- \`${e.path}\` — ${truncate(e.summary, 200)}`);
          } else {
            lines.push(`- \`${e.path}\``);
          }
        }
        lines.push("</l2_scene_index>");
      }
      lines.push("</agent>");
    }

    lines.push("</tdai_profile_memory>");
    lines.push("");
    lines.push(MEMORY_TOOLS_GUIDE);

    return [
      {
        type: "text",
        content: lines.join("\n"),
        metadata: {
          source: this.id,
          agentCount: groups.length,
          l3Count,
          l2IndexCount: l2TotalCount,
          mode: "index+tools",
        },
      },
    ];
  }
}

function createPrewarmAgentContext(input: PrewarmInput): AgentContext {
  return {
    messages: [],
    tools: [],
    requestParams: {},
    metadata: {
      protocol: "anthropic",
      traceId: `prewarm:${input.keyId}`,
      keyId: input.keyId,
      modelId: "prewarm",
      stream: false,
      agentSource: "session-init",
      custom: { session: input.sessionInfo },
    },
  };
}

export const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## ⚠️ Important: this is not documentation, these are capabilities you can use

The tdai_memory_search / tdai_conversation_search tools and the others listed in
\`<tdai_memory_tools>\` are **capabilities you can call proactively** (they are not
reference-only documentation). You use them through **Bash + curl** (see the full
call instructions and URLs in the \`<tdai_memory_tools>\` section above).

**Never** answer with statements such as "I do not have this tool / I need MCP / I need a slash command".
**Correct approach**: when you decide you need to check memory, run curl directly in Bash. The proxy injects identity and authentication automatically.

## Memory usage rules (in the following situations, query first, then answer)

The L3 (persona, long-term profile) and the L2 scene index are already injected into the system prompt. L0/L1 must be searched actively with tools.
When the injected L2 content is related to the current task but not detailed enough, read the full text with \`tdai_read_scene\` using the path from the scene index; if the content is already enough, do not read it again.

### Situations where you must query memory before answering (any match triggers a tool call)

1. **The user refers to history / the past / earlier conversation**: for example "I said before / I told you / last time / do you remember / we talked about / that earlier thing" (in any language)
   → use \`tdai_conversation_search\` (find the specific message in the raw L0 text)
2. **The user asks about their own identity / preferences / habits**: for example "what is my name / my name / I like / my team / I usually use / I do not like / I do not allow" (in any language)
   → use \`tdai_memory_search\` (look up preferences and rules in L1 atomic memories)
3. **The user asks you to recall or find something**: for example "recall / remember / find / is there any record about X / check what we had before" (in any language)
   → trigger the tool directly; do not answer from thin air
4. **The answer depends strongly on historical facts**: for example "how did we fix that bug / what was the plan last time / what is our convention"
   → turn the question into keywords and call \`tdai_memory_search\`

**Typical flow** (user asks: "What is my name?"):
\`\`\`bash
# Step 1: query first
curl -sfk -X POST <bridge>/atomic/search \\
  -H 'Content-Type: application/json' -H 'x-conversation-id: <sid>' \\
  -d '{"query": "user name identity", "limit": 5}'
# Step 2: extract the answer from items[].content, then reply
# If empty: tell the user plainly "I did not find it in memory. What is your name?" -- do not pretend to know
\`\`\`

### Situations where you do not need to query

- Requests that do not depend on history or past experience and can be completed from the current input alone; do not decide whether to search from the task type alone
- The current conversation context (messages in the same turn) can already answer the question
- The answer is already visible in the \`<l3_core_memory>\` section

### ⚠️ Call constraints

- Per turn, \`tdai_memory_search\` + \`tdai_conversation_search\` may be called **at most 3 times in total** (\`tdai_read_scene\` / \`tdai_scenario_ls\` / \`tdai_atomic_query\` do not count)
- When a search finds nothing, **say so plainly**: "I did not find X in memory". Do not make things up
- Do not read the same L2 path twice
</memory-tools-guide>`;

interface AgentProfileBundle {
  ctx: FixedAssetCtx;
  l3: { content: string } | null;
  l2Entries: Array<{ path: string; summary?: string }>;
}

async function loadAgentProfile(
  client: TdaiClient,
  c: FixedAssetCtx,
  opts: { withL2: boolean; projectHash?: string } = { withL2: true },
): Promise<AgentProfileBundle> {
  const tdaiCtx = { teamId: c.teamId, userId: c.userId, agentId: c.agentId, agentName: c.agentName };
  const [l3, l2Entries] = await Promise.all([
    client.readL3ForCtx(tdaiCtx, opts.projectHash),
    opts.withL2 ? client.listL2ForCtx(tdaiCtx, opts.projectHash) : Promise.resolve([]),
  ]);
  const l3Stripped = l3 ? stripSceneNavigation(l3.content) : "";
  return {
    ctx: c,
    l3: l3Stripped.trim() ? { content: l3Stripped } : null,
    l2Entries: (l2Entries ?? []).map((e) => ({ path: e.path, summary: e.summary })),
  };
}

export function stripSceneNavigation(personaContent: string): string {
  const idx = personaContent.indexOf("## 🗺️ Scene Navigation");
  if (idx === -1) return personaContent;
  let cut = personaContent.slice(0, idx);
  cut = cut.replace(/\s*-{3,}\s*$/, "");
  return cut.trimEnd();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s;
}

// ── Deny mode: user-global L3 only ──────────────────────────────────────────

/**
 * First line of an L3 that the user-global persona generator wrote and checked
 * for project facts. Deny mode injects no L3 without it, so a persona written
 * by the earlier generator is never injected.
 */
export const USER_GLOBAL_SCOPE_MARKER = "<!-- agent-memory:scope=user-global v1 -->";

/** True when the L3 starts with {@link USER_GLOBAL_SCOPE_MARKER}. */
export function hasUserGlobalMarker(content: string): boolean {
  return content.trimStart().startsWith(USER_GLOBAL_SCOPE_MARKER);
}

function stripUserGlobalMarker(content: string): string {
  return content.trimStart().slice(USER_GLOBAL_SCOPE_MARKER.length).trim();
}

const INJECTED_PROFILE_NOTE =
  "The L3 (persona, long-term profile) and the L2 scene index are already injected into the system prompt. L0/L1 must be searched actively with tools.\n" +
  "When the injected L2 content is related to the current task but not detailed enough, read the full text with `tdai_read_scene` using the path from the scene index; if the content is already enough, do not read it again.";

const USER_GLOBAL_PROFILE_NOTE =
  "The system prompt includes at most the cross-project L3 (the user long-term profile). It includes no project information and no L2 scene index. " +
  "L0/L1/L2 must be searched actively with tools.";

/** Tools guide for deny mode: it does not claim that an L2 index was injected. */
export const MEMORY_TOOLS_GUIDE_USER_GLOBAL = MEMORY_TOOLS_GUIDE.replace(INJECTED_PROFILE_NOTE, USER_GLOBAL_PROFILE_NOTE);

const PROJECT_PROFILE_NOTE =
  "The system prompt injects two kinds of memory: `<user_global_memory>` is the cross-project L3 (the user long-term profile) and has no project information; " +
  "`<project_memory>` is the L3 and L2 scene index of the current project and applies only to the current project. " +
  "The user-global L2 scene index is not injected; list it with tdai_scenario_ls when needed. " +
  "Read an injected project scene with `tdai_read_scene` using the path from the index; if the content is already enough, do not read it again. L0/L1 must be searched actively with tools.";

/** Tools guide for a session with injected project memory. */
export const MEMORY_TOOLS_GUIDE_PROJECT = MEMORY_TOOLS_GUIDE.replace(INJECTED_PROFILE_NOTE, PROJECT_PROFILE_NOTE);

/** Cache id part of "scoped" mode; `none` is the session without a known project. */
function scopedCacheVariant(projectHash: string | undefined): string {
  return `scoped:v1:${projectHash ?? "none"}`;
}

/** Scope facts written into block metadata; the Langfuse observer copies them to the span. */
interface ProfileScopeMeta {
  mode: ProfileScopeMode;
  scopesInjected: string[];
  deniedReason?: string;
  deniedAgentCount: number;
  /** Hash of the project of the session. Never the project key or the remote URL. */
  projectHash?: string;
}

function renderUserGlobalBlocks(
  source: string,
  groups: AgentProfileBundle[],
  mode: "deny" | "scoped",
  projectHash?: string,
): ContextBlock[] {
  const allowed = groups.filter((g) => g.l3 && hasUserGlobalMarker(g.l3.content));
  const scope: ProfileScopeMeta = {
    mode,
    scopesInjected: allowed.length > 0 ? ["global-l3"] : [],
    deniedAgentCount: groups.length - allowed.length,
    ...(allowed.length === 0 ? { deniedReason: "no-user-global-l3" } : {}),
    ...(projectHash ? { projectHash } : {}),
  };
  if (allowed.length === 0) {
    return [{
      type: "text",
      content: MEMORY_TOOLS_GUIDE_USER_GLOBAL,
      metadata: { source, agentCount: 0, l3Count: 0, l2Count: 0, mode: "tools-only", scope },
    }];
  }
  const lines: string[] = [
    "<tdai_profile_memory>",
    "The following is the cross-project long-term memory that TDAI maintains for the current agent (it contains no project information; search project memory with tools when needed):",
  ];
  pushUserGlobalAgents(lines, allowed);
  lines.push("</tdai_profile_memory>", "", MEMORY_TOOLS_GUIDE_USER_GLOBAL);
  return [{
    type: "text",
    content: lines.join("\n"),
    metadata: { source, agentCount: allowed.length, l3Count: allowed.length, l2IndexCount: 0, mode: "user-global", scope },
  }];
}

function agentOpenTag(g: AgentProfileBundle): string {
  const tag = g.ctx.isSelf ? "self" : "imported_from";
  return `<agent name=${JSON.stringify(g.ctx.agentName)} role=${JSON.stringify(tag)} agent_id=${JSON.stringify(g.ctx.agentId)}>`;
}

/** One `<agent>` segment per allowed agent. Shared by "deny" and "scoped" so that both render the same text. */
function pushUserGlobalAgents(lines: string[], allowed: AgentProfileBundle[]): void {
  for (const g of allowed) {
    lines.push(
      agentOpenTag(g),
      "<l3_core_memory>",
      truncate(stripUserGlobalMarker(g.l3!.content), 6000),
      "</l3_core_memory>",
      "</agent>",
    );
  }
}

/**
 * "scoped" mode. The user-global part follows the same marker gate as "deny".
 * The project part is added only when the session has a known project and that
 * project has memory; it needs no marker, because project memory is meant to
 * hold project facts. Without project memory the result is the "deny" output.
 */
function renderScopedBlocks(
  source: string,
  globalGroups: AgentProfileBundle[],
  projectHash: string | undefined,
  projectGroups: AgentProfileBundle[],
  projectName?: string,
): ContextBlock[] {
  const withProject = projectGroups.filter((g) => g.l3 || g.l2Entries.length > 0);
  if (!projectHash || withProject.length === 0) {
    return renderUserGlobalBlocks(source, globalGroups, "scoped", projectHash);
  }

  const allowed = globalGroups.filter((g) => g.l3 && hasUserGlobalMarker(g.l3.content));
  // The name is validated upstream (one line, no angle brackets). The hash prefix is the fallback.
  const label = projectName ?? projectHash.slice(0, 8);
  const lines: string[] = [
    "<tdai_profile_memory>",
    "The following is the long-term memory that TDAI maintains for the current agent. It has two kinds: " +
      "`<user_global_memory>` is the cross-project memory (it contains no project information); " +
      `\`<project_memory>\` belongs only to the current project ${label}. Do not treat it as fact about any other project:`,
  ];
  if (allowed.length > 0) {
    lines.push("<user_global_memory>");
    pushUserGlobalAgents(lines, allowed);
    lines.push("</user_global_memory>");
  }

  let projectL3Count = 0;
  let projectL2Count = 0;
  lines.push(`<project_memory project=${JSON.stringify(label)}>`);
  for (const g of withProject) {
    lines.push(agentOpenTag(g));
    if (g.l3) {
      projectL3Count++;
      lines.push("<l3_core_memory scope=\"project\">", truncate(g.l3.content, 6000), "</l3_core_memory>");
    }
    if (g.l2Entries.length > 0) {
      lines.push("<l2_scene_index scope=\"project\">");
      for (const e of g.l2Entries) {
        projectL2Count++;
        lines.push(e.summary ? `- \`${e.path}\` — ${truncate(e.summary, 200)}` : `- \`${e.path}\``);
      }
      lines.push("</l2_scene_index>");
    }
    lines.push("</agent>");
  }
  lines.push("</project_memory>", "</tdai_profile_memory>", "", MEMORY_TOOLS_GUIDE_PROJECT);

  const scopesInjected = [
    ...(allowed.length > 0 ? ["global-l3"] : []),
    ...(projectL3Count > 0 ? ["project-l3"] : []),
    ...(projectL2Count > 0 ? ["project-l2"] : []),
  ];
  const scope: ProfileScopeMeta = {
    mode: "scoped",
    scopesInjected,
    deniedAgentCount: globalGroups.length - allowed.length,
    projectHash,
    ...(allowed.length === 0 ? { deniedReason: "no-user-global-l3" } : {}),
  };
  return [{
    type: "text",
    content: lines.join("\n"),
    metadata: {
      source,
      agentCount: new Set([...allowed, ...withProject].map((g) => g.ctx.agentId)).size,
      l3Count: allowed.length + projectL3Count,
      l2IndexCount: projectL2Count,
      mode: "user-global+project",
      scope,
    },
  }];
}
