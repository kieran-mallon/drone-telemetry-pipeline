import type { QuarantinedRecord, TelemetryEvent } from '../../core/schema.js';
import type { EventStore, InsertResult } from '../../ports/event-store.js';

/**
 * An in-memory EventStore for tests.
 *
 * It reproduces the one behaviour of the real store that the handler depends
 * on: uniqueness on event_id. A double that accepted duplicates would let an
 * idempotency bug pass its own test, which is the classic way a test double
 * makes a suite worse rather than better.
 *
 * `failNextWith` exists so failure paths can be exercised without a database.
 * Distinguishing "the database is down" from "this record is malformed" is the
 * central error-handling decision in this service, and it needs a test.
 */
export class InMemoryEventStore implements EventStore {
  readonly events = new Map<string, TelemetryEvent>();
  readonly quarantined: QuarantinedRecord[] = [];

  private pendingFailure: Error | undefined;

  /** The next call to either method throws this, then the failure clears. */
  failNextWith(error: Error): void {
    this.pendingFailure = error;
  }

  private throwIfFailing(): void {
    if (this.pendingFailure !== undefined) {
      const error = this.pendingFailure;
      this.pendingFailure = undefined;
      throw error;
    }
  }

  async insertEvents(events: readonly TelemetryEvent[]): Promise<InsertResult> {
    this.throwIfFailing();

    let inserted = 0;
    for (const event of events) {
      if (this.events.has(event.eventId)) continue;
      this.events.set(event.eventId, event);
      inserted += 1;
    }

    return { attempted: events.length, inserted, duplicates: events.length - inserted };
  }

  async insertQuarantined(records: readonly QuarantinedRecord[]): Promise<number> {
    this.throwIfFailing();
    this.quarantined.push(...records);
    return records.length;
  }
}
