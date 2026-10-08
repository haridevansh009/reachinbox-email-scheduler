import IORedis from 'ioredis';
import { env } from '../config/env';
import { logger } from '../lib/logger';

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it blocks on,
 * otherwise long-running blocking commands are aborted mid-flight.
 */
/**
 * Railway/Render private networking resolves only over IPv6, but ioredis defaults
 * to `family: 4` and would fail with ENOTFOUND against a `*.railway.internal`
 * host. `family: 0` lets Node try both A and AAAA records.
 */
const isInternalHost = /\.(railway|render)\.internal(:|\/|$)/i.test(env.REDIS_URL);

export function createRedisConnection(role: string): IORedis {
  const client = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    ...(isInternalHost ? { family: 0 } : {}),
  });

  client.on('error', (err) => logger.error({ err, role }, 'Redis connection error'));
  client.on('reconnecting', () => logger.warn({ role }, 'Redis reconnecting'));

  return client;
}

/** Shared connection for non-blocking work: rate limiting, health checks, queue writes. */
export const redis = createRedisConnection('shared');

export async function checkRedisConnection(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch (err) {
    logger.error({ err }, 'Redis health check failed');
    return false;
  }
}
