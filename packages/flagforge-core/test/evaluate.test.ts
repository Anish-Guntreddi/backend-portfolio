import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/evaluate.ts';
import { evalContextSchema, flagDefinitionSchema, referentialErrors } from '../src/schemas.ts';
import type { FlagDefinition } from '../src/schemas.ts';

/** Parse through the schema so tests exercise the same defaults (targets:[], rules:[], negate:false). */
function flag(partial: Record<string, unknown>): FlagDefinition {
  return flagDefinitionSchema.parse(partial);
}
function ctx(key: string, attributes: Record<string, unknown> = {}) {
  return evalContextSchema.parse({ key, attributes });
}

const boolFlag = (overrides: Record<string, unknown> = {}): FlagDefinition =>
  flag({
    key: 'feature',
    type: 'boolean',
    enabled: true,
    variations: [
      { key: 'on', value: true },
      { key: 'off', value: false },
    ],
    offVariation: 'off',
    fallthrough: { kind: 'fixed', variation: 'on' },
    salt: 'salt-1',
    ...overrides,
  });

describe('evaluate — waterfall order', () => {
  it('disabled flag serves the off variation with reason OFF', () => {
    const result = evaluate(boolFlag({ enabled: false }), ctx('alice'));
    expect(result).toEqual({ value: false, variation: 'off', reason: { kind: 'OFF' } });
  });

  it('explicit target beats rules and fallthrough', () => {
    const f = boolFlag({
      targets: [{ variation: 'off', values: ['alice'] }],
      rules: [{ id: 'r1', clauses: [], serve: { kind: 'fixed', variation: 'on' } }],
    });
    expect(evaluate(f, ctx('alice')).reason).toEqual({ kind: 'TARGET_MATCH' });
    expect(evaluate(f, ctx('alice')).value).toBe(false);
    // A non-targeted user falls into the catch-all rule.
    expect(evaluate(f, ctx('bob')).reason).toMatchObject({ kind: 'RULE_MATCH', ruleId: 'r1' });
  });

  it('first matching rule wins; order is respected', () => {
    const f = boolFlag({
      fallthrough: { kind: 'fixed', variation: 'off' },
      rules: [
        { id: 'beta', clauses: [{ attribute: 'group', op: 'in', values: ['beta'] }], serve: { kind: 'fixed', variation: 'on' } },
        { id: 'all', clauses: [], serve: { kind: 'fixed', variation: 'off' } },
      ],
    });
    expect(evaluate(f, ctx('u', { group: 'beta' })).reason).toMatchObject({ kind: 'RULE_MATCH', ruleId: 'beta', ruleIndex: 0 });
    expect(evaluate(f, ctx('u', { group: 'ga' })).reason).toMatchObject({ kind: 'RULE_MATCH', ruleId: 'all', ruleIndex: 1 });
  });

  it('no target or rule match serves fallthrough', () => {
    const f = boolFlag({ fallthrough: { kind: 'fixed', variation: 'off' } });
    expect(evaluate(f, ctx('nobody')).reason).toEqual({ kind: 'FALLTHROUGH', inRollout: false });
    expect(evaluate(f, ctx('nobody')).value).toBe(false);
  });
});

describe('evaluate — operators', () => {
  const ruleFlag = (op: string, values: unknown[]) =>
    boolFlag({
      fallthrough: { kind: 'fixed', variation: 'off' },
      rules: [{ id: 'r', clauses: [{ attribute: 'attr', op, values }], serve: { kind: 'fixed', variation: 'on' } }],
    });
  const matches = (op: string, values: unknown[], attr: unknown) =>
    evaluate(ruleFlag(op, values), ctx('u', attr === undefined ? {} : { attr })).value === true;

  it('in: exact membership (strings, numbers, booleans)', () => {
    expect(matches('in', ['a', 'b'], 'b')).toBe(true);
    expect(matches('in', ['a', 'b'], 'c')).toBe(false);
    expect(matches('in', [1, 2, 3], 2)).toBe(true);
    expect(matches('in', [true], true)).toBe(true);
  });

  it('contains / startsWith / endsWith on strings', () => {
    expect(matches('contains', ['example.com'], 'a@example.com')).toBe(true);
    expect(matches('startsWith', ['v2'], 'v2.1.0')).toBe(true);
    expect(matches('endsWith', ['.edu'], 'mit.edu')).toBe(true);
    expect(matches('endsWith', ['.edu'], 'mit.com')).toBe(false);
  });

  it('relational operators compare numbers numerically', () => {
    expect(matches('greaterThan', [10], 11)).toBe(true);
    expect(matches('greaterThan', [10], 10)).toBe(false);
    expect(matches('greaterThanOrEqual', [10], 10)).toBe(true);
    expect(matches('lessThan', [10], 9)).toBe(true);
    expect(matches('lessThanOrEqual', [10], 10)).toBe(true);
    // Numeric, not lexical: 9 < 100 (a string compare would say "9" > "100").
    expect(matches('lessThan', [100], 9)).toBe(true);
  });

  it('relational operators on SAME-typed strings compare lexically', () => {
    expect(matches('greaterThan', ['v1'], 'v2')).toBe(true);
    expect(matches('lessThan', ['2.0.0'], '1.9.9')).toBe(true);
  });

  it('relational operators on MIXED types are a non-match (no "10" < 2 footgun)', () => {
    // Attribute is the string "10", threshold is the number 2. A naive string fallback would make
    // "10" < "2" true; we instead refuse to compare across types and report no match.
    expect(matches('lessThan', [2], '10')).toBe(false);
    expect(matches('greaterThan', [2], '10')).toBe(false);
    expect(matches('greaterThanOrEqual', ['5'], 5)).toBe(false);
  });

  it('an array-valued attribute matches if ANY element matches', () => {
    expect(matches('in', ['admin'], ['user', 'admin'])).toBe(true);
    expect(matches('in', ['admin'], ['user', 'guest'])).toBe(false);
  });

  it('negate inverts the clause', () => {
    const f = boolFlag({
      fallthrough: { kind: 'fixed', variation: 'off' },
      rules: [{ id: 'r', clauses: [{ attribute: 'country', op: 'in', values: ['US'], negate: true }], serve: { kind: 'fixed', variation: 'on' } }],
    });
    expect(evaluate(f, ctx('u', { country: 'CA' })).value).toBe(true); // not US -> match
    expect(evaluate(f, ctx('u', { country: 'US' })).value).toBe(false); // US -> no match -> fallthrough
  });

  it('a missing attribute is a non-match; negate makes "not-in" true for missing', () => {
    expect(matches('in', ['x'], undefined)).toBe(false);
    const f = boolFlag({
      fallthrough: { kind: 'fixed', variation: 'off' },
      rules: [{ id: 'r', clauses: [{ attribute: 'plan', op: 'in', values: ['pro'], negate: true }], serve: { kind: 'fixed', variation: 'on' } }],
    });
    expect(evaluate(f, ctx('u')).value).toBe(true); // no plan attribute -> "not pro" -> match
  });

  it('the "key" pseudo-attribute reads the context key', () => {
    const f = boolFlag({
      fallthrough: { kind: 'fixed', variation: 'off' },
      rules: [{ id: 'r', clauses: [{ attribute: 'key', op: 'in', values: ['vip-1'] }], serve: { kind: 'fixed', variation: 'on' } }],
    });
    expect(evaluate(f, ctx('vip-1')).value).toBe(true);
    expect(evaluate(f, ctx('vip-2')).value).toBe(false);
  });

  it('multiple clauses in a rule are AND-ed', () => {
    const f = boolFlag({
      fallthrough: { kind: 'fixed', variation: 'off' },
      rules: [
        {
          id: 'r',
          clauses: [
            { attribute: 'country', op: 'in', values: ['US'] },
            { attribute: 'age', op: 'greaterThanOrEqual', values: [21] },
          ],
          serve: { kind: 'fixed', variation: 'on' },
        },
      ],
    });
    expect(evaluate(f, ctx('u', { country: 'US', age: 25 })).value).toBe(true);
    expect(evaluate(f, ctx('u', { country: 'US', age: 18 })).value).toBe(false);
    expect(evaluate(f, ctx('u', { country: 'CA', age: 25 })).value).toBe(false);
  });
});

describe('evaluate — rollout serving', () => {
  it('fallthrough rollout splits deterministically and reports inRollout', () => {
    const f = boolFlag({
      fallthrough: { kind: 'rollout', weights: [{ variation: 'on', weight: 50 }, { variation: 'off', weight: 50 }] },
    });
    const r = evaluate(f, ctx('alice'));
    expect(r.reason).toEqual({ kind: 'FALLTHROUGH', inRollout: true });
    expect(evaluate(f, ctx('alice')).value).toBe(r.value); // stable
  });

  it('roughly honors a 20/80 split over many keys', () => {
    const f = boolFlag({
      fallthrough: { kind: 'rollout', weights: [{ variation: 'on', weight: 20 }, { variation: 'off', weight: 80 }] },
    });
    let on = 0;
    const n = 10_000;
    for (let i = 0; i < n; i++) if (evaluate(f, ctx(`user-${i}`)).value === true) on++;
    expect(on / n).toBeGreaterThan(0.17);
    expect(on / n).toBeLessThan(0.23);
  });

  it('bucketBy buckets on a custom attribute (e.g. account, not user)', () => {
    const f = boolFlag({
      fallthrough: { kind: 'rollout', bucketBy: 'account', weights: [{ variation: 'on', weight: 50 }, { variation: 'off', weight: 50 }] },
    });
    // Two different users in the same account bucket identically.
    const a = evaluate(f, ctx('user-1', { account: 'acme' }));
    const b = evaluate(f, ctx('user-2', { account: 'acme' }));
    expect(a.value).toBe(b.value);
  });
});

describe('evaluate — error handling (engine stays total)', () => {
  it('an unknown fallthrough variation resolves to ERROR + off value, never throws', () => {
    // Bypass referential validation to simulate corrupt stored data.
    const corrupt = { ...boolFlag(), fallthrough: { kind: 'fixed' as const, variation: 'ghost' } };
    const r = evaluate(corrupt, ctx('u'));
    expect(r.reason.kind).toBe('ERROR');
    expect(r.value).toBe(false); // fell back to off variation's value
  });

  it('a malformed flag with non-array variations still does not throw (catch path is total)', () => {
    // Simulate corrupt cache/data: variations isn't even an array. The catch path must not re-throw.
    const malformed = { ...boolFlag(), variations: null } as unknown as FlagDefinition;
    const r = evaluate(malformed, ctx('u'));
    expect(r.reason.kind).toBe('ERROR');
    expect(r.value).toBe(null);
    expect(r.variation).toBe(null);
  });
});

describe('referentialErrors', () => {
  it('passes a well-formed flag', () => {
    expect(referentialErrors(boolFlag())).toEqual([]);
  });

  it('flags an offVariation that does not exist', () => {
    const bad = { ...boolFlag(), offVariation: 'nope' };
    expect(referentialErrors(bad)).toContain('offVariation references unknown variation "nope"');
  });

  it('flags rollout weights that sum to zero', () => {
    const bad = boolFlag({
      fallthrough: { kind: 'rollout', weights: [{ variation: 'on', weight: 0 }, { variation: 'off', weight: 0 }] },
    });
    expect(referentialErrors(bad).some((e) => e.includes('sum to a positive number'))).toBe(true);
  });

  it('flags a rule serving an unknown variation', () => {
    const bad = boolFlag({
      rules: [{ id: 'r', clauses: [], serve: { kind: 'fixed', variation: 'ghost' } }],
    });
    expect(referentialErrors(bad).some((e) => e.includes('unknown variation "ghost"'))).toBe(true);
  });

  it('flags duplicate variation keys', () => {
    const bad = {
      ...boolFlag(),
      variations: [
        { key: 'on', value: true },
        { key: 'on', value: false },
      ],
    };
    expect(referentialErrors(bad)).toContain('variations contain duplicate keys');
  });
});
