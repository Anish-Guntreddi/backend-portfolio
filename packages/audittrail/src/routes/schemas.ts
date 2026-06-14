import { z } from 'zod';

/** Ingest payload. `.strict()` rejects unknown keys so typos surface as 400s, not silent drops. */
export const EventInput = z
  .object({
    actor: z.string().min(1).max(512),
    action: z.string().min(1).max(512),
    resource: z.string().min(1).max(1024),
    occurredAt: z.string().datetime().optional(),
    ip: z.string().ip().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const EventOutput = z.object({
  id: z.number(),
  actor: z.string(),
  action: z.string(),
  resource: z.string(),
  occurredAt: z.string(),
  recordedAt: z.string(),
  ip: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  prevHash: z.string(),
  hash: z.string(),
});

export const EventListQuery = z.object({
  actor: z.string().optional(),
  action: z.string().optional(),
  resource: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const EventExportQuery = EventListQuery.omit({ cursor: true, limit: true }).extend({
  format: z.enum(['json', 'csv']).default('json'),
});

export const EventListResponse = z.object({
  items: z.array(EventOutput),
  nextCursor: z.number().nullable(),
});

export const VerifyResponse = z.object({
  valid: z.boolean(),
  checkedCount: z.number(),
  /** The hash of the last event when valid — record it externally to detect suffix/rewrite tampering. */
  headHash: z.string().optional(),
  brokenAtId: z.number().optional(),
  reason: z.string().optional(),
  expected: z.string().optional(),
  actual: z.string().optional(),
});

export const RuleInput = z
  .object({
    name: z.string().min(1).max(256),
    matchAction: z.string().min(1).max(512),
    threshold: z.number().int().positive(),
    windowSeconds: z.number().int().positive().max(86_400),
    groupByActor: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const RuleOutput = z.object({
  id: z.number(),
  name: z.string(),
  enabled: z.boolean(),
  matchAction: z.string(),
  groupByActor: z.boolean(),
  threshold: z.number(),
  windowSeconds: z.number(),
  createdAt: z.string(),
});

export const AlertOutput = z.object({
  id: z.number(),
  ruleId: z.number(),
  actor: z.string().nullable(),
  matchedCount: z.number(),
  windowStart: z.string(),
  windowEnd: z.string(),
  triggeredAt: z.string(),
});
