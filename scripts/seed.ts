/**
 * Generate a synthetic fleet-scale batch and push it through the pipeline.
 *
 *   npm run seed                    2000 records, 5% deliberately corrupt
 *   npm run seed -- 20000 0.02      20000 records, 2% corrupt
 *
 * Uploads as NDJSON to S3, which triggers the same ObjectCreated notification a
 * real drone batch would. Useful for seeing the batching, deduplication and
 * quarantine behaviour at a size where the numbers in the logs mean something.
 */
import '../src/load-env.js';

import { PutObjectCommand } from '@aws-sdk/client-s3';

import { createS3Client } from '../src/adapters/s3/object-store.js';
import { createSqsClient } from '../src/adapters/sqs/queue.js';
import { loadConfig } from '../src/config.js';
import { notifyObjectCreated } from './s3-notification.js';

const config = loadConfig();

const count = Number(process.argv[2] ?? 2000);
const corruptRate = Number(process.argv[3] ?? 0.05);

const DRONES = Array.from({ length: 25 }, (_, i) => `DRONE-${String(i + 1).padStart(3, '0')}`);
const EVENT_TYPES = [
  'TAKEOFF',
  'SENSOR_READING',
  'SENSOR_READING',
  'SENSOR_READING',
  'ROUTE_ADJUSTED',
  'DELIVERY_COMPLETED',
  'LANDING',
  'BATTERY_LOW',
  'DELIVERY_FAILED',
  'MOTOR_FAULT',
  'GPS_SIGNAL_LOST',
];

/** Each corruption is a failure mode the pipeline is expected to survive. */
const CORRUPTIONS = [
  (r: Record<string, unknown>) => ({ ...r, droneId: '' }),
  (r: Record<string, unknown>) => ({ ...r, timestamp: 'not-a-timestamp' }),
  (r: Record<string, unknown>) => ({ ...r, timestamp: '2099-06-01T00:00:00Z' }),
  (r: Record<string, unknown>) => ({
    ...r,
    telemetryData: { ...(r['telemetryData'] as object), batteryPct: 900 },
  }),
  (r: Record<string, unknown>) => ({
    ...r,
    telemetryData: { ...(r['telemetryData'] as object), lat: 1234 },
  }),
  (r: Record<string, unknown>) => {
    const { droneId, ...rest } = r;
    return rest;
  },
];

const round = (n: number, digits: number): number => Number(n.toFixed(digits));

function makeRecord(index: number): Record<string, unknown> {
  const eventType = EVENT_TYPES[index % EVENT_TYPES.length] ?? 'SENSOR_READING';
  const statusCode =
    eventType === 'DELIVERY_FAILED' ? 503 : eventType === 'MOTOR_FAULT' ? 500 : 200;

  return {
    droneId: DRONES[index % DRONES.length],
    // Spread over the last 24 hours so time-window queries have something to bite on.
    timestamp: new Date(Date.now() - (count - index) * 40_000).toISOString(),
    eventType,
    statusCode,
    telemetryData: {
      batteryPct: round(100 - ((index * 7) % 95), 1),
      lat: round(54.5973 + Math.sin(index / 40) * 0.05, 5),
      lon: round(-5.9301 + Math.cos(index / 40) * 0.07, 5),
      altitudeM: 40 + (index % 90),
      speedMps: round(4 + (index % 14), 1),
    },
  };
}

const lines: string[] = [];
let corrupted = 0;
let duplicated = 0;

for (let i = 0; i < count; i += 1) {
  let record = makeRecord(i);

  if (Math.random() < corruptRate) {
    const corrupt = CORRUPTIONS[Math.floor(Math.random() * CORRUPTIONS.length)];
    if (corrupt !== undefined) {
      record = corrupt(record);
      corrupted += 1;
    }
  }

  lines.push(JSON.stringify(record));

  // Occasionally repeat a record verbatim, so the deduplication counter in the
  // processor logs is exercised rather than just asserted in tests.
  if (i % 97 === 0 && i > 0) {
    lines.push(JSON.stringify(record));
    duplicated += 1;
  }
}

const key = `seed/${Date.now()}-fleet-${count}.ndjson`;

const body = lines.join('\n');

try {
  await createS3Client(config).send(
    new PutObjectCommand({
      Bucket: config.rawBucket,
      Key: key,
      Body: body,
      ContentType: 'application/x-ndjson',
    }),
  );

  // In AWS the bucket notification does this. See scripts/s3-notification.ts.
  await notifyObjectCreated(
    createSqsClient(config),
    config,
    config.rawBucket,
    key,
    Buffer.byteLength(body),
  );

  console.log(`uploaded s3://${config.rawBucket}/${key}`);
  console.log(`  ${lines.length} lines: ${count} generated, ${duplicated} repeated verbatim`);
  console.log(`  ~${corrupted} deliberately corrupted (${Math.round(corruptRate * 100)}% target)`);
  console.log('\nExpect roughly:');
  console.log(`  stored      ~${count - corrupted}`);
  console.log(`  quarantined ~${corrupted}`);
  console.log(`  duplicates  ~${duplicated}`);
  console.log('\nThen: curl "http://localhost:3000/events/errors?limit=5" | jq');
} catch (error) {
  console.error(`seed failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error('\nIs the stack running? Try: docker compose up -d');
  process.exitCode = 1;
}
