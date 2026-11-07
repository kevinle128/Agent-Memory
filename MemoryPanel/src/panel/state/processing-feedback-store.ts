/**
 * 👍/👎 ratings of the Processing History page, kept by the Panel server.
 *
 * One rating per user per target: an injection (recall log row), an
 * extraction (memory generation log) or a skill proposal. The ratings are the
 * seed of a fixed evaluation set, so they are kept until a person removes them.
 *
 * Storage: one JSON file, the same pattern as the auth identity store. The
 * file is read on first use and written with a temp file and rename, so a
 * crash during a write keeps the previous file. One Panel process owns the
 * file; the Hub runs one Panel process.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const FEEDBACK_TARGET_TYPES = ['injection', 'extraction', 'skill'] as const;
export type FeedbackTargetType = (typeof FEEDBACK_TARGET_TYPES)[number];
export type FeedbackRating = 'up' | 'down';

/** Longest note that is stored. */
export const MAX_FEEDBACK_NOTE_CHARS = 1000;

export interface FeedbackEntry {
  instance_id: string;
  team_id: string;
  target_type: FeedbackTargetType;
  target_id: string;
  rating: FeedbackRating;
  note: string;
  user_id: string;
  /** ISO-8601 time of the last change. */
  updated_at: string;
}

interface FeedbackFile {
  version: 1;
  entries: FeedbackEntry[];
}

function isEntry(v: unknown): v is FeedbackEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.instance_id === 'string' &&
    typeof e.team_id === 'string' &&
    typeof e.target_type === 'string' &&
    (FEEDBACK_TARGET_TYPES as readonly string[]).includes(e.target_type) &&
    typeof e.target_id === 'string' &&
    (e.rating === 'up' || e.rating === 'down') &&
    typeof e.note === 'string' &&
    typeof e.user_id === 'string' &&
    typeof e.updated_at === 'string'
  );
}

export class FileFeedbackStore {
  private entries: Map<string, FeedbackEntry> | null = null;

  constructor(private readonly filePath: string) {}

  /** Ratings of the given targets in one team, from every user. */
  list(
    scope: { instanceId: string; teamId: string },
    targets: Array<{ target_type: FeedbackTargetType; target_id: string }>,
  ): FeedbackEntry[] {
    const wanted = new Set(targets.map((t) => `${t.target_type}\u0000${t.target_id}`));
    const out: FeedbackEntry[] = [];
    for (const e of this.load().values()) {
      if (e.instance_id !== scope.instanceId || e.team_id !== scope.teamId) continue;
      if (wanted.has(`${e.target_type}\u0000${e.target_id}`)) out.push(e);
    }
    return out;
  }

  /** Set the rating of one user on one target. A null rating removes it. */
  set(
    key: Omit<FeedbackEntry, 'rating' | 'note' | 'updated_at'>,
    rating: FeedbackRating | null,
    note: string,
  ): FeedbackEntry | null {
    const entries = this.load();
    const k = this.key(key);
    if (rating === null) {
      if (entries.delete(k)) this.flush();
      return null;
    }
    const entry: FeedbackEntry = {
      ...key,
      rating,
      note: note.trim().slice(0, MAX_FEEDBACK_NOTE_CHARS),
      updated_at: new Date().toISOString(),
    };
    entries.set(k, entry);
    this.flush();
    return entry;
  }

  private key(e: Pick<FeedbackEntry, 'instance_id' | 'team_id' | 'target_type' | 'target_id' | 'user_id'>): string {
    return [e.instance_id, e.team_id, e.target_type, e.target_id, e.user_id].join('\u0000');
  }

  /** Read the file once. A damaged file is an error: writing over it would lose the ratings. */
  private load(): Map<string, FeedbackEntry> {
    if (this.entries) return this.entries;
    const entries = new Map<string, FeedbackEntry>();
    if (existsSync(this.filePath)) {
      let parsed: Partial<FeedbackFile>;
      try {
        parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<FeedbackFile>;
      } catch (err) {
        throw new Error(`invalid feedback store ${this.filePath}: ${(err as Error).message}`);
      }
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        throw new Error(`invalid feedback store ${this.filePath}: unknown format`);
      }
      for (const e of parsed.entries) if (isEntry(e)) entries.set(this.key(e), e);
    }
    this.entries = entries;
    return entries;
  }

  private flush(): void {
    const entries = this.entries;
    if (!entries) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    const file: FeedbackFile = { version: 1, entries: [...entries.values()] };
    writeFileSync(tempPath, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, this.filePath);
  }
}
