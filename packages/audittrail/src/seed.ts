import { createLogger } from '@portfolio/shared';
import { loadConfig } from './config.ts';
import { createDb } from './db/client.ts';
import { appendEvent } from './repo/eventsRepo.ts';
import { createRule, evaluateRules } from './repo/alertsRepo.ts';

const log = createLogger('audittrail:seed');
const cfg = loadConfig();
const { db, pool } = createDb(cfg.DATABASE_URL);

const actors = ['alice', 'bob', 'carol'];

try {
  // Normal activity.
  for (let i = 0; i < 20; i++) {
    await appendEvent(db, {
      actor: actors[i % actors.length]!,
      action: i % 5 === 0 ? 'login.success' : 'document.view',
      resource: `doc:${i % 4}`,
      ip: `203.0.113.${i % 254}`,
      metadata: { seq: i },
    });
  }

  // A burst of failed logins by one actor — enough to trip a brute-force rule.
  for (let i = 0; i < 6; i++) {
    await appendEvent(db, {
      actor: 'mallory',
      action: 'login.failed',
      resource: 'auth',
      ip: '198.51.100.7',
      metadata: { attempt: i + 1 },
    });
  }

  const rule = await createRule(db, {
    name: 'Brute-force logins',
    matchAction: 'login.failed',
    threshold: 5,
    windowSeconds: 300,
    groupByActor: true,
  });

  const fired = await evaluateRules(db);
  log.info({ ruleId: rule.id, alerts: fired.length }, 'seed complete');
} catch (err) {
  log.error({ err }, 'seed failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
