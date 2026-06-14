import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import { createLogger } from '@portfolio/shared';
import { loadConfig } from './config.ts';
import { createDb } from './db/client.ts';
import { templates } from './db/schema.ts';

const SEEDS = [
  {
    key: 'welcome-email',
    channel: 'email',
    subject: 'Welcome, {{name}}!',
    body: 'Hi {{name}},\n\nWelcome to our platform! Your account ({{email}}) is ready.\n\nCheers,\nThe Team',
  },
  {
    key: 'otp-sms',
    channel: 'sms',
    subject: null,
    body: 'Your one-time code is {{otp}}. It expires in {{expiryMinutes}} minutes.',
  },
];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const log = createLogger('notifycore:seed');
  const cfg = loadConfig();
  const { db, pool } = createDb(cfg.DATABASE_URL);

  let seeded = 0;
  for (const tmpl of SEEDS) {
    const existing = await db
      .select({ id: templates.id })
      .from(templates)
      .where(eq(templates.key, tmpl.key))
      .limit(1);
    if (existing.length > 0) {
      log.info({ key: tmpl.key }, 'template already exists, skipping');
      continue;
    }
    await db.insert(templates).values(tmpl);
    seeded += 1;
    log.info({ key: tmpl.key }, 'seeded template');
  }

  await pool.end();
  log.info({ seeded }, 'seed complete');
  process.exit(0);
}
