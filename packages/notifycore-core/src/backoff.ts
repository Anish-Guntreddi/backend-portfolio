/**
 * Exponential backoff for delivery retries. Pure and deterministic (no jitter baked in, so it stays
 * unit-testable); a worker can layer jitter on top if it needs to spread a thundering herd.
 *
 *   attempt 1 -> base
 *   attempt 2 -> base * 2
 *   attempt 3 -> base * 4
 *   ... capped at `max`.
 */
export function backoffDelayMs(attempt: number, baseMs = 1000, maxMs = 60_000): number {
  if (attempt < 1) return 0;
  // 2^(attempt-1) grows fast; cap the exponent so the shift can't overflow before the min() clamps it.
  const exponent = Math.min(attempt - 1, 30);
  const raw = baseMs * 2 ** exponent;
  return Math.min(raw, maxMs);
}
