# ReachInbox — Email Job Scheduler

A production-grade email scheduling service and dashboard. Emails are accepted over an API,
persisted to PostgreSQL, scheduled as **BullMQ delayed jobs** in Redis, throttled per sender,
and delivered through **Ethereal** SMTP — surviving process restarts without losing or
duplicating a single send.

**Stack:** TypeScript · Express · BullMQ · Redis · PostgreSQL · Drizzle ORM · Nodemailer ·
Next.js 15 · Tailwind CSS · Auth.js (Google OAuth) · TanStack Query

---

## Table of contents

1. [Quick start](#quick-start)
2. [Environment variables](#environment-variables)
3. [Setting up Ethereal Email](#setting-up-ethereal-email)
4. [Setting up Google OAuth](#setting-up-google-oauth)
5. [Architecture overview](#architecture-overview)
6. [How scheduling works](#how-scheduling-works)
7. [How persistence on restart is handled](#how-persistence-on-restart-is-handled)
8. [How rate limiting and concurrency are implemented](#how-rate-limiting-and-concurrency-are-implemented)
9. [Idempotency — four layers](#idempotency--four-layers)
10. [Behaviour under load](#behaviour-under-load)
11. [API reference](#api-reference)
12. [Feature checklist](#feature-checklist)
13. [Testing and verification](#testing-and-verification)
14. [Deploying](#deploying)
15. [Demo runbook](#demo-runbook)
16. [Assumptions, shortcuts and trade-offs](#assumptions-shortcuts-and-trade-offs)

---

## Quick start

**Prerequisites:** Node.js 20+, Docker (for Redis + Postgres), and a Google OAuth client.

```bash
git clone <your-repo-url> && cd reachInbox
```

### 1. Start Redis and Postgres

```bash
docker compose up -d
```

> Not using Docker? Any local PostgreSQL 14+ and Redis 7+ will do — just point
> `DATABASE_URL` and `REDIS_URL` at them. Redis **must** have AOF persistence enabled
> (`--appendonly yes`); see [persistence](#how-persistence-on-restart-is-handled).

### 2. Configure and seed the backend

```bash
cd backend
cp .env.example .env
```

Generate the two secrets and paste them into `.env`:

```bash
node -e "console.log('JWT_SECRET='+require('crypto').randomBytes(32).toString('hex'))"
```

```bash
node -e "console.log('ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('hex'))"
```

Set `GOOGLE_CLIENT_ID` to the same client ID the frontend uses, then:

```bash
npm install && npm run setup
```

`npm run setup` applies the schema and auto-provisions three Ethereal SMTP accounts,
printing their credentials.

### 3. Run the API and the worker

These are **two separate processes**. Use two terminals:

```bash
npm run dev
```

```bash
npm run dev:worker
```

### 4. Configure and run the frontend

```bash
cd frontend && cp .env.example .env.local && npm install
```

Fill in `AUTH_SECRET`, `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`, then:

```bash
npm run dev
```

Open **http://localhost:3000** and sign in with Google.

### Convenience scripts (from the repo root)

```bash
npm run install:all && npm run infra:up && npm run setup
```

---

## Environment variables

### Backend — `backend/.env`

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | API port |
| `APP_URL` | `http://localhost:3000` | Frontend origin, used for CORS |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `DATABASE_SSL` | `false` | Set `true` for managed Postgres. See [Deploying](#deploying) |
| `REDIS_URL` | — | Redis connection string |
| `QUEUE_NAME` | `email-send` | BullMQ queue name |
| `RUN_WORKER_IN_PROCESS` | `false` | Co-host the worker in the API process (single-container deploys) |
| `SEED_ON_BOOT` | `false` | Provision Ethereal senders on boot if none exist. Required on deploys that never run `npm run seed` |
| `GOOGLE_CLIENT_ID` | — | Verifies Google ID tokens; must match the frontend |
| `JWT_SECRET` | — | Signs the backend's own session JWT |
| `ENCRYPTION_KEY` | — | 64 hex chars. AES-256-GCM key for SMTP passwords at rest |
| **`WORKER_CONCURRENCY`** | `5` | Jobs processed in parallel per worker process |
| **`MIN_DELAY_MS`** | `2000` | **Minimum gap between two sends on the same sender** |
| `MIN_DELAY_MS_FLOOR` | `1000` | Hard floor a campaign can never request below |
| **`MAX_EMAILS_PER_HOUR_PER_SENDER`** | `200` | **Hourly cap per sender** |
| `MAX_EMAILS_PER_HOUR_PER_SENDER_CEILING` | `500` | Hard ceiling a campaign can never exceed |
| `RECONCILE_ON_BOOT` | `true` | Rebuild queue state from Postgres on worker start |
| `STALE_PROCESSING_MS` | `300000` | A job stuck `processing` this long is treated as abandoned |
| `JOB_ATTEMPTS` | `3` | Retries on transient SMTP failures |
| `JOB_BACKOFF_MS` | `5000` | Exponential backoff base |
| `SENDER_COUNT` | `3` | Ethereal accounts to auto-create when seeding |
| `ETHEREAL_ACCOUNTS` | — | Optional JSON array; bring your own accounts |
| `DRY_RUN` | `false` | Skip SMTP but run the full claim/limit/persist path |
| `MAX_RECIPIENTS_PER_CAMPAIGN` | `50000` | Upper bound per campaign |

### Frontend — `frontend/.env.local`

| Variable | Purpose |
|---|---|
| `AUTH_SECRET` | Auth.js session encryption. `npx auth secret` |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google OAuth client credentials |
| `AUTH_TRUST_HOST` | Set `true` for local development |
| `NEXT_PUBLIC_API_URL` | Backend URL used by the browser |
| `BACKEND_URL` | Backend URL used server-side during the token exchange |

**No limit is hardcoded.** Delay and hourly-limit values entered in the compose form are
clamped to the env floor/ceiling — env is both the default *and* the enforced bound.

---

## Setting up Ethereal Email

Two options.

**Automatic (default).** `npm run seed` provisions three accounts against Ethereal's API and
stores them encrypted, printing the credentials — log in at
[ethereal.email](https://ethereal.email) to browse the inboxes.

> It calls the provisioning endpoint directly rather than
> `nodemailer.createTestAccount()`. That helper **memoises the first account for the lifetime
> of the process**, so calling it N times returns identical credentials N times — which the
> unique index on `smtp_user` then collapses to a single sender, silently cutting throughput
> to 1x the hourly limit instead of Nx. The seeder also de-duplicates and retries, and warns
> loudly if it ends up with fewer senders than requested.

Re-seed with different accounts using `npm run seed -- --force`.

**Manual.** Create accounts yourself and paste them into `backend/.env`:

```
ETHEREAL_ACCOUNTS=[{"user":"abc@ethereal.email","pass":"xyz","host":"smtp.ethereal.email","port":587,"name":"Sender One"}]
```

This survives a database reset, which the auto-created accounts do not.

Every sent email stores its Ethereal **preview URL**, surfaced as a *View* link in the Sent
Emails table so you can open the rendered message in one click.

---

## Setting up Google OAuth

1. [Google Cloud Console](https://console.cloud.google.com) → **APIs & Services → Credentials**
2. **Create Credentials → OAuth client ID → Web application**
3. Authorised JavaScript origin: `http://localhost:3000`
4. Authorised redirect URI: `http://localhost:3000/api/auth/callback/google`
5. Put the client ID and secret in `frontend/.env.local`, and the **same client ID** in
   `backend/.env` as `GOOGLE_CLIENT_ID`

The frontend never asserts identity. Auth.js receives Google's `id_token`, hands the raw
token to `POST /api/auth/google`, and the backend verifies its signature, issuer and
audience against Google's public keys before minting its own session JWT.

---

## Architecture overview

```
┌──────────────────────────────────────────────────────────────┐
│  Next.js 15 · Auth.js (Google) · TanStack Query · Tailwind   │
└───────────────────────────┬──────────────────────────────────┘
                            │ Bearer <backend JWT>
┌───────────────────────────▼──────────────────────────────────┐
│  Express API  (process 1)                                    │
│   POST /api/campaigns → parse CSV → plan send times          │
│                       → persist rows → addBulk delayed jobs  │
│   GET  /api/emails?status=scheduled|sent → paginated reads   │
└──────────┬──────────────────────────────────┬────────────────┘
           │                                  │
   ┌───────▼────────┐                ┌────────▼─────────┐
   │   PostgreSQL   │◄───reconcile───┤      Redis       │
   │ SOURCE OF TRUTH│    on boot     │ BullMQ delayed   │
   │ users          │                │ zset + rate-     │
   │ senders        │                │ limit counters   │
   │ campaigns      │                │ (AOF everysec)   │
   │ email_jobs     │                └────────▲─────────┘
   └───────▲────────┘                         │
           │                       ┌──────────┴───────────────┐
           └───────────────────────┤ Worker (process 2)       │
                                   │ concurrency = N          │
                                   │ claim → Lua gate → SMTP  │
                                   └──────────┬───────────────┘
                                              │ pooled transports
                                   ┌──────────▼───────────────┐
                                   │ Ethereal SMTP × M senders│
                                   └──────────────────────────┘
```

**The API and the worker are separate processes** sharing one codebase. Either half can be
restarted independently — which is exactly what makes the restart demo meaningful.

### Data model

One API call creates **one campaign** fanned out into **N `email_jobs`**, one per recipient.
This is the central modelling decision: it gives per-recipient status, per-recipient retry,
a per-recipient dedupe key, and a `sequence_index` used to restore CSV order after a
rate-limit deferral.

| Table | Notes |
|---|---|
| `users` | Google `sub` is unique |
| `senders` | Multiple Ethereal accounts. SMTP passwords AES-256-GCM encrypted at rest |
| `campaigns` | Subject and **body stored once here** — never denormalised onto each row |
| `email_jobs` | One row per recipient; the scheduler's unit of work |

Constraints that do real work:

- `UNIQUE (campaign_id, recipient_email)` — idempotency layer 4
- `INDEX (status, scheduled_at)` — drives the boot reconciler
- `INDEX (user_id, status, scheduled_at)` / `(user_id, sent_at DESC)` — drive the two tabs

### Project layout

```
backend/src/
  config/env.ts          Zod-validated env; fails fast with a readable message
  db/                    schema · migrations.sql · migrate · seed
  queue/                 Redis connection · BullMQ queue + job options
  services/
    scheduler.ts         send-time planner + rate-limit backoff   ← core logic
    rateLimiter.ts       atomic Lua limiter                       ← core logic
    campaignService.ts   create / list / cancel campaigns
    emailService.ts      claim · release · mark sent/failed · list
    mailer.ts            pooled Nodemailer transports per sender
    senderService.ts     sender lookup + round-robin assignment
    authService.ts       Google token verification + session JWT
  workers/
    emailWorker.ts       the processor                            ← core logic
    reconciler.ts        rebuilds queue state from Postgres       ← core logic
    index.ts             worker entrypoint + graceful shutdown
  routes/                auth · campaigns · emails · senders · health
  scripts/               verify.ts · loadtest.ts

frontend/src/
  auth.ts                Auth.js config + backend token exchange
  app/                   login · dashboard · route handlers
  components/
    ui/                  Button · Field · Modal · Table · FileDropzone · Feedback
    emails/EmailTable    one table, two column configs
    compose/ComposeModal
  hooks/useApi.ts        every query and mutation in one place
  lib/                   api client · shared types · csv · utils
```

---

## How scheduling works

**No cron anywhere.** No `node-cron`, no `agenda`, no OS crontab — and deliberately not
BullMQ's `repeat`/`JobScheduler` either, since that is cron-shaped. Only plain delayed jobs.

The naive approach is to give every job the same delay and let the rate limiter sort it out.
With 1000 recipients that means 1000 jobs stampede the worker at T, ~995 bounce off the
limiter, get requeued, and bounce again. Ordering is destroyed and Redis churns.

Instead, **send times are planned at enqueue time** (`services/scheduler.ts`). Recipients
are round-robined across the active senders, so each sender receives every Nth recipient and
runs its own independent stream:

```
slotOnSender = floor(index / senderCount)
hourIndex    = floor(slotOnSender / hourlyLimit)
slotInHour   = slotOnSender % hourlyLimit

scheduledAt  = startAt + hourIndex * 1h + slotInHour * minDelayMs
```

1000 emails at 200/hr per sender across 3 senders lay themselves out across two hour windows,
pre-spaced, in CSV order. **The rate limiter then never fires in the happy path** — it exists
purely as a safety net for things the planner cannot see (a second campaign competing for the
same sender, a backlog after downtime, two API replicas enqueueing concurrently).

If `minDelayMs × hourlyLimit` exceeds an hour, spacing rather than the cap is the binding
constraint and the planner falls through to pure spacing, so two sends on one sender can
never be scheduled for the same instant.

Jobs are enqueued with `addBulk` in chunks of 500:

```ts
{
  jobId: `email-${row.id}`,                    // deterministic → dedupe
  delay: scheduledAt - now,
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 86400, count: 10000 },
  priority: sequenceIndex + 1,                 // CSV order on simultaneous promotion
}
```

Only the **row id** travels through Redis — never the subject or body. Redis is an index,
not a document store.

---

## How persistence on restart is handled

Two layers, because "Redis persists jobs" is only half an answer.

### Layer A — Redis durability

`docker-compose.yml` runs Redis with `--appendonly yes --appendfsync everysec`, bounding
worst-case loss to ~1 second of writes. BullMQ keeps delayed jobs in a sorted set keyed by
execution timestamp, so killing and restarting the worker resumes promotion from that zset
and future emails fire on time.

`--maxmemory-policy noeviction` is also set and is **not optional**: under an LRU policy
Redis would silently evict queue keys under memory pressure, and scheduled emails would
vanish with no error anywhere.

### Layer B — reconciliation from Postgres on boot

Redis can still be flushed, restored from an older snapshot, or come up empty. **Postgres is
the source of truth; Redis is a rebuildable index.** On every worker start
(`workers/reconciler.ts`):

1. Reset rows stuck in `processing` past `STALE_PROCESSING_MS` whose worker died — but
   **only those with no `provider_message_id`**, so a message that was actually accepted is
   never re-sent.
2. Load every `scheduled` row belonging to a non-cancelled campaign.
3. For each, check whether a live BullMQ job exists. If it is `delayed`/`waiting`/`active`,
   leave it alone. Otherwise re-add it.
4. Rows whose send time passed while the server was down get `delay: 0` and go out
   immediately rather than being skipped.

Because job ids are deterministic (`email-<uuid>`), **re-adding an existing job is a no-op** —
the reconciler is naturally idempotent and safe to run on every boot. (A hyphen, not a colon:
BullMQ v5 reserves `:` as its Redis key separator and rejects custom ids containing one.)

### Graceful shutdown

`SIGTERM`/`SIGINT` call `worker.close()`, which lets in-flight sends finish instead of
abandoning them to the stalled-job reaper. Skipping this is the most common cause of
accidental duplicates during a restart demo.

### Verifying it

```bash
curl "http://localhost:4000/health"
```

Schedule a campaign a few minutes out, `Ctrl+C` the worker, confirm the rows still read
`scheduled` in the dashboard, restart with `npm run dev:worker`, and watch the reconciler
log (`pendingInDb`, `alreadyQueued`, `requeued`, `overdue`) before the emails go out on time.

---

## How rate limiting and concurrency are implemented

### Why not the obvious options

| Option | Why it was rejected |
|---|---|
| BullMQ's built-in `limiter: { max, duration }` | Per-**queue** and global. Cannot express per-sender, which the multi-sender requirement demands. |
| In-memory counters | Two worker processes would each believe they were under the limit. Explicitly disallowed, and correctly so. |
| `worker.rateLimit(ms)` | Idiomatic, but pauses the **entire worker** — sender A hitting its cap would stall sender B. Wrong granularity. |

### The design: one Lua script, two gates, atomic

Redis executes Lua single-threaded with no interleaving, so check-and-increment become one
uninterruptible operation. `services/rateLimiter.ts`:

```lua
-- KEYS[1] = rl:gap:{senderId}
-- KEYS[2] = rl:quota:{senderId}:{hourWindow}

local elapsed = now - lastSend
if elapsed < minDelay then
  return { 0, minDelay - elapsed, 'gap' }        -- Gate 1: minimum spacing
end

local used = tonumber(redis.call('GET', KEYS[2]) or '0')
if used >= limit then
  return { 0, msToWindow, 'quota' }              -- Gate 2: hourly cap
end

redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], 7200)              -- self-cleaning; no cleanup job
redis.call('SET', KEYS[1], now, 'PX', minDelay * 2)
return { 1, 0, 'ok' }
```

There is no TOCTOU window. This stays correct at any concurrency, across any number of
worker processes. The window key is `floor(now / 3600000)` — a fixed tumbling window,
keyed by `hour_window + sender` exactly as the brief describes.

**Chosen defaults: minimum 2 seconds between sends on a sender, 200 emails/hour per sender,
worker concurrency 5.** All three are env-configurable.

### When the limiter says no

```ts
await releaseEmailJob(emailJobId, nextAt);        // hand the claim back
await job.moveToDelayed(nextAt.getTime(), token); // defer THIS job only
throw new DelayedError();
```

- **Nothing is dropped or permanently failed.** `moveToDelayed` does not increment
  `attemptsMade`, so a throttled job never exhausts its retries and never lands in `failed`.
- **Only the affected job is delayed** — other senders keep flowing at full speed.
- **Order is preserved.** Rescheduling everything to the exact window boundary would make
  200 jobs wake simultaneously and thrash again, so a quota rejection re-lays them at
  `nextWindowStart + (sequence_index % hourlyLimit) × minDelayMs` — back in original CSV
  order. A gap rejection is a sub-second wait plus a small pad.

### Concurrency

`WORKER_CONCURRENCY` (default 5) sets BullMQ's parallelism. Parallel execution is safe
because the Lua gate is atomic and the DB claim is a conditional update.

An honest note on the interaction: **with a single sender and a 2s minimum gap, throughput is
gap-bound rather than concurrency-bound** — effective concurrency is ~1. Concurrency pays off
across *multiple senders* (independent gap keys → genuine parallelism, so effective
throughput is `senders × hourlyLimit` per hour) and when SMTP latency spikes.

`lockDuration` is 60s — comfortably above the slowest SMTP round-trip, so BullMQ never
mistakes a healthy in-flight job for a stalled one.

---

## Idempotency — four layers

The real duplicate risk is not double-enqueue; it is BullMQ's **stalled-job reaper**. If a
worker is `SIGKILL`ed or blocks its event loop past `stalledInterval`, the job is
re-delivered — possibly *after* SMTP already accepted the message. Defence in depth:

| # | Mechanism | Catches |
|---|---|---|
| 1 | Deterministic `jobId = email-<uuid>` | Duplicate enqueue, reconciler re-runs |
| 2 | Conditional claim: `UPDATE … WHERE id = ? AND status = 'scheduled'` | Two workers racing the same job |
| 3 | `provider_message_id` short-circuit | Stalled re-delivery after a successful send |
| 4 | `UNIQUE (campaign_id, recipient_email)` | Duplicate rows from the CSV or an API retry |

Layer 2 is the lock: zero rows updated means another worker owns it, so this one returns
`skipped` without sending. Layer 3 checks for a provider receipt *before* claiming.

`removeOnComplete` is deliberately `{ age: 86400 }` rather than `true` — with `true` the job
id frees up immediately and layer 1 would stop protecting against a duplicate re-enqueue.

---

## Behaviour under load

### 1000+ emails scheduled for the same time

The planner spreads them at enqueue time, so this is a non-event: with 3 senders at 200/hr
and a 2s gap, 1000 recipients lay out across two hour windows at 600/hour and the limiter
barely fires. Rows are inserted and enqueued in chunks of 500 so no single statement or
`addBulk` call grows unbounded.

```bash
npm run loadtest -- 1000
```

Pair it with `DRY_RUN=true` to exercise the full claim → limiter → persist path at speed
without hitting Ethereal's own per-account limits.

### The rate limit would be exceeded

Jobs are deferred, never dropped — see [above](#when-the-limiter-says-no). Worst case a
campaign takes longer than requested; no email is lost and none is sent out of order beyond
what deferral requires.

### A worker dies mid-send

The row stays `processing`. On the next boot the reconciler resets it — but only if it has no
`provider_message_id`, so an already-accepted message is never re-sent.

---

## API reference

All `/api/*` routes except `POST /api/auth/google` require `Authorization: Bearer <token>`.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/google` | Exchange a Google `id_token` for a backend session JWT |
| `GET` | `/api/auth/me` | Current user |
| `POST` | `/api/campaigns` | Schedule a campaign (multipart: `subject`, `body`, `file`, `startAt`, `minDelayMs`, `hourlyLimit`) |
| `POST` | `/api/campaigns/preview` | Parse a leads file and return the detected address count |
| `GET` | `/api/campaigns` | List campaigns |
| `GET` | `/api/campaigns/:id` | Campaign detail with a per-status breakdown |
| `POST` | `/api/campaigns/:id/cancel` | Cancel pending recipients and remove their queued jobs |
| `GET` | `/api/emails?status=scheduled\|sent&page=&pageSize=` | Paginated table data |
| `GET` | `/api/emails/stats` | Counts by status |
| `GET` | `/api/senders` | Senders with live hourly usage + scheduler config |
| `GET` | `/health` | Postgres + Redis + queue depth |

### Driving the API without the browser

`npm run devtoken` prints a backend session JWT for a local dev user, so the scheduler can be
exercised from curl or Postman without completing the Google flow:

```bash
cd backend && npm run devtoken --silent
```

Schedule a campaign with it:

```bash
curl -X POST http://localhost:4000/api/campaigns -H "Authorization: Bearer $TOKEN" -F "subject=Hello from ReachInbox" -F "body=Testing the scheduler." -F "startAt=$(date -u -d '+2 minutes' +%Y-%m-%dT%H:%M:%SZ)" -F "minDelayMs=2000" -F "hourlyLimit=200" -F "file=@sample-leads.csv"
```

A 25-lead `sample-leads.csv` is included at the repo root.

---

## Feature checklist

### Backend

| Requirement | Status | Where |
|---|---|---|
| Accept scheduling requests via API | ✅ | `routes/campaigns.ts` |
| Store in a relational DB | ✅ | PostgreSQL + Drizzle, `db/schema.ts` |
| Schedule with BullMQ delayed jobs | ✅ | `queue/emailQueue.ts`, `services/campaignService.ts` |
| **No cron of any kind** | ✅ | No cron dependency; no BullMQ `repeat`/`JobScheduler` |
| Send from multiple senders via Ethereal | ✅ | `services/mailer.ts`, `senderService.ts` |
| Future emails still send after restart | ✅ | `workers/reconciler.ts` + Redis AOF |
| Emails not duplicated or restarted | ✅ | Four idempotency layers |
| Configurable worker concurrency | ✅ | `WORKER_CONCURRENCY` |
| Safe when jobs run in parallel | ✅ | Atomic Lua gate + conditional DB claim |
| Minimum delay between sends | ✅ | **2s default**, `MIN_DELAY_MS` |
| Emails-per-hour rate limit | ✅ | **200/hr per sender**, `MAX_EMAILS_PER_HOUR_PER_SENDER` |
| Per-sender limiting, multiple senders | ✅ | Keyed `hour_window + sender` |
| Limits configurable, never hardcoded | ✅ | Env floor/ceiling; UI values clamped |
| Redis/DB-backed counters, not in-memory | ✅ | `services/rateLimiter.ts` |
| Jobs delayed, not dropped, at the limit | ✅ | `moveToDelayed` + `DelayedError` |
| Order preserved as far as possible | ✅ | `sequence_index` re-lay + BullMQ `priority` |
| Defined behaviour at 1000+ emails | ✅ | Enqueue-time planning; `npm run loadtest` |

### Frontend

| Requirement | Status | Where |
|---|---|---|
| Real Google OAuth, no mock | ✅ | Auth.js + server-side ID-token verification |
| Redirect to dashboard after login | ✅ | `middleware.ts`, `callbackUrl` |
| Header shows name, email, avatar | ✅ | `components/layout/Header.tsx` |
| Logout | ✅ | Header dropdown |
| Scheduled / Sent tabs | ✅ | `app/dashboard/page.tsx` |
| Compose New Email button | ✅ | Dashboard header |
| Compose: subject + body | ✅ | `components/compose/ComposeModal.tsx` |
| Upload CSV/text, show count detected | ✅ | Local parse for instant count, server parse confirms |
| Set start time, delay, hourly limit | ✅ | Compose modal, clamped to server config |
| Scheduled table: email, subject, time, status | ✅ | `components/emails/EmailTable.tsx` |
| Sent table: email, subject, sent time, status | ✅ | Same component, different columns |
| Loading states | ✅ | Skeleton rows, button spinners |
| Empty states | ✅ | Distinct per tab, with a CTA |
| Error handling | ✅ | Toasts, inline field errors, retryable error state |
| Reusable components, DRY | ✅ | `components/ui/*`; one table for both tabs |
| Proper TypeScript | ✅ | Typed API responses and props; no `any` |

---

## Testing and verification

```bash
npm run verify
```

16 assertions covering the logic that carries the most risk — no Postgres or Redis required:

- **Send-time planner** — spacing, round-robin across senders, hour-window rollover, the
  1000-email layout, no two sends on one sender at the same instant, determinism
- **Rate-limit backoff** — gap vs. quota behaviour, and that CSV order survives a deferral
- **Lead parser** — headered CSV, bare list, `Name <addr>` form, case-insensitive dedupe,
  invalid-row counting
- **Credential encryption** — AES-256-GCM round-trip, random IV, tamper rejection

```bash
npm run typecheck
```

Both packages typecheck strict-clean, and `npm run build` produces a clean Next.js
production build.

### End-to-end results (measured, not projected)

Run against live Postgres 16 + Redis 7 in Docker, with three real Ethereal senders.

**1 — Delivery.** 25 recipients from `sample-leads.csv`, `minDelayMs=2000`, `hourlyLimit=200`:

```
byStatus: { scheduled: 0, processing: 0, sent: 25, failed: 0 }
sender usage this hour: 9 / 8 / 8      ← round-robin across 3 senders
```

Every row carried a real Ethereal preview URL.

**2 — Restart persistence.** 25 emails scheduled 90 s out, then **both the worker process and
the Redis container** were killed and restarted before the send window:

```
after Redis restart:  ZCARD bull:email-send:delayed = 25   ← recovered from AOF
reconciler on boot:   pendingInDb 25 · alreadyQueued 25 · requeued 0 · staleReset 0
final integrity:      rows 25 · distinct_recipients 25
                      receipts 25 · distinct_receipts 25 · max_attempt_count 1
```

All 25 then sent on time. `distinct_receipts == receipts == rows` and `max_attempt_count = 1`
is the duplicate check: **every email was sent exactly once across a full restart.** The
reconciler correctly detected AOF had already restored the jobs and added nothing.

**3 — Rate limiting under contention.** Two 25-recipient campaigns scheduled for the same
instant with `hourlyLimit=5` per sender — 50 emails competing for 15 slots:

```
sent this hour: 15          ← exactly 3 senders x cap 5
deferred:       35          ← still 'scheduled', none dropped
failed:         0           ← BullMQ failed list empty
deferred rows rescheduled to 16:00:00 (next hour boundary), in sequence_index order
```

This is the required behaviour precisely: the cap held exactly, nothing was dropped or
permanently failed, and order was preserved into the next window.

### Bugs this end-to-end pass caught

Three defects that typechecking and unit tests could not have surfaced:

1. **`jobId` contained `:`** — BullMQ v5 reserves the colon as its Redis key separator and
   rejected every job with *"Custom Id cannot contain :"*. Nothing could be scheduled at all.
   Fixed to `email-<uuid>`.
2. **`createTestAccount()` returned the same account three times** — nodemailer memoises it,
   so the unique index on `smtp_user` silently dropped two of three senders and throughput
   would have been 1x instead of 3x. Fixed by calling Ethereal's API directly, with dedupe
   and retry.
3. **A failed enqueue stranded rows in `scheduled`** — they had no job behind them and would
   sit in the dashboard forever claiming they were about to send. `createCampaign` now rolls
   the campaign back on enqueue error, and the dashboard queries exclude `building`
   campaigns so a hard crash mid-insert cannot surface ghost rows either.

---

## Deploying

The project is built to run as **two processes** — API and worker. Most single-container
platforms (Railway, Render, Fly) start only one, so the worker would never run and nothing
would ever send. Two ways to handle that:

**Option A — two services (preferred).** Deploy the same repo twice:

| Service | Start command |
|---|---|
| API | `npm run start` |
| Worker | `npm run start:worker` |

Both point at the same Postgres and Redis. This matches the local topology and lets you
restart either half independently.

**Option B — one service.** Set `RUN_WORKER_IN_PROCESS=true` and the API co-hosts the worker.
Simpler and cheaper, but API traffic and email sending then share an event loop, and you can
no longer restart one without the other.

### Required environment variables in production

Everything in [Environment variables](#environment-variables), plus:

| Variable | Value | Why |
|---|---|---|
| `DATABASE_SSL` | `true` | Managed Postgres terminates TLS with a cert the container has no CA for. **Without this the container crash-loops on boot** — the single commonest first-deploy failure. Set `false` if you use the platform's *internal* host, which is not TLS. |
| `RUN_WORKER_IN_PROCESS` | `true` (Option B only) | Otherwise nothing sends |
| `SEED_ON_BOOT` | `true` | A deployed container never runs `npm run seed`, so without this there are zero senders and every campaign is rejected |
| `APP_URL` | Deployed **frontend** URL | CORS rejects the frontend without it. Not this API's own URL |
| `PORT` | **Leave unset** | The platform injects it. Hardcoding it causes "Application failed to respond", because the proxy routes to a port nothing is listening on |

### Platform gotchas worth knowing

- **Unresolved variable references become empty strings.** On Railway, `${{Redis.REDIS_URL}}` naming a service that does not exist resolves to `""` rather than failing — so the app sees a *set but empty* variable. The env validator reports that state explicitly.
- **Private networking is IPv6-only.** `*.railway.internal` hosts need `family: 0` on the Redis client; this is applied automatically when an internal host is detected.
- **Verify readiness, not just liveness.** `/health` reports `activeSenders` and returns `degraded` when it is zero — an instance can reach Postgres and Redis yet still reject every campaign.

`ETHEREAL_ACCOUNTS` is worth setting explicitly in production — the auto-provisioned accounts
are recreated on every fresh database, so pinning them keeps senders stable across redeploys.

### If the container crash-loops

The API prints the real cause to stderr between `=== API FAILED TO START ===` markers, and a
preflight check names which backing service is unreachable before migrations run — so the logs
say *"Cannot connect to Postgres at …"* rather than a generic startup failure.

Most common causes, in order:

1. `DATABASE_SSL` not set to `true` on managed Postgres.
2. `DATABASE_URL` / `REDIS_URL` pointing at a service that isn't provisioned or linked.
3. A missing required variable — `JWT_SECRET`, `ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID`. These fail
   validation before startup and print `Invalid environment configuration` naming each field.

Health check path for the platform: `/health`.

---

## Demo runbook

Exact commands for recording the walkthrough.

**Restart scenario** — schedule 90 s out, kill everything, restart, watch it still send:

```bash
cd backend && TOKEN=$(npm run devtoken --silent) && curl -s -X POST http://localhost:4000/api/campaigns -H "Authorization: Bearer $TOKEN" -F "subject=Restart test" -F "body=Must survive a restart." -F "startAt=$(date -u -d '+90 seconds' +%Y-%m-%dT%H:%M:%SZ)" -F "file=@../sample-leads.csv"
```

```bash
docker exec reachinbox-redis redis-cli ZCARD "bull:email-send:delayed"
```

Stop the worker with `Ctrl+C`, optionally `docker compose restart redis`, then restart it and
read the reconciler line — `pendingInDb` / `alreadyQueued` / `requeued` / `overdue`.

**Prove no duplicates** after everything drains:

```bash
docker exec reachinbox-postgres psql -U reachinbox -d reachinbox -c "SELECT count(*) rows, count(DISTINCT recipient_email) recipients, count(DISTINCT provider_message_id) receipts, max(attempt_count) max_att FROM email_jobs;"
```

All three counts equal and `max_att = 1` means every email went exactly once.

**Rate limiting under load** — 50 emails competing for 15 slots:

```bash
cd backend && TOKEN=$(npm run devtoken --silent) && ST=$(date -u -d '+8 seconds' +%Y-%m-%dT%H:%M:%SZ) && for i in 1 2; do curl -s -X POST http://localhost:4000/api/campaigns -H "Authorization: Bearer $TOKEN" -F "subject=Load $i" -F "body=Rate limit demo." -F "startAt=$ST" -F "minDelayMs=1000" -F "hourlyLimit=5" -F "file=@../sample-leads.csv"; done
```

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/senders | grep -o '"usedThisHour":[0-9]*'
```

Expect each sender pinned at 5, 35 rows still `scheduled`, and zero failures.

**1000+ emails:**

```bash
cd backend && npm run loadtest -- 1000
```

---

## Assumptions, shortcuts and trade-offs

### Assumptions

1. **One campaign = one subject and body for all recipients.** No per-lead merge fields; the
   brief's compose form has a single subject/body pair. `campaign_id + sequence_index` is
   the natural place to add personalisation later.
2. **Recipients are extracted permissively.** Any email-shaped token in any column is taken,
   so headered CSVs, bare lists and `Name <addr>` forms all work without a fixed schema.
   Duplicates are removed case-insensitively, preserving first-seen order.
3. **Senders are shared infrastructure**, not per-user. A production system would scope them
   per tenant.
4. **Compose-form values are requests, not commands.** They are clamped to the env
   floor/ceiling, so the UI can never exceed the operator's configured limits.
5. **Rate limiting is per-sender**, which the brief offers as an alternative to global. With
   round-robin assignment this also gives `senders × limit` aggregate throughput.

### Trade-offs

1. **Tumbling hour window, not sliding.** `floor(now / 3600000)` is cheap, exact and trivial
   to reason about, but permits a burst across a boundary — up to `2 × limit` in a 60-minute
   span straddling it. A sliding window via a Redis sorted set would be smoother at the cost
   of memory and complexity. For provider-throttling mimicry the tumbling window is fine.
2. **Clock skew across instances.** `now` is passed from the client into Lua rather than
   using Redis `TIME`, keeping the script deterministic. Multiple API/worker hosts should run
   NTP. Using `redis.call('TIME')` would remove this at the cost of replication nuance.
3. **Delivery is at-least-once, not exactly-once.** If a worker is `SIGKILL`ed in the window
   between SMTP accepting the message and the `markEmailSent` commit, that one email can be
   re-sent. The window is small and the four idempotency layers close everything around it,
   but it cannot be eliminated over SMTP without a provider-side idempotency key. Graceful
   shutdown avoids it in every non-`SIGKILL` case. **Claiming exactly-once here would be
   false.**
4. **A quota rejection burns a claim cycle.** The job is claimed, rejected, released. Slightly
   more DB traffic than checking the limiter first, but it guarantees a duplicate delivery
   can never consume a quota slot a real send needs. Correctness over chattiness.
5. **A process crash mid-insert and an enqueue error are handled differently.** A crash leaves
   the campaign `building`, and the reconciler deliberately ignores those — a partial campaign
   never half-sends. An enqueue *error* is different: the process is still alive, so
   `createCampaign` rolls the campaign back to `cancelled` rather than stranding rows that
   claim they will send but have no job behind them. The dashboard queries also exclude
   `building` campaigns, so a hard crash cannot surface ghost rows either.
6. **Pagination is offset-based.** Simple and correct for dashboard-sized data; keyset
   pagination would be better past ~100k rows per user.
7. **The dashboard polls every 5 seconds** rather than using websockets. Rows visibly move
   `scheduled → sent` during a demo for a fraction of the complexity.
8. **Idempotent DDL instead of a migration-state table.** `migrations.sql` is
   `CREATE … IF NOT EXISTS` throughout and runs on every boot. Right for a project this size;
   a real deployment wants versioned migrations.
9. **Ethereal is not a real ESP.** It accepts and renders mail but never delivers externally,
   and throttles per account. Throughput numbers here measure the scheduler, not deliverability.

### Known gaps

- **The Figma file was not accessible during development**, so the UI follows the written
  spec — header with user info and logout, Scheduled/Sent tabs, a primary *Compose New Email*
  button, and a compose modal with subject, body, file upload with detected count, start
  time, delay and hourly limit. Spacing, colour and type will need reconciling against the
  actual design file.
- No automated integration tests against live Postgres/Redis — `npm run verify` covers pure
  logic only. Testcontainers would be the natural next step.
- Campaign cancellation exists in the API but has no UI control yet.
- No per-user sender assignment or per-tenant quotas.
