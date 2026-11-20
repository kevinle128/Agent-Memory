import { describe, expect, it } from 'vitest';
import { DeviceFlow, normalizeUserCode, type DeviceRequest } from '../../../src/extensions/vtc/device/device-flow.js';

const REQUEST: DeviceRequest = { installId: 'install-0001', deviceName: 'Paseo on Mac', hasKey: false };
const OUTCOME = { kind: 'approved', coreUserId: 'usr-1', subject: '10482', email: 'a.b@vtc.vn' } as const;

function setup(opts: { max?: number } = {}) {
  const clock = { now: 1_000_000 };
  const flow = new DeviceFlow({ ttlMs: 600_000, intervalSec: 5, now: () => clock.now, ...opts });
  return { clock, flow };
}

describe('device flow', () => {
  it('issues a device code and a readable user code', () => {
    const { flow } = setup();
    const started = flow.start(REQUEST)!;
    expect(started.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(started.deviceCode.length).toBeGreaterThanOrEqual(43);
    expect(started.interval).toBe(5);
    expect(started.expiresIn).toBe(600);
    // The device code is kept only as a hash: no key and no field of the stored state equals it.
    const state = flow as unknown as { byHash: Map<string, unknown> };
    expect([...state.byHash.keys()]).not.toContain(started.deviceCode);
    expect(JSON.stringify([...state.byHash.entries()])).not.toContain(started.deviceCode);
  });

  it('gives each live code its own user code and refuses when full', () => {
    const { flow } = setup({ max: 3 });
    const codes = new Set([flow.start(REQUEST)!.userCode, flow.start(REQUEST)!.userCode, flow.start(REQUEST)!.userCode]);
    expect(codes.size).toBe(3);
    expect(flow.start(REQUEST)).toBeNull();
  });

  it('asks the client to slow down when it polls too fast', () => {
    const { clock, flow } = setup();
    const { deviceCode } = flow.start(REQUEST)!;
    clock.now += 1000;
    expect(flow.poll(deviceCode)).toEqual({ status: 'slow_down' });
    clock.now += 4000;
    expect(flow.poll(deviceCode)).toEqual({ status: 'authorization_pending' });
    // A poll that was served moves the mark; the next one inside the interval is refused again.
    clock.now += 2000;
    expect(flow.poll(deviceCode)).toEqual({ status: 'slow_down' });
  });

  it('expires codes', () => {
    const { clock, flow } = setup();
    const { deviceCode, userCode } = flow.start(REQUEST)!;
    clock.now += 600_000;
    expect(flow.findByUserCode(userCode)).toBeNull();
    expect(flow.poll(deviceCode)).toEqual({ status: 'expired_token' });
  });

  it('returns the outcome exactly once', () => {
    const { clock, flow } = setup();
    const { deviceCode, userCode } = flow.start(REQUEST)!;
    expect(flow.findByUserCode(userCode)?.request).toEqual(REQUEST);
    expect(flow.decide(userCode, OUTCOME)).toBe(true);
    expect(flow.findByUserCode(userCode)).toBeNull();
    clock.now += 5000;
    const done = flow.poll(deviceCode);
    expect(done).toEqual({ status: 'done', ticket: expect.any(String), request: REQUEST, outcome: OUTCOME });
    if (done.status === 'done') flow.complete(done.ticket);
    clock.now += 5000;
    expect(flow.poll(deviceCode)).toEqual({ status: 'expired_token' });
  });

  it('locks the outcome while an answer is built and gives it back on release', () => {
    const { clock, flow } = setup();
    const { deviceCode, userCode } = flow.start(REQUEST)!;
    flow.decide(userCode, OUTCOME);
    clock.now += 5000;
    const first = flow.poll(deviceCode);
    expect(first.status).toBe('done');
    // A second poll while the first holds the outcome must not get it too.
    clock.now += 5000;
    expect(flow.poll(deviceCode)).toEqual({ status: 'authorization_pending' });
    if (first.status !== 'done') return;
    flow.release(first.ticket);
    clock.now += 5000;
    expect(flow.poll(deviceCode)).toMatchObject({ status: 'done', outcome: OUTCOME });
  });

  it('issues a page confirmation once and only for the code it was issued for', () => {
    const { clock, flow } = setup();
    const a = flow.start(REQUEST)!;
    const b = flow.start(REQUEST)!;
    const token = flow.issueConfirm(a.userCode)!;
    expect(flow.takeConfirm(b.userCode, token)).toBe(false);
    expect(flow.takeConfirm(a.userCode, undefined)).toBe(false);
    expect(flow.takeConfirm(a.userCode, 'wrong')).toBe(false);
    // Wrong attempts do not use the token up.
    expect(flow.takeConfirm(a.userCode, token)).toBe(true);
    expect(flow.takeConfirm(a.userCode, token)).toBe(false);

    const late = flow.issueConfirm(a.userCode)!;
    clock.now += 5 * 60_000;
    expect(flow.takeConfirm(a.userCode, late)).toBe(false);
  });

  it('refuses a confirmation for a code that is decided or unknown', () => {
    const { flow } = setup();
    const { userCode } = flow.start(REQUEST)!;
    flow.decide(userCode, OUTCOME);
    expect(flow.issueConfirm(userCode)).toBeNull();
    expect(flow.issueConfirm('ZZZZ-ZZZZ')).toBeNull();
  });

  it('refuses a second decision', () => {
    const { flow } = setup();
    const { userCode } = flow.start(REQUEST)!;
    expect(flow.decide(userCode, OUTCOME)).toBe(true);
    expect(flow.decide(userCode, { kind: 'rejected' })).toBe(false);
    expect(flow.decide('ZZZZ-ZZZZ', OUTCOME)).toBe(false);
  });

  it('does not know a device code it never issued', () => {
    const { flow } = setup();
    expect(flow.poll('not-a-code')).toEqual({ status: 'expired_token' });
  });

  it('normalizes typed codes', () => {
    for (const typed of ['abcd efgh', 'ABCD-EFGH', 'abcdefgh', ' ab-cd ef-gh ']) {
      expect(normalizeUserCode(typed), typed).toBe('ABCD-EFGH');
    }
    for (const typed of ['ABCD-EFGI', 'ABCD-EFGO', 'ABCD-EFG0', 'ABCD-EFG1', 'ABCD-EFG', 'ABCD-EFGHJ', '', undefined]) {
      expect(normalizeUserCode(typed), String(typed)).toBeNull();
    }
  });
});
