import { Queue, type JobsOptions } from 'bullmq';
import { env } from '../config/env';
import { createRedisConnection } from './connection';

export interface EmailJobPayload {
  /** Only the row id travels through Redis — never the subject/body. */
  emailJobId: string;
  campaignId: string;
  senderId: string;
  sequenceIndex: number;
}

export const QUEUE_NAME = env.QUEUE_NAME;

const queueConnection = createRedisConnection('queue');

export const emailQueue = new Queue<EmailJobPayload>(QUEUE_NAME, {
  connection: queueConnection,
});

/**
 * Deterministic job id — idempotency layer 1.
 * Re-adding the same id is a no-op in BullMQ, which is what makes the boot
 * reconciler safe to run repeatedly.
 *
 * A hyphen, not a colon: BullMQ v5 reserves `:` as its Redis key separator and
 * rejects custom ids containing it.
 */
export const jobIdFor = (emailJobId: string) => `email-${emailJobId}`;

export function defaultJobOptions(delayMs: number, sequenceIndex: number): JobsOptions {
  return {
    delay: Math.max(0, Math.round(delayMs)),
    attempts: env.JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: env.JOB_BACKOFF_MS },
    // Completed jobs are retained so their deterministic id stays reserved.
    // With removeOnComplete:true the id frees up immediately and idempotency
    // layer 1 would stop protecting against a duplicate re-enqueue.
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: { age: 604_800 },
    // Lower number = higher priority. Preserves CSV order when a batch of jobs
    // is promoted from delayed to waiting at the same instant.
    priority: Math.min(sequenceIndex + 1, 2_097_151),
  };
}

export async function closeQueue(): Promise<void> {
  await emailQueue.close();
  await queueConnection.quit();
}
