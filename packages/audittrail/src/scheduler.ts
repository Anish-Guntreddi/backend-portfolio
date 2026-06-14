import { createLogger } from '@portfolio/shared';
import type { Db } from './db/client.ts';
import { evaluateRules } from './repo/alertsRepo.ts';

export interface Scheduler {
  stop: () => void;
}

/**
 * Periodically evaluate alert rules in-process. Ticks are non-overlapping (a slow evaluation is
 * skipped rather than queued) and the timer is unref'd so it never holds the process open by itself.
 */
export function startAlertScheduler(db: Db, intervalSeconds: number): Scheduler {
  const log = createLogger('audittrail:scheduler');
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const fired = await evaluateRules(db);
      if (fired.length > 0) log.info({ count: fired.length }, 'alerts triggered');
    } catch (err) {
      log.error({ err }, 'alert evaluation failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalSeconds * 1000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
