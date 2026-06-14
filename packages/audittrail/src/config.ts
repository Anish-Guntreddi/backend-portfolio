import { z } from 'zod';
import { loadEnv } from '@portfolio/shared';

const EnvSchema = z.object({
  /** Owner connection: migrations, runtime queries, tests. */
  DATABASE_URL: z.string().url(),
  /** Least-privilege role connection used only by the append-only integration test. */
  APP_DATABASE_URL: z.string().url().optional(),
  API_KEY: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  ALERT_EVAL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  NODE_ENV: z.string().default('development'),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  return loadEnv(EnvSchema, source);
}
