import pg from 'pg';

import type { Config } from '../../config.js';

const { Pool, types } = pg;

/** Postgres OID for NUMERIC. */
const NUMERIC_OID = 1700;

/**
 * Teach node-postgres to return NUMERIC as a number.
 *
 * By default it returns a string, because a Postgres NUMERIC can hold values
 * that lose precision as a JavaScript double. `battery_pct` is NUMERIC(5,2),
 * which is nowhere near that boundary, so a string here just means the API
 * serves {"battery_pct": "87.50"} and every consumer has to remember to coerce.
 *
 * This is an explicit function rather than a side effect of importing this
 * module, and an integration test is why. The registration used to run at
 * import time, so any pool created without importing this file, which is
 * exactly what the test helper did, silently got strings back. Correctness that
 * depends on which modules happen to have been imported is not correctness.
 *
 * Note that `setTypeParser` mutates pg's process-global registry, so this
 * affects every pool in the process. That is fine, and intended, but it is the
 * reason it is called from one place.
 */
export function registerTypeParsers(): void {
  types.setTypeParser(NUMERIC_OID, (value) => (value === null ? null : Number(value)));
}

export type PostgresPool = pg.Pool;

export function createPool(config: Config): PostgresPool {
  registerTypeParsers();

  return new Pool({
    connectionString: config.databaseUrl,

    /**
     * Deliberately small. Under Lambda each concurrent invocation is its own
     * process with its own pool, so a generous pool size multiplied by the
     * concurrency limit is how you exhaust max_connections on RDS and take the
     * database down with your own ingestion. The production answer is RDS Proxy
     * in front of this; see the README.
     */
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,

    /** Fail a wedged query rather than holding a connection open indefinitely. */
    statement_timeout: 30_000,
  });
}
