import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { PostgresPool } from './client.js';

/**
 * A deliberately small migration runner.
 *
 * Numbered .sql files, applied in order, each inside a transaction, recorded in
 * a table so they run exactly once. That is the whole feature set, and for this
 * project it is enough. A migration tool would add a dependency and a config
 * file to do the same thing, and would put a layer between the reviewer and the
 * SQL, which is the part of this project most worth reading.
 *
 * What a real deployment would want on top: down migrations (or a strict
 * forward-only policy), an advisory lock so two instances starting at once
 * cannot race, and a separate migration step in the deploy pipeline rather than
 * migrations running from application startup.
 */

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(
  pool: PostgresPool,
  directory: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationResult> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(directory)).filter((f) => f.endsWith('.sql')).sort();

  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const alreadyApplied = new Set(rows.map((row) => row.name));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (alreadyApplied.has(file)) {
      skipped.push(file);
      continue;
    }

    const sql = await readFile(new URL(file, `file://${directory}`), 'utf8');
    const client = await pool.connect();

    try {
      // One transaction per migration: a migration either lands completely or
      // not at all, and a failure leaves the recorded state honest.
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}

/** CLI entry point: `npm run migrate`. */
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const { loadConfig } = await import('../../config.js');
  const { createPool } = await import('./client.js');

  const pool = createPool(loadConfig());
  try {
    const result = await runMigrations(pool);
    for (const name of result.applied) console.error(`applied  ${name}`);
    for (const name of result.skipped) console.error(`skipped  ${name} (already applied)`);
    console.error(`\nmigrations complete: ${result.applied.length} applied, ${result.skipped.length} already present`);
  } catch (error) {
    console.error(`migration failed: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
