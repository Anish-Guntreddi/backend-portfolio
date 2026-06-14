import { asc } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client.ts';
import { events } from '../../src/db/schema.ts';
import { appendEvent, verifyChain } from '../../src/repo/eventsRepo.ts';
import { resetDb, testConfig } from '../helpers.ts';

const cfg = testConfig();
const { db, pool } = createDb(cfg.DATABASE_URL);

describe('chain integrity under concurrency', () => {
  beforeEach(async () => {
    await resetDb(db);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('stays linear and verifiable when many appends race', async () => {
    const N = 50;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        appendEvent(db, { actor: `u${i % 5}`, action: 'concurrent', resource: 'r', metadata: { i } }),
      ),
    );

    const result = await verifyChain(db);
    expect(result.valid).toBe(true);
    expect(result.checkedCount).toBe(N);

    // No forking: every row links to a distinct predecessor (the advisory lock serialized writers).
    const rows = await db.select().from(events).orderBy(asc(events.id));
    const prevHashes = rows.map((r) => r.prevHash);
    expect(new Set(prevHashes).size).toBe(N);
    // Each non-genesis row's prev_hash equals the previous row's hash.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.prevHash).toBe(rows[i - 1]!.hash);
    }
  });
});
