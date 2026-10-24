/**
 * Pure helpers for the scoped-skill UI: badges, filters, known projects,
 * error mapping, version audit text, line diff and time format.
 * No React and no alias imports, so unit tests can load this file directly.
 */

export type SkillScope = 'global' | 'project';
export type SkillOrigin = 'extracted' | 'manual' | 'template';

export interface ScopedSkillFields {
  skill_id: string;
  name: string;
  description?: string;
  scope?: SkillScope;
  project_key?: string;
  project_hash?: string;
  project_name?: string;
  origin?: SkillOrigin;
}

/** Rows written before scoping have no `scope`; they are global. */
export function scopeOf(skill: Pick<ScopedSkillFields, 'scope'>): SkillScope {
  return skill.scope === 'project' ? 'project' : 'global';
}

/** Project display name; falls back to the first 8 characters of the hash. */
export function projectLabel(
  skill: Pick<ScopedSkillFields, 'project_name' | 'project_hash'>,
): string {
  const name = skill.project_name?.trim();
  if (name) return name;
  return skill.project_hash ? skill.project_hash.slice(0, 8) : '';
}

export interface KnownProject {
  hash: string;
  key?: string;
  label: string;
}

/** Distinct projects (by hash) found in the loaded skills, sorted by label. */
export function collectProjects(skills: ScopedSkillFields[]): KnownProject[] {
  const byHash = new Map<string, KnownProject>();
  for (const s of skills) {
    if (scopeOf(s) !== 'project' || !s.project_hash) continue;
    const prev = byHash.get(s.project_hash);
    const label = projectLabel(s);
    if (!prev) {
      byHash.set(s.project_hash, { hash: s.project_hash, key: s.project_key || undefined, label });
    } else if (!prev.key && s.project_key) {
      prev.key = s.project_key;
    }
  }
  return [...byHash.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export interface SkillFilter {
  type: 'all' | SkillScope;
  /** Project hash, or '' for all projects. */
  project: string;
  origin: 'all' | SkillOrigin;
  query: string;
}

export const EMPTY_FILTER: SkillFilter = { type: 'all', project: '', origin: 'all', query: '' };

export function filterSkills<T extends ScopedSkillFields>(skills: T[], f: SkillFilter): T[] {
  const q = f.query.trim().toLowerCase();
  return skills.filter((s) => {
    const scope = scopeOf(s);
    if (f.type !== 'all' && scope !== f.type) return false;
    // A project filter only matches project skills of that project.
    if (f.project && (scope !== 'project' || s.project_hash !== f.project)) return false;
    if (f.origin !== 'all' && (s.origin ?? 'extracted') !== f.origin) return false;
    if (q && !`${s.name} ${s.description ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

// ---------------------------------------------------------------- errors

export const SKILL_ERROR_KEY: Record<number, string> = {
  42204: 'skills.error.nameOtherScope',
  42205: 'skills.error.projectRequired',
  40901: 'skills.error.versionMoved',
  40902: 'skills.error.proposalNotPending',
};

/** i18n key for a known skill error code, or null for any other error. */
export function skillErrorKey(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? (SKILL_ERROR_KEY[code] ?? null) : null;
}

// ---------------------------------------------------------------- versions

export interface VersionAudit {
  version: number;
  change_source?: string | null;
  change_summary?: string[];
}

/** Newest first. */
export function sortVersionsDesc<T extends { version: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.version - a.version);
}

/** Improvement summaries of every version after `target`: what a rollback to `target` drops. */
export function lostImprovements<T extends VersionAudit>(
  versions: T[],
  target: number,
): Array<{ version: number; source: string | null | undefined; summary: string[] }> {
  return sortVersionsDesc(versions)
    .filter((v) => v.version > target)
    .map((v) => ({ version: v.version, source: v.change_source, summary: v.change_summary ?? [] }))
    .filter((v) => v.summary.length > 0);
}

/** Improvement summaries of the versions in (from, to]. */
export function improvementsBetween<T extends VersionAudit>(versions: T[], from: number, to: number) {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return sortVersionsDesc(versions)
    .filter((v) => v.version > lo && v.version <= hi)
    .map((v) => ({ version: v.version, source: v.change_source, summary: v.change_summary ?? [] }))
    .filter((v) => v.summary.length > 0);
}

/** Summaries written by the system start with "(auto) ". */
export function isAutoSummary(item: string): boolean {
  return item.startsWith('(auto) ');
}

export function stripAuto(item: string): string {
  return isAutoSummary(item) ? item.slice('(auto) '.length) : item;
}

/** Version just below `version` in the list, or undefined for the first version. */
export function previousVersion(versions: Array<{ version: number }>, version: number): number | undefined {
  const lower = versions.map((v) => v.version).filter((n) => n < version);
  return lower.length ? Math.max(...lower) : undefined;
}

// ---------------------------------------------------------------- proposals

export interface ProposalLike {
  skill_id: string;
  status: string;
}

/** Pending proposals per skill. Stale proposals are not counted. */
export function pendingBySkill(proposals: ProposalLike[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of proposals) {
    if (p.status === 'pending') out[p.skill_id] = (out[p.skill_id] ?? 0) + 1;
  }
  return out;
}

export function countPending(proposals: ProposalLike[]): number {
  return proposals.filter((p) => p.status === 'pending').length;
}

// ---------------------------------------------------------------- time

const SAIGON_TZ = 'Asia/Ho_Chi_Minh';

/** "YYYY-MM-DD HH:mm" in Asia/Saigon (UTC+7), independent of the browser zone. */
export function formatSaigon(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SAIGON_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

// ---------------------------------------------------------------- diff

export interface DiffRow {
  type: 'added' | 'removed' | 'unchanged';
  text: string;
  old_line?: number;
  new_line?: number;
}

/** Line diff by longest common subsequence. Used where no stored version exists to diff against. */
export function diffLines(before: string, after: string): { lines: DiffRow[]; added: number; removed: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      lines.push({ type: 'unchanged', text: a[i], old_line: i + 1, new_line: j + 1 });
      i++;
      j++;
    } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      // Removed lines come before the added lines that replace them.
      lines.push({ type: 'removed', text: a[i], old_line: i + 1 });
      removed++;
      i++;
    } else {
      lines.push({ type: 'added', text: b[j], new_line: j + 1 });
      added++;
      j++;
    }
  }
  return { lines, added, removed };
}

export type DiffBlock =
  | { kind: 'line'; row: DiffRow }
  | { kind: 'collapsed'; count: number };

/** Keep `context` unchanged lines around each change and collapse the rest. */
export function collapseUnchanged(lines: DiffRow[], context = 2): DiffBlock[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((row, idx) => {
    if (row.type === 'unchanged') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true;
  });
  const out: DiffBlock[] = [];
  let hidden = 0;
  lines.forEach((row, idx) => {
    if (keep[idx]) {
      if (hidden > 0) {
        out.push({ kind: 'collapsed', count: hidden });
        hidden = 0;
      }
      out.push({ kind: 'line', row });
    } else {
      hidden++;
    }
  });
  if (hidden > 0) out.push({ kind: 'collapsed', count: hidden });
  return out;
}

/** User-facing text for a skill API error: a mapped message for known codes, else the raw message. */
export function describeSkillError(err: unknown, t: (key: string) => string): string {
  const key = skillErrorKey(err);
  if (key) return t(key);
  return err instanceof Error ? err.message : String(err);
}
