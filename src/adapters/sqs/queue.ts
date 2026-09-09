import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';

import { sqsEndpoint, type Config } from '../../config.js';

export function createSqsClient(config: Config): SQSClient {
  const endpoint = sqsEndpoint(config);

  return new SQSClient({
    region: config.awsRegion,
    // Present for the local stack, absent in a real deployment.
    ...(endpoint !== undefined ? { endpoint } : {}),
  });
}

/**
 * Point a queue URL at the endpoint we were actually given.
 *
 * A queue server advertises URLs using whatever hostname it was configured
 * with, and under Docker Compose that hostname is only resolvable from inside
 * the network. The processor reaches the queue at http://elasticmq:9324 while a
 * script on the host reaches the same queue at http://localhost:9324, and
 * whichever hostname the server advertises is wrong for one of them.
 *
 * So when an endpoint override is configured, the endpoint wins: it is the
 * address this process can actually reach. Against real AWS no override is set
 * and the URL is returned untouched.
 */
export function applyEndpointHost(queueUrl: string, endpoint: string | undefined): string {
  if (endpoint === undefined) return queueUrl;

  try {
    const target = new URL(endpoint);
    const original = new URL(queueUrl);
    original.protocol = target.protocol;
    original.host = target.host;
    return original.toString();
  } catch {
    // A malformed endpoint is the caller's problem, and the SDK will say so
    // more clearly than we can here.
    return queueUrl;
  }
}

/**
 * Resolve the ingest queue's URL, preferring an explicit override.
 *
 * Queue URL formats differ between providers: real SQS returns
 * `https://sqs.<region>.amazonaws.com/<account>/<name>`, while a local
 * SQS-compatible server uses whatever shape it likes. Asking the service for
 * the URL by name means the same configuration works against both, and removes
 * a class of "works locally, 404s in production" mistakes caused by a
 * hand-written URL.
 *
 * The result is cached by the caller: this is a startup concern, not a
 * per-message one.
 */
export async function resolveQueueUrl(client: SQSClient, config: Config): Promise<string> {
  if (config.ingestQueueUrl !== '') return config.ingestQueueUrl;

  const result = await client.send(
    new GetQueueUrlCommand({ QueueName: config.ingestQueueName }),
  );

  if (result.QueueUrl === undefined) {
    throw new Error(`queue "${config.ingestQueueName}" exists but returned no URL`);
  }

  return applyEndpointHost(result.QueueUrl, sqsEndpoint(config));
}
