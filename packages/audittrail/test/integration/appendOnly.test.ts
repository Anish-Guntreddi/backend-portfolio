import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb } from '../../src/db/client.ts';
import { appendEvent, verifyChain } from '../../src/repo/eventsRepo.ts';
import { resetDb, testConfig } from '../helpers.ts';

const cfg = testConfig();
const owner = createDb(cfg.DATABASE_URL);

/**
 * Drizzle wraps driver errors: its own `.message` is "Failed query: …" and the real Postgres error
 * (the trigger's RAISE or a grant-level "permission denied") is in `.cause`. Flatten the whole
 * Error cause chain so assertions can match the underlying reason.
 */
async function rejectionChain(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '<<did not throw>>';
  } catch (e) {
    const parts: string[] = [];
    let cur: unknown = e;
    while (cur instanceof Error) {
      parts.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    }
    return parts.join(' | ');
  }
}

describe('append-only enforcement & tamper evidence', () => {
  beforeEach(async () => {
    await resetDb(owner.db);
  });
  afterAll(async () => {
    await owner.pool.end();
  });

  it('rejects UPDATE and DELETE via the trigger, even as the table owner', async () => {
    await appendEvent(owner.db, { actor: 'alice', action: 'login', resource: 'auth' });

    expect(
      await rejectionChain(owner.db.execute(sql`UPDATE events SET actor = 'evil' WHERE id = 1`)),
    ).toMatch(/append-only/i);
    expect(
      await rejectionChain(owner.db.execute(sql`DELETE FROM events WHERE id = 1`)),
    ).toMatch(/append-only/i);
  });

  it('rejects TRUNCATE of the events log (even as the table owner)', async () => {
    await appendEvent(owner.db, { actor: 'alice', action: 'login', resource: 'auth' });
    expect(await rejectionChain(owner.db.execute(sql`TRUNCATE events`))).toMatch(/append-only/i);
    // The row is still there.
    expect((await verifyChain(owner.db)).checkedCount).toBe(1);
  });

  it('lets the least-privilege app role INSERT but denies UPDATE/DELETE at the grant level', async () => {
    expect(cfg.APP_DATABASE_URL, 'APP_DATABASE_URL must be set for this test').toBeTruthy();
    const app = createDb(cfg.APP_DATABASE_URL!);
    try {
      // The app role can append…
      await appendEvent(app.db, { actor: 'alice', action: 'login', resource: 'auth' });
      // …but cannot mutate (permission denied fires before the trigger even runs).
      expect(
        await rejectionChain(app.db.execute(sql`UPDATE events SET actor = 'evil' WHERE id = 1`)),
      ).toMatch(/permission denied|append-only/i);
      expect(
        await rejectionChain(app.db.execute(sql`DELETE FROM events WHERE id = 1`)),
      ).toMatch(/permission denied|append-only/i);
    } finally {
      await app.pool.end();
    }
  });

  it('verifies an intact chain and detects out-of-band content tampering', async () => {
    await appendEvent(owner.db, { actor: 'alice', action: 'login', resource: 'auth', metadata: { v: 1 } });
    await appendEvent(owner.db, { actor: 'bob', action: 'logout', resource: 'auth' });

    expect((await verifyChain(owner.db)).valid).toBe(true);

    // Simulate a privileged/storage-level attacker who bypasses the trigger.
    await owner.db.execute(sql`ALTER TABLE events DISABLE TRIGGER events_append_only`);
    await owner.db.execute(sql`UPDATE events SET actor = 'evil' WHERE id = 1`);
    await owner.db.execute(sql`ALTER TABLE events ENABLE TRIGGER events_append_only`);

    const result = await verifyChain(owner.db);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.brokenAtId).toBe(1);
      expect(result.reason).toBe('content_tampered');
    }
  });

  it('detects chain re-linking tampering (prev_hash mismatch)', async () => {
    await appendEvent(owner.db, { actor: 'a', action: 'x', resource: 'r' });
    await appendEvent(owner.db, { actor: 'b', action: 'y', resource: 's' });

    // Corrupt the second row's prev_hash so it no longer links to row 1.
    await owner.db.execute(sql`ALTER TABLE events DISABLE TRIGGER events_append_only`);
    await owner.db.execute(sql`UPDATE events SET prev_hash = ${'f'.repeat(64)} WHERE id = 2`);
    await owner.db.execute(sql`ALTER TABLE events ENABLE TRIGGER events_append_only`);

    const result = await verifyChain(owner.db);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.brokenAtId).toBe(2);
      expect(result.reason).toBe('prev_hash_mismatch');
    }
  });
});
