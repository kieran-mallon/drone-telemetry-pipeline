import { pino } from 'pino';

import type { Config } from '../../config.js';
import type { Logger } from '../../ports/logger.js';

/**
 * Structured JSON logging.
 *
 * JSON rather than pretty text because these logs are read by CloudWatch Logs
 * Insights, not by a human tailing a terminal. `{ droneId: "D1" }` is
 * queryable; "processing drone D1" is a regex problem.
 *
 * The logging *strategy* matters as much as the library: the processor emits
 * one summary line per batch, not one per record. At fleet volume, per-record
 * logging costs more to ingest and store than the pipeline itself costs to run,
 * and it buries the signal. Individual records stay traceable through the
 * quarantine table and the `source` column instead.
 */
export function createLogger(config: Config): Logger {
  const options = {
    level: config.logLevel,
    base: { service: 'drone-telemetry-pipeline' },
    // CloudWatch adds its own timestamp, but a readable one in the body is what
    // makes a log line pasteable into a ticket.
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
  };

  if (!config.logPretty) {
    return pino(options) as unknown as Logger;
  }

  try {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,service',
        },
      },
    }) as unknown as Logger;
  } catch {
    /**
     * pino-pretty is a dev dependency, so it is absent from any production
     * install. Asking for pretty logs where they are not available should
     * degrade to JSON, not take the process down: a logging preference is never
     * worth a crash loop, and this exact case did crash the Compose stack once.
     */
    const logger = pino(options) as unknown as Logger;
    logger.warn({}, 'LOG_PRETTY is set but pino-pretty is not installed; using JSON');
    return logger;
  }
}
