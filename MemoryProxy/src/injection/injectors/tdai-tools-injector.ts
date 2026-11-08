/**
 * TdaiMemoryToolsInjector — inject a static `<tdai_memory_tools>` text block
 * that teaches the LLM to curl `<proxy>/memory-bridge/v3/*` for TDAI memory
 * read operations.
 *
 *   Why static (NOT native tool defs):
 */

import type {
  AgentContext,
  AnchorTarget,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { getProjectHash, getTdaiIdentity } from "../../tdai/identity.js";
import { resolveProfileScopeMode } from "../../tdai/profile-scope-mode.js";
import type { ProfileScopeMode } from "../../tdai/types.js";

export interface TdaiMemoryToolsInjectorConfig {
  /**
   * Base URL the LLM should curl. Filled into every curl recipe.
   * E.g. `http://127.0.0.1:8096`. Trailing slash trimmed.
   */
  proxyBaseUrl: string;
  /** Profile scope mode of the profile injector; decides what the coverage text says. Missing means "scoped". */
  profileScopeMode?: ProfileScopeMode;
}

/**
 * `projectKnown` only matters in "scoped" mode: it describes the project scenes
 * and the `scope` field of the scene tools. Without it, "scoped" renders the
 * same text as "deny". The text with a project holds whether or not the profile
 * injector renders a `<project_memory>` block: the block is described as
 * conditional, and the scene tools act on the known project in both cases.
 */
export function renderTdaiMemoryToolsBlock(
  proxyBaseUrl: string,
  sessionId?: string,
  spaceId?: string,
  profileScopeMode: ProfileScopeMode = "deny",
  projectKnown = false,
): string {
  const legacyProfile = profileScopeMode === "legacy";
  const projectScenes = profileScopeMode === "scoped" && projectKnown;
  const base = proxyBaseUrl.replace(/\/$/, "");
  const bridge = `${base}/memory-bridge/v3`;
  const sessionHeader = sessionId ? ` -H 'x-conversation-id: ${sessionId}'` : "";
  const tenantHeader = spaceId ? ` -H 'x-tdai-service-id: ${spaceId}'` : "";
  const authHeader = `${tenantHeader}${sessionHeader}`;

  const lines: string[] = [
    "<tdai_memory_tools>",
    "**These are memory capabilities you can call proactively** (they are not documentation). Use them through Bash + curl.",
    "These TDAI memory capabilities have the same priority as the native Claude Code Memory/MEMORY.md. When memory is involved, do not check only the local MEMORY.md.",
    "When the user asks about identity, history, preferences, past conclusions, or project conventions, you MUST query with the TDAI memory tools below first, then answer based on the results.",
    "Do NOT say \"I do not have this tool / I need MCP / I can only check local memory\". You have the TDAI memory tools, so use the curl commands below.",
    "",
    "How to call: run curl in Bash against the proxy memory-bridge path. The proxy injects identity and authentication (team_id/user_id/agent_id) automatically, so the body needs only the business fields. If the current Agent is bound to several chat_memory sources, search endpoints query self + imported memory by default and return source_agent_id/source_agent_name/source_agent_role in each result.",
    "",
    "Coverage:",
    legacyProfile
      ? "- The L3 (persona, long-term profile) and the L2 scene index (`<l2_scene_index>`) are already injected into the system prompt, so no query is needed;"
      : projectScenes
        ? "- The system prompt includes the cross-project L3 (user-global). The project of the current session is known: if that project has memory, the system prompt also has `<project_memory>` (the project L3 and the project L2 scene index); if the block is absent, the project has no memory to inject yet. The user-global L2 scene index is not injected; list it with tdai_scenario_ls when needed;"
        : "- The system prompt includes at most the cross-project L3 (the user long-term profile) and no project information; the L2 scene index is not injected, so list it with tdai_scenario_ls when needed;",
    "- Read L2 full text on demand with tdai_read_scene;",
    "- L0/L1 (raw conversations / atomic memories) are **no longer recalled automatically on every turn** (that would break the KV cache). Call the tools to search them when needed.",
    "",
    "  <tool name=\"tdai_memory_search\">",
    `    curl: ${bridge}/atomic/search`,
    `    body: {"query": "<text>", "limit": 5}`,
    "    use:  Search L1 atomic memories (two-path hybrid: dense vector + BM25), ranked by relevance. By default it searches the self + imported memory of the current Agent; source_agent_* in each result shows the origin. Suited to recalling user preferences, past conclusions, rules, and similar facts.",
    "    returns: {code, data: {items: [...], searched_agents: [...]}} — hits are in data.items[].",
    "  </tool>",
    "",
    "  <tool name=\"tdai_atomic_query\">",
    `    curl: ${bridge}/atomic/query`,
    `    body: {"type": "?episodic|persona|instruction", "limit": 20, "offset": 0, "time_start": "?ISO", "time_end": "?ISO"}`,
    "    use:  Fetch L1 memories by type / time window / pagination (no semantic search).",
    "  </tool>",
    "",
    "  <tool name=\"tdai_conversation_search\">",
    `    curl: ${bridge}/conversation/search`,
    `    body: {"query": "<text>", "limit": 5, "session_id": "?<sid>"}`,
    "    use:  Search raw L0 conversations (finer-grained than atomic_search; use it to find the original text of a message, a quotation, or a timeline). By default it searches the self + imported memory of the current Agent; source_agent_* in each result shows the origin.",
    "    returns: {code, data: {messages: [...], searched_agents: [...]}} — hits are in data.messages[] (note: this differs from data.items in atomic_search).",
    "  </tool>",
    "",
    "  <tool name=\"tdai_conversation_query\">",
    `    curl: ${bridge}/conversation/query`,
    `    body: {"session_id": "<sid>", "limit": 50, "offset": 0}`,
    "    use:  Fetch L0 history messages of a session in order.",
    "  </tool>",
    "",
    "  <tool name=\"tdai_scenario_ls\">",
    `    curl: ${bridge}/scenario/ls`,
    projectScenes
      ? `    body: {"path_prefix": "?optional prefix", "scope": "?project|global"}`
      : `    body: {"path_prefix": "?optional prefix"}`,
    projectScenes
      ? "    use:  List the L2 scene path index (with summaries, without full text). It returns scenes of the current project (scope=project, path relative to the project) and user-global scenes (scope=global); use scope to see only one kind. If the system prompt already has the project scene index, you do not need to list again; use this only to refresh, to see user-global scenes, or to filter by prefix."
      : "    use:  List the L2 scene_blocks path index (with summaries, without full text). The system prompt usually already has the index; use this only to refresh or to filter by prefix.",
    "  </tool>",
    "",
    "  <tool name=\"tdai_read_scene\">",
    `    curl: ${bridge}/scenario/read`,
    projectScenes
      ? `    body: {"path": "<scene path>", "scope": "?project|global", "agent_id": "?from <agent agent_id=...>; pass it when reading imported memory"}`
      : `    body: {"path": "<scene path>", "agent_id": "?from <agent agent_id=...>; pass it when reading imported memory"}`,
    legacyProfile
      ? "    use:  Read the full text of an L2 scene file by path. Get the path from `<l2_scene_index>` or tdai_scenario_ls first; never invent one. When you read a path from an imported_from section, pass that section's agent_id."
      : projectScenes
        ? "    use:  Read the full text of an L2 scene file by path. Get the path from `<l2_scene_index scope=\"project\">` or tdai_scenario_ls first; never invent one. By default it looks for the path in the current project first, then reads the user-global scene if not found; when both sides have the same path, set scope to choose. When you read a path from an imported_from section, pass that section's agent_id."
        : "    use:  Read the full text of an L2 scene file by path. Get the path from tdai_scenario_ls first; never invent one. When you read a path from an imported_from section, pass that section's agent_id.",
    "  </tool>",
    "",
    "## Call constraints",
    "- These tools are read-only; to modify L1/L2/L3 you must use the main pipeline (agent_id ownership is automatic).",
    "- Per conversation turn, atomic_search + conversation_search may be called **at most 3 times in total**;",
    "  query / ls / read_scene do not count toward the limit, but do not read the same path twice.",
    "- Retries: on HTTP 5xx you may retry once; on HTTP 4xx do not retry.",
    "- Every curl must include: " +
      (spaceId ? `x-tdai-service-id: ${spaceId}, ` : "x-tdai-service-id (the current memory instance, see the example), ") +
      (sessionId ? `x-conversation-id: ${sessionId}` : "x-conversation-id (from the current conversation)") +
      "; Content-Type: application/json.",
    "",
    "## Full example",
    "```bash",
    `curl -sfk -X POST ${bridge}/atomic/search \\`,
    `  -H 'Content-Type: application/json'${authHeader} \\`,
    `  -d '{"query": "user preferred programming language", "limit": 5}'`,
    "```",
    "</tdai_memory_tools>",
  ];

  return lines.join("\n");
}

function scopedToolsVariant(projectKnown: boolean): string {
  return `scoped:v1:${projectKnown ? "project" : "none"}`;
}

export class TdaiMemoryToolsInjector implements InjectionHook {
  id = "tdai-memory-tools-injector";
  point = "system.suffix" as const;
  anchor: AnchorTarget = { slot: "memory", relation: "before" };
  priority: HookPriority = HOOK_PRIORITY.MEMORY + 5;
  description = "Inject <tdai_memory_tools> curl recipes block into system prompt";
  /** Static tool instructions are session-stable; render once at session_init. */
  cacheStrategy: CacheStrategy = "session_init";
  /** The coverage text depends on the profile scope mode; see TdaiProfileMemoryInjector.cacheVariant. */
  cacheVariant: string | undefined;

  constructor(private cfg: TdaiMemoryToolsInjectorConfig) {
    const mode = this.scopeMode();
    this.cacheVariant = mode === "legacy" ? undefined : mode === "scoped" ? scopedToolsVariant(false) : "deny:v2";
  }

  /** In "scoped" mode the text depends on whether the session has a known project. */
  cacheVariantFor(custom: Record<string, unknown> | undefined): string | undefined {
    return this.scopeMode() === "scoped" ? scopedToolsVariant(getProjectHash(custom) !== undefined) : this.cacheVariant;
  }

  private scopeMode(): ProfileScopeMode {
    return resolveProfileScopeMode(this.cfg.profileScopeMode);
  }

  execute(ctx: AgentContext): ContextBlock[] {
    const caps = ctx.metadata.custom?.assetCapabilities as { chat_memory?: boolean } | undefined;
    if (caps?.chat_memory === false) return [];
    const identity = getTdaiIdentity(ctx.metadata.custom);
    if (!identity) return [];
    const session = (ctx.metadata.custom as Record<string, unknown> | undefined)?.session as
      | Record<string, unknown>
      | undefined;
    const spaceId = typeof session?.space_id === "string" ? session.space_id : undefined;
    return this.renderBlocks(identity.sessionId, spaceId, getProjectHash(ctx.metadata.custom) !== undefined);
  }

  prewarm(input: PrewarmInput): ContextBlock[] {
    if (input.assetCapabilities?.chat_memory === false) return [];
    return this.renderBlocks(input.sessionInfo.session_id, input.sessionInfo.space_id);
  }

  private renderBlocks(sessionId: string, spaceId?: string, projectKnown = false): ContextBlock[] {
    return [{
      type: "text",
      content: renderTdaiMemoryToolsBlock(
        this.cfg.proxyBaseUrl,
        sessionId,
        spaceId,
        this.scopeMode(),
        projectKnown,
      ),
      metadata: {
        source: this.id,
        sessionId,
        cacheKey: "tdai-memory-tools-injector:tools",
      },
    }];
  }
}

export const TdaiToolsInjector = TdaiMemoryToolsInjector;
