import fp from 'fastify-plugin';
import { createHash, timingSafeEqual } from 'node:crypto';

export interface ApiKeyAuthOptions {
  /** The expected secret. Requests must send it in the `x-api-key` header. */
  apiKey: string;
  /** Path prefixes exempt from auth (health checks, docs, static admin UI). */
  publicPaths: string[];
}

function safeEqual(a: string, b: string): boolean {
  // Hash both sides to fixed 32-byte digests before comparing, so the comparison is constant-time
  // regardless of input length. A raw length check would short-circuit and leak the key length.
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

/**
 * Minimal API-key gate. Every request must present a matching `x-api-key` header except for the
 * configured public path prefixes. The comparison is constant-time to avoid leaking the key via
 * timing. (v1 auth model: a single shared key — multi-tenant RBAC is explicitly out of scope.)
 */
export const apiKeyAuth = fp<ApiKeyAuthOptions>(
  (app, opts, done) => {
    app.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?', 1)[0] ?? req.url;
      // Boundary-aware match: a public prefix matches the path exactly or as a `/`-delimited
      // segment prefix. This keeps `'/'` from matching everything and `'/docs'` from matching
      // `'/docs-internal'`.
      const isPublic = opts.publicPaths.some((p) => {
        if (path === p) return true;
        if (p === '/') return false; // root is exact-only; never a catch-all prefix
        const prefix = p.endsWith('/') ? p : `${p}/`;
        return path.startsWith(prefix);
      });
      if (isPublic) return;

      const provided = req.headers['x-api-key'];
      const key = Array.isArray(provided) ? provided[0] : provided;
      if (!key || !safeEqual(key, opts.apiKey)) {
        return reply.code(401).type('application/problem+json').send({
          type: 'about:blank',
          title: 'unauthorized',
          status: 401,
          detail: 'Missing or invalid API key.',
        });
      }
    });
    done();
  },
  { name: 'api-key-auth' },
);
