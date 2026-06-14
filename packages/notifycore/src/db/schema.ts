import {
  pgTable,
  bigserial,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  index,
  unique,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

export const templates = pgTable(
  'templates',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    key: text('key').notNull().unique(),
    channel: text('channel').notNull(),
    subject: text('subject'),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('templates_key_idx').on(t.key)],
);

export type TemplateRow = typeof templates.$inferSelect;

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

export const notifications = pgTable(
  'notifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    recipient: text('recipient').notNull(),
    channel: text('channel').notNull(),
    templateKey: text('template_key').notNull(),
    data: jsonb('data').notNull().default({}).$type<Record<string, unknown>>(),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lastError: text('last_error'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_status_idx').on(t.status),
    index('notifications_recipient_idx').on(t.recipient),
    index('notifications_idempotency_key_idx').on(t.idempotencyKey),
  ],
);

export type NotificationRow = typeof notifications.$inferSelect;

// ---------------------------------------------------------------------------
// preferences
// ---------------------------------------------------------------------------

export const preferences = pgTable(
  'preferences',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    recipient: text('recipient').notNull(),
    channel: text('channel').notNull(),
    optedOut: boolean('opted_out').notNull().default(false),
    quietStart: text('quiet_start'),
    quietEnd: text('quiet_end'),
    timezone: text('timezone'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('preferences_recipient_channel_unique').on(t.recipient, t.channel),
    index('preferences_recipient_idx').on(t.recipient),
  ],
);

export type PreferenceRow = typeof preferences.$inferSelect;
