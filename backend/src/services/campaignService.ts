import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { env } from '../config/env';
import { db } from '../db';
import { campaigns, emailJobs, type CampaignRow, type NewEmailJobRow } from '../db/schema';
import { badRequest, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { defaultJobOptions, emailQueue, jobIdFor, type EmailJobPayload } from '../queue/emailQueue';
import { plannedEndAt, plannedSendTime, type PlanInput } from './scheduler';
import { assignSender, listActiveSenders } from './senderService';

/** Rows are written and enqueued in chunks so a huge campaign never builds one giant statement. */
const CHUNK_SIZE = 500;

export interface CreateCampaignInput {
  userId: string;
  subject: string;
  body: string;
  recipients: string[];
  startAt: Date;
  minDelayMs?: number;
  hourlyLimit?: number;
}

export interface CreateCampaignResult {
  campaign: CampaignRow;
  totalRecipients: number;
  plannedEndAt: Date;
  senderCount: number;
  effectiveMinDelayMs: number;
  effectiveHourlyLimit: number;
}

/**
 * Env values are the defaults AND the hard limits; the compose form may request
 * different values but they are clamped. This keeps the "configurable via env,
 * no hardcoding" requirement true while still honouring the UI controls.
 */
export function clampMinDelay(requested?: number): number {
  if (requested === undefined || Number.isNaN(requested)) return env.MIN_DELAY_MS;
  return Math.max(env.MIN_DELAY_MS_FLOOR, Math.floor(requested));
}

export function clampHourlyLimit(requested?: number): number {
  if (requested === undefined || Number.isNaN(requested)) return env.MAX_EMAILS_PER_HOUR_PER_SENDER;
  return Math.min(env.MAX_EMAILS_PER_HOUR_PER_SENDER_CEILING, Math.max(1, Math.floor(requested)));
}

export async function createCampaign(input: CreateCampaignInput): Promise<CreateCampaignResult> {
  if (input.recipients.length === 0) {
    throw badRequest('No valid email addresses were found in the uploaded file.');
  }
  if (input.recipients.length > env.MAX_RECIPIENTS_PER_CAMPAIGN) {
    throw badRequest(
      `Too many recipients (${input.recipients.length}). Maximum is ${env.MAX_RECIPIENTS_PER_CAMPAIGN}.`,
    );
  }

  const activeSenders = await listActiveSenders();
  if (activeSenders.length === 0) {
    throw badRequest('No active senders configured. Run `npm run seed` on the backend first.');
  }
  const senderIds = activeSenders.map((s) => s.id);

  const minDelayMs = clampMinDelay(input.minDelayMs);
  const hourlyLimit = clampHourlyLimit(input.hourlyLimit);

  const plan: PlanInput = {
    startAt: input.startAt,
    totalRecipients: input.recipients.length,
    minDelayMs,
    hourlyLimit,
    senderCount: senderIds.length,
  };

  const campaignId = randomUUID();
  const endAt = plannedEndAt(plan);

  // Status starts at 'building'. Only once every row is inserted does it become
  // 'scheduled' — the reconciler ignores 'building' campaigns so a crash
  // mid-insert can never half-send a campaign.
  const [campaign] = await db
    .insert(campaigns)
    .values({
      id: campaignId,
      userId: input.userId,
      subject: input.subject,
      body: input.body,
      startAt: input.startAt,
      minDelayMs,
      hourlyLimit,
      totalRecipients: input.recipients.length,
      status: 'building',
      plannedEndAt: endAt,
    })
    .returning();

  if (!campaign) throw new Error('Failed to create campaign');

  const rows: NewEmailJobRow[] = input.recipients.map((email, index) => ({
    id: randomUUID(),
    campaignId,
    userId: input.userId,
    senderId: assignSender(index, senderIds),
    recipientEmail: email,
    sequenceIndex: index,
    status: 'scheduled',
    scheduledAt: plannedSendTime(index, plan),
  }));

  // 1. Persist first. Postgres is the source of truth; Redis is a rebuildable index.
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    await db.insert(emailJobs).values(rows.slice(i, i + CHUNK_SIZE)).onConflictDoNothing();
  }

  // 2. Then enqueue. If the PROCESS DIES between 1 and 2, the campaign stays
  //    'building' and the boot reconciler deliberately ignores it, so a partial
  //    campaign can never half-send.
  //
  //    An enqueue ERROR is different: we are still alive and must not leave rows
  //    stranded in 'scheduled' with no job behind them — they would sit in the
  //    dashboard forever claiming they are going to send. Roll the campaign back.
  const now = Date.now();
  try {
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      await emailQueue.addBulk(
        chunk.map((row) => ({
          name: 'send-email',
          data: {
            emailJobId: row.id!,
            campaignId,
            senderId: row.senderId,
            sequenceIndex: row.sequenceIndex,
          } satisfies EmailJobPayload,
          opts: {
            jobId: jobIdFor(row.id!),
            ...defaultJobOptions(row.scheduledAt.getTime() - now, row.sequenceIndex),
          },
        })),
      );
    }
  } catch (err) {
    logger.error({ err, campaignId }, 'Enqueue failed — rolling campaign back');

    await db
      .update(emailJobs)
      .set({ status: 'cancelled', lastError: 'Enqueue failed', updatedAt: new Date() })
      .where(and(eq(emailJobs.campaignId, campaignId), eq(emailJobs.status, 'scheduled')));

    await db
      .update(campaigns)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(campaigns.id, campaignId));

    // Best-effort removal of anything that did make it into Redis.
    for (const row of rows) {
      await emailQueue
        .getJob(jobIdFor(row.id!))
        .then((job) => job?.remove())
        .catch(() => undefined);
    }

    throw err;
  }

  const [updated] = await db
    .update(campaigns)
    .set({ status: 'scheduled', updatedAt: new Date() })
    .where(eq(campaigns.id, campaignId))
    .returning();

  logger.info(
    {
      campaignId,
      recipients: rows.length,
      senders: senderIds.length,
      minDelayMs,
      hourlyLimit,
      startAt: input.startAt.toISOString(),
      plannedEndAt: endAt.toISOString(),
    },
    'Campaign scheduled',
  );

  return {
    campaign: updated ?? campaign,
    totalRecipients: rows.length,
    plannedEndAt: endAt,
    senderCount: senderIds.length,
    effectiveMinDelayMs: minDelayMs,
    effectiveHourlyLimit: hourlyLimit,
  };
}

export async function listCampaigns(userId: string, limit = 50) {
  return db
    .select()
    .from(campaigns)
    .where(eq(campaigns.userId, userId))
    .orderBy(desc(campaigns.createdAt))
    .limit(limit);
}

export async function getCampaign(userId: string, campaignId: string) {
  const rows = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .limit(1);

  const campaign = rows[0];
  if (!campaign) throw notFound('Campaign not found');

  const breakdown = await db
    .select({ status: emailJobs.status, total: count() })
    .from(emailJobs)
    .where(eq(emailJobs.campaignId, campaignId))
    .groupBy(emailJobs.status);

  return { campaign, breakdown };
}

/** Cancels every not-yet-sent recipient and removes their delayed jobs from Redis. */
export async function cancelCampaign(userId: string, campaignId: string) {
  const rows = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .limit(1);
  if (!rows[0]) throw notFound('Campaign not found');

  const pending = await db
    .select({ id: emailJobs.id })
    .from(emailJobs)
    .where(and(eq(emailJobs.campaignId, campaignId), inArray(emailJobs.status, ['scheduled'])));

  await db
    .update(emailJobs)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(emailJobs.campaignId, campaignId), inArray(emailJobs.status, ['scheduled'])));

  await db
    .update(campaigns)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(campaigns.id, campaignId));

  let removed = 0;
  for (const row of pending) {
    const job = await emailQueue.getJob(jobIdFor(row.id));
    if (job) {
      await job.remove().catch(() => undefined);
      removed += 1;
    }
  }

  logger.info({ campaignId, cancelled: pending.length, jobsRemoved: removed }, 'Campaign cancelled');
  return { cancelled: pending.length, jobsRemoved: removed };
}

/** Marks a campaign completed once no recipient is still pending. */
export async function refreshCampaignCompletion(campaignId: string): Promise<void> {
  const [pending] = await db
    .select({ total: count() })
    .from(emailJobs)
    .where(
      and(eq(emailJobs.campaignId, campaignId), inArray(emailJobs.status, ['scheduled', 'processing'])),
    );

  if ((pending?.total ?? 0) === 0) {
    await db
      .update(campaigns)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, 'scheduled')));
  }
}
