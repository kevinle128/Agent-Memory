/**
 * Tool registry of the agent-memory MCP server.
 *
 * A tool reaches Core and the knowledge service only through the `RequestAccess` that
 * the server passes to `run`. The registry has no other path to data, so every tool
 * gets the same caller and team checks.
 */
import type { RequestAccess } from './access.js';
import { whoamiTool } from './tools/whoami.js';
import { helpTool } from './tools/help.js';
import { knowledgeTools } from './tools/knowledge.js';

/**
 * Same shape as the tool definitions of the stdio knowledge MCP (`name`, `description`,
 * `inputSchema`, `endpoint`), so those definitions register here without reshaping.
 */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  /** Upstream path of a tool that forwards to the knowledge service (without the /v3 prefix). */
  endpoint?: string;
}

export interface RegisteredTool extends McpToolDef {
  /** Tool group, for example `core` or `knowledge`. */
  group: string;
  /**
   * Returns the data of the call. A `{ text, isError }` object passes through as text;
   * any other value is sent as JSON. Throw `NotReadableError` to refuse.
   */
  run(args: Record<string, unknown>, access: RequestAccess): Promise<unknown>;
}

export const TEAM_ID_PROPERTY = {
  type: 'string',
  description: 'Optional team id. Omit for all your teams.',
} as const;

export const TOOL_REGISTRY: RegisteredTool[] = [whoamiTool, helpTool, ...knowledgeTools];

/** The `tools/list` answer. Every tool takes `team_id`; it is added here, in one place. */
export function buildToolList(tools: RegisteredTool[] = TOOL_REGISTRY) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      ...t.inputSchema,
      properties: { ...t.inputSchema.properties, team_id: TEAM_ID_PROPERTY },
    },
  }));
}
