import { describe, expect, it } from 'vitest';
import {
  localTimeMinutes,
  nextSendTime,
  parseHHMM,
  quietDeferralMinutes,
} from '../src/quietHours.ts';

describe('parseHHMM', () => {
  it('parses valid times to minutes', () => {
    expect(parseHHMM('00:00')).toBe(0);
    expect(parseHHMM('07:30')).toBe(450);
    expect(parseHHMM('23:59')).toBe(1439);
    expect(parseHHMM('9:05')).toBe(545);
  });
  it('rejects malformed or out-of-range times', () => {
    expect(parseHHMM('24:00')).toBe(null);
    expect(parseHHMM('12:60')).toBe(null);
    expect(parseHHMM('noon')).toBe(null);
    expect(parseHHMM('')).toBe(null);
  });
});

describe('quietDeferralMinutes — same-day window (01:00–06:00)', () => {
  const start = 60;
  const end = 360;
  it('before the window: send now', () => expect(quietDeferralMinutes(30, start, end)).toBe(0));
  it('exactly at start: quiet, defer to end', () => expect(quietDeferralMinutes(60, start, end)).toBe(300));
  it('inside the window: defer the remainder', () => expect(quietDeferralMinutes(120, start, end)).toBe(240));
  it('exactly at end (exclusive): send now', () => expect(quietDeferralMinutes(360, start, end)).toBe(0));
  it('after the window: send now', () => expect(quietDeferralMinutes(800, start, end)).toBe(0));
});

describe('quietDeferralMinutes — window wrapping midnight (22:00–07:00)', () => {
  const start = 1320; // 22:00
  const end = 420; // 07:00
  it('just before start: send now', () => expect(quietDeferralMinutes(1319, start, end)).toBe(0));
  it('at start: defer across midnight to 07:00 next day', () =>
    expect(quietDeferralMinutes(1320, start, end)).toBe(1440 - 1320 + 420)); // 540
  it('late evening inside window: defer across midnight', () =>
    expect(quietDeferralMinutes(1380, start, end)).toBe(1440 - 1380 + 420)); // 480
  it('after midnight, still in window: defer remainder of morning', () =>
    expect(quietDeferralMinutes(60, start, end)).toBe(360)); // 01:00 -> 07:00
  it('at end (exclusive): send now', () => expect(quietDeferralMinutes(420, start, end)).toBe(0));
  it('daytime, outside window: send now', () => expect(quietDeferralMinutes(720, start, end)).toBe(0));
});

describe('quietDeferralMinutes — degenerate', () => {
  it('zero-length window (start==end) is never quiet', () => {
    expect(quietDeferralMinutes(500, 600, 600)).toBe(0);
  });
});

describe('localTimeMinutes', () => {
  it('reads the wall-clock minute-of-day in a timezone', () => {
    // 2025-01-01T12:00:00Z is 07:00 in New York (UTC-5, winter).
    const at = new Date('2025-01-01T12:00:00Z');
    expect(localTimeMinutes(at, 'America/New_York')).toBe(7 * 60);
    expect(localTimeMinutes(at, 'UTC')).toBe(12 * 60);
  });
});

describe('nextSendTime', () => {
  it('returns now when there are no quiet hours', () => {
    const now = new Date('2025-06-01T15:00:00Z');
    expect(nextSendTime(now, null).getTime()).toBe(now.getTime());
  });

  it('returns now when outside the quiet window', () => {
    // 15:00Z == 10:00 in New York; window 22:00–07:00 -> not quiet.
    const now = new Date('2025-06-01T15:00:00Z');
    const quiet = { start: '22:00', end: '07:00', timeZone: 'America/New_York' };
    expect(nextSendTime(now, quiet).getTime()).toBe(now.getTime());
  });

  it('defers to the end of a midnight-crossing window', () => {
    // 04:00Z == 00:00 (midnight) in New York (EDT, summer, UTC-4). Window 22:00–07:00 -> defer 7h to 07:00 local.
    const now = new Date('2025-06-01T04:00:00Z');
    const quiet = { start: '22:00', end: '07:00', timeZone: 'America/New_York' };
    const next = nextSendTime(now, quiet);
    expect(next.getTime()).toBe(now.getTime() + 7 * 60 * 60_000);
  });

  it('falls back to now on an invalid timezone (never stalls)', () => {
    const now = new Date('2025-06-01T04:00:00Z');
    const quiet = { start: '22:00', end: '07:00', timeZone: 'Not/AZone' };
    expect(nextSendTime(now, quiet).getTime()).toBe(now.getTime());
  });
});
