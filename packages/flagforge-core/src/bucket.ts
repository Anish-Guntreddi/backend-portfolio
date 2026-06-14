import { createHash } from 'node:crypto';
import type { Weight } from './schemas.ts';

// We read the first 13 hex digits (52 bits) of a SHA-1 digest as an integer and scale to [0, 1).
// 52 bits is the most a JS double represents EXACTLY (2^52 - 1 < 2^53), so every distinct hash maps
// to a distinct, exactly-representable numerator — no low-bit aliasing from float rounding. 52 bits
// is far more resolution than percentage rollouts need. 2^52 is the exclusive upper bound + 1.
const BUCKET_SPACE = 2 ** 52;

/**
 * Map (seed, key) to a stable, uniform float in [0, 1).
 *
 * Two properties make this the right primitive for rollouts:
 *   1. Deterministic — identical (seed, key) always yields the identical bucket, so a user sees a
 *      stable variation across requests, processes, server and SDK.
 *   2. Weight-independent — the bucket depends ONLY on (seed, key), never on the rollout weights.
 *      This is what makes rollouts MONOTONIC: widening an on-variation's share from 10% to 20% can
 *      only add users to it, never evict someone who was already at 10%.
 *
 * The seed is the flag's `key.salt`; rotating the salt reshuffles all buckets for that flag.
 */
export function bucket(seed: string, key: string): number {
  const hex = createHash('sha1').update(`${seed}.${key}`).digest('hex').slice(0, 13);
  return parseInt(hex, 16) / BUCKET_SPACE;
}

/**
 * Select a variation from weighted bands using a precomputed bucket in [0, 1). Variations are laid
 * out along [0, 1) in array order, each occupying a band proportional to its share of the total
 * weight; the bucket selects the band it falls in. Array order is fixed, so growing the first band
 * never reshuffles users already inside it (the monotonicity guarantee above).
 *
 * A non-positive total (caller is expected to reject this via `referentialErrors`) falls back to the
 * first variation deterministically rather than throwing.
 */
export function pickVariation(weights: Weight[], bucketValue: number): string {
  const total = weights.reduce((sum, w) => sum + Math.max(0, w.weight), 0);
  if (total <= 0) return weights[0]?.variation ?? '';

  let cumulative = 0;
  for (const w of weights) {
    cumulative += Math.max(0, w.weight) / total;
    if (bucketValue < cumulative) return w.variation;
  }
  // Floating-point slack: a bucket of 0.999… can edge past the final boundary. Last band catches it.
  return weights[weights.length - 1]!.variation;
}
