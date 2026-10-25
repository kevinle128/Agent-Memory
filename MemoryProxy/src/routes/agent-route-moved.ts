/**
 * `/pi/...` is a retired route. oh-my-pi (omp) has its own route `/omp/<space>`. A request that
 * still arrives on `/pi/` gets HTTP 410 with the new base URL. The request is not forwarded, not
 * stored and needs no user key, so an old client config fails fast and says what to change.
 */

import type { Context } from "hono";
import { resolveProxyOrigin } from "../session/hook-gate-core.js";

/** A space id is copied into the message, so only plain id characters are accepted. */
const SPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Path segments that follow `/pi/` directly when the client has no space id in its base URL. */
const API_SEGMENT_RE = /^v\d+$/;

function spaceIdFromPath(path: string): string | null {
  const second = path.split("/").filter(Boolean)[1];
  if (!second || API_SEGMENT_RE.test(second) || !SPACE_ID_RE.test(second)) return null;
  return second;
}

export function handleAgentRouteMoved(c: Context): Response {
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) headers[k.toLowerCase()] = v;
  const origin = resolveProxyOrigin(headers, c.req.url) ?? "";
  const spaceId = spaceIdFromPath(c.req.path);
  const newBaseUrl = spaceId ? `${origin}/omp/${spaceId}` : `${origin}/omp`;
  console.log(`[agent-route-moved] method=${c.req.method} path=${c.req.path} new_base_url=${newBaseUrl}`);
  return c.json(
    {
      error: {
        type: "invalid_request_error",
        code: "agent_route_moved",
        message: `pi is not supported. Point oh-my-pi at ${newBaseUrl} (run install.sh --client omp or setup-proxy.sh --agent omp).`,
      },
      detail: { new_base_url: newBaseUrl },
    },
    410,
  );
}
