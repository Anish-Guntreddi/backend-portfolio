import { sql } from 'drizzle-orm';
import type { Db } from '../src/db/client.ts';
import { loadConfig, type Config } from '../src/config.ts';

export function testConfig(): Config {
  return loadConfig();
}

/**
 * Reset all tables to a clean, deterministic state (ids restart at 1).
 * No triggers to worry about — just TRUNCATE.
 */
export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`TRUNCATE flags, flag_audit RESTART IDENTITY CASCADE`);
}
