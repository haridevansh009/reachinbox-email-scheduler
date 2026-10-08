import { DelayedError, UnrecoverableError, Worker, type Job } from 'bullmq';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { createRedisConnection } from '../queue/connection';
import { QUEUE_NAME, type EmailJobPayload } from '../queue/emailQueue';
import { refreshCampaignCompletion } from '../services/campaignService';
import {
  claimEmailJob,
  incrementAttempt,
  markEmailFailed,
  markEmailSent,
  releaseEmailJob,
} from '../services/emailService';
import { sendEmail } from '../services/mailer';
import { acquireSendSlot } from '../services/rateLimiter';
import { rescheduleDelayMs } from '../services/scheduler';

export interface ProcessResult {
  status: 'sent' | 'skipped' | 'failed';
  reason?: string;
  messageId?: string;
}

/**
 * SMTP errors in the 5xx range are the provider saying "never going to work" —
 * a bad recipient, a rejected sender. Retrying wastes quota, so fail immediately.
 */
function isPermanentSmtpError(err: unknown): boolean {
  const code = (err as { responseCode?: number })?.responseCode;
  if (typeof code === 'number' && code >= 500 && code < 600) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /invalid recipient|no such user|mailbox unavailable/i.test(message);
}

export async function processEmailJob(
  job: Job<EmailJobPayload>,
  token?: string,
): Promise<ProcessResult> {
  const { emailJobId } = job.data;
  const log = logger.child({ emailJobId, jobId: job.id, attempt: job.attemptsMade + 1 });

  // ── 1. Claim ───────────────────────────────────────────────────────────────
  // Must happen before the rate-limit check so a duplicate delivery never
  // consumes a quota slot that a real send needs.
  const claim = await claimEmailJob(emailJobId);

  if (!claim.ok) {
    // Every non-claim path is a success from the queue's perspective: the row is
    // already in a terminal state, so re-running must not retry or error.
    log.info({ reason: claim.reason, status: claim.status }, 'Skipping job');
    return { status: 'skipped', reason: claim.reason };
  }

  const { email, subject, body, minDelayMs, hourlyLimit, campaignStatus } = claim.job;

  if (campaignStatus === 'cancelled') {
    await markEmailFailed(emailJobId, 'Campaign cancelled', true);
    return { status: 'skipped', reason: 'campaign_cancelled' };
  }

  // ── 2. Rate limit ──────────────────────────────────────────────────────────
  const decision = await acquireSendSlot({
    senderId: email.senderId,
    minDelayMs,
    hourlyLimit,
  });

  if (!decision.allowed) {
    const delayMs = rescheduleDelayMs({
      reason: decision.reason === 'quota' ? 'quota' : 'gap',
      retryAfterMs: decision.retryAfterMs,
      sequenceIndex: email.sequenceIndex,
      hourlyLimit,
      minDelayMs,
    });
    const nextAt = new Date(Date.now() + delayMs);

    // Hand the claim back so another worker (or this one) can pick it up later.
    await releaseEmailJob(emailJobId, nextAt);

    log.debug(
      { reason: decision.reason, delayMs, nextAt: nextAt.toISOString(), senderId: email.senderId },
      'Rate limited — deferring job',
    );

    if (token) {
      // Delays THIS job only, so other senders keep flowing at full speed.
      // Crucially this does not increment attemptsMade: a throttled job never
      // exhausts its retries and never lands in `failed`.
      await job.moveToDelayed(nextAt.getTime(), token);
      throw new DelayedError();
    }

    // No token (direct invocation in a test): report without mutating the queue.
    return { status: 'skipped', reason: `rate_limited_${decision.reason}` };
  }

  // ── 3. Send ────────────────────────────────────────────────────────────────
  await incrementAttempt(emailJobId);

  try {
    const result = await sendEmail({
      senderId: email.senderId,
      to: email.recipientEmail,
      subject,
      body,
    });

    await markEmailSent(emailJobId, {
      messageId: result.messageId,
      previewUrl: result.previewUrl,
    });

    await refreshCampaignCompletion(email.campaignId);

    log.info(
      { to: email.recipientEmail, senderId: email.senderId, previewUrl: result.previewUrl },
      'Email sent',
    );

    return { status: 'sent', messageId: result.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const permanent = isPermanentSmtpError(err);
    const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? env.JOB_ATTEMPTS);

    await markEmailFailed(emailJobId, message, permanent || lastAttempt);

    if (permanent || lastAttempt) {
      await refreshCampaignCompletion(email.campaignId);
    }

    log.error({ err, permanent, lastAttempt }, 'Email send failed');

    if (permanent) throw new UnrecoverableError(message);
    throw err;
  }
}

export function createEmailWorker(): Worker<EmailJobPayload, ProcessResult> {
  const connection = createRedisConnection('worker');

  const worker = new Worker<EmailJobPayload, ProcessResult>(
    QUEUE_NAME,
    (job, token) => processEmailJob(job, token),
    {
      connection,
      concurrency: env.WORKER_CONCURRENCY,
      // Lock must comfortably exceed the slowest SMTP round-trip, or BullMQ will
      // consider a healthy in-flight job stalled and hand it to a second worker.
      lockDuration: 60_000,
      stalledInterval: 30_000,
      maxStalledCount: 2,
    },
  );

  worker.on('completed', (job, result) => {
    logger.debug({ jobId: job.id, result }, 'Job completed');
  });

  worker.on('failed', (job, err) => {
    if (err instanceof DelayedError) return; // deliberate deferral, not a failure
    logger.warn({ jobId: job?.id, err: err.message }, 'Job failed');
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'Worker error');
  });

  return worker;
}
