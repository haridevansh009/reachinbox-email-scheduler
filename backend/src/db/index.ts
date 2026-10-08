import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import * as schema from './schema';

/**
 * Managed Postgres (Railway, Render, Neon, Supabase, Heroku) terminates TLS with
 * a certificate the container has no CA for. Without this the connection is
 * refused outright — the commonest cause of a crash-loop on first deploy.
 * Enabled by DATABASE_SSL=true, or automatically when the URL asks for SSL.
 */
const needsSsl =
  env.DATABASE_SSL ||
  /[?&]sslmode=(require|verify-ca|verify-full)/.test(env.DATABASE_URL);

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle Postgres client');
});

export const db = drizzle(pool, { schema });

export async function checkDbConnection(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    logger.error({ err }, 'Postgres health check failed');
    return false;
  }
}

export async function closeDb(): Promise<void> {
  await pool.end();
}

export { schema };
