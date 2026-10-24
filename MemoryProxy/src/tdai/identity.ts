import type { TdaiIdentity } from "./types.js";

interface SessionInfoLike {
  session_id?: unknown;
  team_id?: unknown;
  user_id?: unknown;
  agent_id?: unknown;
  task_id?: unknown;
}

export interface TdaiIdentitySource {
  sessionInfo?: Record<string, unknown> | null;
  /** User ID from auth/verify — replaces legacy codeBuddyUserId. */
  userId?: string | null;
  sessionKey?: string | null;
  /** 请求发起者 user_key（来自 Authorization: Bearer；ACL 校验用）。 */
  userKey?: string | null;
}

/**
 * Derive a fully-qualified TDAI identity from session state. Every required
 * field (team_id / user_id / agent_id / session_id) must come from the
 * session or auth layer — there is no fallback "team_default" / "u_default".
 * Missing any → return null and let the caller bypass memory injection.
 */
export function deriveTdaiIdentity(source: TdaiIdentitySource): TdaiIdentity | null {
  const session = source.sessionInfo as SessionInfoLike | undefined;
  const teamId = pickString(session?.team_id);
  const userId = pickString(session?.user_id) ?? pickString(source.userId);
  const agentId = pickString(session?.agent_id);
  const sessionId = pickString(session?.session_id) ?? pickString(source.sessionKey);
  const taskId = pickString(session?.task_id);
  const userKey = pickString(source.userKey);
  if (!teamId || !userId || !agentId || !sessionId) return null;
  return { teamId, userId, agentId, sessionId, taskId, userKey };
}

export function getTdaiIdentity(custom: Record<string, unknown> | undefined): TdaiIdentity | null {
  const userKey = pickString(custom?.userKey);
  return deriveTdaiIdentity({
    sessionInfo: custom?.session as Record<string, unknown> | null | undefined,
    userKey,
  });
}

const PROJECT_HASH_RE = /^[0-9a-f]{16}$/;

/**
 * Project hash of the request, as the runner put it into `custom.projectHash`.
 * Returns undefined for anything but 16 lowercase hex chars, so a malformed
 * value never reaches a cache id or a Core request.
 */
export function getProjectHash(custom: Record<string, unknown> | undefined): string | undefined {
  const value = custom?.projectHash;
  return typeof value === "string" && PROJECT_HASH_RE.test(value) ? value : undefined;
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const PROJECT_NAME_MAX = 200;
// eslint-disable-next-line no-control-regex -- control chars are the point of the check
// C0/C1 controls, Unicode line separators, bidi overrides, and angle brackets
// can break the prompt line or the tag, so they are rejected.
export const PROJECT_NAME_BAD_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069<>]/;

/**
 * Project name of the request, as the runner put it into `custom.projectName`.
 * The name is rendered into the prompt, so it must be one short line with no
 * control characters and no angle brackets that could close or open a tag.
 * Returns undefined for anything else.
 */
export function getProjectName(custom: Record<string, unknown> | undefined): string | undefined {
  const value = custom?.projectName;
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (!name || name.length > PROJECT_NAME_MAX || PROJECT_NAME_BAD_RE.test(name)) return undefined;
  return name;
}
