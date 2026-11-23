import { describe, expect, it } from 'vitest';
import {
  approveBody,
  asVtcErrorCode,
  candidatesFromConflictBody,
  canSubmit,
  defaultAccountChoice,
  formatSaigon,
  isSelectable,
  unselectableReason,
  VTC_ERROR_CODES,
  type Candidate,
  type PendingItem,
} from '../../../web/src/extensions/vtc/logic';
import { vtcWebExtension } from '../../../web/src/extensions/vtc/index';
import { enUS } from '../../../web/src/extensions/vtc/i18n/en-US';
import { viVN } from '../../../web/src/extensions/vtc/i18n/vi-VN';
import { zhCN } from '../../../web/src/extensions/vtc/i18n/zh-CN';

const NEW_ITEM: PendingItem = {
  pending_id: 'pnd_1',
  email: 'person@example.test',
  vtc_user_id: 'vtc-1',
  kind: 'new',
  status: 'pending',
  source: 'device',
  first_login_at: '2026-11-19T14:40:00Z',
  last_login_at: '2026-11-19T14:40:00Z',
  login_count: 1,
};
const NO_TEAM_ITEM: PendingItem = { ...NEW_ITEM, pending_id: 'pnd_2', kind: 'no_team', core_user_id: 'u_9', core_username: 'person' };

function candidate(id: string, extra: Partial<Candidate> = {}): Candidate {
  return {
    user_id: id,
    username: `user_${id}`,
    display_name: null,
    email: null,
    auth_provider: 'api_key',
    user_type: 'normal',
    match: ['email'],
    ...extra,
  };
}

describe('pending users logic', () => {
  it('links the first selectable candidate by default', () => {
    const list = [candidate('a', { linked_vtc_user_id: 'vtc-other' }), candidate('b'), candidate('c')];
    expect(defaultAccountChoice(NEW_ITEM, list)).toEqual({ mode: 'link', userId: 'b' });
  });

  it('creates by default when there is no candidate, and uses the existing user for no_team', () => {
    expect(defaultAccountChoice(NEW_ITEM, [])).toEqual({ mode: 'create', confirmed: false });
    expect(defaultAccountChoice(NO_TEAM_ITEM, [])).toEqual({ mode: 'existing' });
    // A user without a team never gets a second account, whatever the lookup says.
    expect(defaultAccountChoice(NO_TEAM_ITEM, [candidate('a')])).toEqual({ mode: 'existing' });
  });

  it('skips candidates linked to another VTC account and the system admin', () => {
    const linked = candidate('a', { linked_vtc_user_id: 'vtc-other' });
    const admin = candidate('b', { user_type: 'system_admin' });
    expect(isSelectable(linked)).toBe(false);
    expect(unselectableReason(linked)).toBe('linked');
    expect(isSelectable(admin)).toBe(false);
    expect(unselectableReason(admin)).toBe('system_admin');
    expect(unselectableReason(candidate('c'))).toBeNull();

    const choice = defaultAccountChoice(NEW_ITEM, [linked, admin]);
    expect(choice).toEqual({ mode: 'create', confirmed: false });
    expect(canSubmit(NEW_ITEM, [linked, admin], choice, 't1')).toBe(false);
    expect(canSubmit(NEW_ITEM, [linked, admin], { mode: 'create', confirmed: true }, 't1')).toBe(true);
    // A link to a refused candidate is never submittable, even when chosen by hand.
    expect(canSubmit(NEW_ITEM, [linked, admin], { mode: 'link', userId: 'b' }, 't1')).toBe(false);
  });

  it('needs a team and, with candidates, a confirmation to create', () => {
    const one = [candidate('a')];
    const rows: Array<[string, PendingItem, Candidate[], Parameters<typeof canSubmit>[2], string | null, boolean]> = [
      ['link with team', NEW_ITEM, one, { mode: 'link', userId: 'a' }, 't1', true],
      ['link without team', NEW_ITEM, one, { mode: 'link', userId: 'a' }, null, false],
      ['link to an unknown user', NEW_ITEM, one, { mode: 'link', userId: 'zzz' }, 't1', false],
      ['create without candidates', NEW_ITEM, [], { mode: 'create', confirmed: false }, 't1', true],
      ['create with candidates, not confirmed', NEW_ITEM, one, { mode: 'create', confirmed: false }, 't1', false],
      ['create with candidates, confirmed', NEW_ITEM, one, { mode: 'create', confirmed: true }, 't1', true],
      ['create without team', NEW_ITEM, [], { mode: 'create', confirmed: false }, null, false],
      ['existing for no_team', NO_TEAM_ITEM, [], { mode: 'existing' }, 't1', true],
      ['existing for a new person', NEW_ITEM, [], { mode: 'existing' }, 't1', false],
      ['create for no_team', NO_TEAM_ITEM, [], { mode: 'create', confirmed: true }, 't1', false],
    ];
    for (const [name, item, list, choice, team, expected] of rows) {
      expect(canSubmit(item, list, choice, team), name).toBe(expected);
    }
  });

  it('sends confirm_create only for a confirmed create with candidates', () => {
    const one = [candidate('a')];
    expect(approveBody(NEW_ITEM, one, { mode: 'link', userId: 'a' }, 't1', 'member')).toEqual({
      pending_id: 'pnd_1',
      team_id: 't1',
      role: 'member',
      mode: 'link',
      link_user_id: 'a',
    });
    expect(approveBody(NEW_ITEM, one, { mode: 'create', confirmed: true }, 't1', 'admin')).toEqual({
      pending_id: 'pnd_1',
      team_id: 't1',
      role: 'admin',
      mode: 'create',
      confirm_create: true,
    });
    expect(approveBody(NEW_ITEM, [], { mode: 'create', confirmed: false }, 't1', 'member')).toEqual({
      pending_id: 'pnd_1',
      team_id: 't1',
      role: 'member',
      mode: 'create',
    });
    // Unconfirmed create never carries the flag, whatever the list holds.
    expect(approveBody(NEW_ITEM, one, { mode: 'create', confirmed: false }, 't1', 'member')).not.toHaveProperty('confirm_create');
    expect(approveBody(NO_TEAM_ITEM, [], { mode: 'existing' }, 't1', 'member')).toEqual({
      pending_id: 'pnd_2',
      team_id: 't1',
      role: 'member',
    });
  });

  it('formats times in Asia/Saigon', () => {
    expect(formatSaigon('2026-11-19T14:40:00Z')).toBe('2026-11-19 21:40');
    expect(formatSaigon('2026-11-19T18:00:00Z')).toBe('2026-11-20 01:00');
    expect(formatSaigon('not a date')).toBe('not a date');
  });

  it('reads the candidates of a CANDIDATES_EXIST conflict only', () => {
    const body = JSON.stringify({ code: 409, message: 'CANDIDATES_EXIST', data: { candidates: [candidate('a')] } });
    expect(candidatesFromConflictBody(409, body)).toEqual([candidate('a')]);
    expect(candidatesFromConflictBody(500, body)).toBeNull();
    expect(candidatesFromConflictBody(409, JSON.stringify({ code: 409, message: 'LINK_CONFLICT', data: null }))).toBeNull();
    expect(candidatesFromConflictBody(409, 'not json')).toBeNull();
  });

  it('knows the error codes of the admin routes', () => {
    expect(asVtcErrorCode('USER_NOT_LINKABLE')).toBe('USER_NOT_LINKABLE');
    expect(asVtcErrorCode('SOMETHING_ELSE')).toBeNull();
    expect(asVtcErrorCode(undefined)).toBeNull();
  });
});

describe('vtc web extension', () => {
  it('ships the same keys in en-US, zh-CN and vi-VN with no empty values', () => {
    const keys = Object.keys(enUS).sort();
    expect(keys.length).toBeGreaterThan(0);
    expect(Object.keys(zhCN).sort()).toEqual(keys);
    expect(Object.keys(viVN).sort()).toEqual(keys);
    for (const [name, bundle] of Object.entries({ enUS, zhCN, viVN })) {
      for (const [key, value] of Object.entries(bundle)) {
        expect(value.trim(), `${name}.${key}`).not.toBe('');
      }
    }
    // Interpolation placeholders must match across languages.
    const placeholders = (text: string) => (text.match(/\{\{\w+\}\}/g) ?? []).sort();
    for (const key of keys) {
      expect(placeholders(zhCN[key]!), `zh-CN ${key}`).toEqual(placeholders(enUS[key]!));
      expect(placeholders(viVN[key]!), `vi-VN ${key}`).toEqual(placeholders(enUS[key]!));
    }
  });

  it('has a text for every error code', () => {
    for (const code of VTC_ERROR_CODES) expect(enUS[`error.${code}`], code).toBeTruthy();
  });

  it('declares the Pending users page for team admins under Members', () => {
    expect(vtcWebExtension.id).toBe('vtc');
    expect(vtcWebExtension.namespace).toBe('ext-vtc');
    expect(Object.keys(vtcWebExtension.i18n).sort()).toEqual(['en-US', 'vi-VN', 'zh-CN']);
    const page = vtcWebExtension.pages.find((p) => p.id === 'ext.vtc.pending_users');
    expect(page).toBeDefined();
    expect(page!.path).toBe('/ext/vtc/pending-users');
    expect(page!.group).toBe('organization');
    expect(page!.order).toBeGreaterThan(0);
    expect(page!.order).toBeLessThan(1);
    expect(page!.visibleTo).toBe('team_admin');
    expect((page!.Component as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.lazy'));
    expect((page!.Badge as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.lazy'));
    expect(enUS[page!.labelKey]).toBeTruthy();
    expect(enUS[page!.descKey!]).toBeTruthy();
  });
});
