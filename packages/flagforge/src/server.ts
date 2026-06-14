import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fastifyStatic from '@fastify/static';
import { buildBaseServer, type ZodFastifyInstance } from '@portfolio/shared';
import type { Config } from './config.ts';
import { createDb, type Db } from './db/client.ts';
import { createCache, type FlagCache } from './cache.ts';
import { apiRoutes } from './routes/index.ts';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '../public');

export interface BuiltServer {
  app: ZodFastifyInstance;
  db: Db;
  cache: FlagCache;
  close: () => Promise<void>;
}

/**
 * Assemble the FlagForge server: shared base (Zod/OpenAPI/auth/error handling), the static admin
 * dashboard at /admin, a root redirect, and the API routes. Pass `deps.db`/`deps.cache` in tests
 * to share connections; otherwise they are created from config and owned by `close()`.
 */
export async function buildServer(
  cfg: Config,
  deps?: { db?: Db; cache?: FlagCache },
): Promise<BuiltServer> {
  const created = deps?.db ? null : createDb(cfg.DATABASE_URL);
  const db = deps?.db ?? created!.db;
  const cache = deps?.cache ?? createCache(cfg);

  const app = await buildBaseServer({
    serviceName: 'FlagForge',
    description:
      'Feature flags with deterministic percentage rollouts, targeting, and a typed evaluation engine.',
    apiKey: cfg.API_KEY,
    publicPaths: ['/', '/admin'],
    logLevel: cfg.LOG_LEVEL,
  });

  await app.register(fastifyStatic, { root: publicDir, prefix: '/admin/' });
  app.get('/', { schema: { hide: true } }, async (_req, reply) => reply.redirect('/admin/'));

  await app.register(apiRoutes, { db, cache });

  const close = async () => {
    await app.close();
    if (created) await created.pool.end();
    await cache.close();
  };

  return { app, db, cache, close };
}
