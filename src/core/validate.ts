import { rawTelemetryRecordSchema, type RawTelemetryRecord, type ValidationIssue } from './schema.js';

/**
 * Validation, expressed as a value rather than an exception.
 *
 * `safeParse` (not `parse`) is the whole point: a bad record must be a *result*
 * the caller handles, not a thrown error that unwinds the batch. Zod also
 * collects every issue rather than stopping at the first, so a quarantined row
 * carries the full list of what was wrong with it and one round trip is enough
 * to diagnose it.
 */

export type ValidationResult =
  | { ok: true; value: RawTelemetryRecord }
  | { ok: false; issues: ValidationIssue[] };

export function validateRecord(input: unknown): ValidationResult {
  const result = rawTelemetryRecordSchema.safeParse(input);

  if (result.success) {
    return { ok: true, value: result.data };
  }

  return { ok: false, issues: flattenIssues(result.error.issues) };
}

/**
 * Flatten Zod issues into the shape stored in `telemetry_quarantine.errors`.
 *
 * Structured rather than a joined string, so that "which field fails most
 * often" is a query instead of a grep. That question usually points straight at
 * a firmware bug on one drone model.
 */
export function flattenIssues(
  issues: readonly { path: PropertyKey[]; code: string; message: string }[],
): ValidationIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    code: issue.code,
    message: issue.message,
  }));
}
