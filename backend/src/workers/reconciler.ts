import { env } from '../config/env';
import { logger } from '../lib/logger';
import { defaultJobOptions, emailQueue, jobIdFor, type EmailJobPayload } from '../queue/emailQueue';
import { findPendingEmailJobs, resetStaleProcessing } from '../services/emailService';

export interface ReconcileReport {
  pendingInDb: number;
  staleReset: number;
  requeued: number;
  alreadyQueued: number;
  overdue: number;
  durationMs: number;
}

/**
 * Rebuilds queue state from the database on boot.
 *
 * Redis AOF persistence alone is only half an answer — Redis can still be
 * flushed, restored from an older snapshot, or brought up empty. Postgres is the
 * source of truth and Redis is a rebuildable index, so on every worker start we
 * walk every pending row and make sure it has a live BullMQ job.
 *
 * This is safe to run repeatedly: job ids are deterministic (`email:<uuid>`), so
 * re-adding an existing job is a no-op in BullMQ. That is what guarantees a
 * restart never duplicates or re-sends mail.
 */
export async function reconcile(): Promise<ReconcileReport> {
  const startedAt = Date.now();

  // Rows whose worker was killed mid-send. Only rows with no provider receipt
  // are reset, so a message that was actually accepted is never re-sent.
  const stale = await resetStaleProcessing(env.STALE_PROCESSING_MS);
  if (stale.length > 0) {
    logger.warn({ count: stale.length }, 'Reset stale `processing` rows abandoned by a dead worker');
  }

  const pending = await findPendingEmailJobs();

  let requeued = 0;
  let alreadyQueued = 0;
  let overdue = 0;
  const now = Date.now();

  for (const row of pending) {
    const jobId = jobIdFor(row.id);

    const existing = await emailQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState().catch(() => 'unknown');
      // A job sitting in `completed`/`failed` is retained only to keep its id
      // reserved; the DB says this row is still pending, so it needs a fresh job.
      if (state === 'delayed' || state === 'waiting' || state === 'active' || state === 'prioritized') {
        alreadyQueued += 1;
        continue;
      }
      await existing.remove().catch(() => undefined);
    }

    const delay = row.scheduledAt.getTime() - now;
    // Past-due while the server was down: send immediately rather than skipping.
    if (delay <= 0) overdue += 1;

    await emailQueue.add(
      'send-email',
      {
        emailJobId: row.id,
        campaignId: row.campaignId,
        senderId: row.senderId,
        sequenceIndex: row.sequenceIndex,
      } satisfies EmailJobPayload,
      { jobId, ...defaultJobOptions(delay, row.sequenceIndex) },
    );
    requeued += 1;
  }

  const report: ReconcileReport = {
    pendingInDb: pending.length,
    staleReset: stale.length,
    requeued,
    alreadyQueued,
    overdue,
    durationMs: Date.now() - startedAt,
  };

  logger.info(report, 'Reconciliation complete');
  return report;
}
