import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';

import { resolveQueueUrl } from '../src/adapters/sqs/queue.js';
import type { Config } from '../src/config.js';

/**
 * Publish the notification that S3 publishes for itself in AWS.
 *
 * In a real deployment nothing calls this: the bucket notification defined in
 * infra/index.ts wires ObjectCreated straight to the queue, and the uploader
 * does nothing but upload. It exists because the local S3 server (MinIO) can
 * emit notifications to a webhook, Kafka or Redis, but not to an SQS queue.
 *
 * What matters is that this changes nothing the application sees. The message
 * below is the S3 event shape, and the processor cannot tell whether S3 or this
 * script put it on the queue. The keys are URL-encoded exactly as S3 encodes
 * them, spaces as '+' included, so the decoding path in the handler is
 * genuinely exercised locally rather than only in unit tests.
 */
export function buildS3Notification(
  bucket: string,
  key: string,
  size: number,
  region: string,
): string {
  return JSON.stringify({
    Records: [
      {
        eventVersion: '2.1',
        eventSource: 'aws:s3',
        awsRegion: region,
        eventTime: new Date().toISOString(),
        eventName: 'ObjectCreated:Put',
        s3: {
          s3SchemaVersion: '1.0',
          bucket: { name: bucket, arn: `arn:aws:s3:::${bucket}` },
          object: { key: encodeS3Key(key), size },
        },
      },
    ],
  });
}

/** S3 percent-encodes object keys and encodes spaces as '+'. */
export function encodeS3Key(key: string): string {
  return encodeURIComponent(key).replace(/%2F/g, '/').replace(/%20/g, '+');
}

export async function notifyObjectCreated(
  sqs: SQSClient,
  config: Config,
  bucket: string,
  key: string,
  size: number,
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: await resolveQueueUrl(sqs, config),
      MessageBody: buildS3Notification(bucket, key, size, config.awsRegion),
    }),
  );
}
