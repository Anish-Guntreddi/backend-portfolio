import { Queue } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { missingPlaceholders } from '@portfolio/notifycore-core';
import { BadRequest, NotFound } from '@portfolio/shared';
import type { Db } from './db/client.ts';
import { notifications, templates } from './db/schema.ts';
import type { NotificationRow } from './db/schema.ts';

export const QUEUE_NAME = 'notifycore';

/** BullMQ job data — just the notification id; the worker loads the full row. */
export interface NotificationJobData {
  notificationId: number;
}

/** Parse a Redis URL into BullMQ ConnectionOptions (host+port object). */
function parseRedisUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port) || 6379 };
}

/** Create a BullMQ Queue using a plain connection options object (avoids ioredis version conflicts). */
export function createQueue(redisUrl: string): Queue<NotificationJobData> {
  return new Queue<NotificationJobData>(QUEUE_NAME, {
    connection: parseRedisUrl(redisUrl),
  });
}

export interface EnqueueInput {
  idempotencyKey: string;
  recipient: string;
  channel: string;
  templateKey: string;
  data?: Record<string, unknown>;
  maxAttempts?: number;
}

export interface EnqueueResult {
  notification: NotificationRow;
  created: boolean;
}

/**
 * Idempotent enqueue: inserts the notification row (ON CONFLICT DO NOTHING) and adds a BullMQ job.
 * If the row already exists (duplicate idempotencyKey), returns the existing row with created=false
 * and does NOT add another job.
 */
export async function enqueueNotification(
  db: Db,
  queue: Queue<NotificationJobData>,
  input: EnqueueInput,
  defaultMaxAttempts: number,
  retryBaseMs: number,
): Promise<EnqueueResult> {
  const maxAttempts = input.maxAttempts ?? defaultMaxAttempts;

  // Validate: template exists and channel matches.
  const [template] = await db
    .select()
    .from(templates)
    .where(eq(templates.key, input.templateKey))
    .limit(1);

  if (!template) {
    throw BadRequest(`template "${input.templateKey}" not found`);
  }
  if (template.channel !== input.channel) {
    throw BadRequest(
      `template "${input.templateKey}" is for channel "${template.channel}", but request specifies "${input.channel}"`,
    );
  }

  // Validate placeholders in body (and subject if present).
  const data = input.data ?? {};
  const bodyMissing = missingPlaceholders(template.body, data);
  if (bodyMissing.length > 0) {
    throw BadRequest(`template body is missing placeholder data: ${bodyMissing.join(', ')}`);
  }
  if (template.subject) {
    const subjectMissing = missingPlaceholders(template.subject, data);
    if (subjectMissing.length > 0) {
      throw BadRequest(`template subject is missing placeholder data: ${subjectMissing.join(', ')}`);
    }
  }

  // Idempotent insert.
  const inserted = await db
    .insert(notifications)
    .values({
      idempotencyKey: input.idempotencyKey,
      recipient: input.recipient,
      channel: input.channel,
      templateKey: input.templateKey,
      data,
      status: 'queued',
      attempts: 0,
      maxAttempts,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted.length > 0) {
    // Fresh insert — add a BullMQ job.
    const notification = inserted[0]!;
    await queue.add(
      'send',
      { notificationId: notification.id },
      {
        attempts: maxAttempts,
        backoff: { type: 'exponential', delay: retryBaseMs },
      },
    );
    return { notification, created: true };
  }

  // Duplicate — load the existing row, return it without adding a job.
  const [existing] = await db
    .select()
    .from(notifications)
    .where(eq(notifications.idempotencyKey, input.idempotencyKey))
    .limit(1);

  return { notification: existing!, created: false };
}

/**
 * Replay a dead notification: reset it to 'queued' and add a fresh BullMQ job. 404 if not found, 400
 * if not currently 'dead'. The reset is an ATOMIC conditional update (`WHERE id=? AND status='dead'`)
 * so two concurrent replays can't both reset-and-enqueue: only the row that flips wins and enqueues.
 */
export async function replayNotification(
  db: Db,
  queue: Queue<NotificationJobData>,
  id: number,
  retryBaseMs: number,
): Promise<NotificationRow> {
  const [updated] = await db
    .update(notifications)
    .set({
      status: 'queued',
      attempts: 0,
      lastError: null,
      scheduledFor: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(notifications.id, id), eq(notifications.status, 'dead')))
    .returning();

  if (!updated) {
    // Distinguish "doesn't exist" from "not dead" for a useful error.
    const [existing] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.id, id))
      .limit(1);
    if (!existing) throw NotFound(`notification ${id} not found`);
    throw BadRequest(`notification ${id} is not dead (current status: ${existing.status})`);
  }

  await queue.add(
    'send',
    { notificationId: id },
    {
      attempts: updated.maxAttempts,
      backoff: { type: 'exponential', delay: retryBaseMs },
    },
  );

  return updated;
}
