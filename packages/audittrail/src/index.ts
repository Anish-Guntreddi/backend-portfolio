import { createLogger } from '@portfolio/shared';
import { loadConfig } from './config.ts';
import { buildServer } from './server.ts';
import { startAlertScheduler } from './scheduler.ts';

const log = createLogger('audittrail');
const cfg = loadConfig();

const { app, db, close } = await buildServer(cfg);
const scheduler = startAlertScheduler(db, cfg.ALERT_EVAL_INTERVAL_SECONDS);

const shutdown = async (signal: string) => {
  log.info({ signal }, 'shutting down');
  scheduler.stop();
  await close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: cfg.PORT, host: cfg.HOST });
} catch (err) {
  log.error({ err }, 'failed to start');
  await close();
  process.exit(1);
}
