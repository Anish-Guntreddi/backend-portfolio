import { describe, expect, it } from 'vitest';
import { backoffDelayMs } from '../src/backoff.ts';

describe('backoffDelayMs', () => {
  it('doubles each attempt from the base', () => {
    expect(backoffDelayMs(1, 1000, 60_000)).toBe(1000);
    expect(backoffDelayMs(2, 1000, 60_000)).toBe(2000);
    expect(backoffDelayMs(3, 1000, 60_000)).toBe(4000);
    expect(backoffDelayMs(4, 1000, 60_000)).toBe(8000);
  });
  it('caps at max', () => {
    expect(backoffDelayMs(20, 1000, 60_000)).toBe(60_000);
  });
  it('never overflows for large attempts', () => {
    expect(backoffDelayMs(1000, 1000, 60_000)).toBe(60_000);
  });
  it('returns 0 for non-positive attempts', () => {
    expect(backoffDelayMs(0)).toBe(0);
  });
});
