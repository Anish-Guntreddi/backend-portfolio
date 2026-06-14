import pino, { type Logger } from 'pino';

/** A pino logger for non-Fastify contexts (schedulers, seed scripts, migrations). */
export function createLogger(name: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({ name, level });
}

export type { Logger };
