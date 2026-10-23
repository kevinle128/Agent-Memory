/**
 * Check that a Core answer to a project request is a project answer.
 *
 * Core echoes the requested `project_hash` in `data` of every project read. A
 * Core that does not know the field ignores it and serves user-global data, so
 * an answer without the echo must never be shown or used as project memory.
 */

let warned = false;

/** Reset the once-per-process warning (tests). */
export function resetProjectEchoWarning(): void {
  warned = false;
}

/**
 * True when `data.project_hash` equals `requested`. A mismatch is logged once
 * per process. An empty `data` is a failed call (the client returns `{}` on
 * an error), not an old Core, so it gives false without the warning.
 */
export function isProjectAnswer(data: unknown, requested: string): boolean {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  if (record.project_hash === requested) return true;
  if (Object.keys(record).length > 0 && !warned) {
    warned = true;
    console.warn("[project-scope] core does not support project_hash; project memory skipped");
  }
  return false;
}
