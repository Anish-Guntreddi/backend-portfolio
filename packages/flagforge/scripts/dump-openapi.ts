import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildServer } from '../src/server.ts';
import type { Config } from '../src/config.ts';

// OpenAPI generation reads route schemas only — no DB or Redis connection is ever opened.
const cfg: Config = {
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://placeholder:placeholder@localhost:5432/placeholder',
  REDIS_URL: undefined,
  API_KEY: process.env.API_KEY ?? 'placeholder',
  PORT: 8081,
  HOST: '0.0.0.0',
  LOG_LEVEL: 'silent',
  NODE_ENV: 'development',
};

const { app, close } = await buildServer(cfg);
await app.ready();
const spec = app.swagger();
const out = join(dirname(fileURLToPath(import.meta.url)), '../openapi.json');
writeFileSync(out, JSON.stringify(spec, null, 2));
await close();
// eslint-disable-next-line no-console
console.log(`wrote ${out}`);
