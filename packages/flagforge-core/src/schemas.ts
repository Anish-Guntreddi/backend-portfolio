import { z } from 'zod';

/**
 * Flag definitions, targeting rules, and evaluation contexts — defined once as Zod schemas, with the
 * TypeScript types inferred from them. The service validates API input against these; the engine and
 * SDK consume the inferred types. One source of truth means the wire format, the stored format, and
 * the in-memory format can never drift apart.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(jsonValue),
  ]),
);

/** Comparison operators available to a targeting clause. `negate` (on the clause) inverts the result. */
export const OPERATORS = [
  'in',
  'contains',
  'startsWith',
  'endsWith',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
] as const;
export type Operator = (typeof OPERATORS)[number];

export const clauseSchema = z.object({
  /** Context attribute to read. The literal `"key"` reads the context's canonical bucketing key. */
  attribute: z.string().min(1),
  op: z.enum(OPERATORS),
  values: z.array(jsonValue).min(1),
  /** Invert the match (e.g. `in` + negate == "not in"). */
  negate: z.boolean().default(false),
});
export type Clause = z.infer<typeof clauseSchema>;

export const weightSchema = z.object({
  variation: z.string().min(1),
  /** Relative share. Bands are proportional to weight / sum(weights); absolute scale is irrelevant. */
  weight: z.number().nonnegative(),
});
export type Weight = z.infer<typeof weightSchema>;

const fixedServe = z.object({
  kind: z.literal('fixed'),
  variation: z.string().min(1),
});
const rolloutServe = z.object({
  kind: z.literal('rollout'),
  /** Context attribute whose value buckets the user. Defaults to the context key. */
  bucketBy: z.string().min(1).optional(),
  weights: z.array(weightSchema).min(1),
});
export const serveSchema = z.discriminatedUnion('kind', [fixedServe, rolloutServe]);
export type ServeStrategy = z.infer<typeof serveSchema>;

export const ruleSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  /** ALL clauses must match (logical AND). An empty clause list matches everyone (a catch-all rule). */
  clauses: z.array(clauseSchema).default([]),
  serve: serveSchema,
});
export type Rule = z.infer<typeof ruleSchema>;

export const variationSchema = z.object({
  key: z.string().min(1),
  value: jsonValue,
  name: z.string().optional(),
});
export type Variation = z.infer<typeof variationSchema>;

export const targetSchema = z.object({
  variation: z.string().min(1),
  /** Explicit context keys that always receive `variation`, checked before any rule. */
  values: z.array(z.string()),
});
export type Target = z.infer<typeof targetSchema>;

export const FLAG_TYPES = ['boolean', 'string', 'number', 'json'] as const;
export type FlagType = (typeof FLAG_TYPES)[number];

/** The complete, self-contained definition the engine needs to evaluate a flag. No I/O references. */
export const flagDefinitionSchema = z.object({
  key: z.string().min(1),
  type: z.enum(FLAG_TYPES),
  enabled: z.boolean(),
  variations: z.array(variationSchema).min(1),
  /** Variation served when the flag is disabled. */
  offVariation: z.string().min(1),
  /** Served when the flag is enabled but no target or rule matched. */
  fallthrough: serveSchema,
  targets: z.array(targetSchema).default([]),
  rules: z.array(ruleSchema).default([]),
  /** Stabilizes bucketing. Combined with the flag key; rotating it reshuffles every rollout. */
  salt: z.string().min(1),
});
export type FlagDefinition = z.infer<typeof flagDefinitionSchema>;

export const evalContextSchema = z.object({
  /** Canonical identity used for bucketing and target lookups (e.g. a user id). */
  key: z.string().min(1),
  attributes: z.record(jsonValue).default({}),
});
export type EvalContext = z.infer<typeof evalContextSchema>;

/**
 * Referential-integrity checks the type system can't express: every variation key referenced by a
 * serve strategy, target, or offVariation must exist, and rollout weights must sum to something
 * positive. Returns human-readable problems (empty == valid). The service runs this on every write
 * so the engine only ever sees self-consistent flags.
 */
export function referentialErrors(flag: FlagDefinition): string[] {
  const errors: string[] = [];
  const known = new Set(flag.variations.map((v) => v.key));

  const dupes = flag.variations.length - known.size;
  if (dupes > 0) errors.push('variations contain duplicate keys');

  const checkVariation = (key: string, where: string) => {
    if (!known.has(key)) errors.push(`${where} references unknown variation "${key}"`);
  };
  const checkServe = (serve: ServeStrategy, where: string) => {
    if (serve.kind === 'fixed') {
      checkVariation(serve.variation, where);
    } else {
      const total = serve.weights.reduce((s, w) => s + w.weight, 0);
      if (total <= 0) errors.push(`${where} rollout weights must sum to a positive number`);
      for (const w of serve.weights) checkVariation(w.variation, `${where} rollout`);
    }
  };

  checkVariation(flag.offVariation, 'offVariation');
  checkServe(flag.fallthrough, 'fallthrough');
  flag.targets.forEach((t, i) => checkVariation(t.variation, `targets[${i}]`));
  flag.rules.forEach((r, i) => checkServe(r.serve, `rules[${i}] (${r.id})`));

  return errors;
}
