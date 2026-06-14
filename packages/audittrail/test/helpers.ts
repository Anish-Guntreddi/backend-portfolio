import { sql } from 'drizzle-orm';
import type { Db } from '../src/db/client.ts';
import { loadConfig, type Config } from '../src/config.ts';

export function testConfig(): Config {
  return loadConfig();
}

/**
 * Reset all tables to a clean, deterministic state (ids restart at 1). TRUNCATE on `events` is
 * blocked by the append-only guard, so disable user triggers for the duration of the reset — a
 * privileged setup step, exactly what a test harness is.
 */
export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`ALTER TABLE events DISABLE TRIGGER USER`);
  await db.execute(sql`TRUNCATE events, alerts, alert_rules RESTART IDENTITY CASCADE`);
  await db.execute(sql`ALTER TABLE events ENABLE TRIGGER USER`);
}
