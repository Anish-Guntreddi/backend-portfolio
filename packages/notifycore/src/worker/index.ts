import { Worker, Queue, type Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { createLogger } from '@portfolio/shared';
import type { Db } from '../db/client.ts';
import { notifications } from '../db/schema.ts';
import type { ChannelProvider } from '../providers.ts';
import { ConsoleProvider } from '../providers.ts';
import { QUEUE_NAME, type NotificationJobData } from '../queue.ts';
import { processNotification } from './processor.ts';

const log = createLogger('notifycore:worker');

function parseRedisUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port) || 6379 };
}

export interface WorkerDeps {
  db: Db;
  provider?: ChannelProvider;
  queue: Queue<NotificationJobData>;
  retryBaseMs?: number;
}

export interface StartedWorker {
  worker: Worker;
  close: () => Promise<void>;
}

/**
 * Start the BullMQ worker. The worker processes `notifycore` jobs and handles the `failed` event
 * to dead-letter notifications that have exhausted all retries.
 *
 * NOTE: the Worker uses its own BullMQ connection (plain object, avoids ioredis version conflicts).
 * The `queue` dep is used for re-enqueuing deferred jobs.
 */
export function startWorker(
  cfg: { redisUrl: string; retryBaseMs?: number },
  deps: WorkerDeps,
): StartedWorker {
  const provider = deps.provider ?? new ConsoleProvider();
  const retryBaseMs = deps.retryBaseMs ?? cfg.retryBaseMs ?? 1000;
  const { queue } = deps;

  // The queue name to listen on is the one from the passed queue instance.
  // For the default case this is QUEUE_NAME; for tests it may differ.
  const queueName = (queue as unknown as { name: string }).name;

  const worker = new Worker<NotificationJobData>(
    queueName,
    async (job: Job<NotificationJobData>) => {
      const { notificationId } = job.data;
      log.info({ notificationId, attempt: job.attemptsMade }, 'processing notification');
      await processNotification(
        { db: deps.db, provider, queue, retryBaseMs },
        notificationId,
      );
    },
    { connection: parseRedisUrl(cfg.redisUrl) },
  );

  // Dead-letter: when BullMQ exhausts all retries, mark the notification dead.
  worker.on('failed', (job, err) => {
    if (!job) return;
    const { notificationId } = job.data;
    const maxAttempts = (job.opts.attempts as number | undefined) ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      log.warn({ notificationId, err: err.message }, 'notification dead-lettered');
      deps.db
        .update(notifications)
        .set({
          status: 'dead',
          lastError: err.message,
          updatedAt: sql`now()`,
        })
        .where(eq(notifications.id, notificationId))
        .catch((dbErr: unknown) => {
          log.error({ dbErr, notificationId }, 'failed to dead-letter notification');
        });
    }
  });

  worker.on('error', (err) => {
    log.error({ err }, 'worker error');
  });

  const close = async () => {
    await worker.close();
  };

  return { worker, close };
}
