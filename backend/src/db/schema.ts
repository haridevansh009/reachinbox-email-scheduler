import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Lifecycle of a single recipient's email. */
export const EMAIL_STATUSES = [
  'scheduled', // persisted + queued as a BullMQ delayed job, waiting for its send time
  'processing', // claimed by exactly one worker, SMTP call in flight
  'sent', // provider accepted the message
  'failed', // permanently failed after exhausting retries
  'cancelled', // campaign cancelled before this recipient was reached
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const CAMPAIGN_STATUSES = [
  'building', // rows are still being inserted; not yet safe to reconcile
  'scheduled', // fully enqueued
  'completed', // every recipient reached a terminal state
  'cancelled',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    googleSub: text('google_sub').notNull(),
    email: text('email').notNull(),
    name: text('name'),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    googleSubKey: uniqueIndex('users_google_sub_key').on(t.googleSub),
  }),
);

export const senders = pgTable(
  'senders',
  {
    id: uuid('id').primaryKey(),
    label: text('label').notNull(),
    smtpHost: text('smtp_host').notNull(),
    smtpPort: integer('smtp_port').notNull(),
    smtpSecure: boolean('smtp_secure').notNull().default(false),
    smtpUser: text('smtp_user').notNull(),
    /** AES-256-GCM ciphertext — never the raw password. */
    smtpPassEnc: text('smtp_pass_enc').notNull(),
    fromEmail: text('from_email').notNull(),
    fromName: text('from_name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    smtpUserKey: uniqueIndex('senders_smtp_user_key').on(t.smtpUser),
  }),
);

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    subject: text('subject').notNull(),
    /** Stored once here, never denormalised onto each email_job row. */
    body: text('body').notNull(),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    minDelayMs: integer('min_delay_ms').notNull(),
    hourlyLimit: integer('hourly_limit').notNull(),
    totalRecipients: integer('total_recipients').notNull().default(0),
    status: text('status').notNull().default('building'),
    /** Planned send time of the last recipient — shown in the UI as "finishes by". */
    plannedEndAt: timestamp('planned_end_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUser: index('campaigns_user_created_idx').on(t.userId, t.createdAt),
  }),
);

export const emailJobs = pgTable(
  'email_jobs',
  {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    userId: uuid('user_id').notNull(),
    senderId: uuid('sender_id').notNull(),
    recipientEmail: text('recipient_email').notNull(),
    /** Position in the original CSV. Used to restore order after a rate-limit bounce. */
    sequenceIndex: integer('sequence_index').notNull(),
    status: text('status').notNull().default('scheduled'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: text('last_error'),
    /** Set once SMTP accepts the message. Doubles as the "already sent" receipt. */
    providerMessageId: text('provider_message_id'),
    previewUrl: text('preview_url'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Idempotency layer 4: the same address can never be inserted twice for one campaign.
    campaignRecipientKey: uniqueIndex('email_jobs_campaign_recipient_key').on(
      t.campaignId,
      t.recipientEmail,
    ),
    // Drives the boot reconciler.
    statusScheduledIdx: index('email_jobs_status_scheduled_at_idx').on(t.status, t.scheduledAt),
    // Drives the "Scheduled Emails" table.
    userStatusIdx: index('email_jobs_user_status_idx').on(t.userId, t.status, t.scheduledAt),
    // Drives the "Sent Emails" table.
    userSentIdx: index('email_jobs_user_sent_idx').on(t.userId, t.sentAt),
    byCampaign: index('email_jobs_campaign_seq_idx').on(t.campaignId, t.sequenceIndex),
  }),
);

export type UserRow = typeof users.$inferSelect;
export type SenderRow = typeof senders.$inferSelect;
export type CampaignRow = typeof campaigns.$inferSelect;
export type EmailJobRow = typeof emailJobs.$inferSelect;
export type NewEmailJobRow = typeof emailJobs.$inferInsert;
