/**
 * Maps a Core model-source error to a localized message. Core puts its error identifier at the
 * start of the message ("SOURCE_NAME_TAKEN: ..."). Returns null for codes without a message here.
 */
import i18n from '@/i18n';
import { ApiError } from '@/lib/api/base';
import { parsePoolErrorCode } from '@/lib/subscription-pool-display';

export function sourceErrorCode(error: unknown): string | null {
  return error instanceof ApiError ? parsePoolErrorCode(error.rawMessage) : null;
}

export function sourceErrorMessage(error: unknown): string | null {
  const code = sourceErrorCode(error);
  if (!code) return null;
  const key = `modelSource.error.${code}`;
  return i18n.exists(key) ? i18n.t(key) : null;
}

/** Codes that mean the shown data is older than the stored data. */
export const STALE_SOURCE_CODES: ReadonlySet<string> = new Set(['WRITE_CONFLICT', 'GROUP_NOT_FOUND']);
