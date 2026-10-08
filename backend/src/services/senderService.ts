import { eq } from 'drizzle-orm';
import { db } from '../db';
import { senders, type SenderRow } from '../db/schema';
import { decryptSecret } from '../lib/crypto';

export interface SenderCredentials {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromEmail: string;
  fromName: string;
}

/** Active senders are cached briefly — the set changes only when seeding. */
let cache: { rows: SenderRow[]; at: number } | null = null;
const CACHE_TTL_MS = 30_000;

export async function listActiveSenders(force = false): Promise<SenderRow[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.rows;
  }
  const rows = await db.select().from(senders).where(eq(senders.isActive, true)).orderBy(senders.createdAt);
  cache = { rows, at: Date.now() };
  return rows;
}

export function invalidateSenderCache(): void {
  cache = null;
}

export async function getSenderCredentials(senderId: string): Promise<SenderCredentials | null> {
  const rows = await db.select().from(senders).where(eq(senders.id, senderId)).limit(1);
  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    label: row.label,
    host: row.smtpHost,
    port: row.smtpPort,
    secure: row.smtpSecure,
    user: row.smtpUser,
    pass: decryptSecret(row.smtpPassEnc),
    fromEmail: row.fromEmail,
    fromName: row.fromName,
  };
}

/**
 * Round-robin assignment. Recipient i goes to sender i % N, which spreads a
 * campaign evenly and lets each sender burn its own hourly quota in parallel —
 * effective throughput is N x the per-sender limit.
 */
export function assignSender(sequenceIndex: number, senderIds: string[]): string {
  if (senderIds.length === 0) {
    throw new Error('No active senders configured. Run `npm run seed` to create Ethereal accounts.');
  }
  return senderIds[sequenceIndex % senderIds.length]!;
}
