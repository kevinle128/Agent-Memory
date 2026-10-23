import type { TdaiClient } from "./client.js";
import type { TdaiIdentity, TdaiMessage } from "./types.js";
import { extractUserQueryText } from "../common/user-query-extractor.js";
import { isProtectedSkillCallId } from "../skill/selection/delivery/protect-results.js";
import { isSubagentRequest } from "../session-trace/subagent.js";

/**
 * 从最后一条 user 消息中抽取「真正的用户提问」，写入 L0。
 *
 * 背景：CodeBuddy / Claude Code / DSH 等编码 agent 的 user 消息里除了真实问题，
 * 还塞了大量 harness 上下文（<additional_data>、current_time、<system_reminder>、
 * DSH 的 `Current runtime context.` 快照等）。如果把整条消息原样写进 L0，记忆
 * 会被这些噪声污染，而且每轮都不一样、检索价值极低。因此这里只保留真实提问。
 *
 * 抽取算法在 `common/user-query-extractor.ts` 内实现（tdai / mem-command /
 * codebuddy adapter 共用同一份，避免语义漂移）；本模块只负责"取最后一条
 * user message → 抽 query 文本 → 组装 TdaiMessage"这几步。
 */

// 保留 re-export，避免下游（含单测）import 路径变化引发一次性大改。
export { extractUserQueryText };

export function extractLatestUserMessage(messages: unknown[]): TdaiMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg?.role !== "user") continue;
    // 只取真实 user_query，避免把 harness 上下文写进 L0
    const content = extractUserQueryText(extractContentText(msg.content));
    if (content.trim()) return { role: "user", content };
  }
  return null;
}

/** Claude Code sends the body of a loaded SKILL.md as a user text block that starts with this line. */
const SKILL_BODY_PREFIX = "Base directory for this skill:";

/** Text of the user content without skill bodies: those are tool output, not typed by the human. */
function humanContentText(content: unknown): string {
  if (!Array.isArray(content)) return extractContentText(content);
  return extractContentText(content.filter((part) => {
    const p = part as { type?: unknown; text?: unknown } | null;
    return !(p && p.type === "text" && typeof p.text === "string" && p.text.trimStart().startsWith(SKILL_BODY_PREFIX));
  }));
}

/**
 * Pick the human query of the CURRENT turn: the last `user` message, and only
 * that message. Return null when it holds no human text (a tool-loop step that
 * carries only `tool_result` blocks), or when an `assistant` message comes
 * after the last `user` message. `extractLatestUserMessage` walks back to an
 * older message in those cases, which would write the same prompt to L0 again
 * on every step of a tool loop.
 */
export function extractCurrentTurnUserMessage(messages: unknown[]): TdaiMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg?.role === "assistant") return null;
    if (msg?.role !== "user") continue;
    const content = extractUserQueryText(humanContentText(msg.content));
    return content.trim() ? { role: "user", content } : null;
  }
  return null;
}

/**
 * True when the last `user` message holds tool results only, and every result
 * answers a skill load that the proxy itself added to the conversation. The
 * client did not ask for that round, so the human query it follows is still
 * unwritten.
 */
function endsWithProxySkillLoadResult(messages: unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg?.role === "assistant") return false;
    if (msg?.role !== "user") continue;
    if (!Array.isArray(msg.content)) return false;
    const results = (msg.content as Array<Record<string, unknown> | null>).filter((b) => b?.type === "tool_result");
    return results.length > 0 && results.every((b) => isProtectedSkillCallId(b?.tool_use_id));
  }
  return false;
}

export interface L0Capture {
  /** True for a subagent request: nothing from it goes to L0. */
  skip: boolean;
  userMessage: TdaiMessage | null;
  allowAssistantOnly: boolean;
}

/**
 * Decide once per request what the L0 write holds.
 *
 * Claude Code needs two rules that other agents do not:
 *   - A subagent shares the lead's session id and project, so its brief and
 *     tool-loop chatter would be stored as if the lead said them. Skip it.
 *   - One human message is one L0 row. A tool-loop step has no new human text,
 *     so it writes only its own assistant text (Anthropic message format only;
 *     OpenAI-format tool results are not `user` messages). The two cases where
 *     the human text is still unwritten use the walk-back message instead:
 *     the last step of session init and a skill-load round added by the proxy.
 * Every other agent keeps the `fallbackUserMessage` it extracted already.
 */
export function resolveL0Capture(args: {
  agentSource: string;
  headers: Record<string, string>;
  body: unknown;
  messages: unknown[];
  messageFormat: "anthropic" | "openai";
  /**
   * The request is the last step of session init. The first human prompt sits
   * before the init question and its answer, so it is the one to write.
   */
  sessionJustRegistered?: boolean;
  fallbackUserMessage: TdaiMessage | null;
}): L0Capture {
  if (args.agentSource !== "claude-code") {
    return { skip: false, userMessage: args.fallbackUserMessage, allowAssistantOnly: false };
  }
  if (isSubagentRequest(args.agentSource, args.headers, args.body)) {
    return { skip: true, userMessage: null, allowAssistantOnly: false };
  }
  if (args.messageFormat === "openai") {
    return { skip: false, userMessage: args.fallbackUserMessage, allowAssistantOnly: false };
  }
  const current = extractCurrentTurnUserMessage(args.messages);
  const walkBack = !current && (args.sessionJustRegistered || endsWithProxySkillLoadResult(args.messages));
  return {
    skip: false,
    userMessage: walkBack ? args.fallbackUserMessage : current,
    allowAssistantOnly: true,
  };
}

export interface RecordTdaiTurnOptions {
  /**
   * Write the assistant text alone when there is no user message. Used for
   * tool-loop steps, whose human query was already written by the first step.
   * Off by default: other callers treat a missing user message as "nothing to
   * record".
   */
  allowAssistantOnly?: boolean;
}

export async function recordTdaiTurn(
  client: TdaiClient,
  identity: TdaiIdentity | null,
  userMessage: TdaiMessage | null,
  assistantContent: string | null | undefined,
  options: RecordTdaiTurnOptions = {},
): Promise<void> {
  if (!identity) return;
  if (!userMessage && !options.allowAssistantOnly) return;
  const messages: TdaiMessage[] = userMessage ? [userMessage] : [];
  if (assistantContent?.trim()) {
    messages.push({ role: "assistant", content: assistantContent });
  }
  await client.addConversation(identity, messages);
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return "";
      const p = part as Record<string, unknown>;
      if (p.type !== "text" && p.type !== "input_text") return "";
      return typeof p.text === "string" ? p.text : "";
    }).filter(Boolean).join("\n");
  }
  return "";
}
