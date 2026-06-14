import type { NotificationRow, TemplateRow, PreferenceRow } from '../db/schema.ts';

export function toNotificationDTO(row: NotificationRow, created?: boolean) {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    recipient: row.recipient,
    channel: row.channel,
    templateKey: row.templateKey,
    data: (row.data ?? {}) as Record<string, unknown>,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError: row.lastError ?? null,
    scheduledFor: row.scheduledFor ? row.scheduledFor.toISOString() : null,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(created !== undefined ? { created } : {}),
  };
}

export function toTemplateDTO(row: TemplateRow) {
  return {
    id: row.id,
    key: row.key,
    channel: row.channel,
    subject: row.subject ?? null,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPreferenceDTO(row: PreferenceRow) {
  return {
    id: row.id,
    recipient: row.recipient,
    channel: row.channel,
    optedOut: row.optedOut,
    quietStart: row.quietStart ?? null,
    quietEnd: row.quietEnd ?? null,
    timezone: row.timezone ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
