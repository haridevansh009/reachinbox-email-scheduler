import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env';
import { encryptSecret } from '../lib/crypto';
import { logger } from '../lib/logger';
import { notInArray } from 'drizzle-orm';
import { closeDb, db } from './index';
import { emailJobs, senders } from './schema';
import { runMigrations } from './migrate';

const accountSchema = z.array(
  z.object({
    user: z.string(),
    pass: z.string(),
    host: z.string().default('smtp.ethereal.email'),
    port: z.coerce.number().default(587),
    secure: z.boolean().optional().default(false),
    name: z.string().optional(),
  }),
);

interface EtherealAccount {
  user: string;
  pass: string;
  host: string;
  port: number;
  secure: boolean;
  name: string;
}

/** Ethereal's provisioning endpoint — the same one nodemailer calls internally. */
const ETHEREAL_API = 'https://api.nodemailer.com/user';

/**
 * Provisions ONE Ethereal account.
 *
 * Deliberately not `nodemailer.createTestAccount()`: that helper memoises the
 * first account for the lifetime of the process, so calling it N times returns
 * the same credentials N times. That silently collapses multi-sender support to
 * a single sender (the unique index on smtp_user drops the rest), which in turn
 * cuts effective throughput to 1x the hourly limit instead of Nx.
 */
async function createEtherealAccount(): Promise<EtherealAccount> {
  const res = await fetch(ETHEREAL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestor: 'reachinbox-scheduler', version: '1.0.0' }),
  });

  if (!res.ok) {
    throw new Error(`Ethereal API returned ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    status?: string;
    user?: string;
    pass?: string;
    smtp?: { host: string; port: number; secure: boolean };
    error?: string;
  };

  if (data.status !== 'success' || !data.user || !data.pass || !data.smtp) {
    throw new Error(`Ethereal API error: ${data.error ?? 'malformed response'}`);
  }

  return {
    user: data.user,
    pass: data.pass,
    host: data.smtp.host,
    port: data.smtp.port,
    secure: data.smtp.secure,
    name: '',
  };
}

/**
 * Ethereal accounts come from one of two places:
 *   1. ETHEREAL_ACCOUNTS env (JSON) — deterministic, survives re-seeding.
 *   2. The Ethereal API — auto-provisioned, needs network access.
 */
async function resolveAccounts(): Promise<EtherealAccount[]> {
  if (env.ETHEREAL_ACCOUNTS.trim().length > 0) {
    const parsed = accountSchema.parse(JSON.parse(env.ETHEREAL_ACCOUNTS));
    logger.info({ count: parsed.length }, 'Using Ethereal accounts from ETHEREAL_ACCOUNTS');
    return parsed.map((a, i) => ({
      user: a.user,
      pass: a.pass,
      host: a.host,
      port: a.port,
      secure: a.secure ?? false,
      name: a.name ?? `ReachInbox Sender ${i + 1}`,
    }));
  }

  logger.info({ count: env.SENDER_COUNT }, 'Provisioning Ethereal accounts (requires internet)');

  const accounts: EtherealAccount[] = [];
  const seen = new Set<string>();

  // Ethereal occasionally hands back an address we already hold; retry rather
  // than silently seeding fewer senders than the operator asked for.
  const maxAttempts = env.SENDER_COUNT * 3;
  let attempts = 0;

  while (accounts.length < env.SENDER_COUNT && attempts < maxAttempts) {
    attempts += 1;
    try {
      const account = await createEtherealAccount();
      if (seen.has(account.user)) {
        logger.warn({ user: account.user }, 'Ethereal returned a duplicate account — retrying');
        continue;
      }
      seen.add(account.user);
      account.name = `ReachInbox Sender ${accounts.length + 1}`;
      accounts.push(account);
      logger.info({ user: account.user, index: accounts.length }, 'Ethereal account provisioned');
    } catch (err) {
      logger.warn({ err, attempt: attempts }, 'Ethereal provisioning attempt failed — retrying');
    }
  }

  if (accounts.length === 0) {
    throw new Error(
      'Could not provision any Ethereal accounts. Check internet access, or set ETHEREAL_ACCOUNTS in .env.',
    );
  }

  if (accounts.length < env.SENDER_COUNT) {
    logger.warn(
      { requested: env.SENDER_COUNT, provisioned: accounts.length },
      'Fewer senders than requested — throughput will be lower than configured',
    );
  }

  return accounts;
}

export async function seed(): Promise<void> {
  await runMigrations();

  // `npm run seed -- --force` replaces the existing senders.
  const force = process.argv.includes('--force');

  const existing = await db.select().from(senders);
  if (existing.length > 0 && !force) {
    logger.info(
      { count: existing.length },
      'Senders already seeded — skipping. Re-run with `--force` to replace them.',
    );
    return;
  }

  if (force && existing.length > 0) {
    // A sent email keeps a foreign key to the sender that delivered it, so
    // senders cannot simply be deleted — and shouldn't be, since that would
    // erase the record of who sent what. Retire them instead: `is_active=false`
    // removes them from round-robin while leaving history intact. Only senders
    // nothing references are actually removed.
    await db.update(senders).set({ isActive: false });

    const referenced = await db
      .selectDistinct({ senderId: emailJobs.senderId })
      .from(emailJobs);
    const referencedIds = referenced.map((r) => r.senderId);

    const deleted =
      referencedIds.length > 0
        ? await db.delete(senders).where(notInArray(senders.id, referencedIds)).returning()
        : await db.delete(senders).returning();

    logger.info(
      { retired: existing.length - deleted.length, deleted: deleted.length },
      'Existing senders cleared (--force): referenced ones retired, unreferenced ones deleted',
    );
  }

  const accounts = await resolveAccounts();

  for (const account of accounts) {
    await db
      .insert(senders)
      .values({
        id: randomUUID(),
        label: account.name,
        smtpHost: account.host,
        smtpPort: account.port,
        smtpSecure: account.secure,
        smtpUser: account.user,
        // Never stored in plaintext.
        smtpPassEnc: encryptSecret(account.pass),
        fromEmail: account.user,
        fromName: account.name,
        isActive: true,
      })
      .onConflictDoNothing();
  }

  const seeded = await db.select().from(senders);
  logger.info({ count: seeded.length }, 'Senders seeded');

  // eslint-disable-next-line no-console
  console.log(
    '\nEthereal credentials (log in at https://ethereal.email to view inboxes):\n' +
      accounts.map((a) => `  ${a.name}: ${a.user} / ${a.pass}`).join('\n') +
      '\n\nTip: paste these into ETHEREAL_ACCOUNTS in .env to reuse them after a DB reset:\n' +
      `ETHEREAL_ACCOUNTS=${JSON.stringify(
        accounts.map((a) => ({
          user: a.user,
          pass: a.pass,
          host: a.host,
          port: a.port,
          name: a.name,
        })),
      )}\n`,
  );
}

if (require.main === module) {
  seed()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'Seed failed');
      process.exit(1);
    });
}
