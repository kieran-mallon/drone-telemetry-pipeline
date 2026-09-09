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

const configSchema = z.object({
  databaseUrl: z.string().min(1, { error: 'DATABASE_URL is required' }),

  awsRegion: z.string().default('eu-west-1'),
  /**
   * Set to LocalStack's address for local development, left unset in a real
   * deployment so the SDK resolves the real AWS endpoint. This single variable
   * is the entire difference between the local and cloud runtimes.
   */
  awsEndpointUrl: z.string().optional(),

  rawBucket: z.string().default('drone-telemetry-raw'),
  ingestQueueUrl: z.string().default(''),

  batchSize: z.coerce.number().int().min(1).max(10).default(10),
  /** Ceiling on records read from one object, so a hostile upload cannot exhaust memory. */
  maxRecordsPerObject: z.coerce.number().int().min(1).default(50_000),
  /** Rows per INSERT statement. Postgres caps a statement at 65535 bind parameters. */
  insertChunkSize: z.coerce.number().int().min(1).max(5000).default(500),

  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  apiPort: z.coerce.number().int().min(1).max(65535).default(3000),
  apiHost: z.string().default('0.0.0.0'),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse({
    databaseUrl: env['DATABASE_URL'],
    awsRegion: env['AWS_REGION'],
    awsEndpointUrl: env['AWS_ENDPOINT_URL'],
    rawBucket: env['RAW_BUCKET'],
    ingestQueueUrl: env['INGEST_QUEUE_URL'],
    batchSize: env['BATCH_SIZE'],
    maxRecordsPerObject: env['MAX_RECORDS_PER_OBJECT'],
    insertChunkSize: env['INSERT_CHUNK_SIZE'],
    logLevel: env['LOG_LEVEL'],
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
