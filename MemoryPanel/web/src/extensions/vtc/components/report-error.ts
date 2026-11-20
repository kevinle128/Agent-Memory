import type { TFunction } from 'i18next';
import { tea } from '@/lib/tea-bridge';
import { vtcErrorCode } from '../api';

/** True when the request is gone or already decided, so the list the user sees is stale. */
export function isStaleRequestError(err: unknown): boolean {
  const code = vtcErrorCode(err);
  return code === 'PENDING_NOT_FOUND' || code === 'PENDING_NOT_PENDING' || code === 'PENDING_NOT_REJECTED';
}

/** Text of a known VTC error code, or null for any other failure. */
export function knownErrorText(t: TFunction, err: unknown): string | null {
  const code = vtcErrorCode(err);
  return code ? t(`error.${code}`) : null;
}

/** Shows the text of a known VTC error code; any other failure goes through the shared error notice. */
export function reportError(t: TFunction, err: unknown): void {
  const code = vtcErrorCode(err);
  if (code) tea.notify.error({ detail: t(`error.${code}`) });
  else tea.notify.error(err);
}
