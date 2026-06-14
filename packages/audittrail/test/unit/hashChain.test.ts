import { describe, expect, it } from 'vitest';
import { computeEventHash, GENESIS_HASH, type HashableEvent } from '../../src/domain/hashChain.ts';

const base: HashableEvent = {
  actor: 'alice',
  action: 'login.success',
  resource: 'auth',
  occurredAt: new Date('2020-01-01T00:00:00.000Z'),
  ip: '203.0.113.5',
  metadata: {},
};

describe('computeEventHash', () => {
  it('produces a 64-char hex sha256', () => {
    expect(computeEventHash(base, GENESIS_HASH)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for identical input', () => {
    expect(computeEventHash(base, GENESIS_HASH)).toBe(computeEventHash(base, GENESIS_HASH));
  });

  it('is independent of metadata key insertion order (canonical JSON)', () => {
    const a = computeEventHash({ ...base, metadata: { x: 1, y: { b: 2, a: 1 } } }, GENESIS_HASH);
    const b = computeEventHash({ ...base, metadata: { y: { a: 1, b: 2 }, x: 1 } }, GENESIS_HASH);
    expect(a).toBe(b);
  });

  it('treats a string occurredAt identically to the equivalent Date', () => {
    const a = computeEventHash({ ...base, occurredAt: new Date('2020-01-01T00:00:00.000Z') }, GENESIS_HASH);
    const b = computeEventHash({ ...base, occurredAt: '2020-01-01T00:00:00.000Z' }, GENESIS_HASH);
    expect(a).toBe(b);
  });

  it('changes when any covered field changes', () => {
    const h = computeEventHash(base, GENESIS_HASH);
    expect(computeEventHash({ ...base, actor: 'bob' }, GENESIS_HASH)).not.toBe(h);
    expect(computeEventHash({ ...base, action: 'login.failed' }, GENESIS_HASH)).not.toBe(h);
    expect(computeEventHash({ ...base, resource: 'other' }, GENESIS_HASH)).not.toBe(h);
    expect(computeEventHash({ ...base, ip: '198.51.100.1' }, GENESIS_HASH)).not.toBe(h);
    expect(computeEventHash({ ...base, metadata: { changed: true } }, GENESIS_HASH)).not.toBe(h);
  });

  it('changes when the predecessor hash changes (chain linkage)', () => {
    expect(computeEventHash(base, GENESIS_HASH)).not.toBe(computeEventHash(base, 'a'.repeat(64)));
  });

  it('forms a verifiable chain across multiple links', () => {
    const e1 = { ...base, actor: 'a' };
    const e2 = { ...base, actor: 'b' };
    const h1 = computeEventHash(e1, GENESIS_HASH);
    const h2 = computeEventHash(e2, h1);
    // Re-deriving from the same predecessors reproduces the chain exactly.
    expect(computeEventHash(e1, GENESIS_HASH)).toBe(h1);
    expect(computeEventHash(e2, h1)).toBe(h2);
    // A different predecessor for link 2 yields a different hash.
    expect(computeEventHash(e2, GENESIS_HASH)).not.toBe(h2);
  });
});
