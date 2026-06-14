import { createLogger } from '@portfolio/shared';
import { loadConfig } from './config.ts';
import { buildServer } from './server.ts';

const log = createLogger('flagforge');
const cfg = loadConfig();

const { app, close } = await buildServer(cfg);

const shutdown = async (signal: string) => {
  log.info({ signal }, 'shutting down');
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
