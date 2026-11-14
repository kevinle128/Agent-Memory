/**
 * Asset Reflection Injector — 内部效果评估用，在 system prompt 末尾追加
 * `<asset_reflection>` 块，指导 agent 在最终回答里点评「本轮调用过哪些云端
 * 资产工具、各自起没起到作用」。
 *
 * ## 门控
 * 完全对齐 `costGuard.markerOptIn` 的双闸门模式：
 *   1. `injection.assetReflection.markerOptIn=true` → factory 才 register 本 hook
 *      （否则线上 pod 上 getAll() 里根本没这个 hook，零性能开销）；
 *   2. 请求 URL 带 `/analyse` marker → execute 才真 emit 块（否则返回 []，
 *      对无 marker 的请求 prompt 零改动）。
 *
 * ## Tag 集合
 * 由构造函数传入的 `activeAssetTags` 决定——由 factory 根据本节点上实际
 * register 了哪些资产 injector 计算好静态列表：
 *   - skill-*         → `<skill_tools>` + `<available_skills>`
 *   - tdai-*          → `<tdai_memory_tools>`
 *   - knowledge-*     → `<knowledge_tools>`
 *
 * 一个都没注册（activeAssetTags 空） → hook 恒不 emit。
 */

import type {
  AgentContext,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { hasAnalyseMarker } from "../../routes/whitelist.js";

export interface AssetReflectionInjectorConfig {
  /** 本节点实际启用的资产 tag 名列表（无尖括号），如 `["skill_tools", "tdai_memory_tools"]`。 */
  activeAssetTags: string[];
}

const TAG = "[asset-reflection-injector]";

/** 纯函数：渲染 `<asset_reflection>` 段。空 tag 列表返回空串，便于调用方早退。 */
export function renderAssetReflectionBlock(tags: string[]): string {
  if (tags.length === 0) return "";
  const tagList = tags.map((t) => `<${t}>`).join(" / ");
  return [
    "<asset_reflection>",
    "**Internal evaluation mode.** This system prompt contains these cloud asset tool blocks:",
    `  ${tagList}`,
    "",
    "If you **actually called** any of these tools in this turn (through Bash curl or MCP),",
    "add a short review at the **end** of your final answer, in this fixed format:",
    "",
    "[Asset reflection]",
    "- <tag>::<tool_name>: one sentence on **whether the call helped** (the key information it gave, the detour it saved, or why it missed)",
    "- ... (one line per tool you called; merge repeated calls of the same tool into one line)",
    "",
    "Rules:",
    "- **Review only the tools you actually called in this turn.** Do not list other tools, and do not guess.",
    "- If you called none of these asset tools in this turn, still write:",
    "  [Asset reflection] No cloud asset tool was used in this turn.",
    "- Keep the review short and honest. If a tool did not help, say so. The review measures the integration; it is not praise.",
    "- The review is for internal evaluation only. Separate it from the main answer clearly (a blank line and \"---\").",
    "</asset_reflection>",
  ].join("\n");
}

/**
 * AssetReflectionInjector —— 见文件头。
 *
 * point: `system.suffix`（贴在系统提示词最末，符合内部评估语义：先看正文，再看反思要求）
 * priority: `HOOK_PRIORITY.CUSTOM`（1000，最后跑，避免影响任何资产 injector）
 * cacheStrategy: `none`（依赖运行时 URL marker，不能预热）
 */
export class AssetReflectionInjector implements InjectionHook {
  id = "asset-reflection-injector";
  point = "system.suffix" as const;
  priority: HookPriority = HOOK_PRIORITY.CUSTOM;
  description = "Inject <asset_reflection> block into system prompt when URL has /analyse marker.";
  cacheStrategy: CacheStrategy = "none";

  constructor(private config: AssetReflectionInjectorConfig) {}

  execute(ctx: AgentContext): ContextBlock[] {
    if (this.config.activeAssetTags.length === 0) {
      // Factory 已经保证不会 register 空 tag 的 injector；这里是防御性早退。
      return [];
    }
    const requestPath = ctx.metadata.requestPath ?? "";
    if (!hasAnalyseMarker(requestPath)) {
      // 没带 marker —— 对普通请求 prompt 零改动，保证 KV cache 前缀不受影响。
      return [];
    }
    const content = renderAssetReflectionBlock(this.config.activeAssetTags);
    if (!content) return [];
    if (process.env.PROXY_DEBUG_ASSET_REFLECTION) {
      console.log(`${TAG} emit for path=${requestPath} tags=[${this.config.activeAssetTags.join(",")}]`);
    }
    return [{
      type: "text",
      content,
      metadata: {
        source: this.id,
        // cache-strategy=none，但仍给一个稳定 cacheKey 便于 observer 去重。
        cacheKey: `asset-reflection-injector:${this.config.activeAssetTags.join(",")}`,
      },
    }];
  }
}
