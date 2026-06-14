import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { registerErrorHandler } from './errors.ts';
import { apiKeyAuth } from './auth.ts';

export interface BaseServerOptions {
  serviceName: string;
  version?: string;
  description?: string;
  /** When set, enables API-key auth for all non-public routes. */
  apiKey?: string;
  /** Extra path prefixes exempt from auth (in addition to /healthz and /docs). */
  publicPaths?: string[];
  logLevel?: string;
  /** Pass `false`/a custom logger config; defaults to a leveled pino logger. */
  logger?: boolean | object;
}

export type ZodFastifyInstance = ReturnType<FastifyInstance['withTypeProvider']> &
  FastifyInstance;

/**
 * Build a Fastify instance preconfigured with everything the portfolio services share:
 *   - Zod as the validation + serialization + OpenAPI source of truth
 *   - Swagger spec at /openapi.json and Swagger UI at /docs
 *   - RFC-7807 problem+json error handling
 *   - optional API-key auth (skips /healthz, /docs, and any extra publicPaths)
 *   - a /healthz route
 *
 * Register your route plugins on the returned instance using `FastifyPluginAsyncZod`.
 */
export async function buildBaseServer(opts: BaseServerOptions) {
  const app = Fastify({
    logger: opts.logger ?? { level: opts.logLevel ?? process.env.LOG_LEVEL ?? 'info' },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      info: {
        title: opts.serviceName,
        version: opts.version ?? '0.1.0',
        ...(opts.description ? { description: opts.description } : {}),
      },
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', name: 'x-api-key', in: 'header' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, { routePrefix: '/docs' });

  registerErrorHandler(app);

  if (opts.apiKey) {
    await app.register(apiKeyAuth, {
      apiKey: opts.apiKey,
      publicPaths: ['/healthz', '/docs', '/openapi.json', ...(opts.publicPaths ?? [])],
    });
  }

  app.get('/healthz', { schema: { hide: true } }, async () => ({
    status: 'ok',
    service: opts.serviceName,
  }));

  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  return app;
}
