import { beforeEach, describe, expect, it } from 'vitest';

import { InMemoryEventStore } from '../../src/adapters/memory/event-store.js';
import { InMemoryObjectStore } from '../../src/adapters/memory/object-store.js';
import { RecordingLogger } from '../../src/adapters/memory/logger.js';
import {
  decodeS3Key,
  processTelemetry,
  type HandlerDependencies,
  type IngestMessage,
} from '../../src/handlers/process-telemetry.js';

let eventStore: InMemoryEventStore;
let objectStore: InMemoryObjectStore;
let logger: RecordingLogger;
let deps: HandlerDependencies;

beforeEach(() => {
  eventStore = new InMemoryEventStore();
  objectStore = new InMemoryObjectStore();
  logger = new RecordingLogger();
  deps = { eventStore, objectStore, logger, maxRecordsPerObject: 1000 };
});

const RECORD = {
  droneId: 'DRONE-001',
  timestamp: '2026-09-01T10:00:00Z',
  eventType: 'DELIVERY_COMPLETED',
  statusCode: 200,
  telemetryData: { batteryPct: 80, lat: 54.6, lon: -5.9 },
};

function message(body: unknown, messageId = 'm1'): IngestMessage {
  return { messageId, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

function s3Notification(bucket: string, key: string): IngestMessage {
  return message({ Records: [{ s3: { bucket: { name: bucket }, object: { key } } }] });
}

describe('the direct-to-queue path', () => {
  it('stores a single telemetry record posted straight to the queue', async () => {
    const result = await processTelemetry([message(RECORD)], deps);

    expect(result.failedMessageIds).toEqual([]);
    expect(eventStore.events.size).toBe(1);
    expect([...eventStore.events.values()][0]?.droneId).toBe('DRONE-001');
  });

  it('accepts an array of records in one message', async () => {
    await processTelemetry([message([RECORD, { ...RECORD, droneId: 'DRONE-002' }])], deps);
    expect(eventStore.events.size).toBe(2);
  });

  it('quarantines a body that is not JSON, keeping the original text', async () => {
    await processTelemetry([message('this is not json')], deps);

    expect(eventStore.events.size).toBe(0);
    expect(eventStore.quarantined[0]?.rawPayload).toBe('this is not json');
    // Crucially NOT a retry: the data is wrong, and retrying will not fix it.
    expect(eventStore.quarantined).toHaveLength(1);
  });
});

describe('the S3 file-drop path', () => {
  it('reads the object named in the notification and stores its records', async () => {
    objectStore.put(
      'raw-bucket',
      'batch.csv',
      'droneId,timestamp,eventType,batteryPct\nD1,2026-09-01T10:00:00Z,TAKEOFF,80\nD2,2026-09-01T10:00:01Z,LANDING,79\n',
    );

    await processTelemetry([s3Notification('raw-bucket', 'batch.csv')], deps);
    expect(eventStore.events.size).toBe(2);
  });

  it('decodes URL-encoded keys, including plus-encoded spaces', () => {
    expect(decodeS3Key('delivery+batch+2026-09-01.csv')).toBe('delivery batch 2026-09-01.csv');
    expect(decodeS3Key('2026%2F09%2Fbatch.csv')).toBe('2026/09/batch.csv');
  });

  it('finds an object whose key arrived URL-encoded', async () => {
    objectStore.put('raw-bucket', 'delivery batch.csv', 'droneId,timestamp,eventType\nD1,2026-09-01T10:00:00Z,TAKEOFF\n');

    await processTelemetry([s3Notification('raw-bucket', 'delivery+batch.csv')], deps);
    expect(eventStore.events.size).toBe(1);
  });

  it('skips the s3:TestEvent that S3 sends when a notification is created', async () => {
    const result = await processTelemetry(
      [message({ Service: 'Amazon S3', Event: 's3:TestEvent' })],
      deps,
    );

    expect(result.outcomes[0]?.status).toBe('skipped');
    expect(result.failedMessageIds).toEqual([]);
    expect(eventStore.quarantined).toHaveLength(0);
  });
});

describe('idempotency: at-least-once delivery must not double-count', () => {
  it('stores one row when the same message is delivered twice', async () => {
    await processTelemetry([message(RECORD, 'm1')], deps);
    await processTelemetry([message(RECORD, 'm1-redelivered')], deps);

    expect(eventStore.events.size).toBe(1);
  });

  it('reports the redelivery as a duplicate rather than as an insert', async () => {
    await processTelemetry([message(RECORD)], deps);
    const second = await processTelemetry([message(RECORD, 'm2')], deps);

    expect(second.outcomes[0]).toMatchObject({ inserted: 0, duplicates: 1, status: 'processed' });
  });

  it('deduplicates across ingestion paths, not just within one', async () => {
    objectStore.put('raw-bucket', 'batch.ndjson', `${JSON.stringify(RECORD)}\n`);

    await processTelemetry([message(RECORD, 'direct')], deps);
    await processTelemetry([s3Notification('raw-bucket', 'batch.ndjson')], deps);

    // The same fact arriving as a file and as a message is still one event.
    expect(eventStore.events.size).toBe(1);
  });

  it('replaying an entire file is a no-op', async () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({ ...RECORD, droneId: `D${i}` }),
    ).join('\n');
    objectStore.put('raw-bucket', 'batch.ndjson', rows);

    await processTelemetry([s3Notification('raw-bucket', 'batch.ndjson')], deps);
    await processTelemetry([s3Notification('raw-bucket', 'batch.ndjson')], deps);

    expect(eventStore.events.size).toBe(20);
  });
});

describe('bad data is quarantined; broken infrastructure is retried', () => {
  it('acknowledges a message whose records are all invalid', async () => {
    const result = await processTelemetry([message({ droneId: '', timestamp: 'nope' })], deps);

    // Not retried: no amount of retrying will make this record valid.
    expect(result.failedMessageIds).toEqual([]);
    expect(result.outcomes[0]?.status).toBe('processed');
    expect(eventStore.quarantined).toHaveLength(1);
  });

  it('warns when an entire message fails validation, because that is a contract smell', async () => {
    await processTelemetry([message({ droneId: '', timestamp: 'nope' })], deps);

    expect(
      logger.entries.some(
        (e) => e.level === 'warn' && e.message?.includes('failed validation'),
      ),
    ).toBe(true);
  });

  it('retries the message when the database is unreachable', async () => {
    eventStore.failNextWith(new Error('ECONNREFUSED: could not connect to Postgres'));

    const result = await processTelemetry([message(RECORD)], deps);

    expect(result.failedMessageIds).toEqual(['m1']);
    expect(result.outcomes[0]?.status).toBe('failed');
    // Nothing was written, so the retry is safe rather than partially applied.
    expect(eventStore.events.size).toBe(0);
  });

  it('retries the message when S3 is unreachable, rather than losing the file', async () => {
    objectStore.failNextWith(new Error('503 SlowDown'));

    const result = await processTelemetry([s3Notification('raw-bucket', 'batch.csv')], deps);

    expect(result.failedMessageIds).toEqual(['m1']);
    expect(eventStore.quarantined).toHaveLength(0);
  });

  it('fails only the broken message and still processes its neighbours', async () => {
    objectStore.put('raw-bucket', 'good.ndjson', `${JSON.stringify(RECORD)}\n`);

    const result = await processTelemetry(
      [
        message({ ...RECORD, droneId: 'FIRST' }, 'ok-1'),
        s3Notification('raw-bucket', 'missing.ndjson'),
        message({ ...RECORD, droneId: 'THIRD' }, 'ok-2'),
      ],
      deps,
    );

    // This is what SQS partial batch responses are for: one bad message in a
    // batch of ten must not force the other nine to be reprocessed.
    expect(result.failedMessageIds).toHaveLength(1);
    expect(eventStore.events.size).toBe(2);
  });

  it('never throws out of the handler, whatever the input', async () => {
    const nasty: IngestMessage[] = [
      { messageId: 'a', body: '' },
      { messageId: 'b', body: 'null' },
      { messageId: 'c', body: '[]' },
      { messageId: 'd', body: '{"Records":[]}' },
      { messageId: 'e', body: '{"Records":[{"s3":{}}]}' },
    ];

    await expect(processTelemetry(nasty, deps)).resolves.toBeDefined();
  });
});

describe('observability', () => {
  it('emits one summary line per message, not one per record', async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({ ...RECORD, droneId: `D${i}` }),
    ).join('\n');
    objectStore.put('raw-bucket', 'batch.ndjson', rows);

    await processTelemetry([s3Notification('raw-bucket', 'batch.ndjson')], deps);

    const summaries = logger.entries.filter((e) => e.message === 'batch processed');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.context).toMatchObject({ received: 50, inserted: 50 });
    expect(summaries[0]?.context['messageId']).toBe('m1');
  });
});
