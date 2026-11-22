/**
 * OpenAI Protocol Adapter.
 * Converts OpenAI Chat Completions format ↔ AgentContext.
 *
 * OpenAI message format:
 *   - system/user: { role, content: string | ContentPart[] }
 *   - assistant: { role, content: string | null, tool_calls?: ToolCall[] }
 *   - tool: { role: "tool", content: string, tool_call_id: string }
 */

import type { ProtocolAdapter } from "./interface.js";
import { parseToolResultContent, serializeToolResultContent } from "./tool-result-content.js";
import {
  blockChanged,
  blockWire,
  messageUnchanged,
  messageWire,
  preservedBlock,
  rememberBlock,
  rememberBody,
  rememberMessage,
  rememberedBody,
  sameBlocks,
  type ContentShape,
} from "./client-wire.js";
import type {
  AgentContext,
  AgentContextMetadata,
  AgentTool,
  ContextBlock,
  ContextMessage,
  MessageRole,
} from "../types.js";

function parseOriginalPart(content: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export class OpenAIAdapter implements ProtocolAdapter {
  readonly protocol = "openai" as const;
  private readonly toolDefinitions = new WeakMap<AgentTool, Record<string, unknown>>();

  parse(body: Record<string, unknown>, metadata: AgentContextMetadata): AgentContext {
    const rawMessages = (body.messages as unknown[]) ?? [];
    const messages: ContextMessage[] = rawMessages.map((m) => this.parseMessage(m));

    // Extract tools if present
    let tools: AgentTool[] | undefined;
    if (Array.isArray(body.tools)) {
      tools = (body.tools as Record<string, unknown>[]).map((t) => this.parseTool(t));
    }

    // Extract request parameters (everything except messages and tools)
    const requestParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key !== "messages" && key !== "tools") {
        requestParams[key] = value;
      }
    }

    const ctx: AgentContext = { messages, tools, requestParams, metadata };
    rememberBody(ctx, body);
    return ctx;
  }

  serialize(ctx: AgentContext): Record<string, unknown> {
    const original = rememberedBody(ctx);
    const body: Record<string, unknown> = original ? { ...original } : { ...ctx.requestParams };
    body.messages = ctx.messages.map((m) => this.serializeMessage(m));

    if (ctx.tools && (ctx.tools.length > 0 || (original !== undefined && "tools" in original))) {
      body.tools = ctx.tools.map((t) => this.serializeTool(t));
    } else {
      delete body.tools;
    }

    return body;
  }

  // ── Private: parse helpers ──────────────────────────────────────────────────

  private parseMessage(raw: unknown): ContextMessage {
    const m = raw as Record<string, unknown>;
    const role = m.role as MessageRole;
    const metadata = typeof m.name === "string" ? { name: m.name } : undefined;
    const blocks: ContextBlock[] = [];

    if (role === "tool") {
      const parsed = parseToolResultContent(m.content);
      const block: ContextBlock = {
        type: "tool_result",
        content: parsed.text,
        metadata: { tool_use_id: m.tool_call_id as string, ...parsed.metadata },
      };
      rememberBlock(block, {}, parsed.text);
      const message: ContextMessage = { role, blocks: [block], metadata };
      rememberMessage(message, {
        raw: m,
        contentShape: Array.isArray(m.content) ? "array" : typeof m.content === "string" ? "string" : "absent",
        blockCount: 1,
      });
      return message;
    }

    if (role === "assistant") {
      const contentShape = this.pushContentBlocks(m.content, blocks, true);
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls as Record<string, unknown>[]) {
          const fn = tc.function as Record<string, unknown> | undefined;
          const content = JSON.stringify({
            name: fn?.name ?? "unknown",
            arguments: fn?.arguments ?? "{}",
          });
          const block: ContextBlock = {
            type: "tool_use",
            content,
            metadata: { tool_id: tc.id as string },
          };
          rememberBlock(block, tc, content);
          blocks.push(block);
        }
      }

      // Preserve `reasoning_content` (deepseek thinking mode). The client must
      // send it back, or the upstream returns 400. Other upstreams ignore it.
      const message: ContextMessage = { role, blocks, metadata };
      if (typeof m.reasoning_content === "string") {
        message.metadata = { ...(message.metadata ?? {}), reasoning_content: m.reasoning_content };
      }
      rememberMessage(message, { raw: m, contentShape, blockCount: blocks.length });
      return message;
    }

    const contentShape = this.pushContentBlocks(m.content, blocks, false);
    const message: ContextMessage = { role, blocks, metadata };
    rememberMessage(message, { raw: m, contentShape, blockCount: blocks.length });
    return message;
  }

  /**
   * Read message content into blocks.
   * An empty assistant string stays empty so serialize can keep `""`, not null.
   */
  private pushContentBlocks(content: unknown, blocks: ContextBlock[], assistant: boolean): ContentShape {
    if (typeof content === "string") {
      if (!assistant || content.length > 0) {
        const block: ContextBlock = { type: "text", content };
        rememberBlock(block, { type: "text", text: content }, content, "text");
        blocks.push(block);
      }
      return "string";
    }
    if (Array.isArray(content)) {
      for (const part of content as Record<string, unknown>[]) {
        blocks.push(this.parseContentPart(part));
      }
      return "array";
    }
    if (content === null) return "null";
    return "absent";
  }

  private parseContentPart(part: Record<string, unknown>): ContextBlock {
    const type = part.type as string;
    let block: ContextBlock;
    switch (type) {
      case "text":
        block = { type: "text", content: part.text as string };
        rememberBlock(block, part, block.content, "text");
        return block;
      case "image_url": {
        const imageUrl = part.image_url as Record<string, unknown> | undefined;
        block = {
          type: "image",
          content: (imageUrl?.url as string) ?? "",
          metadata: { detail: imageUrl?.detail },
        };
        rememberBlock(block, part, block.content);
        return block;
      }
      default:
        block = {
          type: "custom",
          content: JSON.stringify(part),
          metadata: { original_type: type },
        };
        rememberBlock(block, part, block.content);
        return block;
    }
  }

  private parseTool(raw: Record<string, unknown>): AgentTool {
    const fn = raw.function as Record<string, unknown> | undefined;
    const tool: AgentTool = {
      name: (fn?.name as string) ?? (raw.name as string) ?? "unknown",
      description: (fn?.description as string) ?? (raw.description as string) ?? "",
      parameters: (fn?.parameters as Record<string, unknown>) ?? (raw.parameters as Record<string, unknown>) ?? {},
    };
    this.toolDefinitions.set(tool, raw);
    return tool;
  }

  // ── Private: serialize helpers ──────────────────────────────────────────────

  private serializeMessage(msg: ContextMessage): Record<string, unknown> {
    if (messageUnchanged(msg)) return messageWire(msg)!.raw!;
    const wire = messageWire(msg);
    const raw = wire?.raw;
    const identity: Record<string, unknown> = raw ? { ...raw, role: msg.role } : { role: msg.role };
    if (typeof msg.metadata?.name === "string") identity.name = msg.metadata.name;

    if (msg.role === "tool") {
      const toolResult = msg.blocks.find((b) => b.type === "tool_result");
      identity.content = serializeToolResultContent(toolResult);
      identity.tool_call_id = toolResult?.metadata?.tool_use_id ?? raw?.tool_call_id ?? "";
      return identity;
    }

    if (msg.role === "assistant") {
      identity.content = this.assistantContent(msg, wire?.contentShape);
      const toolUses = msg.blocks.filter((b) => b.type === "tool_use");
      const originalUses = (messageWire(msg)?.blocks ?? []).filter((b) => b.type === "tool_use");
      const hadCalls = Array.isArray(raw?.tool_calls);
      if (toolUses.length === 0) {
        if (hadCalls) delete identity.tool_calls;
      } else if (!hadCalls || !sameBlocks(toolUses, originalUses)) {
        identity.tool_calls = toolUses.map((block) => this.serializeToolCall(block));
      }
      if (typeof msg.metadata?.reasoning_content === "string") {
        identity.reasoning_content = msg.metadata.reasoning_content;
      }
      return identity;
    }

    identity.content = this.plainContent(msg, wire?.contentShape);
    return identity;
  }

  /** Assistant text joins with "" so one string stays one string. An array stays an array. */
  private assistantContent(msg: ContextMessage, shape: ContentShape | undefined): unknown {
    const parts = msg.blocks.filter((block) => block.type !== "tool_use");
    if (shape === "array") return parts.map((block) => this.emitPart(block));
    if (parts.length === 0) return shape === "string" ? "" : null;
    if (parts.every((block) => block.type === "text")) {
      return parts.map((block) => block.content).join("");
    }
    return parts.map((block) => this.emitPart(block));
  }

  /**
   * System and user string content stays a string. Callers such as the Codex
   * and WorkBuddy runners read this string after injection. A content array
   * stays an array, including a text-only array.
   */
  private plainContent(msg: ContextMessage, shape: ContentShape | undefined): unknown {
    if (shape === "string" && msg.blocks.every((block) => block.type === "text")) {
      return msg.blocks.map((block) => block.content).join("\n");
    }
    if (shape === "array" || msg.blocks.some((block) => block.type !== "text")) {
      return msg.blocks.map((block) => this.emitPart(block));
    }
    return msg.blocks.map((block) => block.content).join("\n");
  }

  private emitPart(block: ContextBlock): Record<string, unknown> {
    const kept = preservedBlock(block);
    if (kept) return kept;
    const src = blockWire(block);
    if (src && block.type === "image" && src.raw.image_url && typeof src.raw.image_url === "object") {
      const imageUrl: Record<string, unknown> = {
        ...(src.raw.image_url as Record<string, unknown>),
        url: block.content,
      };
      if (block.metadata && "detail" in block.metadata) imageUrl.detail = block.metadata.detail;
      return { ...src.raw, image_url: imageUrl };
    }
    if (src && block.type === "text") return { ...src.raw, text: block.content };
    switch (block.type) {
      case "text":
        return { type: "text", text: block.content };
      case "image":
        return { type: "image_url", image_url: { url: block.content, detail: block.metadata?.detail } };
      case "custom": {
        const original = parseOriginalPart(block.content);
        return original ?? { type: block.type, content: block.content, ...block.metadata };
      }
      default:
        return { type: block.type, content: block.content, ...block.metadata };
    }
  }

  private serializeToolCall(block: ContextBlock): Record<string, unknown> {
    const src = blockWire(block);
    if (src && !blockChanged(block)) return src.raw;
    const parsed = JSON.parse(block.content) as { name: string; arguments: string };
    const fn = (src?.raw.function as Record<string, unknown> | undefined) ?? {};
    return {
      ...(src?.raw ?? {}),
      id: block.metadata?.tool_id ?? src?.raw.id ?? "",
      type: src?.raw.type ?? "function",
      function: {
        ...fn,
        name: parsed.name,
        arguments: typeof parsed.arguments === "string" ? parsed.arguments : JSON.stringify(parsed.arguments),
      },
    };
  }

  private serializeTool(tool: AgentTool): Record<string, unknown> {
    const original = this.toolDefinitions.get(tool);
    if (!original) {
      return {
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      };
    }
    const fn = original.function as Record<string, unknown> | undefined;
    const name = (fn?.name as string) ?? (original.name as string) ?? "unknown";
    const description = (fn?.description as string) ?? (original.description as string) ?? "";
    const parameters = (fn?.parameters as Record<string, unknown>)
      ?? (original.parameters as Record<string, unknown>)
      ?? {};
    if (name === tool.name && description === tool.description && parameters === tool.parameters) {
      return original;
    }
    if (fn) {
      return {
        ...original,
        function: { ...fn, name: tool.name, description: tool.description, parameters: tool.parameters },
      };
    }
    return { ...original, name: tool.name, description: tool.description, parameters: tool.parameters };
  }
}
