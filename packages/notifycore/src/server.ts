import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fastifyStatic from '@fastify/static';
import { buildBaseServer, type ZodFastifyInstance } from '@portfolio/shared';
import type { Config } from './config.ts';
import { createDb, type Db } from './db/client.ts';
import { createQueue, type NotificationJobData } from './queue.ts';
import { apiRoutes } from './routes/index.ts';
import type { Queue } from 'bullmq';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '../public');

export interface BuiltServer {
  app: ZodFastifyInstance;
  db: Db;
  queue: Queue<NotificationJobData>;
  close: () => Promise<void>;
}

/**
 * Assemble the NotifyCore server: shared base (Zod/OpenAPI/auth/error handling), the static admin
 * dashboard at /admin, a root redirect, and the API routes.
 * Pass `deps.db`/`deps.queue` in tests to share connections; otherwise they are created from config.
 */
export async function buildServer(
  cfg: Config,
  deps?: { db?: Db; queue?: Queue<NotificationJobData> },
): Promise<BuiltServer> {
  const createdDb = deps?.db ? null : createDb(cfg.DATABASE_URL);
  const db = deps?.db ?? createdDb!.db;

  const createdQueue = deps?.queue ? null : createQueue(cfg.REDIS_URL);
  const queue = deps?.queue ?? createdQueue!;

  const app = await buildBaseServer({
    serviceName: 'NotifyCore',
    description:
      'Reliable notification delivery: templates, preferences, quiet hours, retries, DLQ, idempotency.',
    apiKey: cfg.API_KEY,
    publicPaths: ['/', '/admin'],
    logLevel: cfg.LOG_LEVEL,
  });

  await app.register(fastifyStatic, { root: publicDir, prefix: '/admin/' });
  app.get('/', { schema: { hide: true } }, async (_req, reply) => reply.redirect('/admin/'));

  await app.register(apiRoutes, {
    db,
    queue,
    defaultMaxAttempts: cfg.DEFAULT_MAX_ATTEMPTS,
    retryBaseMs: cfg.RETRY_BASE_MS,
  });

  const close = async () => {
    await app.close();
    if (createdDb) await createdDb.pool.end();
    if (createdQueue) await createdQueue.close();
  };

  return { app, db, queue, close };
}
