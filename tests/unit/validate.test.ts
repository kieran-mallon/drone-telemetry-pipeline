import { describe, expect, it } from 'vitest';

import { UNKNOWN_EVENT_TYPE } from '../../src/core/schema.js';
import { validateRecord } from '../../src/core/validate.js';

/** A record that should always pass, so each test varies exactly one thing. */
const valid = {
  droneId: 'DRONE-001',
  timestamp: '2026-09-01T10:00:00.000Z',
  eventType: 'DELIVERY_COMPLETED',
  statusCode: 200,
  telemetryData: { batteryPct: 87.5, lat: 54.597, lon: -5.93 },
};

function expectOk(input: unknown) {
  const result = validateRecord(input);
  if (!result.ok) throw new Error(`expected valid, got ${JSON.stringify(result.issues)}`);
  return result.value;
}

function expectFail(input: unknown) {
  const result = validateRecord(input);
  if (result.ok) throw new Error('expected validation to fail');
  return result.issues;
}

describe('validateRecord: the happy path', () => {
  it('accepts a well-formed record', () => {
    const value = expectOk(valid);
    expect(value.droneId).toBe('DRONE-001');
    expect(value.eventType).toBe('DELIVERY_COMPLETED');
    expect(value.timestamp.toISOString()).toBe('2026-09-01T10:00:00.000Z');
  });
});

describe('validateRecord: representation is flexible, meaning is not', () => {
  it('accepts numeric strings from CSV cells', () => {
    const value = expectOk({
      ...valid,
      statusCode: '404',
      telemetryData: { batteryPct: '42.5', lat: '54.6', lon: '-5.9' },
    });
    expect(value.statusCode).toBe(404);
    expect(value.telemetryData['batteryPct']).toBe(42.5);
  });

  it('accepts telemetryData as an embedded JSON string', () => {
    const value = expectOk({ ...valid, telemetryData: '{"batteryPct":50,"altitudeM":120}' });
    expect(value.telemetryData).toEqual({ batteryPct: 50, altitudeM: 120 });
  });

  it('accepts epoch milliseconds', () => {
    const value = expectOk({ ...valid, timestamp: 1788000000000 });
    expect(value.timestamp.getTime()).toBe(1788000000000);
  });

  it('accepts epoch seconds and does not file them under 1970', () => {
    const value = expectOk({ ...valid, timestamp: 1788000000 });
    expect(value.timestamp.getFullYear()).toBe(2026);
  });

  it('accepts a numeric string epoch rather than parsing it as a year', () => {
    const value = expectOk({ ...valid, timestamp: '1788000000000' });
    expect(value.timestamp.getFullYear()).toBe(2026);
  });

  it('treats empty CSV cells as absent, not as zero', () => {
    const value = expectOk({
      ...valid,
      statusCode: '',
      telemetryData: { batteryPct: '', lat: '', lon: '' },
    });
    expect(value.statusCode).toBeUndefined();
    expect(value.telemetryData['batteryPct']).toBeUndefined();
  });

  it('normalises event type casing and separators', () => {
    expect(expectOk({ ...valid, eventType: 'delivery completed' }).eventType).toBe(
      'DELIVERY_COMPLETED',
    );
    expect(expectOk({ ...valid, eventType: 'battery-low' }).eventType).toBe('BATTERY_LOW');
  });
});

describe('validateRecord: missing and corrupt data', () => {
  it('rejects a missing droneId', () => {
    const issues = expectFail({ ...valid, droneId: undefined });
    expect(issues.some((i) => i.path === 'droneId')).toBe(true);
  });

  it('rejects an empty droneId', () => {
    expect(expectFail({ ...valid, droneId: '   ' })[0]?.message).toMatch(/must not be empty/);
  });

  it('rejects an unparseable timestamp', () => {
    expect(expectFail({ ...valid, timestamp: 'yesterday-ish' })[0]?.path).toBe('timestamp');
  });

  it('rejects a timestamp far in the future as a clock fault', () => {
    expect(expectFail({ ...valid, timestamp: '2099-01-01T00:00:00Z' })[0]?.message).toMatch(
      /future/,
    );
  });

  it('rejects a timestamp from before the fleet existed', () => {
    expect(expectFail({ ...valid, timestamp: '1994-01-01T00:00:00Z' })[0]?.message).toMatch(
      /implausibly old/,
    );
  });

  it('rejects an out-of-range battery level', () => {
    expect(expectFail({ ...valid, telemetryData: { batteryPct: 4000 } })[0]?.path).toBe(
      'telemetryData.batteryPct',
    );
  });

  it('rejects out-of-range coordinates', () => {
    const issues = expectFail({ ...valid, telemetryData: { lat: 999, lon: -400 } });
    expect(issues.map((i) => i.path).sort()).toEqual([
      'telemetryData.lat',
      'telemetryData.lon',
    ]);
  });

  it('rejects telemetryData that is not an object', () => {
    expect(expectFail({ ...valid, telemetryData: 'not json at all' })[0]?.path).toBe(
      'telemetryData',
    );
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const issues = expectFail({ droneId: '', timestamp: 'nope', eventType: '' });
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects an entirely non-object payload without throwing', () => {
    expect(() => validateRecord('just a string')).not.toThrow();
    expect(validateRecord(null).ok).toBe(false);
    expect(validateRecord(undefined).ok).toBe(false);
    expect(validateRecord(42).ok).toBe(false);
  });
});

describe('validateRecord: forward compatibility', () => {
  it('keeps an unrecognised event type as UNKNOWN instead of dropping the record', () => {
    const value = expectOk({ ...valid, eventType: 'PARACHUTE_DEPLOYED' });
    expect(value.eventType).toBe(UNKNOWN_EVENT_TYPE);
  });

  it('passes through telemetry fields it has never seen', () => {
    const value = expectOk({
      ...valid,
      telemetryData: { batteryPct: 50, windSpeedMps: 4.2, payloadAttached: true },
    });
    expect(value.telemetryData['windSpeedMps']).toBe(4.2);
    expect(value.telemetryData['payloadAttached']).toBe(true);
  });

  it('treats missing telemetryData as empty rather than as a failure', () => {
    expect(expectOk({ ...valid, telemetryData: undefined }).telemetryData).toEqual({});
    expect(expectOk({ ...valid, telemetryData: null }).telemetryData).toEqual({});
  });

  it('accepts a record with only the required fields', () => {
    const value = expectOk({
      droneId: 'D1',
      timestamp: '2026-09-01T10:00:00Z',
      eventType: 'SENSOR_READING',
    });
    expect(value.statusCode).toBeUndefined();
    expect(value.telemetryData).toEqual({});
  });
});
