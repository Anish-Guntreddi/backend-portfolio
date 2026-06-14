import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createDb } from './client.ts';
import { loadConfig } from '../config.ts';
import { createLogger } from '@portfolio/shared';

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/** Apply all pending migrations against the given connection, then close the pool. */
export async function runMigrations(connectionString: string): Promise<void> {
  const { db, pool } = createDb(connectionString);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}

// Run as a script: `tsx src/db/migrate.ts`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const log = createLogger('notifycore:migrate');
  const cfg = loadConfig();
  runMigrations(cfg.DATABASE_URL)
    .then(() => {
      log.info('migrations applied');
      process.exit(0);
    })
    .catch((err) => {
      log.error({ err }, 'migration failed');
      process.exit(1);
    });
}
