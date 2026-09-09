import { z } from 'zod';

/**
 * Configuration, validated at boot.
 *
 * Parsed rather than read ad hoc from `process.env` so that a missing or
 * malformed variable fails immediately with a readable message, rather than
 * surfacing as `undefined` in a connection string three minutes into a batch.
 * In a Lambda this runs once per cold start, so a bad deployment fails on its
 * first invocation instead of corrupting data quietly.
 */

/**
 * Parse a boolean from an environment variable.
 *
 * Not `z.coerce.boolean()`, which is a trap here: it applies JavaScript's
 * `Boolean()`, and `Boolean("false")` is `true`. Every non-empty string would
 * enable the flag, including the string that means the opposite.
 */
const booleanFromEnv = z.preprocess(
  (value) =>
    typeof value === 'string'
      ? ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
      : value,
  z.boolean().default(false),
);

const configSchema = z.object({
  databaseUrl: z.string().min(1, { error: 'DATABASE_URL is required' }),

  awsRegion: z.string().default('eu-west-1'),
  /**
   * Endpoint overrides for local development, all unset in a real deployment so
   * the SDK resolves real AWS. These are the entire difference between the
   * local and cloud runtimes.
   *
   * AWS_ENDPOINT_URL is the fallback for both, which is what a single-endpoint
   * emulator wants. The local stack instead runs two separate servers, MinIO
   * for S3 and ElasticMQ for SQS, so each gets its own override.
   */
  awsEndpointUrl: z.string().optional(),
  s3EndpointUrl: z.string().optional(),
  sqsEndpointUrl: z.string().optional(),

  rawBucket: z.string().default('drone-telemetry-raw'),

  /**
   * The queue is identified by name and its URL resolved at runtime via
   * GetQueueUrl, with INGEST_QUEUE_URL as an override when the URL is already
   * known.
   *
   * Resolving by name rather than hardcoding a URL is what lets the identical
   * configuration work against real SQS, which returns
   * https://sqs.<region>.amazonaws.com/<account>/<name>, and against a local
   * SQS-compatible server, whose URL shape is its own business. Hardcoding the
   * URL couples the application to one provider's formatting.
   */
  ingestQueueName: z.string().default('drone-telemetry-ingest'),
  ingestQueueUrl: z.string().default(''),

  batchSize: z.coerce.number().int().min(1).max(10).default(10),
  /** Ceiling on records read from one object, so a hostile upload cannot exhaust memory. */
  maxRecordsPerObject: z.coerce.number().int().min(1).default(50_000),
  /** Rows per INSERT statement. Postgres caps a statement at 65535 bind parameters. */
  insertChunkSize: z.coerce.number().int().min(1).max(5000).default(500),

  // 'silent' is a real Pino level and is what tests and smoke runs want.
  logLevel: z
    .enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  /**
   * Human-readable logs, off by default.
   *
   * Deliberately its own flag rather than being inferred from "am I running
   * locally". Pretty printing is a property of *who is reading*, not of *where
   * the code runs*: a container on a laptop is local and still wants structured
   * JSON, because nobody is watching its stdout and something else will parse
   * it. Inferring this from the endpoint overrides is what crashed the Compose
   * stack, since the pretty transport is a dev dependency the runtime image
   * does not install.
   */
  logPretty: booleanFromEnv,

  apiPort: z.coerce.number().int().min(1).max(65535).default(3000),
  apiHost: z.string().default('0.0.0.0'),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse({
    databaseUrl: env['DATABASE_URL'],
    awsRegion: env['AWS_REGION'],
    awsEndpointUrl: env['AWS_ENDPOINT_URL'],
    s3EndpointUrl: env['S3_ENDPOINT_URL'],
    sqsEndpointUrl: env['SQS_ENDPOINT_URL'],
    rawBucket: env['RAW_BUCKET'],
    ingestQueueName: env['INGEST_QUEUE_NAME'],
    ingestQueueUrl: env['INGEST_QUEUE_URL'],
    batchSize: env['BATCH_SIZE'],
    maxRecordsPerObject: env['MAX_RECORDS_PER_OBJECT'],
    insertChunkSize: env['INSERT_CHUNK_SIZE'],
    logLevel: env['LOG_LEVEL'],
    logPretty: env['LOG_PRETTY'],
    apiPort: env['API_PORT'],
    apiHost: env['API_HOST'],
  });

  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${detail}`);
  }

  return result.data;
}

/** The S3 endpoint override, if any. */
export function s3Endpoint(config: Config): string | undefined {
  return config.s3EndpointUrl ?? config.awsEndpointUrl;
}

/** The SQS endpoint override, if any. */
export function sqsEndpoint(config: Config): string | undefined {
  return config.sqsEndpointUrl ?? config.awsEndpointUrl;
}
