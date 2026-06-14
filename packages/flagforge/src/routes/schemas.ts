import { z } from 'zod';
import {
  flagDefinitionSchema,
  evalContextSchema,
  jsonValue,
} from '@portfolio/flagforge-core';

// ---------------------------------------------------------------------------
// Flag CRUD
// ---------------------------------------------------------------------------

/** Input: full flag definition. The key in PUT body is optional (path key takes precedence). */
export const FlagInput = flagDefinitionSchema;

export const FlagOutput = flagDefinitionSchema.extend({
  version: z.number().int(),
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const FlagListQuery = z.object({
  includeArchived: z
    .union([z.boolean(), z.string().transform((v) => v === 'true')])
    .optional()
    .default(false),
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const AuditOutput = z.object({
  id: z.number(),
  flagKey: z.string(),
  action: z.string(),
  actor: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  createdAt: z.string(),
});

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** A reason object — passthrough so every EvalReason variant serializes. */
export const EvalReasonOutput = z.object({ kind: z.string() }).passthrough();

export const EvalResultOutput = z.object({
  flagKey: z.string(),
  value: jsonValue.nullable(),
  variation: z.string().nullable(),
  reason: EvalReasonOutput,
  flagVersion: z.number().nullable(),
});

export const EvalInput = z.object({
  flagKey: z.string().min(1),
  context: evalContextSchema,
  defaultValue: jsonValue.optional(),
});

export const EvalAllInput = z.object({
  context: evalContextSchema,
});

export const EvalAllOutput = z.object({
  flags: z.record(
    z.object({
      value: jsonValue.nullable(),
      variation: z.string().nullable(),
      reason: EvalReasonOutput,
      flagVersion: z.number().nullable(),
    }),
  ),
});
