import { createLogger } from '@portfolio/shared';
import { loadConfig } from './config.ts';
import { createDb } from './db/client.ts';
import { startWorker } from './worker/index.ts';
import { startReconciler } from './worker/reconciler.ts';
import { createQueue } from './queue.ts';

const log = createLogger('notifycore:worker-main');
const cfg = loadConfig();
const { db, pool } = createDb(cfg.DATABASE_URL);
const queue = createQueue(cfg.REDIS_URL);

const { worker, close } = startWorker(
  { redisUrl: cfg.REDIS_URL, retryBaseMs: cfg.RETRY_BASE_MS },
  { db, queue },
);

// Safety net: re-enqueue notifications orphaned by a crash between a DB write and the queue add.
const reconciler = startReconciler({ db, queue, retryBaseMs: cfg.RETRY_BASE_MS });

const shutdown = async (signal: string) => {
  log.info({ signal }, 'worker shutting down');
  reconciler.stop();
  await close();
  await queue.close();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

log.info('worker started');
