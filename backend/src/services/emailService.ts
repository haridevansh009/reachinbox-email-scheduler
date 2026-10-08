import { and, asc, count, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import { campaigns, emailJobs, type EmailJobRow, type EmailStatus } from '../db/schema';

export interface EmailListItem {
  id: string;
  campaignId: string;
  recipientEmail: string;
  subject: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  senderId: string;
  attemptCount: number;
  lastError: string | null;
  previewUrl: string | null;
  sequenceIndex: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const toListItem = (row: { email: EmailJobRow; subject: string }): EmailListItem => ({
  id: row.email.id,
  campaignId: row.email.campaignId,
  recipientEmail: row.email.recipientEmail,
  subject: row.subject,
  status: row.email.status as EmailStatus,
  scheduledAt: row.email.scheduledAt.toISOString(),
  sentAt: row.email.sentAt ? row.email.sentAt.toISOString() : null,
  senderId: row.email.senderId,
  attemptCount: row.email.attemptCount,
  lastError: row.email.lastError,
  previewUrl: row.email.previewUrl,
  sequenceIndex: row.email.sequenceIndex,
});

export interface ListEmailsParams {
  userId: string;
  /** 'scheduled' tab shows pending work; 'sent' tab shows terminal outcomes. */
  view: 'scheduled' | 'sent';
  page: number;
  pageSize: number;
  campaignId?: string;
}

const VIEW_STATUSES: Record<ListEmailsParams['view'], EmailStatus[]> = {
  scheduled: ['scheduled', 'processing'],
  sent: ['sent', 'failed'],
};

export async function listEmails(params: ListEmailsParams): Promise<Paginated<EmailListItem>> {
  const statuses = VIEW_STATUSES[params.view];
  const offset = (params.page - 1) * params.pageSize;

  const filters = [
    eq(emailJobs.userId, params.userId),
    inArray(emailJobs.status, statuses),
    // A 'building' campaign was abandoned mid-insert; the reconciler ignores it,
    // so its rows will never send and must not appear as if they will.
    ne(campaigns.status, 'building'),
  ];
  if (params.campaignId) filters.push(eq(emailJobs.campaignId, params.campaignId));
  const where = and(...filters);

  const [totalRow] = await db
    .select({ total: count() })
    .from(emailJobs)
    .innerJoin(campaigns, eq(campaigns.id, emailJobs.campaignId))
    .where(where);
  const total = totalRow?.total ?? 0;

  const rows = await db
    .select({ email: emailJobs, subject: campaigns.subject })
    .from(emailJobs)
    .innerJoin(campaigns, eq(campaigns.id, emailJobs.campaignId))
    .where(where)
    // Scheduled reads chronologically forward (what sends next);
    // Sent reads newest-first (what just happened).
    .orderBy(
      params.view === 'scheduled'
        ? asc(emailJobs.scheduledAt)
        : desc(sql`coalesce(${emailJobs.sentAt}, ${emailJobs.updatedAt})`),
    )
    .limit(params.pageSize)
    .offset(offset);

  return {
    items: rows.map(toListItem),
    total,
    page: params.page,
    pageSize: params.pageSize,
    totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
  };
}

export async function getUserStats(userId: string) {
  const rows = await db
    .select({ status: emailJobs.status, total: count() })
    .from(emailJobs)
    .innerJoin(campaigns, eq(campaigns.id, emailJobs.campaignId))
    .where(and(eq(emailJobs.userId, userId), ne(campaigns.status, 'building')))
    .groupBy(emailJobs.status);

  const byStatus: Record<string, number> = {
    scheduled: 0,
    processing: 0,
    sent: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const row of rows) byStatus[row.status] = row.total;

  const [campaignRow] = await db
    .select({ total: count() })
    .from(campaigns)
    .where(eq(campaigns.userId, userId));

  return {
    byStatus,
    totalCampaigns: campaignRow?.total ?? 0,
    pending: byStatus.scheduled! + byStatus.processing!,
    completed: byStatus.sent! + byStatus.failed!,
  };
}

// ─── Worker-side state transitions ───────────────────────────────────────────

export interface ClaimedJob {
  email: EmailJobRow;
  subject: string;
  body: string;
  minDelayMs: number;
  hourlyLimit: number;
  campaignStatus: string;
}

export type ClaimOutcome =
  | { ok: true; job: ClaimedJob }
  | { ok: false; reason: 'not_found' | 'already_sent' | 'not_claimable'; status?: string };

/**
 * Idempotency layer 2 — the conditional claim.
 *
 * `WHERE status IN ('scheduled')` is the lock: exactly one worker can flip the
 * row to 'processing'. Zero rows updated means someone else owns it, so this
 * worker must not send. Combined with the provider_message_id check below, a
 * BullMQ stalled-job re-delivery after a successful send cannot duplicate mail.
 */
export async function claimEmailJob(emailJobId: string): Promise<ClaimOutcome> {
  const existing = await db.select().from(emailJobs).where(eq(emailJobs.id, emailJobId)).limit(1);
  const current = existing[0];

  if (!current) return { ok: false, reason: 'not_found' };

  // Idempotency layer 3: we already have a provider receipt for this row.
  if (current.providerMessageId || current.status === 'sent') {
    return { ok: false, reason: 'already_sent' };
  }
  if (current.status === 'cancelled' || current.status === 'failed') {
    return { ok: false, reason: 'not_claimable', status: current.status };
  }

  const claimed = await db
    .update(emailJobs)
    .set({ status: 'processing', claimedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(emailJobs.id, emailJobId), eq(emailJobs.status, 'scheduled')))
    .returning();

  const row = claimed[0];
  if (!row) return { ok: false, reason: 'not_claimable', status: current.status };

  const campaignRows = await db
    .select({
      subject: campaigns.subject,
      body: campaigns.body,
      minDelayMs: campaigns.minDelayMs,
      hourlyLimit: campaigns.hourlyLimit,
      status: campaigns.status,
    })
    .from(campaigns)
    .where(eq(campaigns.id, row.campaignId))
    .limit(1);

  const campaign = campaignRows[0];
  if (!campaign) return { ok: false, reason: 'not_found' };

  return {
    ok: true,
    job: {
      email: row,
      subject: campaign.subject,
      body: campaign.body,
      minDelayMs: campaign.minDelayMs,
      hourlyLimit: campaign.hourlyLimit,
      campaignStatus: campaign.status,
    },
  };
}

/**
 * Returns a claimed row to 'scheduled' without burning a retry attempt.
 * Used when the rate limiter defers the job — a throttled send is not a failure.
 */
export async function releaseEmailJob(emailJobId: string, nextScheduledAt: Date): Promise<void> {
  await db
    .update(emailJobs)
    .set({ status: 'scheduled', claimedAt: null, scheduledAt: nextScheduledAt, updatedAt: new Date() })
    .where(and(eq(emailJobs.id, emailJobId), eq(emailJobs.status, 'processing')));
}

export async function incrementAttempt(emailJobId: string): Promise<void> {
  await db
    .update(emailJobs)
    .set({ attemptCount: sql`${emailJobs.attemptCount} + 1`, updatedAt: new Date() })
    .where(eq(emailJobs.id, emailJobId));
}

export async function markEmailSent(
  emailJobId: string,
  receipt: { messageId: string; previewUrl: string | null },
): Promise<void> {
  const now = new Date();
  await db
    .update(emailJobs)
    .set({
      status: 'sent',
      sentAt: now,
      providerMessageId: receipt.messageId,
      previewUrl: receipt.previewUrl,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(emailJobs.id, emailJobId));
}

export async function markEmailFailed(emailJobId: string, error: string, permanent: boolean): Promise<void> {
  await db
    .update(emailJobs)
    .set({
      // A retryable failure goes back to 'scheduled' so BullMQ's own retry can pick it up.
      status: permanent ? 'failed' : 'scheduled',
      claimedAt: null,
      lastError: error.slice(0, 2000),
      updatedAt: new Date(),
    })
    .where(eq(emailJobs.id, emailJobId));
}

/** Rows whose worker died mid-send. Reset so the reconciler can re-queue them. */
export async function resetStaleProcessing(olderThanMs: number): Promise<EmailJobRow[]> {
  const cutoff = new Date(Date.now() - olderThanMs);
  return db
    .update(emailJobs)
    .set({ status: 'scheduled', claimedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(emailJobs.status, 'processing'),
        lt(emailJobs.claimedAt, cutoff),
        sql`${emailJobs.providerMessageId} IS NULL`,
      ),
    )
    .returning();
}

/** Everything the boot reconciler needs to compare Postgres against Redis. */
export async function findPendingEmailJobs(): Promise<EmailJobRow[]> {
  return db
    .select()
    .from(emailJobs)
    .innerJoin(campaigns, eq(campaigns.id, emailJobs.campaignId))
    .where(and(eq(emailJobs.status, 'scheduled'), inArray(campaigns.status, ['scheduled', 'completed'])))
    .orderBy(asc(emailJobs.scheduledAt))
    .then((rows) => rows.map((r) => r.email_jobs));
}
