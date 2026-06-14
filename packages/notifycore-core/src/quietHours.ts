/**
 * Quiet-hours deferral: hold a notification until a recipient's "do not disturb" window ends.
 *
 * Design choice — compute a DELTA of minutes from `now`, never an absolute local→UTC conversion. The
 * window is expressed in the recipient's local wall clock; we read the current local time-of-day via
 * `Intl` (full ICU is in Node), then add "minutes until the window ends" to the current instant. This
 * sidesteps the DST-correctness minefield of materializing a future local time back to UTC. (The only
 * residual inaccuracy is a quiet window that straddles a DST transition — at most ~1h, and rare.)
 */

export interface QuietHours {
  /** Local start of the do-not-disturb window, "HH:MM" (24h). */
  start: string;
  /** Local end of the window, "HH:MM" (24h). Equal to `start` means "no quiet window". */
  end: string;
  /** IANA timezone, e.g. "America/New_York". */
  timeZone: string;
}

/** Parse "HH:MM" to minutes-since-midnight, or null if malformed / out of range. */
export function parseHHMM(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** The recipient's local time-of-day (minutes since their local midnight) for an instant. */
export function localTimeMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24; // '24:00' -> 0
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/**
 * Minutes to defer given the local time-of-day and a window [start, end). Returns 0 when not in the
 * window (send now). The window is half-open: a time exactly at `start` is quiet, exactly at `end` is
 * not. Handles windows that wrap midnight (start > end, e.g. 22:00–07:00). Pure arithmetic — the
 * exhaustively-testable heart of the scheduler, with no clock or timezone dependency.
 */
export function quietDeferralMinutes(localNow: number, start: number, end: number): number {
  if (start === end) return 0; // zero-length window == no quiet hours
  const MINUTES_PER_DAY = 1440;

  if (start < end) {
    // Same-day window, e.g. 01:00–06:00.
    const inWindow = localNow >= start && localNow < end;
    return inWindow ? end - localNow : 0;
  }

  // Window wraps midnight, e.g. 22:00–07:00: quiet if at/after start OR before end.
  if (localNow >= start) return MINUTES_PER_DAY - localNow + end; // end is tomorrow
  if (localNow < end) return end - localNow; // end is later today
  return 0;
}

/**
 * The instant a notification should be delivered given `now` and a recipient's quiet hours. Returns
 * `now` when there is no active quiet window; otherwise the instant the window ends. Total — malformed
 * times or an unknown timezone fall back to `now` (send rather than silently stall).
 */
export function nextSendTime(now: Date, quiet: QuietHours | null | undefined): Date {
  if (!quiet) return now;
  const start = parseHHMM(quiet.start);
  const end = parseHHMM(quiet.end);
  if (start === null || end === null) return now;

  let localNow: number;
  try {
    localNow = localTimeMinutes(now, quiet.timeZone);
  } catch {
    return now; // invalid timezone -> don't stall the notification
  }

  const deferMinutes = quietDeferralMinutes(localNow, start, end);
  return deferMinutes > 0 ? new Date(now.getTime() + deferMinutes * 60_000) : now;
}
