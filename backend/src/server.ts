import type { Worker } from 'bullmq';
import { createApp } from './app';
import { env } from './config/env';
import { closeDb, pool } from './db';
import { runMigrations } from './db/migrate';
import { logger } from './lib/logger';
import { redis } from './queue/connection';
import { closeQueue } from './queue/emailQueue';

/**
 * Node surfaces a failed TCP connect as an AggregateError whose own `message` is
 * empty — the real reason (ECONNREFUSED, ENOTFOUND) lives on the nested errors.
 * Without unwrapping, a connection failure reports literally nothing.
 */
function describeError(err: unknown): string {
  if (err instanceof AggregateError) {
    const inner = err.errors
      .map((e) => describeError(e))
      .filter(Boolean)
      .join('; ');
    return inner || err.message || 'AggregateError with no detail';
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    const parts = [err.message, code ? `(${code})` : ''].filter(Boolean);
    const text = parts.join(' ').trim();
    return text || err.name;
  }
  return String(err);
}

/** Hides the password when echoing a connection string into logs. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<unparseable URL>';
  }
}

/**
 * Checks each backing service separately so a failed boot names the thing that
 * is actually broken. Without this, any dependency failure surfaces as one
 * generic startup error — which is exactly what makes a container crash-loop
 * so painful to debug.
 */
async function preflight(): Promise<void> {
  try {
    await pool.query('SELECT 1');
    logger.info({ url: redactUrl(env.DATABASE_URL) }, 'Postgres reachable');
  } catch (err) {
    const hint =
      'Check DATABASE_URL. Managed Postgres usually needs TLS — set DATABASE_SSL=true.';
    throw new Error(
      `Cannot connect to Postgres at ${redactUrl(env.DATABASE_URL)}. ${hint}\n  Cause: ${describeError(err)}`,
    );
  }

  try {
    await redis.ping();
    logger.info({ url: redactUrl(env.REDIS_URL) }, 'Redis reachable');
  } catch (err) {
    throw new Error(
      `Cannot connect to Redis at ${redactUrl(env.REDIS_URL)}. Check REDIS_URL.\n  Cause: ${describeError(err)}`,
    );
  }
}

/**
 * API entrypoint. By default the BullMQ worker runs as its own process
 * (`npm run start:worker`); set RUN_WORKER_IN_PROCESS=true to co-host it here
 * on platforms that only give you one container.
 */
async function main() {
  await preflight();
  await runMigrations();

  // A deployed container runs `npm start` and nothing else, so the seeder never
  // fires and the senders table stays empty — every campaign would then fail
  // with "No active senders configured". The seeder is idempotent (it skips
  // when senders already exist), so this is safe on every restart.
  if (env.SEED_ON_BOOT) {
    const { seed } = await import('./db/seed');
    try {
      await seed();
    } catch (err) {
      // Don't take the API down over this — the rest of the app still works,
      // and senders can be provisioned later.
      logger.error({ err }, 'SEED_ON_BOOT failed — provision senders manually');
    }
  }

  const app = createApp();
  // Bind 0.0.0.0, not the default: container platforms route to the container's
  // external interface, and a loopback-only bind is reported as an unhealthy deploy.
  const server = app.listen(env.PORT, '0.0.0.0', () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening');
  });

  // A single-container deploy (Railway, Render, Fly) runs one process, so the
  // worker would never start and nothing would ever send. This flag co-hosts it
  // with the API. Locally, and anywhere you can run two processes, leave it off
  // and run `npm run start:worker` separately.
  let inProcessWorker: Worker | null = null;
  if (env.RUN_WORKER_IN_PROCESS) {
    logger.warn('RUN_WORKER_IN_PROCESS is on — starting the BullMQ worker inside the API process');
    const { reconcile } = await import('./workers/reconciler');
    const { createEmailWorker } = await import('./workers/emailWorker');
    if (env.RECONCILE_ON_BOOT) await reconcile();
    inProcessWorker = createEmailWorker();
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down API gracefully');

    server.close(async () => {
      try {
        // Let in-flight sends finish before tearing down — otherwise they are
        // left to the stalled-job reaper, which risks a duplicate send.
        if (inProcessWorker) {
          await inProcessWorker.close();
          const { closeAllTransports } = await import('./services/mailer');
          await closeAllTransports();
        }
        await closeQueue();
        await redis.quit();
        await closeDb();
        logger.info('API shutdown complete');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during API shutdown');
        process.exit(1);
      }
    });

    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // Log through pino AND raw to stderr. Some hosted log viewers collapse or drop
  // structured fields, which turns a real stack trace into a bare
  // "API failed to start" and makes a crash-loop impossible to diagnose.
  logger.error({ err }, 'API failed to start');
  // eslint-disable-next-line no-console
  console.error('\n=== API FAILED TO START ===');
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  // eslint-disable-next-line no-console
  console.error('===========================\n');

  // Give stderr a tick to flush before the process dies.
  setTimeout(() => process.exit(1), 100);
});
