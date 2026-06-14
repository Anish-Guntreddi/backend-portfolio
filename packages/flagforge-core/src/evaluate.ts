import { bucket, pickVariation } from './bucket.ts';
import type {
  Clause,
  EvalContext,
  FlagDefinition,
  JsonValue,
  Operator,
  ServeStrategy,
} from './schemas.ts';

/** Why a flag resolved to the value it did — the audit trail of a single evaluation. */
export type EvalReason =
  | { kind: 'OFF' }
  | { kind: 'TARGET_MATCH' }
  | { kind: 'RULE_MATCH'; ruleId: string; ruleIndex: number; inRollout: boolean }
  | { kind: 'FALLTHROUGH'; inRollout: boolean }
  | { kind: 'ERROR'; error: string };

export interface EvalResult {
  value: JsonValue;
  /** The variation key chosen, or null if evaluation errored before one could be selected. */
  variation: string | null;
  reason: EvalReason;
}

/**
 * Evaluate a flag against a context. Pure and total: it performs no I/O and never throws — a
 * malformed flag resolves to the off variation with an `ERROR` reason. This is the exact function
 * the service runs server-side AND the SDK runs client-side, guaranteeing identical decisions.
 *
 * Decision waterfall (first match wins), mirroring the established flag-system model:
 *   1. Flag disabled            -> off variation                (OFF)
 *   2. Explicit target list     -> targeted variation           (TARGET_MATCH)
 *   3. Targeting rules, in order-> first matching rule's serve   (RULE_MATCH)
 *   4. Otherwise                -> fallthrough serve            (FALLTHROUGH)
 */
export function evaluate(flag: FlagDefinition, context: EvalContext): EvalResult {
  try {
    if (!flag.enabled) return serve(flag, flag.offVariation, { kind: 'OFF' });

    for (const target of flag.targets) {
      if (target.values.includes(context.key)) {
        return serve(flag, target.variation, { kind: 'TARGET_MATCH' });
      }
    }

    for (let i = 0; i < flag.rules.length; i++) {
      const rule = flag.rules[i]!;
      if (matchRule(rule, context)) {
        return resolveServe(flag, rule.serve, context, (inRollout) => ({
          kind: 'RULE_MATCH',
          ruleId: rule.id,
          ruleIndex: i,
          inRollout,
        }));
      }
    }

    return resolveServe(flag, flag.fallthrough, context, (inRollout) => ({
      kind: 'FALLTHROUGH',
      inRollout,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort safe default: serve the off variation's value if it resolves, else null. This path
    // must itself be total — guard against a malformed flag whose `variations` isn't even an array.
    const variations = Array.isArray(flag.variations) ? flag.variations : [];
    const off = variations.find((v) => v.key === flag.offVariation);
    return { value: off ? off.value : null, variation: off ? off.key : null, reason: { kind: 'ERROR', error: message } };
  }
}

/** Resolve a serve strategy (fixed or weighted rollout) to a concrete variation. */
function resolveServe(
  flag: FlagDefinition,
  strategy: ServeStrategy,
  context: EvalContext,
  reasonFor: (inRollout: boolean) => EvalReason,
): EvalResult {
  if (strategy.kind === 'fixed') {
    return serve(flag, strategy.variation, reasonFor(false));
  }
  const bucketByValue = strategy.bucketBy
    ? stringifyAttr(readAttribute(context, strategy.bucketBy))
    : context.key;
  const bucketValue = bucket(`${flag.key}.${flag.salt}`, bucketByValue);
  const variation = pickVariation(strategy.weights, bucketValue);
  return serve(flag, variation, reasonFor(true));
}

/** Look up a variation's value by key, throwing (-> ERROR) if the flag references an unknown one. */
function serve(flag: FlagDefinition, variationKey: string, reason: EvalReason): EvalResult {
  const variation = flag.variations.find((v) => v.key === variationKey);
  if (!variation) throw new Error(`flag "${flag.key}" references unknown variation "${variationKey}"`);
  return { value: variation.value, variation: variation.key, reason };
}

/** A rule matches when ALL of its clauses match. An empty clause list is a catch-all (matches all). */
function matchRule(rule: { clauses: Clause[] }, context: EvalContext): boolean {
  return rule.clauses.every((clause) => matchClause(clause, context));
}

/**
 * A clause matches when any of the context attribute's value(s) satisfies the operator against any of
 * the clause's values. A missing attribute is treated as a non-match *before* `negate` is applied, so
 * `attribute not-in [...]` is true for a context that lacks the attribute entirely.
 */
function matchClause(clause: Clause, context: EvalContext): boolean {
  const actual = readAttribute(context, clause.attribute);
  const matched = actual === undefined ? false : clauseMatches(clause, actual);
  return clause.negate ? !matched : matched;
}

function clauseMatches(clause: Clause, actual: JsonValue): boolean {
  const candidates = Array.isArray(actual) ? actual : [actual];
  return candidates.some((c) => clause.values.some((v) => applyOperator(clause.op, c, v)));
}

/** The `"key"` pseudo-attribute reads the context key; everything else reads `attributes`. */
function readAttribute(context: EvalContext, attribute: string): JsonValue | undefined {
  if (attribute === 'key') return context.key;
  return context.attributes[attribute];
}

function applyOperator(op: Operator, actual: JsonValue, expected: JsonValue): boolean {
  switch (op) {
    case 'in':
      return deepEqual(actual, expected);
    case 'contains':
      return asString(actual).includes(asString(expected));
    case 'startsWith':
      return asString(actual).startsWith(asString(expected));
    case 'endsWith':
      return asString(actual).endsWith(asString(expected));
    case 'greaterThan': {
      const c = relCompare(actual, expected);
      return c !== null && c > 0;
    }
    case 'greaterThanOrEqual': {
      const c = relCompare(actual, expected);
      return c !== null && c >= 0;
    }
    case 'lessThan': {
      const c = relCompare(actual, expected);
      return c !== null && c < 0;
    }
    case 'lessThanOrEqual': {
      const c = relCompare(actual, expected);
      return c !== null && c <= 0;
    }
    default:
      return false;
  }
}

/**
 * Ordering comparison for the relational operators, defined ONLY for same-typed operands: numbers
 * compare numerically, strings lexically. A mixed pair (e.g. attribute "10" vs threshold 10) returns
 * `null` — "not comparable" — and the caller treats it as a non-match. This avoids the classic
 * footgun where `"10" < 2` would be `true` under a string fallback. Callers that want numeric
 * comparison must send a numeric attribute (or use a numeric clause value consistently).
 */
function relCompare(a: JsonValue, b: JsonValue): number | null {
  if (typeof a === 'number' && typeof b === 'number') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return null;
}

function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object' && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function asString(v: JsonValue): string {
  return typeof v === 'string' ? v : JSON.stringify(v) ?? '';
}

function stringifyAttr(v: JsonValue | undefined): string {
  return v === undefined ? '' : asString(v);
}
