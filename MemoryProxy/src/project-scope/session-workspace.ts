/**
 * Workspace of a session, as the client hook last reported it.
 *
 * The record lives next to the session state and the hook cache, in the same
 * ProxyStorage directory (`ttl/<spaceId>/<userId>/<agentSource>/<sessionId>/`),
 * so it uses the same backend (sqlite, fs, cos) and goes away with the session.
 * A later report replaces it, so a session that changes its working directory
 * takes the new project on its next prompt.
 */

import { sessionDirOf } from "../storage/key-utils.js";
import { MemoryStorage } from "../storage/memory-storage.js";
import type { ProxyStorage } from "../storage/proxy-storage.js";

const FILENAME = "workspace.json";

export interface SessionWorkspace {
  sessionId: string;
  deviceId: string;
  client: string;
  cwd: string;
  gitToplevel: string | null;
  gitRemote: string | null;
  projectKey: string | null;
  projectHash: string | null;
  projectLabel: string | null;
  hookEvent: string;
  hookVersion: string;
  /** ISO-8601 time when the proxy received the report. */
  reportedAt: string;
}

export interface SessionWorkspaceKey {
  spaceId: string;
  userId: string;
  agentSource: string;
  sessionId: string;
}

export class SessionWorkspaceStore {
  constructor(private readonly storage: ProxyStorage) {}

  async put(key: SessionWorkspaceKey, workspace: SessionWorkspace): Promise<void> {
    await this.storage.putJSON(keyOf(key), workspace);
  }

  /** Last reported workspace, or null when the hook has not reported for this session. */
  async get(key: SessionWorkspaceKey): Promise<SessionWorkspace | null> {
    return this.storage.getJSON<SessionWorkspace>(keyOf(key));
  }
}

function keyOf(key: SessionWorkspaceKey): string {
  return `${sessionDirOf("ttl", key.spaceId || "_default", key.userId, key.agentSource, key.sessionId)}${FILENAME}`;
}

let instance: SessionWorkspaceStore | null = null;

/**
 * Process-wide store. Uses ProxyStorage when `storage.enabled`, else an
 * in-process memory store (single node only, lost on restart).
 */
export async function getSessionWorkspaceStore(config: {
  storage?: import("../types.js").ProxyConfig["storage"];
}): Promise<SessionWorkspaceStore> {
  if (instance) return instance;
  if (config.storage?.enabled) {
    const { getProxyStorage } = await import("../storage/factory.js");
    instance = new SessionWorkspaceStore(getProxyStorage(config.storage));
  } else {
    instance = new SessionWorkspaceStore(new MemoryStorage());
  }
  return instance;
}

/**
 * Add the session's reported project to a TDAI identity, for the L0 write.
 * Returns the identity unchanged when there is no report, the report has no
 * project, or the lookup fails: a missing project means "no project", never a
 * guess.
 */
export async function withSessionProject<T extends { projectKey?: string; projectHash?: string }>(
  identity: T | null,
  config: { storage?: import("../types.js").ProxyConfig["storage"] },
  key: SessionWorkspaceKey,
): Promise<T | null> {
  if (!identity || !key.sessionId || !key.userId || !key.agentSource) return identity;
  try {
    const store = await getSessionWorkspaceStore(config);
    const ws = await store.get(key);
    if (!ws?.projectKey || !ws.projectHash) return identity;
    return { ...identity, projectKey: ws.projectKey, projectHash: ws.projectHash };
  } catch (err) {
    console.warn(
      `[session-workspace] project lookup failed session=${key.sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return identity;
  }
}

/** Replace the process-wide store (tests). */
export function setSessionWorkspaceStore(store: SessionWorkspaceStore | null): void {
  instance = store;
}
