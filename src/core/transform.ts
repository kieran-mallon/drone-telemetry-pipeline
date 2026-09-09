import { createHash } from 'node:crypto';

import {
  UNKNOWN_EVENT_TYPE,
  type RawTelemetryRecord,
  type Severity,
  type TelemetryEvent,
} from './schema.js';

/**
 * Turning a validated record into the row we store.
 *
 * Two derivations happen here and both are load-bearing:
 *   1. `severity`, so that "show me the errors" is one indexed predicate rather
 *      than a growing list of OR conditions spread across the query layer.
 *   2. `eventId`, the idempotency key that makes at-least-once delivery safe.
 */

/** Event types that are failures by definition, whatever the status code says. */
const ERROR_EVENT_TYPES: ReadonlySet<string> = new Set([
  'DELIVERY_FAILED',
  'MOTOR_FAULT',
  'GPS_SIGNAL_LOST',
  'BATTERY_CRITICAL',
]);

const WARNING_EVENT_TYPES: ReadonlySet<string> = new Set(['BATTERY_LOW', 'ROUTE_ADJUSTED']);

/** Below this, a battery reading is worth surfacing even on an otherwise fine event. */
const LOW_BATTERY_THRESHOLD_PCT = 15;

export function deriveSeverity(
  eventType: string,
  statusCode: number | null,
  batteryPct: number | null,
): Severity {
  if (ERROR_EVENT_TYPES.has(eventType)) return 'error';
  if (statusCode !== null && statusCode >= 500) return 'error';
  if (statusCode !== null && statusCode >= 400) return 'warning';
  if (WARNING_EVENT_TYPES.has(eventType)) return 'warning';
  if (batteryPct !== null && batteryPct <= LOW_BATTERY_THRESHOLD_PCT) return 'warning';
  return 'info';
}

/**
 * Deterministic JSON with sorted keys at every level.
 *
 * This matters more than it looks. The dedupe hash is taken over telemetry
 * content, and `{"lat":1,"lon":2}` and `{"lon":2,"lat":1}` are the same reading.
 * Without canonicalisation the same record redelivered with a different key
 * order would hash differently and be stored twice, which is precisely the bug
 * the dedupe key exists to prevent.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`);

  return `{${entries.join(',')}}`;
}

/**
 * The idempotency key.
 *
 * If the drone sends its own `eventId` we trust it: the fleet is the only party
 * that can distinguish two genuinely different events that happen to carry
 * identical content. Otherwise we derive one from the fields that identify the
 * event, so a redelivered SQS message or a re-uploaded file collides on the
 * UNIQUE constraint and is skipped rather than double-counted.
 *
 * The known trade-off: without a supplied id, two genuinely distinct events
 * from the same drone, at the same millisecond, of the same type, with
 * identical telemetry, are indistinguishable and one will be dropped. That is
 * the right way round. Silently double-counting deliveries corrupts every
 * downstream metric; losing a true duplicate-looking event does not.
 */
export function deriveEventId(record: RawTelemetryRecord): string {
  if (record.eventId !== undefined) return record.eventId;

  const material = [
    record.droneId,
    record.timestamp.toISOString(),
    record.eventType,
    String(record.statusCode ?? ''),
    canonicalJson(record.telemetryData),
  ].join('|');

  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface TransformContext {
  source: string;
  /** The record exactly as received, stored alongside the structured row. */
  raw: unknown;
}

export function toTelemetryEvent(
  record: RawTelemetryRecord,
  context: TransformContext,
): TelemetryEvent {
  const telemetry = record.telemetryData;
  const batteryPct = numberOrNull(telemetry['batteryPct']);
  const statusCode = record.statusCode ?? null;

  return {
    eventId: deriveEventId(record),
    droneId: record.droneId,
    eventTime: record.timestamp,
    eventType: record.eventType,
    statusCode,
    severity: deriveSeverity(record.eventType, statusCode, batteryPct),
    batteryPct,
    latitude: numberOrNull(telemetry['lat']),
    longitude: numberOrNull(telemetry['lon']),
    telemetry,
    raw: context.raw,
    source: context.source,
  };
}

export { UNKNOWN_EVENT_TYPE };
