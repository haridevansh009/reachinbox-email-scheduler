import { env } from '../config/env';
import { closeDb } from '../db';
import { logger } from '../lib/logger';
import { closeQueue } from '../queue/emailQueue';
import { redis } from '../queue/connection';
import { closeAllTransports } from '../services/mailer';
import { createEmailWorker } from './emailWorker';
import { reconcile } from './reconciler';

/**
 * Worker entrypoint — runs as its own process, separate from the API.
 * That separation is what lets you restart either half independently and is how
 * the "kill the worker, restart it, future emails still send" demo works.
 */
async function main() {
  logger.info(
    {
      concurrency: env.WORKER_CONCURRENCY,
      minDelayMs: env.MIN_DELAY_MS,
      hourlyLimitPerSender: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
      dryRun: env.DRY_RUN,
    },
    'Starting email worker',
  );

  if (env.RECONCILE_ON_BOOT) {
    await reconcile();
  }

  const worker = createEmailWorker();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down worker gracefully');

    try {
      // Waits for in-flight sends to finish instead of leaving them to the
      // stalled-job reaper — this is what prevents duplicate sends on restart.
      await worker.close();
      await closeAllTransports();
      await closeQueue();
      await redis.quit();
      await closeDb();
      logger.info('Worker shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during worker shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Worker failed to start');
  process.exit(1);
});
