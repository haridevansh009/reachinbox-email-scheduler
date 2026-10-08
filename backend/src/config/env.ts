import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

/** Coerces "true"/"false"/"1"/"0" strings into a real boolean. */
const boolish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : v === 'true' || v === '1'));

const intish = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : Number(v)))
    .pipe(z.number().int().positive());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intish(4000),
  /**
   * Origin of the FRONTEND (not this API) — used for CORS.
   * Hosting dashboards show domains without a scheme (`myapp.up.railway.app`),
   * and pasting that verbatim is the natural mistake, so add `https://` rather
   * than failing boot over it.
   */
  APP_URL: z
    .string()
    .default('http://localhost:3000')
    .transform((v) => {
      const trimmed = v.trim().replace(/\/+$/, '');
      if (trimmed.length === 0) return 'http://localhost:3000';
      return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    })
    .pipe(z.string().url('APP_URL must be a valid URL, e.g. https://your-frontend.vercel.app')),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: boolish(false),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  QUEUE_NAME: z.string().default('email-send'),
  /** Co-host the BullMQ worker inside the API process (single-container deploys). */
  RUN_WORKER_IN_PROCESS: boolish(false),
  /**
   * Provision Ethereal senders on boot if none exist. Deployed containers only
   * run `npm start`, never `npm run seed`, so without this a fresh production
   * database has zero senders and every campaign is rejected.
   */
  SEED_ON_BOOT: boolish(false),

  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),

  WORKER_CONCURRENCY: intish(5),

  MIN_DELAY_MS: intish(2000),
  MIN_DELAY_MS_FLOOR: intish(1000),

  MAX_EMAILS_PER_HOUR_PER_SENDER: intish(200),
  MAX_EMAILS_PER_HOUR_PER_SENDER_CEILING: intish(500),

  RECONCILE_ON_BOOT: boolish(true),
  STALE_PROCESSING_MS: intish(300_000),

  JOB_ATTEMPTS: intish(3),
  JOB_BACKOFF_MS: intish(5000),

  SENDER_COUNT: intish(3),
  ETHEREAL_ACCOUNTS: z.string().optional().default(''),
  DRY_RUN: boolish(false),

  MAX_UPLOAD_BYTES: intish(5 * 1024 * 1024),
  MAX_RECIPIENTS_PER_CAMPAIGN: intish(50_000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => {
      const key = i.path.join('.');
      const raw = process.env[key];
      // A platform reference like ${{Redis.REDIS_URL}} that names a service which
      // does not exist resolves to an EMPTY STRING rather than failing loudly.
      // "Set but empty" is therefore a completely different problem from "unset",
      // and is almost always a typo'd service name.
      const state =
        raw === undefined
          ? 'not set'
          : raw.trim() === ''
            ? 'set but EMPTY'
            : `set to "${key.includes('SECRET') || key.includes('KEY') ? '***' : raw}"`;
      return `  - ${key}: ${i.message}  [currently ${state}]`;
    })
    .join('\n');

  const anyEmpty = parsed.error.issues.some((i) => {
    const raw = process.env[i.path.join('.')];
    return raw !== undefined && raw.trim() === '';
  });

  const hint = anyEmpty
    ? 'A variable is set but empty. On Railway/Render this usually means a reference such as\n' +
      '${{Redis.REDIS_URL}} names a service that does not exist — check the exact service name\n' +
      'on your project canvas (it is case-sensitive), or paste the raw connection string instead.'
    : 'Locally: copy .env.example to .env and fill it in.\n' +
      'On a hosting platform: set these in the service\'s Variables tab.';

  // eslint-disable-next-line no-console
  console.error(`\nInvalid environment configuration:\n${issues}\n\n${hint}\n`);
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';

/** One hour in ms — the rate-limit window size. */
export const HOUR_MS = 3_600_000;
