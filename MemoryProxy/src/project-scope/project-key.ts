/**
 * Project identity of a session, computed from what the client hook reports.
 *
 * The proxy injects project memory only when it knows the project of the
 * session. The key must stay the same for every clone, worktree and machine of
 * one repository, so it comes from the git remote when there is one:
 *
 *   - remote present:   `git:<host>/<path>`  (scheme, user info, port and
 *                       `.git` removed; lower case)
 *   - no remote:        `local:<device_id>:<git toplevel>`  (one machine only)
 *   - not a git folder: null  (no project; no project memory is injected)
 *
 * The key is computed here, in one place, and not on the client.
 */

import { createHash } from "node:crypto";

import { PROJECT_NAME_BAD_RE } from "../tdai/identity.js";

export interface ProjectIdentity {
  /** Stable project key, or null when the folder is not inside a git repository. */
  projectKey: string | null;
  /** First 16 hex chars of sha256(projectKey); used in storage paths. */
  projectHash: string | null;
  /** Short human label for logs and traces, for example `gitlab.example.com/team/repo`. */
  projectLabel: string | null;
  /**
   * Readable project name: the full path of the normalized remote without the
   * host (`group/subgroup/repo`), or the folder name when there is no remote.
   * Null when the folder is not inside a git repository. Display only; it is
   * never part of the key.
   */
  projectName: string | null;
}

/**
 * Normalize a git remote URL to `<host>/<path>` in lower case.
 * Accepts https/http/ssh/git URLs and the scp-like `user@host:path` form.
 * Returns null for a value that does not look like a remote.
 */
export function normalizeRemote(remote: string | null | undefined): string | null {
  if (!remote) return null;
  let r = remote.trim();
  if (!r) return null;

  let host: string;
  let path: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i.exec(r);
  if (scheme) {
    // scheme://[user[:pass]@]host[:port]/path
    let rest = scheme[2];
    const at = rest.lastIndexOf("@", rest.indexOf("/") === -1 ? rest.length : rest.indexOf("/"));
    if (at >= 0) rest = rest.slice(at + 1);
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    host = rest.slice(0, slash).replace(/:\d+$/, "");
    path = rest.slice(slash + 1);
  } else {
    // scp-like: [user@]host:path (no "//" after the colon)
    const scp = /^(?:[^@\s/]+@)?([^:\s/]+):(?!\/\/)(.+)$/.exec(r);
    if (!scp) return null;
    host = scp[1];
    path = scp[2];
  }

  path = path.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/^\/+/, "");
  if (!host || !path) return null;
  r = `${host}/${path}`.toLowerCase();
  return r;
}

/** Compute the project identity of one hook report. */
export function buildProjectIdentity(input: {
  gitRemote?: string | null;
  gitToplevel?: string | null;
  deviceId: string;
}): ProjectIdentity {
  const remote = normalizeRemote(input.gitRemote);
  if (remote) return withHash(`git:${remote}`, remote, displayName(remote.slice(remote.indexOf("/") + 1)));

  const toplevel = input.gitToplevel?.trim();
  if (toplevel) {
    const label = toplevel.split("/").filter(Boolean).pop() ?? toplevel;
    return withHash(`local:${input.deviceId}:${toplevel.replace(/\/+$/, "")}`, label, displayName(label));
  }

  return { projectKey: null, projectHash: null, projectLabel: null, projectName: null };
}

/** First 16 hex chars of sha256(projectKey). */
export function projectHash(projectKey: string): string {
  return createHash("sha256").update(projectKey).digest("hex").slice(0, 16);
}

/**
 * Display form of a project name. The name goes into prompts and Core rows, so
 * it is checked once here: a query string or fragment is removed (it can hold
 * a token), and a value with unsafe characters or over 200 chars becomes null.
 * The key is not changed, so the hash stays the same.
 */
function displayName(raw: string): string | null {
  const name = raw.replace(/[?#].*$/, "").replace(/\/+$/, "").trim();
  if (!name || name.length > 200 || PROJECT_NAME_BAD_RE.test(name)) return null;
  return name;
}

function withHash(projectKey: string, projectLabel: string, projectName: string | null): ProjectIdentity {
  return { projectKey, projectHash: projectHash(projectKey), projectLabel, projectName };
}
