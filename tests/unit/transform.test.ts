import { describe, expect, it } from 'vitest';

import type { RawTelemetryRecord } from '../../src/core/schema.js';
import {
  canonicalJson,
  deriveEventId,
  deriveSeverity,
  toTelemetryEvent,
} from '../../src/core/transform.js';

function record(overrides: Partial<RawTelemetryRecord> = {}): RawTelemetryRecord {
  return {
    eventId: undefined,
    droneId: 'DRONE-001',
    timestamp: new Date('2026-09-01T10:00:00.000Z'),
    eventType: 'DELIVERY_COMPLETED',
    statusCode: 200,
    telemetryData: { batteryPct: 87.5, lat: 54.597, lon: -5.93 },
    ...overrides,
  } as RawTelemetryRecord;
}

describe('deriveSeverity', () => {
  it('treats failure event types as errors regardless of status code', () => {
    expect(deriveSeverity('MOTOR_FAULT', 200, 90)).toBe('error');
    expect(deriveSeverity('DELIVERY_FAILED', null, 90)).toBe('error');
    expect(deriveSeverity('GPS_SIGNAL_LOST', 200, 90)).toBe('error');
    expect(deriveSeverity('BATTERY_CRITICAL', 200, 90)).toBe('error');
  });

  it('maps 5xx to error and 4xx to warning', () => {
    expect(deriveSeverity('SENSOR_READING', 503, 90)).toBe('error');
    expect(deriveSeverity('SENSOR_READING', 404, 90)).toBe('warning');
  });

  it('treats degraded-but-not-failed event types as warnings', () => {
    expect(deriveSeverity('BATTERY_LOW', 200, 90)).toBe('warning');
    expect(deriveSeverity('ROUTE_ADJUSTED', 200, 90)).toBe('warning');
  });

  it('raises a warning on a low battery even for an otherwise fine event', () => {
    expect(deriveSeverity('SENSOR_READING', 200, 12)).toBe('warning');
    expect(deriveSeverity('SENSOR_READING', 200, 16)).toBe('info');
  });

  it('defaults to info', () => {
    expect(deriveSeverity('TAKEOFF', 200, 90)).toBe('info');
    expect(deriveSeverity('UNKNOWN', null, null)).toBe('info');
  });
});

describe('canonicalJson', () => {
  it('is insensitive to key order at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('handles primitives, null and nesting without throwing', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson({ a: [{ z: 1, y: 2 }] })).toBe('{"a":[{"y":2,"z":1}]}');
  });
});

describe('deriveEventId', () => {
  it('trusts an id supplied by the drone', () => {
    expect(deriveEventId(record({ eventId: 'firmware-supplied-id' }))).toBe(
      'firmware-supplied-id',
    );
  });

  it('is stable across repeated calls, which is what makes replay safe', () => {
    expect(deriveEventId(record())).toBe(deriveEventId(record()));
  });

  it('is insensitive to telemetry key order', () => {
    const a = record({ telemetryData: { lat: 1, lon: 2, batteryPct: 50 } });
    const b = record({ telemetryData: { batteryPct: 50, lon: 2, lat: 1 } });
    expect(deriveEventId(a)).toBe(deriveEventId(b));
  });

  it('changes when any identifying field changes', () => {
    const base = deriveEventId(record());
    expect(deriveEventId(record({ droneId: 'DRONE-002' }))).not.toBe(base);
    expect(deriveEventId(record({ timestamp: new Date('2026-09-01T10:00:01Z') }))).not.toBe(base);
    expect(deriveEventId(record({ eventType: 'TAKEOFF' }))).not.toBe(base);
    expect(deriveEventId(record({ statusCode: 500 }))).not.toBe(base);
    expect(deriveEventId(record({ telemetryData: { batteryPct: 50 } }))).not.toBe(base);
  });
});

describe('toTelemetryEvent', () => {
  const context = { source: 's3://bucket/batch.csv#L2', raw: { original: true } };

  it('promotes the queried fields out of telemetryData', () => {
    const event = toTelemetryEvent(record(), context);
    expect(event.batteryPct).toBe(87.5);
    expect(event.latitude).toBe(54.597);
    expect(event.longitude).toBe(-5.93);
  });

  it('keeps the full telemetry object alongside the promoted columns', () => {
    const event = toTelemetryEvent(
      record({ telemetryData: { batteryPct: 50, windSpeedMps: 4.2 } }),
      context,
    );
    expect(event.telemetry).toEqual({ batteryPct: 50, windSpeedMps: 4.2 });
  });

  it('uses null rather than undefined for absent values, matching SQL', () => {
    const event = toTelemetryEvent(
      record({ statusCode: undefined, telemetryData: {} }),
      context,
    );
    expect(event.statusCode).toBeNull();
    expect(event.batteryPct).toBeNull();
    expect(event.latitude).toBeNull();
    expect(event.longitude).toBeNull();
  });

  it('carries provenance and the original record through untouched', () => {
    const event = toTelemetryEvent(record(), context);
    expect(event.source).toBe('s3://bucket/batch.csv#L2');
    expect(event.raw).toEqual({ original: true });
  });
});
