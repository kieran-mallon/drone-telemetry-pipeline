import type { QuarantinedRecord, TelemetryEvent } from '../../core/schema.js';
import type { EventStore, InsertResult } from '../../ports/event-store.js';
import type { PostgresPool } from './client.js';

const EVENT_COLUMNS = [
  'event_id',
  'drone_id',
  'event_time',
  'event_type',
  'status_code',
  'severity',
  'battery_pct',
  'latitude',
  'longitude',
  'telemetry',
  'raw',
  'source',
] as const;

/**
 * Postgres has a hard limit of 65535 bind parameters per statement. At 12
 * parameters per row that is ~5400 rows, so batches are chunked well below it.
 * The chunk size is configurable rather than hard-coded because the right value
 * depends on row width and network latency.
 */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function buildValuesClause(rowCount: number, columnCount: number): string {
  const rows: string[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    const placeholders: string[] = [];
    for (let column = 0; column < columnCount; column += 1) {
      placeholders.push(`$${row * columnCount + column + 1}`);
    }
    rows.push(`(${placeholders.join(', ')})`);
  }
  return rows.join(', ');
}

export class PostgresEventStore implements EventStore {
  constructor(
    private readonly pool: PostgresPool,
    private readonly chunkSize = 500,
  ) {}

  /**
   * Insert valid events, skipping any whose event_id is already present.
   *
   * `ON CONFLICT (event_id) DO NOTHING` is the entire idempotency mechanism.
   * SQS guarantees at-least-once delivery and S3 can fire the same
   * notification twice, so redelivery is a routine event, not an exceptional
   * one. Enforcing uniqueness in the database rather than with a read-then-write
   * check in the application also makes it correct under concurrency: two
   * Lambdas processing the same redelivered message race at the constraint and
   * exactly one wins, with no distributed lock required.
   *
   * `rowCount` reflects rows actually written, so the difference from the
   * attempted count is the duplicate count, for free.
   */
  async insertEvents(events: readonly TelemetryEvent[]): Promise<InsertResult> {
    if (events.length === 0) return { attempted: 0, inserted: 0, duplicates: 0 };

    let inserted = 0;

    for (const batch of chunk(events, this.chunkSize)) {
      const values = batch.flatMap((event) => [
        event.eventId,
        event.droneId,
        event.eventTime.toISOString(),
        event.eventType,
        event.statusCode,
        event.severity,
        event.batteryPct,
        event.latitude,
        event.longitude,
        JSON.stringify(event.telemetry),
        JSON.stringify(event.raw ?? null),
        event.source,
      ]);

      const result = await this.pool.query(
        `INSERT INTO telemetry_events (${EVENT_COLUMNS.join(', ')})
         VALUES ${buildValuesClause(batch.length, EVENT_COLUMNS.length)}
         ON CONFLICT (event_id) DO NOTHING`,
        values,
      );

      inserted += result.rowCount ?? 0;
    }

    return {
      attempted: events.length,
      inserted,
      duplicates: events.length - inserted,
    };
  }

  async insertQuarantined(records: readonly QuarantinedRecord[]): Promise<number> {
    if (records.length === 0) return 0;

    let written = 0;

    for (const batch of chunk(records, this.chunkSize)) {
      const values = batch.flatMap((record) => [
        record.source,
        record.rawPayload,
        JSON.stringify(record.errors),
      ]);

      const result = await this.pool.query(
        `INSERT INTO telemetry_quarantine (source, raw_payload, errors)
         VALUES ${buildValuesClause(batch.length, 3)}`,
        values,
      );

      written += result.rowCount ?? 0;
    }

    return written;
  }
}
