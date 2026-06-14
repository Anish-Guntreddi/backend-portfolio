import pg from 'pg';

const { Pool } = pg;

/** Create a configured Postgres connection pool. One pool per service process. */
export function createPool(connectionString: string, config: pg.PoolConfig = {}): pg.Pool {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...config,
  });
}

export type { Pool } from 'pg';
