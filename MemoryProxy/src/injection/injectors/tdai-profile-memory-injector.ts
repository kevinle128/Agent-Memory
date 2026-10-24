import type { AgentContext, AnchorTarget, CacheStrategy, ContextBlock, InjectionHook, HookPriority, PrewarmInput } from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { TdaiClient } from "../../tdai/client.js";
import type { ProfileScopeMode, TdaiMemoryConfig } from "../../tdai/types.js";
import { getProjectHash, getProjectName, getTdaiIdentity } from "../../tdai/identity.js";
import { resolveProfileScopeMode } from "../../tdai/profile-scope-mode.js";
import type { CoreSkillConfig } from "../../types.js";
import { getMetadataClient } from "../../meta/client.js";
import { resolveFixedAssetCtxs, type FixedAssetCtx } from "./tdai-fixed-asset.js";

/**
 * L2/L3 注入（按 openclaw / hermes 官方做法重构）：
 *   - L3 (persona) → 注入完整内容（稳定且通常较短，作为长期画像）
 *   - L2 (scenarios) → **只注入 Scene Navigation 索引（路径列表 + summary）**，
 *     不预读全文。LLM 需要细节时主动调 `tdai_read_scene` 工具按 path 拉取。
 *   - 同时附 memory-tools-guide 文案，告诉 LLM 怎么用工具 + 调用上限。
 *
 * 这样可以：
 *   1. 大幅降低首轮 token 消耗（L2 全文经常上千 chars × N 个）
 *   2. 让 LLM 按需取文，而不是被无关的场景污染上下文
 *
 * 跨 agent："自有 + 借入"按 agent 分段；每段下面 L3 + Scene 索引并列。
 *
 * 控制面不可达时降级：仅注入当前 agent 的 L3 + Scene 索引。
 */
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
    // spaceId 来自 session 注册时保存的 URL path 中的 `/proxy/<spaceId>/...`；
    // 用作内核的 `x-tdai-service-id` 头做租户路由。空字符串会被内核拒绝（invalid_user_key）
    // —— caller 已在 session-init 阶段做 bypass 处理。
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

    // 对每个 agent 独立拉 L3 + L2 索引（不读 L2 全文）
    const groups = await Promise.all(ctxs.map((c) => loadAgentProfile(client, c)));

    // 全部为空 → 仍注入 tools-guide（LLM 可主动 search L1 / 读 L2）
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
      "以下是 TDAI 为当前 agent 维护的长期工作记忆（自有 + 借入分段；L2 仅给索引，按需用工具读全文）：",
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
          // 索引行：路径 + summary（如果有）；正文用 tool 拉
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
    // 紧跟一段 memory-tools-guide，告诉 LLM 三个工具的用法 + 调用上限
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

/** 记忆使用指南：L0/L1 按需用工具检索（不再自动召回），L3 直注、L2 索引直注。 */
export const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## ⚠️ 重要：这不是文档，这是你的可用能力

以下 \`<tdai_memory_tools>\` 中列出的 tdai_memory_search / tdai_conversation_search
等，是**你可以主动调用的能力**（不是仅供参考的文档）。它们通过 **Bash + curl**
使用（见上方 \`<tdai_memory_tools>\` 段里的完整调用说明与 URL）。

**禁止**回答类似"我没有这个工具 / 需要 MCP / 需要斜杠命令"。
**正确做法**：判定需要查记忆时，直接在 Bash 里执行 curl，proxy 会自动注入身份与鉴权。

## 记忆使用规则（遇到以下场景必须先查再答）

L3（persona 长期画像）与 L2 场景索引已直接注入 system。L0/L1 需要用工具主动检索。
已注入的 L2 内容与当前任务相关但信息不足时，按场景索引中的 path 用 \`tdai_read_scene\` 读取对应正文；内容已足够时无需再读。

### 必须先查记忆再回答的场景（命中任一条即触发工具调用）

1. **用户提及历史/过去/之前**：如 "我之前说过 / 我告诉过你 / 上次 / 你还记不记得 / 我们聊过 / 之前那个"
   → 用 \`tdai_conversation_search\`（L0 原文找具体消息）
2. **用户涉及自己身份/偏好/习惯**：如 "我叫什么 / 我的名字 / 我喜欢 / 我的团队 / 我常用 / 我不喜欢 / 我不允许"
   → 用 \`tdai_memory_search\`（L1 原子记忆查偏好/规则）
3. **用户要求你回忆/找**：如 "回忆一下 / 想起 / 找出 / 有没有关于 X 的记录 / 查我们之前"
   → 直接触发工具，不要凭空回答
4. **答案强依赖历史事实**：如 "那个 bug 我们怎么修的 / 上次方案是啥 / 我们的约定是什么"
   → 关键词化后 \`tdai_memory_search\`

**典型流程**（用户："我叫什么"）：
\`\`\`bash
# Step 1: 先查
curl -sfk -X POST <bridge>/atomic/search \\
  -H 'Content-Type: application/json' -H 'x-conversation-id: <sid>' \\
  -d '{"query": "用户姓名 name 身份", "limit": 5}'
# Step 2: 从 items[].content 里提取答案后回复
# 若为空: 明确告诉用户 "我在记忆里没找到，你叫什么？" —— 不要装作知道
\`\`\`

### 不需要查的场景

- 不依赖历史信息或过往经验、仅凭当前输入即可完成的请求；不能仅凭任务类型判断是否需要检索
- 当前会话上下文（同轮消息）里已能回答
- 已经在 \`<l3_core_memory>\` 段落里直接看到答案

### ⚠️ 调用约束

- 每轮 \`tdai_memory_search\` + \`tdai_conversation_search\` **合计 ≤ 3 次**（\`tdai_read_scene\` / \`tdai_scenario_ls\` / \`tdai_atomic_query\` 不计入）
- 检索无果时**明确说明**"我在记忆里没找到 X"，不要幻想
- 同一 L2 path 不要重复读
</memory-tools-guide>`;

interface AgentProfileBundle {
  ctx: FixedAssetCtx;
  l3: { content: string } | null;
  /** L2 索引：仅 path + 可选 summary，**不**读全文。 */
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
  // L3(persona) 可能在尾部内嵌一份「Scene Navigation」场景索引（plugin 侧 read 会带导航段）。
  // 我们已经单独注入 <l2_scene_index>，必须剥掉 persona 尾部这份，避免 L2 索引重复注入。
  const l3Stripped = l3 ? stripSceneNavigation(l3.content) : "";
  return {
    ctx: c,
    l3: l3Stripped.trim() ? { content: l3Stripped } : null,
    l2Entries: (l2Entries ?? []).map((e) => ({ path: e.path, summary: e.summary })),
  };
}

/**
 * 剥离 persona 尾部的「Scene Navigation (Scene Index)」段。
 * 与 plugin 端 scene-navigation.ts 的 NAV_HEADER 对齐（带或不带前置 `---` 都能命中）。
 */
export function stripSceneNavigation(personaContent: string): string {
  const idx = personaContent.indexOf("## 🗺️ Scene Navigation");
  if (idx === -1) return personaContent;
  // 连同紧邻的 `---` 分隔符与前后空白一起去掉
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
  "L3（persona 长期画像）与 L2 场景索引已直接注入 system。L0/L1 需要用工具主动检索。\n" +
  "已注入的 L2 内容与当前任务相关但信息不足时，按场景索引中的 path 用 `tdai_read_scene` 读取对应正文；内容已足够时无需再读。";

const USER_GLOBAL_PROFILE_NOTE =
  "system 中最多只注入跨项目通用的 L3（用户长期画像），不注入任何项目信息，也不注入 L2 场景索引。" +
  "L0/L1/L2 需要用工具主动检索。";

/** Tools guide for deny mode: it does not claim that an L2 index was injected. */
export const MEMORY_TOOLS_GUIDE_USER_GLOBAL = MEMORY_TOOLS_GUIDE.replace(INJECTED_PROFILE_NOTE, USER_GLOBAL_PROFILE_NOTE);

const PROJECT_PROFILE_NOTE =
  "system 中注入两类记忆：`<user_global_memory>` 是跨项目通用的 L3（用户长期画像），不含项目信息；" +
  "`<project_memory>` 是当前项目的 L3 与 L2 场景索引，只适用于当前项目。" +
  "user-global 的 L2 场景索引不注入，需要时用 tdai_scenario_ls 列出。" +
  "已注入的项目场景按索引中的 path 用 `tdai_read_scene` 读取正文；内容已足够时无需再读。L0/L1 需要用工具主动检索。";

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
    "以下是 TDAI 为当前 agent 维护的跨项目通用长期记忆（不含任何项目信息；项目记忆按需用工具检索）：",
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
    "以下是 TDAI 为当前 agent 维护的长期记忆，分为两类：" +
      "`<user_global_memory>` 是跨项目通用记忆（不含项目信息）；" +
      `\`<project_memory>\` 只属于当前项目 ${label}，不要把它当作其他项目的事实：`,
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
