import {
  pgTable,
  bigserial,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import type { FlagDefinition, ServeStrategy, Target, Rule } from '@portfolio/flagforge-core';

export const flags = pgTable(
  'flags',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    key: text('key').notNull().unique(),
    type: text('type').notNull(),
    enabled: boolean('enabled').notNull(),
    variations: jsonb('variations').notNull().$type<FlagDefinition['variations']>(),
    offVariation: text('off_variation').notNull(),
    fallthrough: jsonb('fallthrough').notNull().$type<ServeStrategy>(),
    targets: jsonb('targets').notNull().default([]).$type<Target[]>(),
    rules: jsonb('rules').notNull().default([]).$type<Rule[]>(),
    salt: text('salt').notNull(),
    version: integer('version').notNull().default(1),
    archived: boolean('archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('flags_key_idx').on(t.key),
    index('flags_archived_idx').on(t.archived),
  ],
);

/** Append-only changelog for flag mutations. No update/delete code paths. */
export const flagAudit = pgTable(
  'flag_audit',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    flagKey: text('flag_key').notNull(),
    action: text('action').notNull(),
    actor: text('actor').notNull(),
    before: jsonb('before').$type<Record<string, unknown> | null>(),
    after: jsonb('after').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('flag_audit_flag_key_idx').on(t.flagKey)],
);

export type FlagRow = typeof flags.$inferSelect;
export type FlagAuditRow = typeof flagAudit.$inferSelect;
