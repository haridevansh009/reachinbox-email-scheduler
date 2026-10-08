import type IORedis from 'ioredis';
import { HOUR_MS } from '../config/env';
import { redis } from '../queue/connection';

/**
 * Distributed rate limiter for outbound email.
 *
 * Two constraints are enforced together, per sender:
 *   1. MIN GAP    — at least `minDelayMs` between two sends on the same sender.
 *   2. HOURLY CAP — at most `hourlyLimit` sends inside a fixed 1-hour window.
 *
 * Both are checked AND committed inside a single Lua script. Redis executes Lua
 * single-threaded with no interleaving, so there is no check-then-increment race:
 * this stays correct with any worker concurrency, across any number of processes.
 *
 * An in-memory counter would be wrong here — two worker processes would each
 * believe they were under the limit.
 */

// KEYS[1] = rl:gap:{senderId}
// KEYS[2] = rl:quota:{senderId}:{hourWindow}
// ARGV[1] = now (ms)   ARGV[2] = minDelayMs
// ARGV[3] = hourlyLimit  ARGV[4] = ms remaining until the next hour window
// -> { allowed, retryAfterMs, reason }
const ACQUIRE_LUA = `
local lastSend   = tonumber(redis.call('GET', KEYS[1]) or '0')
local now        = tonumber(ARGV[1])
local minDelay   = tonumber(ARGV[2])
local limit      = tonumber(ARGV[3])
local msToWindow = tonumber(ARGV[4])

-- Gate 1: minimum spacing between sends on this sender.
local elapsed = now - lastSend
if elapsed < minDelay then
  return { 0, math.floor(minDelay - elapsed), 'gap' }
end

-- Gate 2: hourly quota for this sender.
local used = tonumber(redis.call('GET', KEYS[2]) or '0')
if used >= limit then
  return { 0, math.floor(msToWindow), 'quota' }
end

-- Both gates passed: commit them together, atomically.
redis.call('INCR', KEYS[2])
-- Keep the counter alive for two windows so it expires on its own; no cleanup job.
redis.call('EXPIRE', KEYS[2], 7200)
redis.call('SET', KEYS[1], now, 'PX', math.max(minDelay * 2, 1000))

return { 1, 0, 'ok' }
`;

// Returns the quota consumed in the current window without mutating anything.
const PEEK_LUA = `
return { tonumber(redis.call('GET', KEYS[1]) or '0') }
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    rlAcquire(
      gapKey: string,
      quotaKey: string,
      now: string,
      minDelayMs: string,
      hourlyLimit: string,
      msToWindow: string,
    ): Promise<[number, number, string]>;
    rlPeek(quotaKey: string): Promise<[number]>;
  }
}

let defined = false;

function ensureCommands(client: IORedis): void {
  if (defined) return;
  client.defineCommand('rlAcquire', { numberOfKeys: 2, lua: ACQUIRE_LUA });
  client.defineCommand('rlPeek', { numberOfKeys: 1, lua: PEEK_LUA });
  defined = true;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** How long to wait before this job should be retried. 0 when allowed. */
  retryAfterMs: number;
  reason: 'ok' | 'gap' | 'quota';
}

export interface RateLimitParams {
  senderId: string;
  minDelayMs: number;
  hourlyLimit: number;
  now?: number;
}

/** Fixed tumbling window: every sender shares the same hour boundaries. */
export const hourWindowOf = (ts: number) => Math.floor(ts / HOUR_MS);

const gapKey = (senderId: string) => `rl:gap:${senderId}`;
const quotaKey = (senderId: string, window: number) => `rl:quota:${senderId}:${window}`;

/**
 * Attempts to consume one send slot for `senderId`.
 * On success the slot is already committed — the caller MUST attempt the send.
 */
export async function acquireSendSlot(params: RateLimitParams): Promise<RateLimitDecision> {
  ensureCommands(redis);

  const now = params.now ?? Date.now();
  const window = hourWindowOf(now);
  const msToNextWindow = (window + 1) * HOUR_MS - now;

  const [allowed, retryAfterMs, reason] = await redis.rlAcquire(
    gapKey(params.senderId),
    quotaKey(params.senderId, window),
    String(now),
    String(params.minDelayMs),
    String(params.hourlyLimit),
    String(msToNextWindow),
  );

  return {
    allowed: allowed === 1,
    retryAfterMs,
    reason: reason as RateLimitDecision['reason'],
  };
}

/** Read-only view of a sender's current-hour usage, for /api/stats. */
export async function peekSenderUsage(senderId: string, now = Date.now()): Promise<number> {
  ensureCommands(redis);
  const [used] = await redis.rlPeek(quotaKey(senderId, hourWindowOf(now)));
  return used ?? 0;
}
