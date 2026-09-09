import type { PostgresPool } from './client.js';

/**
 * The read side.
 *
 * The brief asks how this data might be queried later, and these are the two
 * queries the schema was designed around. Each one is written to be satisfied
 * by a specific index; see the comments in migrations/001_telemetry_events.sql.
 */

export interface EventRow {
  id: string;
  event_id: string;
  drone_id: string;
  event_time: Date;
  event_type: string;
  status_code: number | null;
  severity: string;
  battery_pct: number | null;
  latitude: number | null;
  longitude: number | null;
  telemetry: Record<string, unknown>;
  source: string;
  ingested_at: Date;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface QueryOptions {
  from?: Date | undefined;
  to?: Date | undefined;
  limit: number;
  cursor?: string | undefined;
}

/**
 * Keyset (not offset) pagination.
 *
 * OFFSET makes the database count and discard every skipped row, so page 500
 * costs 500 times page 1, and rows arriving during paging shift the window and
 * silently skip or repeat records. A cursor on (event_time, id) reads the same
 * number of rows for every page and is stable under concurrent writes, which
 * matters when the table is being appended to continuously.
 */
function encodeCursor(row: { event_time: Date; id: string }): string {
  return Buffer.from(`${row.event_time.toISOString()}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { time: string; id: string } | null {
  try {
    const [time, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (time === undefined || id === undefined) return null;
    if (Number.isNaN(Date.parse(time))) return null;
    return { time, id };
  } catch {
    return null;
  }
}

function buildPage(rows: EventRow[], limit: number): Page<EventRow> {
  // One row is fetched beyond the page size purely to discover whether another
  // page exists, without a second COUNT query.
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
  };
}

const SELECT_COLUMNS = `id::text, event_id, drone_id, event_time, event_type, status_code,
       severity, battery_pct, latitude, longitude, telemetry, source, ingested_at`;

/** "Find all events for a specific drone". Served by idx_telemetry_events_drone_time. */
export async function findEventsByDrone(
  pool: PostgresPool,
  droneId: string,
  options: QueryOptions,
): Promise<Page<EventRow>> {
  const params: unknown[] = [droneId];
  const conditions: string[] = ['drone_id = $1'];

  if (options.from !== undefined) {
    params.push(options.from.toISOString());
    conditions.push(`event_time >= $${params.length}`);
  }
  if (options.to !== undefined) {
    params.push(options.to.toISOString());
    conditions.push(`event_time < $${params.length}`);
  }

  const cursor = options.cursor !== undefined ? decodeCursor(options.cursor) : null;
  if (cursor !== null) {
    params.push(cursor.time, cursor.id);
    conditions.push(`(event_time, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
  }

  params.push(options.limit + 1);

  const { rows } = await pool.query<EventRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM telemetry_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY event_time DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );

  return buildPage(rows, options.limit);
}

/** "Find all errors within a time window". Served by idx_telemetry_events_errors_time. */
export async function findErrors(
  pool: PostgresPool,
  options: QueryOptions,
): Promise<Page<EventRow>> {
  const params: unknown[] = [];
  // Written as a literal so the planner can match the partial index predicate.
  const conditions: string[] = [`severity = 'error'`];

  if (options.from !== undefined) {
    params.push(options.from.toISOString());
    conditions.push(`event_time >= $${params.length}`);
  }
  if (options.to !== undefined) {
    params.push(options.to.toISOString());
    conditions.push(`event_time < $${params.length}`);
  }

  const cursor = options.cursor !== undefined ? decodeCursor(options.cursor) : null;
  if (cursor !== null) {
    params.push(cursor.time, cursor.id);
    conditions.push(`(event_time, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
  }

  params.push(options.limit + 1);

  const { rows } = await pool.query<EventRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM telemetry_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY event_time DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );

  return buildPage(rows, options.limit);
}

export interface QuarantineRow {
  id: string;
  source: string;
  raw_payload: string;
  errors: { path: string; code: string; message: string }[];
  failed_at: Date;
}

/** Operational view: what has been failing, and why. */
export async function findQuarantined(
  pool: PostgresPool,
  limit: number,
): Promise<QuarantineRow[]> {
  const { rows } = await pool.query<QuarantineRow>(
    `SELECT id::text, source, raw_payload, errors, failed_at
       FROM telemetry_quarantine
      ORDER BY failed_at DESC, id DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}
