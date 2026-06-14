import { describe, expect, it } from 'vitest';
import { selectBreaches } from '../../src/domain/alertRules.ts';
import type { AlertRuleRow } from '../../src/db/schema.ts';

function rule(overrides: Partial<AlertRuleRow> = {}): AlertRuleRow {
  return {
    id: 1,
    name: 'brute-force',
    enabled: true,
    matchAction: 'login.failed',
    groupByActor: true,
    threshold: 5,
    windowSeconds: 300,
    createdAt: new Date('2020-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('selectBreaches', () => {
  it('flags groups at or above threshold (>= semantics)', () => {
    const out = selectBreaches(rule(), [
      { actor: 'a', count: 5 },
      { actor: 'b', count: 4 },
      { actor: 'c', count: 9 },
    ]);
    expect(out).toEqual([
      { actor: 'a', matchedCount: 5 },
      { actor: 'c', matchedCount: 9 },
    ]);
  });

  it('returns nothing when all groups are below threshold', () => {
    expect(selectBreaches(rule(), [{ actor: 'a', count: 4 }])).toEqual([]);
  });

  it('reports a single null-actor group for across-all-actors rules', () => {
    const out = selectBreaches(rule({ groupByActor: false }), [{ actor: null, count: 7 }]);
    expect(out).toEqual([{ actor: null, matchedCount: 7 }]);
  });

  it('forces actor to null when groupByActor is false even if a count carries an actor', () => {
    const out = selectBreaches(rule({ groupByActor: false }), [{ actor: 'a', count: 10 }]);
    expect(out).toEqual([{ actor: null, matchedCount: 10 }]);
  });
});
