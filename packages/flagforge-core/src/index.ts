export {
  type JsonValue,
  jsonValue,
  OPERATORS,
  type Operator,
  clauseSchema,
  type Clause,
  weightSchema,
  type Weight,
  serveSchema,
  type ServeStrategy,
  ruleSchema,
  type Rule,
  variationSchema,
  type Variation,
  targetSchema,
  type Target,
  FLAG_TYPES,
  type FlagType,
  flagDefinitionSchema,
  type FlagDefinition,
  evalContextSchema,
  type EvalContext,
  referentialErrors,
} from './schemas.ts';

export { bucket, pickVariation } from './bucket.ts';

export { evaluate, type EvalReason, type EvalResult } from './evaluate.ts';
