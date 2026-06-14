import {
  pgTable,
  bigserial,
  bigint,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Append-only audit log. There are NO update/delete code paths anywhere in the service, and the
 * append-only-guard migration additionally (a) revokes UPDATE/DELETE grants from the app role and
 * (b) installs a trigger that raises on any UPDATE/DELETE — so even a privileged mistake is caught.
 *
 * Tamper-evidence: each row stores the hash of the previous row (`prev_hash`) and its own content
 * hash (`hash`). The monotonic `id` sequence defines chain order; `prev_hash` links the chain.
 */
export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    resource: text('resource').notNull(),
    /** When the event happened (client-supplied or defaulted to insert time). Covered by the hash. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** When the server recorded it. NOT covered by the hash (server-controlled, not asserted). */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [
    index('events_actor_idx').on(t.actor),
    index('events_action_idx').on(t.action),
    index('events_resource_idx').on(t.resource),
    index('events_occurred_at_idx').on(t.occurredAt),
    index('events_action_occurred_idx').on(t.action, t.occurredAt),
  ],
);

/** A simple rule: count events with `matchAction` in a sliding window; alert above `threshold`. */
export const alertRules = pgTable('alert_rules', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  matchAction: text('match_action').notNull(),
  /** When true, threshold is checked per-actor; when false, across all actors. */
  groupByActor: boolean('group_by_actor').notNull().default(true),
  threshold: integer('threshold').notNull(),
  windowSeconds: integer('window_seconds').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const alerts = pgTable(
  'alerts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ruleId: bigint('rule_id', { mode: 'number' })
      .notNull()
      .references(() => alertRules.id, { onDelete: 'cascade' }),
    /** The actor that breached the threshold, or null for across-all-actors rules. */
    actor: text('actor'),
    matchedCount: integer('matched_count').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    triggeredAt: timestamp('triggered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('alerts_rule_idx').on(t.ruleId), index('alerts_triggered_idx').on(t.triggeredAt)],
);

export type EventRow = typeof events.$inferSelect;
export type AlertRuleRow = typeof alertRules.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
