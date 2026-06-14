import { sql } from 'drizzle-orm';
import { Queue } from 'bullmq';
import type { Db } from '../src/db/client.ts';
import { loadConfig, type Config } from '../src/config.ts';
import type { NotificationJobData } from '../src/queue.ts';

export function testConfig(): Config {
  return loadConfig();
}

/**
 * Reset all tables to a clean, deterministic state (ids restart at 1).
 */
export async function resetDb(db: Db): Promise<void> {
  await db.execute(
    sql`TRUNCATE notifications, templates, preferences RESTART IDENTITY CASCADE`,
  );
}

function parseRedisUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port) || 6379 };
}

/**
 * Create a BullMQ Queue with a unique name for a test run.
 * Using per-run names prevents cross-test job leakage.
 * The caller is responsible for calling `obliterateQueue(queue)` in afterEach/afterAll.
 */
export function createTestQueue(redisUrl: string, suffix?: string): Queue<NotificationJobData> {
  const name = `notifycore-test-${Date.now()}${suffix ? `-${suffix}` : ''}`;
  return new Queue<NotificationJobData>(name, {
    connection: parseRedisUrl(redisUrl),
  });
}

/**
 * Obliterate the queue (removes all jobs) and close it.
 */
export async function obliterateQueue(queue: Queue): Promise<void> {
  try {
    await queue.obliterate({ force: true });
  } catch {
    // best effort — may already be empty
  }
  await queue.close();
}
