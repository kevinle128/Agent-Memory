/**
 * Characters and length that a client session id may have when it goes into a
 * shell command or a storage path. Same limits as the hook report route.
 */
export const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
