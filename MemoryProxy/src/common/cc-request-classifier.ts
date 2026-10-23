/**
 * Claude Code request classification — 基于 Anthropic body 的 `cache_control`
 * marker 位置 + tools/thinking 兜底，把 CC 客户端发到 /v1/messages 的所有请求
 * 三分成 main / fork / sidequery。
 *
 * 判定依据（源码硬约束 + 抓包实证）：
 *   - MAIN 主对话：cache_control marker 在 messages[n-1]（含 msgs=1 边界）
 *   - FORK 复用缓存（SUGGESTION/RECAP/COMPACT/...）：marker 在 messages[n-2]
 *     源码 forkedAgent.ts + claude.ts:3242-3243 强制 skipCacheWrite=true 挪
 *     marker 到 n-2 位置以避免误算 cache write cost
 *   - SIDEQUERY 独立请求（TITLE/verify_api_key/...）：无 marker + tools=[] +
 *     thinking.disabled；源码 sessionTitle.ts:434 + queryHaiku 强制关 caching
 *
 * 3P provider 关缓存的兜底：body 全无 marker 时，用 tools=[] && thinking.disabled
 * 两条硬约束联合判 sidequery；否则保底 main —— 退化到原有一刀切逻辑，不会更糟。
 *
 * 详细设计与抓包实证见:
 *   docs/design/2026-07-30-cc-request-routing-plan.md
 */

export type CcRequestKind = "main" | "fork" | "sidequery";

/**
 * 根据 Anthropic 请求 body 判定请求类型。
 *
 * 输入是 handler 已解析的 body（Record<string, unknown>），字段访问全部走
 * 防御性 narrowing，未知/畸形 body 一律回退 "main" —— 保证判定失败时行为
 * 等价原有链路。
 */
export function classifyCcRequest(body: Record<string, unknown>): CcRequestKind {
  // Explicit side-request shapes win over the cache_control marker logic: the
  // advisor model probe carries a marker on its single message, which the
  // marker logic reads as MAIN.
  if (detectCcSideRequest(body)) return "sidequery";

  const rawMsgs = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];

  // Claude Code puts hook output as trailing role:"system" messages and, on a
  // normal turn, moves the turn marker onto the last one. The filter below
  // drops system messages, so the marker would be lost and the previous
  // assistant marker (n-2) would make the real turn look like a fork. A fork
  // never marks a system message, so a marker on a trailing system message
  // means MAIN.
  if (hasTrailingSystemMarker(rawMsgs)) return "main";
  // Filter out non-conversation messages (e.g. role:"system" injected by some CC
  // versions into the messages array). Only user/assistant participate in the
  // cache_control marker position logic that distinguishes main from fork.
  const msgs = rawMsgs.filter((m) => {
    const role = (m as { role?: string })?.role;
    return role === "user" || role === "assistant";
  });
  const n = msgs.length;
  const markerIdx = findLastCacheControlIndex(msgs);

  // 主判定：cache_control marker 位置
  if (markerIdx >= 0) {
    // messages[n-2] → FORK（skipCacheWrite=true 强制）
    if (markerIdx === n - 2) return "fork";
    // 其它位置（含 last=n-1）→ MAIN
    return "main";
  }

  // 无 marker：可能是 SIDEQUERY，也可能是 3P provider 关 caching 的 MAIN
  // 兜底信号：SIDEQUERY 硬约束是 tools=[] AND thinking.disabled 同时命中
  //          用 && 而非 || 避免误伤"用户单独禁 tools 或单独禁 thinking"的主对话
  const toolsEmpty = !Array.isArray(body.tools) || (body.tools as unknown[]).length === 0;
  const thinking = body.thinking as { type?: string } | undefined;
  const thinkingOff = thinking?.type === "disabled";
  if (toolsEmpty && thinkingOff) return "sidequery";

  return "main";
}

/** True when the last cache_control marker sits on a system message that follows every user/assistant message. */
function hasTrailingSystemMarker(rawMsgs: unknown[]): boolean {
  const markerIdx = findLastCacheControlIndex(rawMsgs);
  if (markerIdx < 0) return false;
  if ((rawMsgs[markerIdx] as { role?: string })?.role !== "system") return false;
  for (let i = markerIdx + 1; i < rawMsgs.length; i++) {
    const role = (rawMsgs[i] as { role?: string })?.role;
    if (role === "user" || role === "assistant") return false;
  }
  return true;
}

export type CcSideRequestKind = "title" | "model-probe";

/** System prompt text of the Claude Code session-title request (v2.1.289). */
export const CC_TITLE_SYSTEM_MARKER = "You are naming a coding session";

/**
 * Detect Claude Code requests that are not part of the conversation and must
 * not receive memory, by their shape (captured from Claude Code v2.1.289):
 *
 *   - "title": session-title generation. Its system prompt contains
 *     {@link CC_TITLE_SYSTEM_MARKER}.
 *   - "model-probe": the availability check Claude Code sends when the user
 *     selects a model (for example `/advisor <model>`): `max_tokens` is 1 and
 *     there are no tools. A one-token reply cannot be a conversation turn.
 *
 * Returns null for every other request.
 */
export function detectCcSideRequest(body: Record<string, unknown>): CcSideRequestKind | null {
  if (systemTextOf(body.system).includes(CC_TITLE_SYSTEM_MARKER)) return "title";
  const toolsEmpty = !Array.isArray(body.tools) || (body.tools as unknown[]).length === 0;
  if (toolsEmpty && typeof body.max_tokens === "number" && body.max_tokens <= 1) return "model-probe";
  return null;
}

/** Join the text of an Anthropic `system` field (string or text blocks). */
function systemTextOf(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
      ? (b as { text: string }).text
      : ""))
    .join("\n");
}

/**
 * 在 messages 数组里找**最后一条**包含 cache_control marker 的 message 索引。
 *
 * cache_control 在 CC 客户端是塞在 content block 层（不是 message 顶层），
 * 所以要扫每条 message 的 content 数组里任意 block 是否含 cache_control 键。
 * 无匹配返回 -1。
 */
export function findLastCacheControlIndex(msgs: unknown[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { content?: unknown };
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content as unknown[]) {
      if (b && typeof b === "object" && "cache_control" in (b as object)) return i;
    }
  }
  return -1;
}
