import { pino } from 'pino';

import type { Config } from '../../config.js';
import type { Logger } from '../../ports/logger.js';

/**
 * Structured JSON logging.
 *
 * JSON rather than pretty text because these logs are read by CloudWatch
 * Logs Insights, not by a human tailing a terminal. `{ droneId: "D1" }` is
 * queryable; "processing drone D1" is a regex problem. `pino-pretty` is wired
 * up for local development only.
 *
 * The logging *strategy* matters as much as the library: the processor emits
 * one summary line per batch, not one per record. At fleet volume, per-record
 * logging costs more to ingest and store than the pipeline itself costs to run,
 * and it buries the signal. Individual records are traceable through the
 * quarantine table and the `source` column instead.
 */
export function createLogger(config: Config): Logger {
  const isLocal = config.awsEndpointUrl !== undefined;

  return pino({
    level: config.logLevel,
    base: { service: 'drone-telemetry-pipeline' },
    // ISO timestamps: CloudWatch does its own, but a readable one in the body
    // is what makes a log line pasteable into a ticket.
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(isLocal
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
          },
        }
      : {}),
  }) as unknown as Logger;
}
