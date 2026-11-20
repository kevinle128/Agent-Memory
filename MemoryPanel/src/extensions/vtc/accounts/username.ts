import { MetaError, type MetaFacade } from '../../../panel/extensions/types.js';

const MAX_LENGTH = 48;
const MAX_SUFFIX = 50;
const FALLBACK = 'vtc-user';
/** Core's internal knowledge-service account: the Panel hides it, so no VTC user may take its name. */
export const HIDDEN_SERVICE_USER = 'knowledge-service';

/** Email local part to a Core username made of [a-z0-9_-]: lower-case, other runs become '-', trimmed of '-', at most 48 characters. */
export function safeUsername(localPart: string): string {
  const cleaned = localPart
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, MAX_LENGTH)
    .replace(/^-+|-+$/g, '');
  return cleaned || FALLBACK;
}

/** First free name among base, base-2, ... base-50 (exact `user/list {username}`). Throws MetaError('username_exhausted'). */
export async function uniqueUsername(meta: MetaFacade, instanceId: string, base: string): Promise<string> {
  for (let n = 1; n <= MAX_SUFFIX; n += 1) {
    const suffix = n === 1 ? '' : `-${n}`;
    // The suffix must not push the name past the length limit.
    const name = `${base.slice(0, MAX_LENGTH - suffix.length)}${suffix}`;
    if (name === HIDDEN_SERVICE_USER) continue;
    if ((await meta.users.listByUsername(instanceId, name)).length === 0) return name;
  }
  throw new MetaError('username_exhausted', 'no free username');
}
