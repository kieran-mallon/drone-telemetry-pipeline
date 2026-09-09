/**
 * The logging port.
 *
 * A structural interface rather than a direct dependency on Pino, so that the
 * handler and the pipeline can be tested with a recording logger and never drag
 * a transport into a unit test.
 */
export interface Logger {
  debug(context: Record<string, unknown>, message?: string): void;
  info(context: Record<string, unknown>, message?: string): void;
  warn(context: Record<string, unknown>, message?: string): void;
  error(context: Record<string, unknown>, message?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** Discards everything. Useful in tests that do not assert on logging. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
