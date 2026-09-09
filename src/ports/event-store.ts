import type { QuarantinedRecord, TelemetryEvent } from '../core/schema.js';

/** Outcome of a batch insert, so the caller can log what actually happened. */
export interface InsertResult {
  attempted: number;
  inserted: number;
  /** Rows already present, skipped by the UNIQUE constraint on event_id. */
  duplicates: number;
}

/**
 * The storage port.
 *
 * Deliberately narrow. The handler needs exactly two capabilities: write good
 * events, and write bad ones somewhere they can be inspected. Keeping the port
 * this small is what lets the whole handler be tested against an in-memory
 * implementation, and what would make swapping Postgres for DynamoDB a change
 * to one file rather than a rewrite.
 *
 * Both methods are batch-oriented on purpose. A per-record interface would push
 * callers into a round trip per row, which at fleet volumes is the difference
 * between one insert and ten thousand.
 */
export interface EventStore {
  insertEvents(events: readonly TelemetryEvent[]): Promise<InsertResult>;
  insertQuarantined(records: readonly QuarantinedRecord[]): Promise<number>;
}
