import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createPool, type Pool } from '@portfolio/shared';
import * as schema from './schema.ts';

export type Db = NodePgDatabase<typeof schema>;

/** Build a Drizzle client (and its underlying pool) for a connection string. */
export function createDb(connectionString: string): { db: Db; pool: Pool } {
  const pool = createPool(connectionString);
  const db = drizzle(pool, { schema });
  return { db, pool };
}
