import { parsePayload, safeStringify, type ParseOptions, type RawRecord } from './parse.js';
import type { QuarantinedRecord, TelemetryEvent } from './schema.js';
import { toTelemetryEvent } from './transform.js';
import { validateRecord } from './validate.js';

/**
 * The pipeline: parse, validate, transform, in one pass over a batch.
 *
 * The contract is the important part, and it holds for every function here:
 *
 *   - It NEVER throws. Every record either becomes an event or becomes a
 *     quarantine row. There is no third outcome and no way for one bad record
 *     to affect its neighbours.
 *   - It performs no I/O. No database, no network, no clock beyond timestamp
 *     validation. That is what makes the tests for this module fast, complete
 *     and free of mocks.
 *
 * All the messy real-world behaviour lives here, behind a signature that takes
 * data and returns data.
 */

export interface PipelineStats {
  received: number;
  valid: number;
  quarantined: number;
  /** Records dropped because an earlier record in the same batch had the same event id. */
  duplicatesInBatch: number;
}

export interface PipelineResult {
  events: TelemetryEvent[];
  quarantined: QuarantinedRecord[];
  stats: PipelineStats;
}

export function processRecords(records: readonly RawRecord[]): PipelineResult {
  const events: TelemetryEvent[] = [];
  const quarantined: QuarantinedRecord[] = [];

  /**
   * In-batch deduplication.
   *
   * The database UNIQUE constraint is the real guarantee, but Postgres will not
   * accept the same key twice inside a single multi-row INSERT even with
   * ON CONFLICT DO NOTHING. Collapsing duplicates here keeps the batch insert a
   * single round trip instead of forcing a row-at-a-time fallback, and it lets
   * us report in-batch duplicates separately from cross-batch ones, which are
   * different operational signals: the first suggests a chatty drone, the
   * second a redelivery.
   */
  const seenEventIds = new Set<string>();
  let duplicatesInBatch = 0;

  for (const record of records) {
    if (record.parseError !== undefined) {
      quarantined.push({
        source: record.source,
        rawPayload: record.rawText,
        errors: [{ path: '(root)', code: 'parse_error', message: record.parseError }],
      });
      continue;
    }

    const validation = validateRecord(record.value);

    if (!validation.ok) {
      quarantined.push({
        source: record.source,
        rawPayload: record.rawText,
        errors: validation.issues,
      });
      continue;
    }

    const event = toTelemetryEvent(validation.value, {
      source: record.source,
      raw: record.value,
    });

    if (seenEventIds.has(event.eventId)) {
      duplicatesInBatch += 1;
      continue;
    }

    seenEventIds.add(event.eventId);
    events.push(event);
  }

  return {
    events,
    quarantined,
    stats: {
      received: records.length,
      valid: events.length,
      quarantined: quarantined.length,
      duplicatesInBatch,
    },
  };
}

/** Convenience wrapper: parse a whole payload, then run it through the pipeline. */
export function processPayload(body: string, options: ParseOptions): PipelineResult {
  return processRecords(parsePayload(body, options));
}

/**
 * Wrap a single already-decoded record (the direct-SQS-message path) so it can
 * go through exactly the same pipeline as a record read out of a file. One code
 * path, two entry points.
 */
export function asRawRecord(value: unknown, source: string): RawRecord {
  return { value, rawText: safeStringify(value), source };
}
