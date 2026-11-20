import { describe, expect, it } from 'vitest';
import { describeShape, parseSsoLoginTimeCandidates } from '../../../src/extensions/vtc/sso/login-time.js';

const iso = (raw: string) => parseSsoLoginTimeCandidates(raw).map((date) => date.toISOString());

describe('SSO login time parsing', () => {
  it('reads ISO 8601 with a zone or an offset as the same instant', () => {
    expect(iso('2026-11-20T02:15:00Z')).toEqual(['2026-11-20T02:15:00.000Z']);
    expect(iso('2026-11-20T09:15:00+07:00')).toEqual(['2026-11-20T02:15:00.000Z']);
  });

  it('reads a time without a zone as UTC+7', () => {
    expect(iso('2026-11-20 09:15:00')).toEqual(['2026-11-20T02:15:00.000Z']);
    expect(iso('2026-11-20T09:15')).toEqual(['2026-11-20T02:15:00.000Z']);
    expect(iso('2026-11-20 09:15:00.250')).toEqual(['2026-11-20T02:15:00.250Z']);
  });

  it('reads the .NET en-US form with AM and PM', () => {
    expect(iso('11/20/2026 9:15:00 AM')).toEqual(['2026-11-20T02:15:00.000Z']);
    expect(iso('11/20/2026 12:05:00 AM')).toEqual(['2026-11-19T17:05:00.000Z']);
    expect(iso('11/20/2026 1:15:00 PM')).toEqual(['2026-11-20T06:15:00.000Z']);
  });

  it('reads the order of day and month from the values', () => {
    expect(iso('20/11/2026 09:15:00')).toEqual(['2026-11-20T02:15:00.000Z']);
    expect(iso('11/20/2026 09:15:00')).toEqual(['2026-11-20T02:15:00.000Z']);
    expect(iso('05/06/2026 09:15:00')).toEqual(['2026-05-06T02:15:00.000Z', '2026-06-05T02:15:00.000Z']);
    expect(iso('05/05/2026 09:15:00')).toHaveLength(1);
  });

  it('reads Unix seconds and milliseconds', () => {
    expect(iso('1795140900')).toEqual([new Date(1795140900 * 1000).toISOString()]);
    expect(iso('1795140900123')).toEqual([new Date(1795140900123).toISOString()]);
  });

  it('gives no candidate for impossible or unknown values', () => {
    const values = [
      '2026-13-01 00:00:00',
      '2026-02-30 00:00:00',
      '2026-11-20 24:00:00',
      'garbage',
      '',
      '   ',
      '13/13/2026 09:00:00',
    ];
    for (const raw of values) expect(parseSsoLoginTimeCandidates(raw)).toEqual([]);
  });

  it('describes the shape without the value', () => {
    expect(describeShape('2026-11-20 09:15:00')).toBe('dddd-dd-dd dd:dd:dd');
    expect(describeShape('11/20/2026 9:15 AM')).toBe('dd/dd/dddd d:dd aa');
  });
});
