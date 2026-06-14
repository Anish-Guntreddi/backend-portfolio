import { describe, expect, it } from 'vitest';
import { bucket, pickVariation } from '../src/bucket.ts';
import type { Weight } from '../src/schemas.ts';

describe('bucket', () => {
  it('is deterministic: identical (seed, key) yields identical bucket', () => {
    for (const key of ['alice', 'bob', 'user-123', '']) {
      expect(bucket('flag.salt', key)).toBe(bucket('flag.salt', key));
    }
  });

  it('always returns a value in [0, 1)', () => {
    for (let i = 0; i < 5000; i++) {
      const b = bucket('seed', `user-${i}`);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(1);
    }
  });

  it('different seeds shuffle the same key to different buckets', () => {
    // A salt rotation should move users around: most keys land in a different decile.
    let moved = 0;
    const n = 1000;
    for (let i = 0; i < n; i++) {
      const a = Math.floor(bucket('flag.saltA', `user-${i}`) * 10);
      const b = Math.floor(bucket('flag.saltB', `user-${i}`) * 10);
      if (a !== b) moved++;
    }
    expect(moved).toBeGreaterThan(n * 0.8);
  });

  it('distributes uniformly across deciles (chi-square within tolerance)', () => {
    const n = 100_000;
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < n; i++) {
      buckets[Math.floor(bucket('uniformity', `key-${i}`) * 10)]++;
    }
    const expected = n / 10;
    // Pearson chi-square statistic. 9 dof, p=0.001 critical value ≈ 27.88; we use a generous 30.
    const chiSquare = buckets.reduce((sum, observed) => sum + (observed - expected) ** 2 / expected, 0);
    expect(chiSquare).toBeLessThan(30);
  });
});

describe('pickVariation', () => {
  const onOff: Weight[] = [
    { variation: 'on', weight: 0 },
    { variation: 'off', weight: 0 },
  ];

  it('places buckets into bands proportional to weight', () => {
    const weights: Weight[] = [
      { variation: 'on', weight: 30 },
      { variation: 'off', weight: 70 },
    ];
    expect(pickVariation(weights, 0.0)).toBe('on');
    expect(pickVariation(weights, 0.29)).toBe('on');
    expect(pickVariation(weights, 0.3)).toBe('off');
    expect(pickVariation(weights, 0.99)).toBe('off');
  });

  it('absolute weight scale is irrelevant — only proportions matter', () => {
    const small: Weight[] = [
      { variation: 'a', weight: 1 },
      { variation: 'b', weight: 1 },
    ];
    const large: Weight[] = [
      { variation: 'a', weight: 5000 },
      { variation: 'b', weight: 5000 },
    ];
    for (const v of [0.1, 0.49, 0.5, 0.9]) {
      expect(pickVariation(small, v)).toBe(pickVariation(large, v));
    }
  });

  it('ROLLOUT IS MONOTONIC: widening the on-band never evicts an already-included user', () => {
    // The portfolio-defining property. As we ramp `on` from 10% -> 100%, a user that is `on` at any
    // percentage stays `on` for every higher percentage. No reshuffle, only additions.
    const keys = Array.from({ length: 2000 }, (_, i) => `user-${i}`);
    let everIncluded = new Set<string>();
    for (let pct = 10; pct <= 100; pct += 10) {
      const weights: Weight[] = [
        { variation: 'on', weight: pct },
        { variation: 'off', weight: 100 - pct },
      ];
      const nowOn = new Set(
        keys.filter((k) => pickVariation(weights, bucket('rollout.salt', k)) === 'on'),
      );
      // Everyone previously `on` must still be `on`.
      for (const k of everIncluded) expect(nowOn.has(k)).toBe(true);
      everIncluded = nowOn;
    }
    // And at 100% everyone is on.
    expect(everIncluded.size).toBe(keys.length);
  });

  it('falls back to the first variation when all weights are zero', () => {
    expect(pickVariation(onOff, 0.5)).toBe('on');
  });
});
