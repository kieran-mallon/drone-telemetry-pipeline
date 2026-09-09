import { z } from 'zod';

import { asRawRecord, processRecords } from '../core/pipeline.js';
import { detectFormat, parsePayload, type RawRecord } from '../core/parse.js';
import type { EventStore } from '../ports/event-store.js';
import type { Logger } from '../ports/logger.js';
import type { ObjectStore } from '../ports/object-store.js';

/**
 * The one handler.
 *
 * This same function runs as an AWS Lambda behind an SQS event source mapping
 * and as a long-lived poller in Docker. Neither runtime appears in this file:
 * it takes messages and dependencies, and returns a result. That is the point
 * of the hexagonal split. The transport is a detail; the pipeline is the
 * product.
 *
 * It accepts two message shapes, because the brief describes both:
 *   1. An S3 event notification, meaning "a batch file landed, go and read it".
 *   2. A telemetry record (or array of records) posted straight to the queue.
 *
 * They converge on `processRecords` within a few lines, so there is exactly one
 * implementation of validation, transformation and deduplication regardless of
 * how the data arrived.
 */

export interface IngestMessage {
  messageId: string;
  body: string;
}

export interface HandlerDependencies {
  eventStore: EventStore;
  objectStore: ObjectStore;
  logger: Logger;
  maxRecordsPerObject: number;
}

export interface MessageOutcome {
  messageId: string;
  status: 'processed' | 'skipped' | 'failed';
  received: number;
  inserted: number;
  duplicates: number;
  quarantined: number;
  error?: string;
}

export interface HandlerResult {
  outcomes: MessageOutcome[];
  /**
   * Messages that hit an infrastructure failure and should be retried.
   * The Lambda runtime returns these as `batchItemFailures` so that only the
   * genuinely failed messages go back on the queue, rather than the whole batch.
   */
  failedMessageIds: string[];
}

// ---------------------------------------------------------------------------
// S3 event notification
// ---------------------------------------------------------------------------

const s3NotificationSchema = z.object({
  Records: z
    .array(
      z.object({
        s3: z.object({
          bucket: z.object({ name: z.string() }),
          object: z.object({ key: z.string(), size: z.number().optional() }),
        }),
      }),
    )
    .min(1),
});

/**
 * When you attach a notification configuration to a bucket, S3 immediately
 * sends a single `s3:TestEvent` to prove the wiring works. It is not telemetry
 * and it has no object to fetch. Left unhandled it fails validation on every
 * deploy and lands in the DLQ, which is a confusing first impression of an
 * otherwise healthy pipeline.
 */
const s3TestEventSchema = z.object({
  Service: z.literal('Amazon S3'),
  Event: z.literal('s3:TestEvent'),
});

/**
 * S3 URL-encodes object keys in notifications, and encodes spaces as '+'
 * specifically. Skipping this step is the classic reason a pipeline works in
 * testing and then cannot find "delivery batch 2026-09-01.csv" in production.
 */
export function decodeS3Key(key: string): string {
  return decodeURIComponent(key.replace(/\+/g, ' '));
}

// ---------------------------------------------------------------------------
// Resolving a message into candidate records
// ---------------------------------------------------------------------------

type Resolution =
  | { kind: 'records'; records: RawRecord[] }
  | { kind: 'skip'; reason: string };

/**
 * Turn one queue message into candidate records.
 *
 * Anything thrown from here is an INFRASTRUCTURE failure (S3 unreachable, for
 * example) and must be retried. Bad *data* never throws: it comes back as
 * records carrying a `parseError`, which the pipeline quarantines.
 */
async function resolveMessage(
  message: IngestMessage,
  dependencies: HandlerDependencies,
): Promise<Resolution> {
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(message.body);
  } catch {
    // Not JSON at all. Treat the raw body as a payload so it is quarantined
    // with its original text rather than silently dropped.
    return {
      kind: 'records',
      records: [
        {
          value: undefined,
          rawText: message.body,
          source: `sqs:${message.messageId}`,
          parseError: 'message body is not valid JSON',
        },
      ],
    };
  }

  if (s3TestEventSchema.safeParse(parsedBody).success) {
    return { kind: 'skip', reason: 's3:TestEvent' };
  }

  const notification = s3NotificationSchema.safeParse(parsedBody);

  if (notification.success) {
    const records: RawRecord[] = [];

    for (const entry of notification.data.Records) {
      const bucket = entry.s3.bucket.name;
      const key = decodeS3Key(entry.s3.object.key);

      // A throw here propagates and the message is retried, which is correct:
      // a transient S3 error should not discard a batch file.
      const body = await dependencies.objectStore.getObjectText(bucket, key);

      records.push(
        ...processPayloadRecords(body, `s3://${bucket}/${key}`, dependencies.maxRecordsPerObject),
      );
    }

    return { kind: 'records', records };
  }

  // Not an S3 notification, so the message body is telemetry itself.
  const source = `sqs:${message.messageId}`;
  const values = Array.isArray(parsedBody) ? parsedBody : [parsedBody];

  return {
    kind: 'records',
    records: values.map((value, index) =>
      asRawRecord(value, values.length > 1 ? `${source}#${index}` : source),
    ),
  };
}

/**
 * Split one object's body into candidate records, letting the file extension
 * (falling back to content sniffing) decide the format. CSV, NDJSON and JSON
 * all land on the same `RawRecord[]` shape here, which is why nothing
 * downstream needs to know which one it was.
 */
function processPayloadRecords(body: string, source: string, maxRecords: number): RawRecord[] {
  return parsePayload(body, {
    sourcePrefix: source,
    format: detectFormat(source, body),
    maxRecords,
  });
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

export async function processTelemetry(
  messages: readonly IngestMessage[],
  dependencies: HandlerDependencies,
): Promise<HandlerResult> {
  const outcomes: MessageOutcome[] = [];
  const failedMessageIds: string[] = [];

  for (const message of messages) {
    const logger = dependencies.logger.child({ messageId: message.messageId });
    const startedAt = Date.now();

    try {
      const resolution = await resolveMessage(message, dependencies);

      if (resolution.kind === 'skip') {
        logger.debug({ reason: resolution.reason }, 'message skipped');
        outcomes.push({
          messageId: message.messageId,
          status: 'skipped',
          received: 0,
          inserted: 0,
          duplicates: 0,
          quarantined: 0,
        });
        continue;
      }

      const result = processRecords(resolution.records);

      /**
       * Order matters. Events are written first because they are the product;
       * quarantine is diagnostic. If the quarantine write then fails, the
       * message is retried and the events collide harmlessly on their unique
       * constraint.
       *
       * The accepted trade-off: a retry can write the same quarantine rows
       * twice, because that table has no dedupe key. Duplicated diagnostics are
       * a much cheaper mistake than duplicated telemetry, which would corrupt
       * every downstream count. If it became a problem, the fix is a dedupe key
       * on (source, hash(raw_payload)).
       */
      const insertResult = await dependencies.eventStore.insertEvents(result.events);
      const quarantinedCount = await dependencies.eventStore.insertQuarantined(result.quarantined);

      /**
       * One summary line per message, not one per record. At fleet volume,
       * per-record logging costs more to ingest and store than the pipeline
       * costs to run, and it buries the signal. Individual bad records stay
       * traceable through the quarantine table and its `source` column.
       */
      logger.info(
        {
          received: result.stats.received,
          inserted: insertResult.inserted,
          duplicates: insertResult.duplicates,
          duplicatesInBatch: result.stats.duplicatesInBatch,
          quarantined: quarantinedCount,
          durationMs: Date.now() - startedAt,
        },
        'batch processed',
      );

      // A batch that is entirely invalid is not a failure, but it is a strong
      // signal of a firmware or contract problem and deserves to be noticed.
      if (result.stats.received > 0 && result.stats.valid === 0) {
        logger.warn(
          { received: result.stats.received, sample: result.quarantined[0]?.errors },
          'every record in this message failed validation',
        );
      }

      outcomes.push({
        messageId: message.messageId,
        status: 'processed',
        received: result.stats.received,
        inserted: insertResult.inserted,
        duplicates: insertResult.duplicates,
        quarantined: quarantinedCount,
      });
    } catch (error) {
      /**
       * Reaching here means infrastructure failed, not that the data was bad.
       * Bad data never throws; it is quarantined above. So this message goes
       * back on the queue to be retried, and after `maxReceiveCount` attempts
       * SQS moves it to the dead-letter queue.
       *
       * Keeping these two failure modes apart is the single most important
       * error-handling decision in this service. Conflate them and the DLQ
       * fills with malformed records that can never succeed, burning retries
       * and hiding the real outages among them.
       */
      const reason = error instanceof Error ? error.message : String(error);

      logger.error(
        { err: reason, durationMs: Date.now() - startedAt },
        'message failed and will be retried',
      );

      failedMessageIds.push(message.messageId);
      outcomes.push({
        messageId: message.messageId,
        status: 'failed',
        received: 0,
        inserted: 0,
        duplicates: 0,
        quarantined: 0,
        error: reason,
      });
    }
  }

  return { outcomes, failedMessageIds };
}
