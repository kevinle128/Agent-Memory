/**
 * agy wraps the text that the user typed in a tagged block and adds optional blocks of its own:
 *
 *   <USER_REQUEST>\nyes\n</USER_REQUEST>\n<ADDITIONAL_METADATA>...</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>...
 *
 * Everything the proxy reads as "what the user said" (the reply to a session-init question, the L0
 * user text) must read only the typed part. The bytes sent upstream are not touched.
 */

const USER_REQUEST_RE = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/;

/** The trimmed text inside `<USER_REQUEST>`, or the whole text, trimmed, when the tag is absent. */
export function userRequestText(text: string): string {
  const match = USER_REQUEST_RE.exec(text);
  return (match ? match[1]! : text).trim();
}

const SYSTEM_NOTICE_RE = /^\s*The following is a <SYSTEM_MESSAGE>/;

/**
 * True for a user turn that agy added itself (a system notice such as "your background tasks were
 * stopped"). It follows the real user turn as another `user` entry and is not something the user typed.
 * A turn that holds `<USER_REQUEST>` is always typed text.
 */
export function isAgySystemNotice(text: string): boolean {
  if (USER_REQUEST_RE.test(text)) return false;
  return SYSTEM_NOTICE_RE.test(text) || (text.includes("<SYSTEM_MESSAGE>") && !text.includes("<USER_REQUEST>"));
}
