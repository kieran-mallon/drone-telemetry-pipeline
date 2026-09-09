/**
 * Feed the running pipeline, to demonstrate both ingestion paths.
 *
 *   npm run send:file                      upload every sample file to S3
 *   npm run send:file -- corrupt           upload only the corrupt one
 *   npm run send:message                   post a single record straight to SQS
 *
 * The file path proves the event-driven route: S3 emits ObjectCreated, the
 * notification lands on SQS, the processor wakes up. The message path proves
 * the same pipeline handles records that never touch S3 at all.
 */
import '../src/load-env.js';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { SendMessageCommand } from '@aws-sdk/client-sqs';

import { createS3Client } from '../src/adapters/s3/object-store.js';
import { createSqsClient, resolveQueueUrl } from '../src/adapters/sqs/queue.js';
import { loadConfig } from '../src/config.js';
import { notifyObjectCreated } from './s3-notification.js';

const config = loadConfig();
const sampleDir = fileURLToPath(new URL('../sample-data/', import.meta.url));

const SAMPLE_FILES = [
  'telemetry-batch.csv',
  'telemetry-batch.ndjson',
  'telemetry-corrupt.csv',
] as const;

async function uploadFiles(filter: string | undefined): Promise<void> {
  const s3 = createS3Client(config);
  const sqs = createSqsClient(config);
  const files = filter === undefined ? SAMPLE_FILES : SAMPLE_FILES.filter((f) => f.includes(filter));

  if (files.length === 0) {
    console.error(`no sample file matches "${filter}". Available: ${SAMPLE_FILES.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  for (const file of files) {
    // A unique key per run, so re-running produces a fresh event rather than a
    // no-op overwrite. The pipeline still deduplicates the records inside.
    const key = `${new Date().toISOString().slice(0, 10)}/${Date.now()}-${file}`;
    const body = readFileSync(`${sampleDir}${file}`);

    await s3.send(
      new PutObjectCommand({
        Bucket: config.rawBucket,
        Key: key,
        Body: body,
        ContentType: file.endsWith('.csv') ? 'text/csv' : 'application/x-ndjson',
      }),
    );

    // In AWS the bucket notification does this. See scripts/s3-notification.ts.
    await notifyObjectCreated(sqs, config, config.rawBucket, key, body.byteLength);

    console.log(`uploaded s3://${config.rawBucket}/${key}`);
  }

  console.log('\nObjectCreated published for each upload. Watch the processor logs.');
}

async function sendMessage(): Promise<void> {
  const sqs = createSqsClient(config);

  const record = {
    droneId: 'DRONE-042',
    timestamp: new Date().toISOString(),
    eventType: 'BATTERY_LOW',
    statusCode: 200,
    telemetryData: { batteryPct: 12.5, lat: 54.5973, lon: -5.9301, altitudeM: 55 },
  };

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: await resolveQueueUrl(sqs, config),
      MessageBody: JSON.stringify(record),
    }),
  );

  console.log('sent one telemetry record straight to the queue:');
  console.log(JSON.stringify(record, null, 2));
  console.log('\nIt should be stored with severity "warning" (battery below 15%).');
}

const [mode, filter] = process.argv.slice(2);

try {
  if (mode === 'message') {
    await sendMessage();
  } else {
    await uploadFiles(filter);
  }
} catch (error) {
  console.error(`failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error('\nIs the stack running? Try: docker compose up -d');
  process.exitCode = 1;
}
