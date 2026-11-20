/**
 * The web extensions built into this bundle, and which of them the server turned on. This is the only file
 * that imports from `extensions/<id>/`.
 */
import { useEffect, useState } from 'react';
import { getPanelSession } from '../lib/panelSession';
import { enabledIdsFrom } from './catalog';
import type { WebExtension } from './types';
import { vtcWebExtension } from './vtc';

export const WEB_EXTENSIONS: WebExtension[] = [vtcWebExtension];

const EXTENSIONS_URL = '/api/v1/extensions';

// Extensions change only with a redeploy, so one answer holds for the page lifetime.
let cache: string[] | null = null;
let inflight: Promise<string[]> | null = null;

async function fetchEnabled(): Promise<string[]> {
  const headers: Record<string, string> = {};
  // A system admin also gets the failure details of an extension; the list itself is open.
  const session = getPanelSession();
  if (session?.instanceId) headers['X-Tdai-Service-Id'] = session.instanceId;
  if (session?.userKey) headers['X-Tdai-User-Key'] = session.userKey;
  try {
    const res = await fetch(EXTENSIONS_URL, { credentials: 'include', headers });
    const body: unknown = res.ok ? await res.json().catch(() => null) : null;
    return enabledIdsFrom(
      res.status,
      body,
      WEB_EXTENSIONS.map((extension) => extension.id),
    );
  } catch {
    return [];
  }
}

/** Ids of the extensions the server runs and this bundle knows. null while loading. */
export function useEnabledExtensions(): string[] | null {
  const [enabled, setEnabled] = useState<string[] | null>(WEB_EXTENSIONS.length === 0 ? [] : cache);

  useEffect(() => {
    if (WEB_EXTENSIONS.length === 0 || cache !== null) return undefined;
    let alive = true;
    inflight ??= fetchEnabled().then((ids) => {
      cache = ids;
      inflight = null;
      return ids;
    });
    void inflight.then((ids) => {
      if (alive) setEnabled(ids);
    });
    return () => {
      alive = false;
    };
  }, []);

  return enabled;
}
