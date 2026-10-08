import fs from 'node:fs';
import path from 'node:path';
import { closeDb, pool } from './index';
import { logger } from '../lib/logger';

/**
 * Applies the schema. The SQL is written to be idempotent (CREATE ... IF NOT EXISTS)
 * so this can safely run on every deploy without a migration-state table.
 */
export async function runMigrations(): Promise<void> {
  // Works both from src/ (tsx) and dist/ (compiled, file copied by `npm run build`).
  const candidates = [
    path.join(__dirname, 'migrations.sql'),
    path.resolve(process.cwd(), 'src/db/migrations.sql'),
  ];
  const sqlPath = candidates.find((p) => fs.existsSync(p));
  if (!sqlPath) throw new Error(`migrations.sql not found. Looked in: ${candidates.join(', ')}`);

  const sql = fs.readFileSync(sqlPath, 'utf8');
  await pool.query(sql);
  logger.info('Database schema applied');
}

if (require.main === module) {
  runMigrations()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'Migration failed');
      process.exit(1);
    });
}
