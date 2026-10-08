import { Router } from 'express';
import { env } from '../config/env';
import { requireAuth } from '../middleware/auth';
import { peekSenderUsage } from '../services/rateLimiter';
import { listActiveSenders } from '../services/senderService';

export const sendersRouter = Router();

/**
 * Exposes each sender's live hourly consumption straight from the Redis
 * counters the limiter uses — handy for demonstrating rate limiting under load.
 * SMTP credentials are never returned.
 */
sendersRouter.get('/', requireAuth, async (_req, res, next) => {
  try {
    const rows = await listActiveSenders();

    const items = await Promise.all(
      rows.map(async (s) => ({
        id: s.id,
        label: s.label,
        fromEmail: s.fromEmail,
        fromName: s.fromName,
        isActive: s.isActive,
        hourlyLimit: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
        usedThisHour: await peekSenderUsage(s.id),
      })),
    );

    res.json({
      items,
      config: {
        minDelayMs: env.MIN_DELAY_MS,
        hourlyLimitPerSender: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
        hourlyLimitCeiling: env.MAX_EMAILS_PER_HOUR_PER_SENDER_CEILING,
        minDelayFloorMs: env.MIN_DELAY_MS_FLOOR,
        workerConcurrency: env.WORKER_CONCURRENCY,
        dryRun: env.DRY_RUN,
      },
    });
  } catch (err) {
    next(err);
  }
});
