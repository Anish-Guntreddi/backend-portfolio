import { z } from 'zod';
import { channelSchema, notificationStatusSchema } from '@portfolio/notifycore-core';

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const NotificationInput = z.object({
  idempotencyKey: z.string().min(1),
  recipient: z.string().min(1),
  channel: channelSchema,
  templateKey: z.string().min(1),
  data: z.record(z.unknown()).optional(),
  maxAttempts: z.number().int().positive().optional(),
});

export const NotificationOutput = z.object({
  id: z.number(),
  idempotencyKey: z.string(),
  recipient: z.string(),
  channel: z.string(),
  templateKey: z.string(),
  data: z.record(z.unknown()),
  status: z.string(),
  attempts: z.number(),
  maxAttempts: z.number(),
  lastError: z.string().nullable(),
  scheduledFor: z.string().nullable(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  created: z.boolean().optional(),
});

export const NotificationListQuery = z.object({
  status: notificationStatusSchema.optional(),
  recipient: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).default(50),
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const TemplateInput = z.object({
  key: z.string().min(1),
  channel: channelSchema,
  subject: z.string().optional(),
  body: z.string().min(1),
});

export const TemplateUpdateInput = z.object({
  channel: channelSchema,
  subject: z.string().optional(),
  body: z.string().min(1),
});

export const TemplateOutput = z.object({
  id: z.number(),
  key: z.string(),
  channel: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export const PreferenceQuery = z.object({
  recipient: z.string().min(1),
  channel: channelSchema,
});

export const PreferenceUpsertInput = z.object({
  recipient: z.string().min(1),
  channel: channelSchema,
  optedOut: z.boolean().optional(),
  quietStart: z.string().optional(),
  quietEnd: z.string().optional(),
  timezone: z.string().optional(),
});

export const PreferenceOutput = z.object({
  id: z.number(),
  recipient: z.string(),
  channel: z.string(),
  optedOut: z.boolean(),
  quietStart: z.string().nullable(),
  quietEnd: z.string().nullable(),
  timezone: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// DLQ
// ---------------------------------------------------------------------------

export const DlqReplayOutput = NotificationOutput;
