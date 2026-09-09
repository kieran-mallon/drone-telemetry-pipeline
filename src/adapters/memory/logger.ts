import type { Logger } from '../../ports/logger.js';

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  context: Record<string, unknown>;
  message: string | undefined;
}

/** A Logger that records rather than writes, so tests can assert on observability. */
export class RecordingLogger implements Logger {
  constructor(
    readonly entries: LogEntry[] = [],
    private readonly bindings: Record<string, unknown> = {},
  ) {}

  private record(level: LogEntry['level']) {
    return (context: Record<string, unknown>, message?: string): void => {
      this.entries.push({ level, context: { ...this.bindings, ...context }, message });
    };
  }

  debug = this.record('debug');
  info = this.record('info');
  warn = this.record('warn');
  error = this.record('error');

  child(bindings: Record<string, unknown>): Logger {
    // Shares the same entries array so assertions can be made on the parent.
    return new RecordingLogger(this.entries, { ...this.bindings, ...bindings });
  }
}
