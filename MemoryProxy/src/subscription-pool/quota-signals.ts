/**
 * Parse the quota signals of the Codex (ChatGPT) backend: rate-limit response headers and the
 * body of a 429. Provider times are epoch seconds; the pool works in epoch milliseconds.
 * Window names match the usage API names so Core can merge a header reading with a usage reading.
 */

import type { PoolQuotaWindow } from "./types.js";

/**
 * Header names of the two windows, by position. The doubled "primary" in the secondary names is
 * real; the plain secondary names are accepted as a fallback.
 */
const WINDOW_HEADERS = [
  {
    position: "primary_window",
    used: ["x-codex-primary-used-percent"],
    reset: ["x-codex-primary-reset-at"],
    minutes: ["x-codex-primary-window-minutes"],
  },
  {
    position: "secondary_window",
    used: ["x-codex-secondary-primary-used-percent", "x-codex-secondary-used-percent"],
    reset: ["x-codex-secondary-primary-reset-at", "x-codex-secondary-reset-at"],
    minutes: ["x-codex-secondary-window-minutes", "x-codex-secondary-primary-window-minutes"],
  },
] as const;

function finiteNumber(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function firstNumber(headers: Headers, names: readonly string[]): number | null {
  for (const name of names) {
    const value = finiteNumber(headers.get(name));
    if (value !== null) return value;
  }
  return null;
}

/**
 * Name of a window by its length: about 5 hours is "primary_window", about 7 days is
 * "secondary_window". Null when the length is missing or between the two.
 */
function windowNameByLength(minutes: number | null): "primary_window" | "secondary_window" | null {
  if (minutes === null || minutes <= 0) return null;
  if (minutes <= 24 * 60) return "primary_window";
  if (minutes >= 6 * 24 * 60) return "secondary_window";
  return null;
}

export function parseCodexQuotaHeaders(headers: Headers, now: number): PoolQuotaWindow[] {
  const readings = WINDOW_HEADERS.flatMap((spec) => {
    const used = firstNumber(headers, spec.used);
    if (used === null) return [];
    return [{
      position: spec.position,
      used,
      resetSec: firstNumber(headers, spec.reset),
      lengthName: windowNameByLength(firstNumber(headers, spec.minutes)),
    }];
  });
  // Same rule as the usage API reading in Core, so both readings use the same name and merge.
  // A weekly-only plan sends its weekly window in the primary headers.
  const useLength = readings.every((reading) => reading.lengthName !== null)
    && new Set(readings.map((reading) => reading.lengthName)).size === readings.length;
  return readings.map((reading) => ({
    name: useLength ? reading.lengthName! : reading.position,
    model_scope: null,
    used_pct: Math.min(100, Math.max(0, reading.used)),
    resets_at: reading.resetSec === null ? null : reading.resetSec * 1000,
    observed_at: now,
    source: "header" as const,
  }));
}

export interface CodexLimitInfo {
  /** Epoch milliseconds when the limit lifts, or null when the response does not say. */
  resetsAt: number | null;
  /** Seconds until then, as Core's `retry_after`. */
  retryAfterSec: number | null;
}

/**
 * Reset time of a 429. Sources, first match wins: `error.resets_at` (epoch s), then
 * `error.resets_in_seconds`, then the `retry-after` header (seconds).
 */
export function parseCodexLimitBody(bodyText: string, headers: Headers, now: number): CodexLimitInfo {
  let resetsAt: number | null = null;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { resets_at?: unknown; resets_in_seconds?: unknown } };
    const error = parsed?.error;
    if (typeof error?.resets_at === "number" && Number.isFinite(error.resets_at)) {
      resetsAt = error.resets_at * 1000;
    } else if (typeof error?.resets_in_seconds === "number" && Number.isFinite(error.resets_in_seconds)) {
      resetsAt = now + error.resets_in_seconds * 1000;
    }
  } catch {
    // A body that is not JSON carries no reset time.
  }
  if (resetsAt === null) {
    const header = finiteNumber(headers.get("retry-after"));
    if (header !== null) resetsAt = now + header * 1000;
  }
  if (resetsAt === null || resetsAt <= now) return { resetsAt: null, retryAfterSec: null };
  return { resetsAt, retryAfterSec: Math.ceil((resetsAt - now) / 1000) };
}

/** Claude rate-limit headers. Utilization is a fraction (about 0 to 1); the pool stores a percent. */
const CLAUDE_WINDOW_HEADERS = [
  { name: "five_hour", used: "anthropic-ratelimit-unified-5h-utilization", reset: "anthropic-ratelimit-unified-5h-reset" },
  { name: "seven_day", used: "anthropic-ratelimit-unified-7d-utilization", reset: "anthropic-ratelimit-unified-7d-reset" },
] as const;

export function parseClaudeQuotaHeaders(headers: Headers, now: number): PoolQuotaWindow[] {
  const windows: PoolQuotaWindow[] = [];
  for (const spec of CLAUDE_WINDOW_HEADERS) {
    const fraction = finiteNumber(headers.get(spec.used));
    if (fraction === null) continue;
    const resetSec = finiteNumber(headers.get(spec.reset));
    windows.push({
      name: spec.name,
      model_scope: null,
      used_pct: Math.min(100, Math.max(0, fraction * 100)),
      resets_at: resetSec === null ? null : resetSec * 1000,
      observed_at: now,
      source: "header",
    });
  }
  return windows;
}

/**
 * Reset time of a Claude 429. Sources, first match wins: the unified reset header (epoch s),
 * the 5-hour window reset, then `retry-after` (seconds).
 */
export function parseClaudeLimitBody(headers: Headers, now: number): CodexLimitInfo {
  const unified = finiteNumber(headers.get("anthropic-ratelimit-unified-reset"));
  const fiveHour = finiteNumber(headers.get("anthropic-ratelimit-unified-5h-reset"));
  const retryAfter = finiteNumber(headers.get("retry-after"));
  const resetsAt = unified !== null
    ? unified * 1000
    : fiveHour !== null
      ? fiveHour * 1000
      : retryAfter !== null
        ? now + retryAfter * 1000
        : null;
  if (resetsAt === null || resetsAt <= now) return { resetsAt: null, retryAfterSec: null };
  return { resetsAt, retryAfterSec: Math.ceil((resetsAt - now) / 1000) };
}
