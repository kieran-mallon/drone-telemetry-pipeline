import pg from 'pg';

import type { Config } from '../../config.js';

const { Pool, types } = pg;

/**
 * node-postgres returns NUMERIC as a string, because a Postgres NUMERIC can
 * hold values that lose precision as a JavaScript number. battery_pct is
 * NUMERIC(5,2), which is comfortably inside the safe integer range once scaled,
 * so parsing it here keeps the API returning numbers rather than strings.
 * OID 1700 is NUMERIC.
 */
types.setTypeParser(1700, (value) => (value === null ? null : Number(value)));

export type PostgresPool = pg.Pool;

export function createPool(config: Config): PostgresPool {
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
