import { z } from 'zod';

/**
 * The telemetry contract.
 *
 * Everything arriving here is untrusted: it may be missing fields, carry the
 * right field with the wrong type (CSV gives us strings for everything), or be
 * outright corrupt. The schemas below are deliberately *lenient about
 * representation* and *strict about meaning*. A battery level of "87.5" from a
 * CSV column and 87.5 from a JSON message are the same fact and both should be
 * accepted; a battery level of 4000 is not a fact at all and is rejected.
 */

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/**
 * Event types the pipeline understands today.
 *
 * Note this is NOT used as a closed enum at the validation boundary. See
 * `eventTypeSchema` below: an unrecognised event type is normalised to
 * `UNKNOWN` and kept, not rejected. Drone firmware ships new event types on its
 * own schedule, and a pipeline that drops anything it has not been taught about
 * silently loses real data until someone notices and redeploys. Keeping the
 * record (with the original value preserved in `raw`) means a later backfill is
 * a SQL update rather than a request to the fleet to resend.
 */
export const KNOWN_EVENT_TYPES = [
  'TAKEOFF',
  'LANDING',
  'DELIVERY_COMPLETED',
  'DELIVERY_FAILED',
  'ROUTE_ADJUSTED',
  'SENSOR_READING',
  'BATTERY_LOW',
  'BATTERY_CRITICAL',
  'MOTOR_FAULT',
  'GPS_SIGNAL_LOST',
] as const;

export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number];

export const UNKNOWN_EVENT_TYPE = 'UNKNOWN';

const KNOWN_EVENT_TYPE_SET: ReadonlySet<string> = new Set(KNOWN_EVENT_TYPES);

export function isKnownEventType(value: string): value is KnownEventType {
  return KNOWN_EVENT_TYPE_SET.has(value);
}

export const SEVERITIES = ['info', 'warning', 'error'] as const;
export type Severity = (typeof SEVERITIES)[number];

// ---------------------------------------------------------------------------
// Coercion helpers
//
// These run as `z.preprocess` steps. The convention throughout: if a value can
// be coerced, return the coerced value; if it cannot, return it UNCHANGED so
// that the schema behind the preprocessor produces a proper, well-typed Zod
// issue. Preprocessors never throw and never invent data.
// ---------------------------------------------------------------------------

/**
 * Timestamps below this value are interpreted as epoch *seconds*, above it as
 * epoch *milliseconds*. 1e11 ms is 1973 and 1e11 seconds is the year 5138, so
 * no plausible real timestamp is ambiguous. Drone firmware in the wild emits
 * both, and guessing wrong silently files a 2026 event under 1970.
 */
const EPOCH_SECONDS_UPPER_BOUND = 1e11;

/** Reject clock-fault timestamps that would poison time-window queries. */
const MIN_PLAUSIBLE_TIME = Date.UTC(2020, 0, 1);
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

function coerceToDate(value: unknown): unknown {
  if (value instanceof Date) return value;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(Math.abs(value) < EPOCH_SECONDS_UPPER_BOUND ? value * 1000 : value);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return value;

    // A bare numeric string is an epoch, not a date string. `new Date("1750000000")`
    // parses as the year 1750 in some engines, which is exactly the kind of
    // silent corruption this branch exists to prevent.
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const asNumber = Number(trimmed);
      return new Date(
        Math.abs(asNumber) < EPOCH_SECONDS_UPPER_BOUND ? asNumber * 1000 : asNumber,
      );
    }

    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? value : parsed;
  }

  return value;
}

function coerceToNumber(value: unknown): unknown {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // Number("") is 0, which would turn an empty CSV cell into a real reading.
    if (trimmed === '') return undefined;
    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? value : parsed;
  }
  return value;
}

/**
 * Strings that are unambiguously numbers or booleans become numbers or
 * booleans.
 *
 * This exists because of a real bug, caught by tests/unit/sample-data.test.ts.
 * Every value in a CSV cell is a string, while the same reading over JSON is a
 * number. Fields the schema knows about (batteryPct, lat, lon) were being
 * coerced individually, but unmodelled ones such as altitudeM were passing
 * through as strings from CSV and as numbers from JSON. Since the dedupe key is
 * hashed over telemetry content, the identical reading arriving as a file and
 * as a message produced two different event ids and would have been stored
 * twice, which is exactly what the dedupe key exists to prevent.
 *
 * The pattern is deliberately strict. It accepts "0.0", "16" and "-5.93", and
 * refuses "007" and "1e5", because a leading zero or exponent notation usually
 * marks an identifier or a formatted string rather than a reading, and turning
 * a serial number into an integer is a worse error than leaving it as text.
 */
const UNAMBIGUOUS_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

function normaliseScalar(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normaliseScalar);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normaliseScalar(v)]),
    );
  }
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return UNAMBIGUOUS_NUMBER.test(trimmed) ? Number(trimmed) : value;
}

/**
 * `telemetryData` arrives as a real object over JSON but as an embedded JSON
 * string in a CSV cell. Both are accepted, then normalised so that the two
 * transports agree on types; anything else is left alone for the schema to
 * reject.
 */
function coerceToObject(value: unknown): unknown {
  if (value === null || value === undefined) return {};

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return {};
    try {
      return normaliseScalar(JSON.parse(trimmed));
    } catch {
      return value;
    }
  }

  if (typeof value === 'object') return normaliseScalar(value);
  return value;
}

/** Treat empty strings and nulls as absent rather than as values. */
function emptyToUndefined(value: unknown): unknown {
  if (value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

export const timestampSchema = z.preprocess(
  coerceToDate,
  z
    .date({ error: 'timestamp must be an ISO 8601 date or an epoch value' })
    .refine((d) => d.getTime() >= MIN_PLAUSIBLE_TIME, {
      error: 'timestamp is implausibly old, which usually indicates a firmware clock fault',
    })
    .refine((d) => d.getTime() <= Date.now() + MAX_CLOCK_SKEW_MS, {
      error: 'timestamp is more than 24 hours in the future',
    }),
);

export const droneIdSchema = z
  .string({ error: 'droneId is required' })
  .trim()
  .min(1, { error: 'droneId must not be empty' })
  .max(128, { error: 'droneId is unreasonably long' });

export const eventTypeSchema = z.preprocess(
  emptyToUndefined,
  z
    .string({ error: 'eventType is required' })
    .trim()
    .min(1)
    .transform((value) => {
      const normalised = value.toUpperCase().replace(/[\s-]+/g, '_');
      return isKnownEventType(normalised) ? normalised : UNKNOWN_EVENT_TYPE;
    }),
);

export const statusCodeSchema = z.preprocess(
  (v) => coerceToNumber(emptyToUndefined(v)),
  z.number().int({ error: 'statusCode must be a whole number' }).optional(),
);

const batteryPctSchema = z.preprocess(
  (v) => coerceToNumber(emptyToUndefined(v)),
  z
    .number()
    .min(0, { error: 'batteryPct must be between 0 and 100' })
    .max(100, { error: 'batteryPct must be between 0 and 100' })
    .optional(),
);

const latitudeSchema = z.preprocess(
  (v) => coerceToNumber(emptyToUndefined(v)),
  z.number().min(-90).max(90, { error: 'lat must be between -90 and 90' }).optional(),
);

const longitudeSchema = z.preprocess(
  (v) => coerceToNumber(emptyToUndefined(v)),
  z.number().min(-180).max(180, { error: 'lon must be between -180 and 180' }).optional(),
);

/**
 * The known-and-queried subset of telemetryData is validated; everything else
 * is passed through untouched. `.loose()` is doing real work here: it is what
 * allows a new sensor field to arrive without a code change.
 */
export const telemetryDataSchema = z.preprocess(
  coerceToObject,
  z
    .looseObject({
      batteryPct: batteryPctSchema,
      lat: latitudeSchema,
      lon: longitudeSchema,
    })
    .transform((data) => data as Record<string, unknown>),
);

// ---------------------------------------------------------------------------
// The record schema
// ---------------------------------------------------------------------------

export const rawTelemetryRecordSchema = z.object({
  /**
   * Optional. When the drone supplies its own event id we use it as the
   * idempotency key; otherwise one is derived from the content. See
   * `deriveEventId` in transform.ts.
   */
  eventId: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(128).optional()),
  droneId: droneIdSchema,
  timestamp: timestampSchema,
  eventType: eventTypeSchema,
  statusCode: statusCodeSchema,
  telemetryData: telemetryDataSchema.default({}),
});

export type RawTelemetryRecord = z.infer<typeof rawTelemetryRecordSchema>;

/**
 * A validated, transformed record ready to be written. This is the only shape
 * the storage layer ever sees, which is what keeps the database adapter free of
 * any knowledge about CSV columns or drone firmware quirks.
 */
export interface TelemetryEvent {
  eventId: string;
  droneId: string;
  eventTime: Date;
  eventType: string;
  statusCode: number | null;
  severity: Severity;
  batteryPct: number | null;
  latitude: number | null;
  longitude: number | null;
  telemetry: Record<string, unknown>;
  raw: unknown;
  source: string;
}

/** A single validation problem, flattened for storage in the quarantine table. */
export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

/** A record that could not be turned into a `TelemetryEvent`. */
export interface QuarantinedRecord {
  source: string;
  rawPayload: string;
  errors: ValidationIssue[];
}
