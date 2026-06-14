import { and, eq, lt, or, sql } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { createLogger } from '@portfolio/shared';
import type { Db } from '../db/client.ts';
import { notifications } from '../db/schema.ts';
import type { NotificationJobData } from '../queue.ts';

const log = createLogger('notifycore:reconciler');

export interface ReconcilerOptions {
  db: Db;
  queue: Queue<NotificationJobData>;
  /** How often to sweep, ms. */
  intervalMs?: number;
  /** A row is considered "stuck" if it hasn't advanced in this long, ms. */
  staleMs?: number;
  retryBaseMs?: number;
  /** Max rows to re-enqueue per sweep. */
  batchSize?: number;
}

export interface StartedReconciler {
  stop: () => void;
}

/**
 * The safety net for the one window the in-line writes can't make atomic: a crash *between* a DB
 * status change and the corresponding `queue.add()` leaves a row that is 'queued'/'deferred' (or a
 * 'sending' row whose worker died) with no live job. This periodic sweep re-enqueues such rows.
 *
 * Re-enqueuing is safe to do speculatively because the processor's atomic claim means a duplicate job
 * just loses the claim and no-ops ('not-claimed') — it can never cause a double-send. We only touch
 * rows that have been stuck past `staleMs` so we don't fight healthy in-flight jobs.
 */
export function startReconciler(opts: ReconcilerOptions): StartedReconciler {
  const { db, queue } = opts;
  const intervalMs = opts.intervalMs ?? 30_000;
  const staleSeconds = (opts.staleMs ?? 60_000) / 1000;
  const retryBaseMs = opts.retryBaseMs ?? 1000;
  const batchSize = opts.batchSize ?? 100;

  let running = false;

  const sweep = async () => {
    if (running) return; // never overlap sweeps
    running = true;
    try {
      const cutoff = sql`now() - make_interval(secs => ${staleSeconds})`;
      const stuck = await db
        .select()
        .from(notifications)
        .where(
          and(
            or(eq(notifications.status, 'queued'), eq(notifications.status, 'deferred'), eq(notifications.status, 'sending')),
            lt(notifications.updatedAt, cutoff),
          ),
        )
        .limit(batchSize);

      if (stuck.length === 0) return;
      log.warn({ count: stuck.length }, 're-enqueuing stuck notifications');
      for (const row of stuck) {
        await queue.add(
          'send',
          { notificationId: row.id },
          { attempts: row.maxAttempts, backoff: { type: 'exponential', delay: retryBaseMs } },
        );
      }
    } catch (err) {
      log.error({ err }, 'reconciler sweep failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
  };
}
