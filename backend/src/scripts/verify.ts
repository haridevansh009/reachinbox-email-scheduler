/* eslint-disable no-console */
import assert from 'node:assert/strict';
import { HOUR_MS } from '../config/env';
import { parseLeadFile } from '../lib/csv';
import { decryptSecret, encryptSecret } from '../lib/crypto';
import { plannedEndAt, plannedSendTime, rescheduleDelayMs, type PlanInput } from '../services/scheduler';

/**
 * Self-checks for the pure logic that does not need Postgres or Redis:
 * the send-time planner, the rate-limit backoff, the lead parser, and crypto.
 *
 *   npm run verify
 */

let passed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
};

const START = new Date('2026-01-01T00:00:00.000Z');

console.log('\nSend-time planner');

check('spaces sends by minDelay within one sender', () => {
  const plan: PlanInput = {
    startAt: START,
    totalRecipients: 5,
    minDelayMs: 2000,
    hourlyLimit: 200,
    senderCount: 1,
  };
  const times = [0, 1, 2, 3, 4].map((i) => plannedSendTime(i, plan).getTime() - START.getTime());
  assert.deepEqual(times, [0, 2000, 4000, 6000, 8000]);
});

check('round-robins across senders so each runs its own stream', () => {
  const plan: PlanInput = {
    startAt: START,
    totalRecipients: 6,
    minDelayMs: 2000,
    hourlyLimit: 200,
    senderCount: 3,
  };
  // Recipients 0,1,2 go to three different senders -> all send immediately.
  const offsets = [0, 1, 2, 3, 4, 5].map((i) => plannedSendTime(i, plan).getTime() - START.getTime());
  assert.deepEqual(offsets, [0, 0, 0, 2000, 2000, 2000]);
});

check('rolls into the next hour window once the hourly cap is reached', () => {
  const plan: PlanInput = {
    startAt: START,
    totalRecipients: 401,
    minDelayMs: 2000,
    hourlyLimit: 200,
    senderCount: 1,
  };
  // Recipient 199 is the last of hour 0; 200 must land in hour 1.
  assert.equal(plannedSendTime(199, plan).getTime() - START.getTime(), 199 * 2000);
  assert.equal(plannedSendTime(200, plan).getTime() - START.getTime(), HOUR_MS);
  assert.equal(plannedSendTime(400, plan).getTime() - START.getTime(), 2 * HOUR_MS);
});

check('1000 emails at 200/hr across 3 senders finish in under 2 hours', () => {
  const plan: PlanInput = {
    startAt: START,
    totalRecipients: 1000,
    minDelayMs: 2000,
    hourlyLimit: 200,
    senderCount: 3,
  };
  const end = plannedEndAt(plan).getTime() - START.getTime();
  // 3 senders x 200/hr = 600/hr, so 1000 spans two hour windows.
  assert.ok(end < 2 * HOUR_MS, `expected < 2h, got ${end / HOUR_MS}h`);
  assert.ok(end > HOUR_MS, `expected > 1h, got ${end / HOUR_MS}h`);
});

check('never schedules two sends on one sender at the same instant', () => {
  const plan: PlanInput = {
    startAt: START,
    totalRecipients: 500,
    minDelayMs: 30_000, // 30s gap x 200/hr would exceed an hour: spacing binds
    hourlyLimit: 200,
    senderCount: 1,
  };
  const seen = new Set<number>();
  for (let i = 0; i < 500; i += 1) {
    const t = plannedSendTime(i, plan).getTime();
    assert.ok(!seen.has(t), `duplicate send time at index ${i}`);
    seen.add(t);
  }
});

check('plan is deterministic — same input, same output', () => {
  const plan: PlanInput = {
    startAt: START,
    totalRecipients: 50,
    minDelayMs: 2000,
    hourlyLimit: 10,
    senderCount: 2,
  };
  for (let i = 0; i < 50; i += 1) {
    assert.equal(plannedSendTime(i, plan).getTime(), plannedSendTime(i, plan).getTime());
  }
});

console.log('\nRate-limit backoff');

check('a gap rejection retries almost immediately', () => {
  const delay = rescheduleDelayMs({
    reason: 'gap',
    retryAfterMs: 800,
    sequenceIndex: 42,
    hourlyLimit: 200,
    minDelayMs: 2000,
  });
  assert.equal(delay, 850);
});

check('a quota rejection re-lays jobs in order inside the next window', () => {
  const base = { reason: 'quota' as const, retryAfterMs: 60_000, hourlyLimit: 200, minDelayMs: 2000 };
  const a = rescheduleDelayMs({ ...base, sequenceIndex: 0 });
  const b = rescheduleDelayMs({ ...base, sequenceIndex: 1 });
  const c = rescheduleDelayMs({ ...base, sequenceIndex: 2 });
  // Original CSV order is preserved, spaced by minDelay.
  assert.ok(a < b && b < c, 'ordering not preserved');
  assert.equal(b - a, 2000);
  assert.equal(c - b, 2000);
});

console.log('\nLead file parser');

check('reads a headered CSV with the address in any column', () => {
  const csv = 'name,email,company\nJane Doe,jane@acme.com,Acme\nJohn Roe,john@beta.io,Beta\n';
  const result = parseLeadFile(csv);
  assert.deepEqual(result.emails, ['jane@acme.com', 'john@beta.io']);
});

check('reads a bare newline-separated list', () => {
  const result = parseLeadFile('a@x.com\nb@y.com\nc@z.com');
  assert.deepEqual(result.emails, ['a@x.com', 'b@y.com', 'c@z.com']);
});

check('extracts addresses embedded in display-name form', () => {
  const result = parseLeadFile('Jane Doe <jane@acme.com>\nBob <bob@beta.io>');
  assert.deepEqual(result.emails, ['jane@acme.com', 'bob@beta.io']);
});

check('de-duplicates case-insensitively and preserves first-seen order', () => {
  const result = parseLeadFile('b@x.com\nA@x.com\na@x.com\nB@X.com');
  assert.deepEqual(result.emails, ['b@x.com', 'a@x.com']);
  assert.equal(result.duplicatesRemoved, 2);
});

check('ignores rows with no valid address', () => {
  const result = parseLeadFile('name,notes\nJane,no email here\nJohn,john@ok.com');
  assert.deepEqual(result.emails, ['john@ok.com']);
  assert.equal(result.invalidRows, 2); // header row + the Jane row
});

console.log('\nCredential encryption');

check('SMTP passwords round-trip through AES-256-GCM', () => {
  const secret = 'sup3r-s3cret-ethereal-password';
  const encrypted = encryptSecret(secret);
  assert.notEqual(encrypted, secret);
  assert.equal(encrypted.split(':').length, 3);
  assert.equal(decryptSecret(encrypted), secret);
});

check('ciphertext differs each time (random IV)', () => {
  assert.notEqual(encryptSecret('same'), encryptSecret('same'));
});

check('tampered ciphertext is rejected', () => {
  const encrypted = encryptSecret('payload');
  const [iv, tag, data] = encrypted.split(':');
  const tampered = `${iv}:${tag}:${data!.slice(0, -2)}ff`;
  assert.throws(() => decryptSecret(tampered));
});

console.log(`\n${passed} checks passed.\n`);
process.exit(0);
