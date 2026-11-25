/**
 * Read-only list of skill folders reported by the signed-in user's machines.
 * It does not create a cloud skill and it does not open a proposal.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalSkillInventoryRow } from '../../../lib/api/skills';
import { formatSaigon } from '../lib/skill-scope';
import '../styles/skills-list.css';

const SOURCE_LABEL_KEY: Record<string, string> = {
  user: 'skills.localInventory.source.user',
  project: 'skills.localInventory.source.project',
  third_party_plugin: 'skills.localInventory.source.third_party_plugin',
};

/** One folder name: letters, marks, digits, space, and . _ - . Same allowlist as Core. */
const SAFE_SKILL_FOLDER_NAME = /^[\p{L}\p{M}\p{N} ._-]+$/u;

function isSafeSkillFolderName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length < 1 || value.length > 128) return false;
  if (value === '.' || value === '..' || value.includes('%') || value.includes('\uFF0E')) return false;
  if (/\p{C}/u.test(value)) return false;
  return SAFE_SKILL_FOLDER_NAME.test(value);
}

/**
 * Drop a row that could throw while rendering, or whose root, name, or path
 * could print a home directory or an absolute path.
 * A cloud skill list must keep rendering when this row is bad data.
 */
export function isSafeLocalInventoryRow(row: unknown): row is LocalSkillInventoryRow {
  if (row === null || typeof row !== 'object') return false;
  const candidate = row as LocalSkillInventoryRow;
  if (typeof candidate.root_kind !== 'string' || !/^[a-z0-9_]{1,64}$/.test(candidate.root_kind)) {
    return false;
  }
  if (!isSafeSkillFolderName(candidate.name)) return false;
  if (typeof candidate.content_hash !== 'string' || !/^[0-9a-f]{64}$/i.test(candidate.content_hash)) {
    return false;
  }
  if (
    typeof candidate.reported_at_ms !== 'number' ||
    !Number.isFinite(candidate.reported_at_ms) ||
    Number.isNaN(new Date(candidate.reported_at_ms).getTime())
  ) {
    return false;
  }
  if (typeof candidate.harness !== 'string' || candidate.harness.length === 0) return false;
  if (typeof candidate.source !== 'string' || candidate.source.length === 0) return false;
  if (typeof candidate.inventory_id !== 'number' || !Number.isFinite(candidate.inventory_id)) return false;
  const value = candidate.relative_path;
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) return false;
  if (value.startsWith('/') || value.startsWith('~')) return false;
  if (value.includes('\\') || value.includes('\0') || value.includes('%') || value.includes('\uFF0E')) {
    return false;
  }
  if (/\p{C}/u.test(value)) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..' || !SAFE_SKILL_FOLDER_NAME.test(part))) {
    return false;
  }
  const head = parts[0].normalize('NFKC').toLowerCase();
  if (head === 'users' || head === 'home') return false;
  return true;
}

function sourceLabel(t: (key: string) => string, source: string): string {
  if (!Object.prototype.hasOwnProperty.call(SOURCE_LABEL_KEY, source)) return source;
  const key = SOURCE_LABEL_KEY[source];
  if (typeof key !== 'string') return source;
  const label = t(key);
  return label === key ? source : label;
}

export function LocalInventoryListView({
  items,
  unavailable = false,
}: {
  items: readonly unknown[];
  unavailable?: boolean;
}) {
  const { t } = useTranslation();
  const safeItems = (Array.isArray(items) ? items : []).filter(isSafeLocalInventoryRow);
  return (
    <section className="_memory-local-inventory" aria-label={t('skills.localInventory.title')}>
      <h3 className="_memory-local-inventory-title">{t('skills.localInventory.title')}</h3>
      {unavailable ? (
        <p className="_memory-local-inventory-note">{t('skills.localInventory.unavailable')}</p>
      ) : safeItems.length === 0 ? (
        <p className="_memory-local-inventory-note">{t('skills.localInventory.empty')}</p>
      ) : (
        <ul className="_memory-local-inventory-list">
          {safeItems.map((row) => (
            <li key={row.inventory_id} className="_memory-local-inventory-row">
              <span className="_memory-local-inventory-name">{row.name}</span>
              <span className="_memory-local-inventory-harness">{row.harness}</span>
              <span className="_memory-local-inventory-source">{sourceLabel(t, row.source)}</span>
              <code className="_memory-local-inventory-root">{row.root_kind}</code>
              <code className="_memory-local-inventory-path">{row.relative_path}</code>
              <code className="_memory-local-inventory-hash">{row.content_hash.slice(0, 12)}</code>
              <time className="_memory-local-inventory-time" dateTime={new Date(row.reported_at_ms).toISOString()}>
                {formatSaigon(row.reported_at_ms)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Loads the signed-in user's report. A failed load stays inside this block. */
export function LocalInventorySection({ refreshToken }: { refreshToken: string | number }) {
  const [items, setItems] = useState<LocalSkillInventoryRow[]>([]);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void import('../../../lib/api/skills')
      .then((mod) => mod.skillApi.listLocalInventory())
      .then((rows) => {
        if (cancelled) return;
        setItems(rows);
        setUnavailable(false);
      })
      .catch(() => {
        if (cancelled) return;
        setItems([]);
        setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  return <LocalInventoryListView items={items} unavailable={unavailable} />;
}
