import { z } from 'zod';
import { loadEnv } from '@portfolio/shared';

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().min(1),
  API_KEY: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8082),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  NODE_ENV: z.string().default('development'),
  RETRY_BASE_MS: z.coerce.number().int().positive().default(1000),
  DEFAULT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  return loadEnv(EnvSchema, source);
}
