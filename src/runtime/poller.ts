import '../load-env.js';

import { DeleteMessageBatchCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';

import { createSqsClient, resolveQueueUrl } from '../adapters/sqs/queue.js';
import { processTelemetry, type IngestMessage } from '../handlers/process-telemetry.js';
import { createRuntime } from './dependencies.js';

/**
 * Local runtime: a long-lived process polling SQS.
 *
 * This exists so the pipeline can be demonstrated end to end with nothing but
 * Docker, and it runs the *same* handler the Lambda runs. Emulating Lambda
 * execution locally adds a slow, occasionally flaky moving part and proves
 * nothing that this does not, because the code under test is identical. The
 * only difference is who calls it.
 *
 * It also mirrors a genuine architectural option: if these batches ever ran
 * long enough to hit the 15 minute Lambda ceiling, this same file is what would
 * run on ECS instead, with no change to anything below it.
 */

const runtime = createRuntime();
const logger = runtime.dependencies.logger.child({ runtime: 'poller' });

const sqs = createSqsClient(runtime.config);

let running = true;

/**
 * Resolved once, then reused.
 *
 * Deliberately lazy rather than resolved at startup: under Compose the queue
 * may not be accepting connections the instant this container starts, and a
 * process that dies on boot because a sibling was two seconds slow is a bad
 * container. Failing here just falls into the loop's backoff and retries.
 */
let cachedQueueUrl: string | undefined;

async function getQueueUrl(): Promise<string> {
  cachedQueueUrl ??= await resolveQueueUrl(sqs, runtime.config);
  return cachedQueueUrl;
}

async function pollOnce(queueUrl: string): Promise<void> {
  const received = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: runtime.config.batchSize,
      // Long polling. Without it the loop spins on empty responses, which costs
      // money on real SQS and makes the local logs unreadable.
      WaitTimeSeconds: 20,
      // Must comfortably exceed the time a batch takes to process, or SQS makes
      // the message visible again mid-flight and a second consumer picks it up.
      VisibilityTimeout: 60,
    }),
  );

  const messages = received.Messages ?? [];
  if (messages.length === 0) return;

  const ingestMessages: IngestMessage[] = messages.map((message) => ({
    messageId: message.MessageId ?? 'unknown',
    body: message.Body ?? '',
  }));

  const result = await processTelemetry(ingestMessages, runtime.dependencies);
  const failed = new Set(result.failedMessageIds);

  /**
   * Delete only what succeeded. Anything left undeleted becomes visible again
   * when the visibility timeout expires and is retried, which is the same
   * contract the Lambda event source mapping provides through
   * batchItemFailures.
   */
  const toDelete = messages.filter((message) => !failed.has(message.MessageId ?? 'unknown'));

  if (toDelete.length > 0) {
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: toDelete.map((message, index) => ({
          Id: String(index),
          ReceiptHandle: message.ReceiptHandle ?? '',
        })),
      }),
    );
  }
}

async function main(): Promise<void> {
  logger.info(
    { queue: runtime.config.ingestQueueName, batchSize: runtime.config.batchSize },
    'processor started',
  );

  while (running) {
    try {
      await pollOnce(await getQueueUrl());
    } catch (error) {
      /**
       * The loop must survive its own errors. A transient SQS failure or a
       * dropped database connection should back off and retry, not take the
       * processor down and leave the queue unattended.
       */
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'poll failed, backing off',
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  logger.info({}, 'processor stopped');
  await runtime.pool.end();
}

// Graceful shutdown: finish the batch in flight rather than abandoning messages
// mid-process and waiting for the visibility timeout to release them.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutdown requested, finishing current batch');
    running = false;
  });
}

await main();
