import { createPool, type PostgresPool } from '../adapters/postgres/client.js';
import { PostgresEventStore } from '../adapters/postgres/event-store.js';
import { createLogger } from '../adapters/pino/logger.js';
import { createS3Client, S3ObjectStore } from '../adapters/s3/object-store.js';
import { loadConfig, type Config } from '../config.js';
import type { HandlerDependencies } from '../handlers/process-telemetry.js';

/**
 * The composition root.
 *
 * The only place in the codebase that knows a real database and a real S3
 * exist. Everything above it depends on interfaces, which is what keeps the
 * tests free of mocking libraries.
 */
export interface Runtime {
  config: Config;
  pool: PostgresPool;
  dependencies: HandlerDependencies;
}

export function createRuntime(config: Config = loadConfig()): Runtime {
  const logger = createLogger(config);
  const pool = createPool(config);

  return {
    config,
    pool,
    dependencies: {
      eventStore: new PostgresEventStore(pool, config.insertChunkSize),
      objectStore: new S3ObjectStore(createS3Client(config)),
      logger,
      maxRecordsPerObject: config.maxRecordsPerObject,
    },
  };
}
