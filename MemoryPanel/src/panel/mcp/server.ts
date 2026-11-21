/**
 * One MCP `Server` per HTTP request (stateless transport). It holds the access of that
 * request only, so two callers never share a server, a caller or a scope.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../infra/logger.js';
import { NotReadableError, type RequestAccess } from './access.js';
import { DEFAULT_DEADLINE_MS, DeadlineExceededError, createRequestLifecycle, withDeadline, type RequestLifecycle } from './guards.js';
import { TOOL_REGISTRY, buildToolList, type RegisteredTool } from './registry.js';
import { HELP_TOPICS, findHelpTopic } from './help/topics.js';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from './server-info.js';

const INSTRUCTIONS =
  'Read-only Agent-Memory data for the teams of the caller. ' +
  'Call whoami first to see your teams, and help to learn how Agent-Memory works.';

export const GENERIC_ERROR_TEXT = 'Agent-Memory could not answer this call.';
export const TIMEOUT_ERROR_TEXT = 'Agent-Memory timed out.';
const HELP_URI_PREFIX = 'agent-memory://help/';

export interface McpServerOptions {
  access: RequestAccess;
  logger: Logger;
  deadlineMs?: number;
  tools?: RegisteredTool[];
  /** Owned by the route. The same object must be given to `createRequestAccess`. */
  lifecycle?: RequestLifecycle;
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/**
 * Result handling of the stdio knowledge MCP: a `{ text, isError }` answer passes through as
 * text; any other data is sent as JSON.
 */
export function toToolResult(data: unknown) {
  if (data && typeof data === 'object' && 'text' in data && 'isError' in data) {
    const result = data as { text: string; isError: boolean };
    return {
      content: [{ type: 'text' as const, text: result.text || '(empty result)' }],
      isError: result.isError,
    };
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    isError: false,
  };
}

export function createMcpServer(options: McpServerOptions): Server {
  const { access, logger } = options;
  const lifecycle = options.lifecycle ?? createRequestLifecycle();
  const tools = options.tools ?? TOOL_REGISTRY;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: buildToolList(tools) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const tool = byName.get(name);
    if (!tool) return errorResult(`Unknown tool: ${name}`);

    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const started = Date.now();
    let outcome = 'ok';
    try {
      const data = await withDeadline(
        lifecycle.track(tool.run(args, access)),
        deadlineMs,
        () => lifecycle.stop(),
      );
      return toToolResult(data);
    } catch (err) {
      if (err instanceof NotReadableError) {
        outcome = 'not_readable';
        return errorResult(err.message);
      }
      if (err instanceof DeadlineExceededError) {
        outcome = 'timeout';
        return errorResult(TIMEOUT_ERROR_TEXT);
      }
      outcome = 'error';
      logger.error('mcp tool failed', {
        component: 'mcp',
        tool: name,
        err: err instanceof Error ? err.message : String(err),
      });
      return errorResult(GENERIC_ERROR_TEXT);
    } finally {
      // Never log headers, keys or tool arguments.
      logger.info('mcp tool call', {
        component: 'mcp',
        tool: name,
        user_id: access.caller.userId,
        team_ids: access.resolvedTeamIds(),
        duration_ms: Date.now() - started,
        outcome,
      });
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: HELP_TOPICS.map((t) => ({
      uri: `${HELP_URI_PREFIX}${t.id}`,
      name: t.title,
      description: t.summary,
      mimeType: 'text/markdown',
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const topic = uri.startsWith(HELP_URI_PREFIX) ? findHelpTopic(uri.slice(HELP_URI_PREFIX.length)) : undefined;
    if (!topic) throw new McpError(ErrorCode.InvalidParams, 'Unknown resource.');
    return { contents: [{ uri, mimeType: 'text/markdown', text: topic.text }] };
  });

  return server;
}
