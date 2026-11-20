/** VTC SSO servers run in Vietnam; a time without a zone is read as UTC+7. The live SSO test confirms this. */
export const SSO_LOCAL_UTC_OFFSET_MINUTES = 420;

const ISO_FORM =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const SLASH_FORM = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?$/i;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Null for an impossible calendar value, so garbage never turns into a nearby valid instant. */
function toInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millis: number,
  offsetMinutes: number,
): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * 60_000);
}

function parseOffset(zone: string | undefined): number | null {
  if (zone === undefined) return SSO_LOCAL_UTC_OFFSET_MINUTES;
  if (zone.toUpperCase() === 'Z') return 0;
  const match = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? '0');
  if (hours > 14 || minutes > 59) return null;
  return (match[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
}

function parseIso(raw: string): Date[] {
  const match = ISO_FORM.exec(raw);
  if (!match) return [];
  const offset = parseOffset(match[8]);
  if (offset === null) return [];
  const millis = Number((match[7] ?? '').slice(0, 3).padEnd(3, '0'));
  const instant = toInstant(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? '0'),
    millis,
    offset,
  );
  return instant ? [instant] : [];
}

function parseSlash(raw: string): Date[] {
  const match = SLASH_FORM.exec(raw);
  if (!match) return [];
  const first = Number(match[1]);
  const second = Number(match[2]);
  const year = Number(match[3]);
  let hour = Number(match[4]);
  const meridiem = match[7]?.toUpperCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return [];
    hour = (hour % 12) + (meridiem === 'PM' ? 12 : 0);
  }
  const at = (month: number, day: number) =>
    toInstant(year, month, day, hour, Number(match[5]), Number(match[6] ?? '0'), 0, SSO_LOCAL_UTC_OFFSET_MINUTES);

  // A time with AM/PM is the .NET en-US form: month first. Without it the order is read from the values.
  const readings: Array<[number, number]> = meridiem
    ? [[first, second]]
    : first > 12
      ? [[second, first]]
      : second > 12
        ? [[first, second]]
        : first === second
          ? [[first, second]]
          : [
              [first, second],
              [second, first],
            ];
  return readings.map(([month, day]) => at(month, day)).filter((instant): instant is Date => instant !== null);
}

function parseEpoch(raw: string): Date[] {
  if (/^\d{10}$/.test(raw)) return [new Date(Number(raw) * 1000)];
  if (/^\d{13}$/.test(raw)) return [new Date(Number(raw))];
  return [];
}

/** All plausible instants for the raw value; empty when the value matches no known form. */
export function parseSsoLoginTimeCandidates(raw: string): Date[] {
  const text = raw.trim();
  if (!text) return [];
  return [...parseIso(text), ...parseSlash(text), ...parseEpoch(text)];
}

/** The latest reading of an ambiguous value: the ticket stays usable until that one ages out. */
export function latestInstant(candidates: Date[]): Date | null {
  return candidates.reduce<Date | null>((best, t) => (best === null || t.getTime() > best.getTime() ? t : best), null);
}

/** Shape for logs: digits become 'd', letters 'a', other characters are kept. Never the value. */
export function describeShape(raw: string): string {
  return raw.replace(/[0-9A-Za-z]/g, (ch) => (ch >= '0' && ch <= '9' ? 'd' : 'a'));
}
