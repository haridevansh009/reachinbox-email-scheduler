-- ReachInbox email scheduler — schema.
-- Idempotent: safe to run on every boot / re-run at will.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── users ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY,
  google_sub  TEXT        NOT NULL,
  email       TEXT        NOT NULL,
  name        TEXT,
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_key ON users (google_sub);

-- ─── senders (multiple Ethereal SMTP accounts) ───────────────────────────────
CREATE TABLE IF NOT EXISTS senders (
  id            UUID PRIMARY KEY,
  label         TEXT        NOT NULL,
  smtp_host     TEXT        NOT NULL,
  smtp_port     INTEGER     NOT NULL,
  smtp_secure   BOOLEAN     NOT NULL DEFAULT false,
  smtp_user     TEXT        NOT NULL,
  smtp_pass_enc TEXT        NOT NULL,
  from_email    TEXT        NOT NULL,
  from_name     TEXT        NOT NULL,
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS senders_smtp_user_key ON senders (smtp_user);

-- ─── campaigns (one API call = one campaign) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id               UUID PRIMARY KEY,
  user_id          UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  subject          TEXT        NOT NULL,
  body             TEXT        NOT NULL,
  start_at         TIMESTAMPTZ NOT NULL,
  min_delay_ms     INTEGER     NOT NULL,
  hourly_limit     INTEGER     NOT NULL,
  total_recipients INTEGER     NOT NULL DEFAULT 0,
  status           TEXT        NOT NULL DEFAULT 'building',
  planned_end_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaigns_user_created_idx ON campaigns (user_id, created_at DESC);

-- ─── email_jobs (one row per recipient) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_jobs (
  id                  UUID PRIMARY KEY,
  campaign_id         UUID        NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  user_id             UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  sender_id           UUID        NOT NULL REFERENCES senders (id),
  recipient_email     TEXT        NOT NULL,
  sequence_index      INTEGER     NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'scheduled',
  scheduled_at        TIMESTAMPTZ NOT NULL,
  sent_at             TIMESTAMPTZ,
  attempt_count       INTEGER     NOT NULL DEFAULT 0,
  last_error          TEXT,
  provider_message_id TEXT,
  preview_url         TEXT,
  claimed_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency layer 4: one address may appear at most once per campaign.
CREATE UNIQUE INDEX IF NOT EXISTS email_jobs_campaign_recipient_key
  ON email_jobs (campaign_id, recipient_email);

-- Boot reconciler: find everything still pending.
CREATE INDEX IF NOT EXISTS email_jobs_status_scheduled_at_idx
  ON email_jobs (status, scheduled_at);

-- Dashboard: "Scheduled Emails" tab.
CREATE INDEX IF NOT EXISTS email_jobs_user_status_idx
  ON email_jobs (user_id, status, scheduled_at);

-- Dashboard: "Sent Emails" tab.
CREATE INDEX IF NOT EXISTS email_jobs_user_sent_idx
  ON email_jobs (user_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS email_jobs_campaign_seq_idx
  ON email_jobs (campaign_id, sequence_index);
