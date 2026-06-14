import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildServer } from '../src/server.ts';
import type { Config } from '../src/config.ts';

// OpenAPI generation reads route schemas only — no real DB or Redis connection is opened.
const cfg: Config = {
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://placeholder:placeholder@localhost:5432/placeholder',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6381',
  API_KEY: process.env.API_KEY ?? 'placeholder',
  PORT: 8082,
  HOST: '0.0.0.0',
  LOG_LEVEL: 'silent',
  NODE_ENV: 'development',
  RETRY_BASE_MS: 1000,
  DEFAULT_MAX_ATTEMPTS: 5,
};

const { app, close } = await buildServer(cfg);
await app.ready();
const spec = app.swagger();
const out = join(dirname(fileURLToPath(import.meta.url)), '../openapi.json');
writeFileSync(out, JSON.stringify(spec, null, 2));
await close();
// eslint-disable-next-line no-console
console.log(`wrote ${out}`);
