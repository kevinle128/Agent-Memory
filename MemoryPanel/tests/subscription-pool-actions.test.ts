import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_PANEL_ACTIONS } from '../src/panel/api/meta-actions';

const metaPost = vi.fn(async (_action: string, _body: Record<string, unknown>) => ({}));
vi.mock('../web/src/lib/api/base', () => ({
  metaPost: (action: string, body: Record<string, unknown>) => metaPost(action, body),
}));

const { subscriptionPoolApi } = await import('../web/src/lib/api/subscription-pool');

const POOL_ACTIONS = [
  'subscription-pool/status',
  'subscription-pool/enable',
  'subscription-pool/disable',
  'subscription-pool/clients/update',
  'subscription-pool/settings/update',
  'subscription-pool/account/oauth-start',
  'subscription-pool/account/oauth-complete',
  'subscription-pool/account/update',
  'subscription-pool/account/delete',
  'subscription-pool/account/check-usage',
  'subscription-pool/account/redeem-reset-credit',
  'subscription-pool/check-all',
];

describe('subscription pool panel actions', () => {
  it.each(POOL_ACTIONS)('allows %s through the meta proxy', (action) => {
    expect(ALLOWED_PANEL_ACTIONS.has(action as never)).toBe(true);
  });

  it('does not expose the internal pool endpoints', () => {
    expect(ALLOWED_PANEL_ACTIONS.has('subscription-pool/accounts/list' as never)).toBe(false);
    expect(ALLOWED_PANEL_ACTIONS.has('subscription-pool/report' as never)).toBe(false);
    expect(ALLOWED_PANEL_ACTIONS.has('subscription-pool/refresh' as never)).toBe(false);
    expect(ALLOWED_PANEL_ACTIONS.has('subscription-pool/check-usage' as never)).toBe(false);
  });
});

describe('pool calls of a team', () => {
  beforeEach(() => metaPost.mockClear());

  it('sends the active team with every pool call', async () => {
    const team = 'team-a';
    await subscriptionPoolApi.status(team);
    await subscriptionPoolApi.status(team, 'claude');
    await subscriptionPoolApi.enable(team, 'codex');
    await subscriptionPoolApi.disable(team, 'codex');
    await subscriptionPoolApi.updateClients(team, 'claude', ['claude-code']);
    await subscriptionPoolApi.oauthStart(team, 'claude');
    await subscriptionPoolApi.oauthComplete(team, { provider: 'claude', state: 's', code: 'c', threshold_pct: 90 });
    await subscriptionPoolApi.checkAll(team);
    expect(metaPost.mock.calls).toHaveLength(8);
    for (const [action, body] of metaPost.mock.calls) {
      expect(body.team_id, action).toBe(team);
    }
    expect(metaPost).toHaveBeenCalledWith('subscription-pool/clients/update', {
      team_id: team,
      provider: 'claude',
      agents: ['claude-code'],
    });
    expect(metaPost).toHaveBeenCalledWith('subscription-pool/status', { team_id: team, provider: 'claude' });
  });

  it('names no team on account calls and on the start threshold', async () => {
    await subscriptionPoolApi.updateAccount({ account_id: 'a1', threshold_pct: 80, expected_version: 2 });
    await subscriptionPoolApi.deleteAccount('a1');
    await subscriptionPoolApi.checkUsage('a1');
    await subscriptionPoolApi.updateThreshold(90);
    for (const [action, body] of metaPost.mock.calls) {
      expect('team_id' in body, action).toBe(false);
    }
    expect(metaPost).toHaveBeenCalledWith('subscription-pool/account/update', {
      account_id: 'a1',
      threshold_pct: 80,
      expected_version: 2,
    });
    expect(metaPost).toHaveBeenCalledWith('subscription-pool/settings/update', { threshold_pct: 90 });
  });

  it('allows the new clients action', () => {
    expect(ALLOWED_PANEL_ACTIONS.has('subscription-pool/clients/update' as never)).toBe(true);
  });
});
