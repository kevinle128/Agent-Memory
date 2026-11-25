/**
 * Latest report of skill folders on one machine.
 * The sqlite skill store keeps these rows. Other skill stores do not.
 */

export const LOCAL_SKILL_HARNESSES = ["claude", "codex", "omp", "agy"] as const;
export const LOCAL_SKILL_SOURCES = ["user", "project", "third_party_plugin"] as const;

export type LocalSkillHarness = (typeof LOCAL_SKILL_HARNESSES)[number];
export type LocalSkillSource = (typeof LOCAL_SKILL_SOURCES)[number];

/**
 * Letters (with combining marks, as macOS returns NFD names), digits,
 * one ASCII space, and `.` `_` `-`.
 * A skill folder uses these characters. The allowlist rejects every other
 * character, so a home directory, an encoded `..`, or a hidden control
 * character cannot be stored or returned.
 */
const RELATIVE_SEGMENT = /^[\p{L}\p{M}\p{N} ._-]+$/u;

/**
 * Return a reason when `value` is not one folder name that a relative_path
 * segment could hold. Unlike a path, any first word is allowed.
 */
export function localSkillNameError(value: string): string | null {
  if (value.length < 1 || value.length > 128) return "name must be 1-128 characters";
  if (value === "." || value === ".." || value.includes("%") || value.includes("\uFF0E")) {
    return "name must be a single folder name";
  }
  if (/[\p{C}]/u.test(value) || !RELATIVE_SEGMENT.test(value)) return "name must be a single folder name";
  return null;
}

/**
 * Return a reason when `value` is not a relative path under a named root.
 * The same check guards the request, the sqlite write, and the list response.
 */
export function relativeSkillPathError(value: string): string | null {
  if (value.length < 1 || value.length > 512) return "relative_path must be 1-512 characters";
  if (value.includes("\0") || value.includes("\\")) return "relative_path must not contain a backslash or a null";
  if (value.startsWith("/") || value.startsWith("~") || value.startsWith("//") || /^[A-Za-z]:/.test(value)) {
    return "relative_path must be relative";
  }
  if (/[\p{C}]/u.test(value) || value.includes("\uFF0E")) {
    return "relative_path must not contain a control, format, or fullwidth dot";
  }
  if (value.includes("%")) return "relative_path must not contain percent-encoding";
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    return "relative_path must not contain '..' or an empty segment";
  }
  const head = parts[0].normalize("NFKC").toLowerCase();
  if (head === "users" || head === "home") return "relative_path must not use a home prefix";
  for (const part of parts) {
    if (!RELATIVE_SEGMENT.test(part)) return "relative_path must use letters, digits, spaces, and ._- only";
  }
  return null;
}

/** One folder in a full snapshot. The path passed relativeSkillPathError. */
export interface LocalSkillInventoryItem {
  harness: LocalSkillHarness;
  source: LocalSkillSource;
  name: string;
  root_kind: string;
  relative_path: string;
  content_hash: string;
}

/** A stored row. `present` is 0 when the folder was missing from the latest snapshot. */
export interface LocalSkillInventoryRow {
  inventory_id: number;
  machine_id: string;
  harness: string;
  source: string;
  name: string;
  root_kind: string;
  relative_path: string;
  content_hash: string;
  reported_at_ms: number;
  present: number;
}

export interface ReplaceLocalSkillInventoryInput {
  user_id: string;
  machine_id: string;
  items: LocalSkillInventoryItem[];
}

export interface ListLocalSkillInventoryInput {
  user_id: string;
  machine_id?: string;
}

export interface LocalSkillInventoryStore {
  replaceLocalSkillInventory(input: ReplaceLocalSkillInventoryInput): { machine_id: string; count: number };
  listLocalSkillInventory(input: ListLocalSkillInventoryInput): LocalSkillInventoryRow[];
}

/** Return the store when it can save a local folder report. Otherwise return null. */
export function asLocalSkillInventoryStore(store: object): LocalSkillInventoryStore | null {
  const candidate = store as Partial<LocalSkillInventoryStore>;
  if (typeof candidate.replaceLocalSkillInventory !== "function") return null;
  if (typeof candidate.listLocalSkillInventory !== "function") return null;
  return candidate as LocalSkillInventoryStore;
}
