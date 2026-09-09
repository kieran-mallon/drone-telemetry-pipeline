import { describe, expect, it } from 'vitest';

import { asRawRecord, processPayload, processRecords } from '../../src/core/pipeline.js';

const HEADER = 'droneId,timestamp,eventType,statusCode,batteryPct,lat,lon';

function csvRow(droneId: string, overrides: Partial<Record<string, string>> = {}): string {
  const cells = {
    timestamp: '2026-09-01T10:00:00Z',
    eventType: 'DELIVERY_COMPLETED',
    statusCode: '200',
    batteryPct: '80',
    lat: '54.6',
    lon: '-5.9',
    ...overrides,
  };
  return [
    droneId,
    cells.timestamp,
    cells.eventType,
    cells.statusCode,
    cells.batteryPct,
    cells.lat,
    cells.lon,
  ].join(',');
}

describe('processPayload: partial failure is the normal case', () => {
  it('keeps the good records and quarantines only the bad ones', () => {
    const rows = [
      csvRow('D1'),
      csvRow('D2'),
      csvRow('', { eventType: 'TAKEOFF' }),
      csvRow('D4'),
      'D5,not-a-date,TAKEOFF,200,80,54.6,-5.9',
      csvRow('D6'),
      'D7,2026-09-01T10:00:00Z',
      csvRow('D8'),
      csvRow('D9', { batteryPct: '4000' }),
      csvRow('D10'),
    ];

    const result = processPayload([HEADER, ...rows].join('\n'), {
      sourcePrefix: 's3://bucket/mixed.csv',
    });

    expect(result.stats).toEqual({
      received: 10,
      valid: 6,
      quarantined: 4,
      duplicatesInBatch: 0,
    });

    expect(result.events.map((e) => e.droneId)).toEqual(['D1', 'D2', 'D4', 'D6', 'D8', 'D10']);
  });

  it('never throws, whatever it is handed', () => {
    const hostile = [
      '',
      ' ',
      'not,a,valid\ncsv,at,all,extra',
      '{"droneId":',
      'droneId\n'.repeat(3),
      'droneId,timestamp\n"unterminated quote,2026-09-01T10:00:00Z',
    ];
    for (const payload of hostile) {
      expect(() => processPayload(payload, { sourcePrefix: 'test' })).not.toThrow();
    }
  });
});

describe('processPayload: quarantine carries enough to diagnose the failure', () => {
  it('attaches the reason and the original text to each quarantined row', () => {
    const result = processPayload([HEADER, csvRow('', { eventType: 'TAKEOFF' })].join('\n'), {
      sourcePrefix: 's3://bucket/bad.csv',
    });

    const [bad] = result.quarantined;
    expect(bad?.source).toBe('s3://bucket/bad.csv#L2');
    expect(bad?.rawPayload).toContain('TAKEOFF');
    expect(bad?.errors.some((e) => e.path === 'droneId')).toBe(true);
  });

  it('distinguishes a parse failure from a validation failure', () => {
    const parseFailure = processPayload([HEADER, 'D1,2026-09-01T10:00:00Z'].join('\n'), {
      sourcePrefix: 'test',
    });
    expect(parseFailure.quarantined[0]?.errors[0]?.code).toBe('parse_error');

    const validationFailure = processPayload([HEADER, csvRow('')].join('\n'), {
      sourcePrefix: 'test',
    });
    expect(validationFailure.quarantined[0]?.errors[0]?.code).not.toBe('parse_error');
  });

  it('reports zero of everything for an empty payload', () => {
    expect(processPayload('', { sourcePrefix: 'test' }).stats).toEqual({
      received: 0,
      valid: 0,
      quarantined: 0,
      duplicatesInBatch: 0,
    });
  });
});

describe('processRecords: in-batch deduplication', () => {
  it('collapses records that derive the same event id', () => {
    const one = { droneId: 'D1', timestamp: '2026-09-01T10:00:00Z', eventType: 'TAKEOFF' };
    const result = processRecords([
      asRawRecord(one, 'sqs:m1'),
      asRawRecord({ ...one }, 'sqs:m2'),
      asRawRecord({ ...one, droneId: 'D2' }, 'sqs:m3'),
    ]);

    expect(result.stats.valid).toBe(2);
    expect(result.stats.duplicatesInBatch).toBe(1);
  });

  it('does not collapse records the drone marked as distinct', () => {
    const base = { droneId: 'D1', timestamp: '2026-09-01T10:00:00Z', eventType: 'TAKEOFF' };
    const result = processRecords([
      asRawRecord({ ...base, eventId: 'a' }, 'sqs:m1'),
      asRawRecord({ ...base, eventId: 'b' }, 'sqs:m2'),
    ]);

    expect(result.stats.valid).toBe(2);
    expect(result.stats.duplicatesInBatch).toBe(0);
  });
});

describe('processPayload: one pipeline, two ingestion paths', () => {
  it('produces the same event id from CSV and from a JSON message', () => {
    const fromCsv = processPayload([HEADER, csvRow('D1')].join('\n'), {
      sourcePrefix: 'a.csv',
    });

    const fromJson = processPayload(
      JSON.stringify({
        droneId: 'D1',
        timestamp: '2026-09-01T10:00:00Z',
        eventType: 'DELIVERY_COMPLETED',
        statusCode: 200,
        telemetryData: { batteryPct: 80, lat: 54.6, lon: -5.9 },
      }),
      { sourcePrefix: 'sqs:abc', format: 'json' },
    );

    // The same fact arriving over two transports must be one row, not two.
    expect(fromCsv.events[0]?.eventId).toBe(fromJson.events[0]?.eventId);
  });

  it('handles a single JSON message, the direct-to-queue path', () => {
    const result = processPayload(
      '{"droneId":"D1","timestamp":"2026-09-01T10:00:00Z","eventType":"BATTERY_LOW"}',
      { sourcePrefix: 'sqs:abc', format: 'json' },
    );

    expect(result.stats.valid).toBe(1);
    expect(result.events[0]?.severity).toBe('warning');
  });
});
