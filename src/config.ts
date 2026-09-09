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
  /**
   * Optional at this layer, required by anything that opens a connection.
   *
   * The uploader and seed scripts talk only to object storage and the queue, so
   * demanding a database URL from them was a false requirement that made them
   * fail for a reason that had nothing to do with what they do. Services still
   * fail fast, because they build a connection pool during startup and
   * `createPool` rejects a missing URL there.
   */
  databaseUrl: z.string().min(1).optional(),

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

/**
 * The environment variable behind each field.
 *
 * Single-sourced so the reader and the error formatter cannot disagree, and so
 * a validation failure names `DATABASE_URL` (which you can act on) rather than
 * `databaseUrl` (which does not exist anywhere you can set it). A config error
 * that does not tell you which variable to fix is only half an error message.
 */
const ENV_KEYS = {
  databaseUrl: 'DATABASE_URL',
  awsRegion: 'AWS_REGION',
  awsEndpointUrl: 'AWS_ENDPOINT_URL',
  s3EndpointUrl: 'S3_ENDPOINT_URL',
  sqsEndpointUrl: 'SQS_ENDPOINT_URL',
  rawBucket: 'RAW_BUCKET',
  ingestQueueName: 'INGEST_QUEUE_NAME',
  ingestQueueUrl: 'INGEST_QUEUE_URL',
  batchSize: 'BATCH_SIZE',
  maxRecordsPerObject: 'MAX_RECORDS_PER_OBJECT',
  insertChunkSize: 'INSERT_CHUNK_SIZE',
  logLevel: 'LOG_LEVEL',
  logPretty: 'LOG_PRETTY',
  apiPort: 'API_PORT',
  apiHost: 'API_HOST',
} as const satisfies Record<keyof Config, string>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(
    Object.fromEntries(
      Object.entries(ENV_KEYS).map(([field, variable]) => [field, env[variable]]),
    ),
  );

  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => {
        const field = String(issue.path[0] ?? '');
        const variable = ENV_KEYS[field as keyof typeof ENV_KEYS] ?? (field === '' ? '(root)' : field);
        return `  ${variable}: ${issue.message}`;
      })
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

/**
 * The database URL, or a clear failure.
 *
 * Called by `createPool`, so every service still fails during startup with a
 * message naming the variable, while the scripts that never touch a database
 * are not asked for one.
 */
export function requireDatabaseUrl(config: Config): string {
  if (config.databaseUrl === undefined) {
    throw new Error('Invalid configuration:\n  DATABASE_URL is required to connect to Postgres');
  }
  return config.databaseUrl;
}
