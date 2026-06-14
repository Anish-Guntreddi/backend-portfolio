import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client.ts';
import { appendEvent } from '../../src/repo/eventsRepo.ts';
import { createRule, evaluateRules, listAlerts } from '../../src/repo/alertsRepo.ts';
import { resetDb, testConfig } from '../helpers.ts';

const cfg = testConfig();
const { db, pool } = createDb(cfg.DATABASE_URL);

describe('alert rule evaluation', () => {
  beforeEach(async () => {
    await resetDb(db);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('triggers a per-actor alert at threshold and dedupes within the window', async () => {
    await createRule(db, {
      name: 'brute-force',
      matchAction: 'login.failed',
      threshold: 3,
      windowSeconds: 300,
      groupByActor: true,
    });

    for (let i = 0; i < 3; i++) {
      await appendEvent(db, { actor: 'mallory', action: 'login.failed', resource: 'auth' });
    }
    await appendEvent(db, { actor: 'alice', action: 'login.failed', resource: 'auth' }); // below threshold

    const fired = await evaluateRules(db);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.actor).toBe('mallory');
    expect(fired[0]!.matchedCount).toBe(3);

    // Re-evaluating in the same window must not re-fire (dedupe).
    expect(await evaluateRules(db)).toHaveLength(0);

    const all = await listAlerts(db);
    expect(all).toHaveLength(1);
  });

  it('supports across-all-actors rules (null actor)', async () => {
    await createRule(db, {
      name: 'too many deletes',
      matchAction: 'document.delete',
      threshold: 4,
      windowSeconds: 300,
      groupByActor: false,
    });

    for (let i = 0; i < 4; i++) {
      await appendEvent(db, { actor: `u${i}`, action: 'document.delete', resource: `doc:${i}` });
    }

    const fired = await evaluateRules(db);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.actor).toBeNull();
    expect(fired[0]!.matchedCount).toBe(4);
  });

  it('does not fire when below threshold', async () => {
    await createRule(db, {
      name: 'brute-force',
      matchAction: 'login.failed',
      threshold: 5,
      windowSeconds: 300,
      groupByActor: true,
    });
    await appendEvent(db, { actor: 'mallory', action: 'login.failed', resource: 'auth' });
    expect(await evaluateRules(db)).toHaveLength(0);
  });
});
