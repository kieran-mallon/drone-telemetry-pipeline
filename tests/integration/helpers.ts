import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';

import { createPool } from '../../src/adapters/postgres/client.js';
import { runMigrations } from '../../src/adapters/postgres/migrate.js';
import { loadConfig } from '../../src/config.js';

/**
 * Integration tests run against a real Postgres, started per test file by
 * Testcontainers.
 *
 * A mocked database can only ever confirm that the code calls the methods the
 * test author expected. It cannot tell you whether `ON CONFLICT DO NOTHING`
 * actually deduplicates, whether the CHECK constraints hold, or whether the
 * planner picks the partial index. Those are the properties the design depends
 * on, so they are tested against the real thing. The same container image the
 * Compose stack uses, so the test environment and the dev environment cannot
 * silently diverge.
 *
 * The pool is built with the same `createPool` the application uses, not a raw
 * `new Pool`. That is deliberate, and it was not always the case: creating the
 * pool directly meant the tests ran against different client configuration from
 * production, and it hid a real bug where NUMERIC columns came back as strings
 * because the type parser was only registered as a side effect of importing
 * `client.ts`. A test double should differ from production in what it talks to,
 * not in how it is configured.
 */

export interface TestDatabase {
  pool: pg.Pool;
  stop: () => Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:17-alpine',
  ).start();

  // Also exercises config parsing, so a broken schema fails here rather than at
  // deploy time.
  const config = loadConfig({ DATABASE_URL: container.getConnectionUri() } as NodeJS.ProcessEnv);
  const pool = createPool(config);

  // Migrations run as part of setup, so every integration test also serves as a
  // check that the migrations apply cleanly from an empty database.
  await runMigrations(pool);

  return {
    pool,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query('TRUNCATE telemetry_events, telemetry_quarantine RESTART IDENTITY');
}
