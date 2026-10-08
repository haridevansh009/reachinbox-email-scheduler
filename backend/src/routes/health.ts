import { Router } from 'express';
import { checkDbConnection } from '../db';
import { checkRedisConnection } from '../queue/connection';
import { emailQueue } from '../queue/emailQueue';
import { listActiveSenders } from '../services/senderService';

export const healthRouter = Router();

/**
 * Liveness + readiness. Useful on camera during the restart demo, and as the
 * platform health-check path.
 *
 * Sender count is part of the check on purpose: an instance with zero senders
 * connects to everything successfully but rejects every campaign, so reporting
 * "ok" there would be misleading. That is the state a fresh deploy lands in if
 * seeding never ran.
 */
healthRouter.get('/', async (_req, res) => {
  const [dbOk, redisOk] = await Promise.all([checkDbConnection(), checkRedisConnection()]);

  let counts: Record<string, number> = {};
  try {
    counts = (await emailQueue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'completed',
      'failed',
      'prioritized',
    )) as unknown as Record<string, number>;
  } catch {
    counts = {};
  }

  let senderCount = 0;
  try {
    senderCount = (await listActiveSenders()).length;
  } catch {
    senderCount = 0;
  }

  const connectionsOk = dbOk && redisOk;
  const canSend = senderCount > 0;

  // Connections down = not serving. Connections up but no senders = serving,
  // but unable to do the one thing this service exists for.
  const status = !connectionsOk ? 'error' : canSend ? 'ok' : 'degraded';

  res.status(connectionsOk ? 200 : 503).json({
    status,
    postgres: dbOk ? 'up' : 'down',
    redis: redisOk ? 'up' : 'down',
    activeSenders: senderCount,
    ...(canSend
      ? {}
      : {
          warning:
            'No active senders — campaigns will be rejected. Run `npm run seed`, or set SEED_ON_BOOT=true and redeploy.',
        }),
    queue: counts,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});
