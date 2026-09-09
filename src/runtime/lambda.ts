import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';

import { processTelemetry, type IngestMessage } from '../handlers/process-telemetry.js';
import { createRuntime } from './dependencies.js';

/**
 * AWS Lambda entry point.
 *
 * Note how little is here. Translating an SQSEvent into IngestMessage and a
 * result back into batchItemFailures is the entire job; all the behaviour lives
 * in the handler, which knows nothing about Lambda.
 */

/**
 * Built once per container, at module scope, deliberately.
 *
 * Lambda reuses a warm container across invocations, so anything constructed
 * here survives between them: the connection pool stays warm rather than
 * reconnecting to Postgres on every message. Building it inside the handler is
 * one of the most common and most expensive Lambda mistakes.
 */
const runtime = createRuntime();

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const messages: IngestMessage[] = event.Records.map((record) => ({
    messageId: record.messageId,
    body: record.body,
  }));

  const result = await processTelemetry(messages, runtime.dependencies);

  /**
   * Partial batch response.
   *
   * Without this, one failed message in a batch of ten forces SQS to redeliver
   * all ten, so nine already-processed messages are reprocessed on every
   * retry. Idempotency makes that survivable, but it is still wasted work and
   * it inflates the retry count of innocent messages towards the DLQ. The event
   * source mapping must also declare ReportBatchItemFailures, which is set in
   * the Pulumi program.
   */
  return {
    batchItemFailures: result.failedMessageIds.map((messageId) => ({ itemIdentifier: messageId })),
  };
};
