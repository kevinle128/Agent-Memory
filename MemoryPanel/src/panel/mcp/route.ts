/**
 * POST /api/v1/mcp — the agent-memory MCP server (streamable HTTP, stateless, JSON responses).
 *
 * The route lives in its own sub-app with its own error handler, a body limit, an in-flight
 * cap and a deadline, so a fault here does not touch the other Panel routes.
 * It accepts the user-key header form only: a cookie session and any request with an
 * `Origin` header are refused.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { PanelDeps } from '../panel-deps.js';
import { validatePanelMetaHeaders } from '../http/middleware/validate-panel-headers.js';
import { buildCtx } from '../http/routes/knowledge/common.js';
import {
  UpstreamUnavailableError,
  createRequestAccess,
  resolveCaller,
} from './access.js';
import {
  DEFAULT_DEADLINE_MS,
  DEFAULT_MAX_IN_FLIGHT,
  MAX_BODY_BYTES,
  createInFlightLimiter,
  createRequestLifecycle,
  jsonRpcError,
  type RequestLifecycle,
  refuseOrigin,
} from './guards.js';
import { createMcpServer, GENERIC_ERROR_TEXT } from './server.js';
import type { RegisteredTool } from './registry.js';

/**
 * Audit user id of a refused request. Without a value, the audit middleware would call
 * `auth/verify` for the same bad key after the response, outside the in-flight cap.
 */
const UNAUTHENTICATED_AUDIT_USER = 'unauthenticated';

export interface McpRouteOptions {
  maxInFlight?: number;
  deadlineMs?: number;
  /** Longest time that a request keeps its slot after the response, whatever Core does. */
  holdMaxMs?: number;
  tools?: RegisteredTool[];
}

async function holdSlot(lifecycle: RequestLifecycle, maxMs: number, logger: PanelDeps['logger']): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), maxMs);
  });
  try {
    const result = await Promise.race([lifecycle.whenIdle().then(() => 'idle' as const), expired]);
    if (result === 'expired') {
      logger.warn('mcp slot freed with Core work still running', { component: 'mcp', hold_max_ms: maxMs });
    }
  } finally {
    clearTimeout(timer);
  }
}

export function registerMcpRoutes(api: Hono, deps: PanelDeps, options: McpRouteOptions = {}): void {
  const limiter = createInFlightLimiter(options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT);
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  // A tool call gets `deadlineMs`; a Core call that started before it ends by its own timeout.
  const holdMaxMs = options.holdMaxMs ?? deadlineMs + (deps.config.metadataRemoteTimeoutMs ?? 30_000);
  const mcp = new Hono();

  mcp.onError((err, c) => {
    const upstream = err instanceof UpstreamUnavailableError;
    deps.logger.error('mcp request failed', {
      component: 'mcp',
      err: err instanceof Error ? err.message : String(err),
    });
    return c.json(jsonRpcError(-32603, GENERIC_ERROR_TEXT), upstream ? 503 : 500);
  });

  // Order matters. Every check that needs no body and no Core call comes first. The body is read,
  // size-limited and parsed before the in-flight slot is taken, so a slow sender holds no slot.
  // The slot is taken before the first Core call and is freed when the Core work of the request
  // has settled, not when the response is sent.
  mcp.post(
    '/',
    refuseOrigin,
    validatePanelMetaHeaders(deps),
    async (c, next) => {
      // Set first and replaced after a good key, so no refusal or Core failure below
      // leaves the audit middleware to call `auth/verify` on its own.
      c.set('resolvedUserId', UNAUTHENTICATED_AUDIT_USER);
      if (c.get('panelMeta').authMethod !== 'user_key') {
        return c.json(jsonRpcError(-32001, 'Send your user key in the x-tdai-user-key header.'), 401);
      }
      await next();
    },
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(jsonRpcError(-32600, 'Request body is too large.'), 413),
    }),
    async (c) => {
      const text = await c.req.text();
      if (!text.trim()) return c.json(jsonRpcError(-32600, 'The request body is empty.'), 400);
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(text);
      } catch {
        return c.json(jsonRpcError(-32700, 'The request body is not valid JSON.'), 400);
      }
      // A batch would run many tool calls under one slot.
      if (Array.isArray(parsedBody) || parsedBody === null || typeof parsedBody !== 'object') {
        return c.json(jsonRpcError(-32600, 'Send one JSON-RPC message per request. Batches are not supported.'), 400);
      }

      if (!limiter.tryAcquire()) {
        c.header('retry-after', '1');
        return c.json(jsonRpcError(-32000, 'Agent-Memory is busy. Try again soon.'), 429);
      }
      const lifecycle = createRequestLifecycle();
      try {
        const ctx = buildCtx(c);
        const caller = await resolveCaller(deps, ctx);
        if (!caller) return c.json(jsonRpcError(-32001, 'Invalid, expired or revoked user key.'), 401);
        c.set('resolvedUserId', caller.userId);

        const access = createRequestAccess(deps, ctx, caller, lifecycle);
        const server = createMcpServer({ access, logger: deps.logger, deadlineMs, lifecycle, tools: options.tools });
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        try {
          await server.connect(transport);
          return await transport.handleRequest(c.req.raw, { parsedBody });
        } finally {
          await server.close().catch(() => undefined);
        }
      } finally {
        // Work that outlived the response holds the slot until it settles, but not longer than
        // `holdMaxMs`, so a call that never settles cannot hold the slot for good.
        lifecycle.stop();
        void holdSlot(lifecycle, holdMaxMs, deps.logger).then(() => limiter.release());
      }
    },
  );

  const methodNotAllowed = (c: import('hono').Context) => {
    c.header('allow', 'POST');
    return c.json(jsonRpcError(-32000, 'Method not allowed.'), 405);
  };
  mcp.get('/', methodNotAllowed);
  mcp.delete('/', methodNotAllowed);

  api.route('/mcp', mcp);
}
