import { and, eq, inArray, or, sql } from 'drizzle-orm';
import {
  render,
  nextSendTime,
  channelSchema,
  type QuietHours,
} from '@portfolio/notifycore-core';
import type { Queue } from 'bullmq';
import type { Db } from '../db/client.ts';
import { notifications, templates, preferences } from '../db/schema.ts';
import type { ChannelProvider } from '../providers.ts';
import type { NotificationJobData } from '../queue.ts';

export type ProcessOutcome =
  | { kind: 'sent' }
  | { kind: 'skipped' }
  | { kind: 'deferred' }
  | { kind: 'dead' }
  | { kind: 'already-terminal' }
  | { kind: 'not-claimed' };

export interface ProcessorDeps {
  db: Db;
  provider: ChannelProvider;
  queue: Queue<NotificationJobData>;
  /** Injected clock for quiet-hours determinism; defaults to () => new Date(). */
  now?: () => Date;
  retryBaseMs?: number;
  /** How long a 'sending' claim is held before another worker may steal it (crash recovery). */
  leaseMs?: number;
}

const TERMINAL_STATUSES = new Set(['sent', 'skipped', 'dead']);
const DEFAULT_LEASE_MS = 60_000;

/**
 * Process one notification. Concurrency- and crash-aware:
 *
 *   - ATOMIC CLAIM: a single `UPDATE ... WHERE status claimable RETURNING *` moves the row to
 *     'sending'. Only one worker can win the row, so two workers can never both call the provider.
 *     "Claimable" = queued/deferred, OR a 'sending' row whose lease has expired (its worker crashed).
 *   - DB-AUTHORITATIVE RETRIES/DLQ: the attempt count and the terminal 'dead' transition live in
 *     Postgres and are written *before* control returns — not in a fire-and-forget queue event — so an
 *     exhausted notification is durably dead even if the process dies. Total provider calls are bounded
 *     by `maxAttempts` regardless of how BullMQ's per-job retry budget is reset by deferral.
 *
 * Delivery is at-least-once (a crash after send but before the 'sent' commit redelivers); the provider
 * receives a stable `deliveryId` so it can dedupe downstream.
 */
export async function processNotification(
  deps: ProcessorDeps,
  notificationId: number,
): Promise<ProcessOutcome> {
  const { db, provider, queue } = deps;
  const now = deps.now ?? (() => new Date());
  const retryBaseMs = deps.retryBaseMs ?? 1000;
  const leaseSeconds = (deps.leaseMs ?? DEFAULT_LEASE_MS) / 1000;

  // 1. Atomic claim: queued/deferred, or a stale 'sending' lease (crashed worker).
  const claimed = await db
    .update(notifications)
    .set({ status: 'sending', updatedAt: sql`now()` })
    .where(
      and(
        eq(notifications.id, notificationId),
        or(
          inArray(notifications.status, ['queued', 'deferred']),
          and(
            eq(notifications.status, 'sending'),
            sql`${notifications.updatedAt} < now() - make_interval(secs => ${leaseSeconds})`,
          ),
        ),
      ),
    )
    .returning();

  if (claimed.length === 0) {
    // Either terminal, or another worker holds a fresh lease.
    const [current] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.id, notificationId))
      .limit(1);
    if (!current) throw new Error(`Notification ${notificationId} not found`);
    return TERMINAL_STATUSES.has(current.status)
      ? { kind: 'already-terminal' }
      : { kind: 'not-claimed' };
  }

  const notif = claimed[0]!;

  // 2. Opt-out.
  const [pref] = await db
    .select()
    .from(preferences)
    .where(and(eq(preferences.recipient, notif.recipient), eq(preferences.channel, notif.channel)))
    .limit(1);

  if (pref?.optedOut) {
    await db
      .update(notifications)
      .set({ status: 'skipped', updatedAt: sql`now()` })
      .where(eq(notifications.id, notificationId));
    return { kind: 'skipped' };
  }

  // 3. Quiet hours — defer until the window ends and re-enqueue with a delay.
  if (pref?.quietStart && pref.quietEnd && pref.timezone) {
    const quiet: QuietHours = {
      start: pref.quietStart,
      end: pref.quietEnd,
      timeZone: pref.timezone,
    };
    const currentNow = now();
    const sendAt = nextSendTime(currentNow, quiet);
    if (sendAt > currentNow) {
      await db
        .update(notifications)
        .set({ status: 'deferred', scheduledFor: sendAt, updatedAt: sql`now()` })
        .where(eq(notifications.id, notificationId));
      await queue.add(
        'send',
        { notificationId },
        {
          delay: sendAt.getTime() - currentNow.getTime(),
          attempts: notif.maxAttempts,
          backoff: { type: 'exponential', delay: retryBaseMs },
        },
      );
      return { kind: 'deferred' };
    }
  }

  // 4. Load template and render.
  const [template] = await db
    .select()
    .from(templates)
    .where(eq(templates.key, notif.templateKey))
    .limit(1);
  if (!template) throw new Error(`Template "${notif.templateKey}" not found`);

  const data = (notif.data ?? {}) as Record<string, unknown>;
  const channel = channelSchema.parse(notif.channel); // validate, not blind-cast
  const message = {
    deliveryId: notif.idempotencyKey,
    channel,
    recipient: notif.recipient,
    subject: template.subject ? render(template.subject, data) : null,
    body: render(template.body, data),
  };

  // 5. Send. On failure, the DB decides retry-vs-DLQ (authoritatively, before returning/throwing).
  try {
    await provider.send(message);
  } catch (err) {
    const attempts = notif.attempts + 1;
    const lastError = err instanceof Error ? err.message : String(err);
    if (attempts >= notif.maxAttempts) {
      await db
        .update(notifications)
        .set({ status: 'dead', attempts, lastError, updatedAt: sql`now()` })
        .where(eq(notifications.id, notificationId));
      return { kind: 'dead' }; // durable DLQ; do NOT throw (no further BullMQ retry)
    }
    await db
      .update(notifications)
      .set({ status: 'queued', attempts, lastError, updatedAt: sql`now()` })
      .where(eq(notifications.id, notificationId));
    throw err; // BullMQ retries with backoff
  }

  // 6. Success.
  await db
    .update(notifications)
    .set({
      status: 'sent',
      sentAt: now(),
      attempts: notif.attempts + 1,
      updatedAt: sql`now()`,
    })
    .where(eq(notifications.id, notificationId));

  return { kind: 'sent' };
}
