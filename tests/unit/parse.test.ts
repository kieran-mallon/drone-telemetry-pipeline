import { describe, expect, it } from 'vitest';

import { detectFormat, parseCsv, parsePayload } from '../../src/core/parse.js';

const S = { sourcePrefix: 's3://bucket/batch.csv' };

describe('parseCsv', () => {
  it('parses a simple table', () => {
    const { header, rows } = parseCsv('droneId,eventType\nD1,TAKEOFF\nD2,LANDING\n');
    expect(header).toEqual(['droneId', 'eventType']);
    expect(rows.map((r) => r.cells)).toEqual([
      ['D1', 'TAKEOFF'],
      ['D2', 'LANDING'],
    ]);
  });

  it('keeps commas inside quoted fields', () => {
    const { rows } = parseCsv('a,b\n"Belfast, NI",2\n');
    expect(rows[0]?.cells).toEqual(['Belfast, NI', '2']);
  });

  it('keeps newlines inside quoted fields and still counts lines correctly', () => {
    const { rows } = parseCsv('a,b\n"line one\nline two",2\nD2,3\n');
    expect(rows[0]?.cells).toEqual(['line one\nline two', '2']);
    // The second data row starts on physical line 4, not line 3.
    expect(rows[1]?.line).toBe(4);
  });

  it('unescapes doubled quotes', () => {
    const { rows } = parseCsv('a\n"she said ""hi"""\n');
    expect(rows[0]?.cells).toEqual(['she said "hi"']);
  });

  it('strips a UTF-8 BOM from the header', () => {
    const { header } = parseCsv('﻿droneId,eventType\nD1,TAKEOFF\n');
    expect(header).toEqual(['droneId', 'eventType']);
  });

  it('handles CRLF line endings', () => {
    const { header, rows } = parseCsv('a,b\r\n1,2\r\n');
    expect(header).toEqual(['a', 'b']);
    expect(rows[0]?.cells).toEqual(['1', '2']);
  });

  it('ignores blank lines rather than treating them as records', () => {
    const { rows } = parseCsv('a,b\n1,2\n\n\n3,4\n');
    expect(rows).toHaveLength(2);
  });

  it('does not require a trailing newline', () => {
    const { rows } = parseCsv('a,b\n1,2');
    expect(rows[0]?.cells).toEqual(['1', '2']);
  });

  it('returns an empty result for empty input', () => {
    expect(parseCsv('')).toEqual({ header: [], rows: [] });
  });
});

describe('parsePayload (csv)', () => {
  it('nests unrecognised columns under telemetryData', () => {
    const csv = 'droneId,timestamp,eventType,batteryPct,lat,lon\nD1,2026-09-01T10:00:00Z,TAKEOFF,88,54.6,-5.9\n';
    const [record] = parsePayload(csv, S);
    expect(record?.value).toEqual({
      droneId: 'D1',
      timestamp: '2026-09-01T10:00:00Z',
      eventType: 'TAKEOFF',
      telemetryData: { batteryPct: '88', lat: '54.6', lon: '-5.9' },
    });
  });

  it('prefers an explicit telemetryData column over flattened ones', () => {
    const csv = 'droneId,telemetryData,batteryPct\nD1,"{""lat"":1}",88\n';
    const [record] = parsePayload(csv, S);
    expect((record?.value as Record<string, unknown>)['telemetryData']).toBe('{"lat":1}');
  });

  it('flags a ragged row instead of silently misaligning the columns', () => {
    const csv = 'droneId,timestamp,eventType\nD1,2026-09-01T10:00:00Z,TAKEOFF\nD2,2026-09-01T10:00:01Z\n';
    const records = parsePayload(csv, S);
    expect(records[0]?.parseError).toBeUndefined();
    expect(records[1]?.parseError).toMatch(/expected 3 columns, found 2/);
    // The original line is preserved so the row stays diagnosable.
    expect(records[1]?.rawText).toBe('D2,2026-09-01T10:00:01Z');
  });

  it('records provenance down to the line number', () => {
    const csv = 'droneId\nD1\nD2\n';
    const records = parsePayload(csv, S);
    expect(records.map((r) => r.source)).toEqual([
      's3://bucket/batch.csv#L2',
      's3://bucket/batch.csv#L3',
    ]);
  });

  it('caps the number of records taken from one payload', () => {
    const csv = ['a', ...Array.from({ length: 100 }, (_, i) => String(i))].join('\n');
    expect(parsePayload(csv, { ...S, maxRecords: 10 })).toHaveLength(10);
  });
});

describe('parsePayload (ndjson)', () => {
  const N = { sourcePrefix: 's3://bucket/batch.ndjson' };

  it('parses one record per line and skips blanks', () => {
    const records = parsePayload('{"droneId":"D1"}\n\n{"droneId":"D2"}\n', N);
    expect(records).toHaveLength(2);
    expect(records[1]?.value).toEqual({ droneId: 'D2' });
  });

  it('flags only the malformed line, leaving its neighbours intact', () => {
    const records = parsePayload('{"droneId":"D1"}\n{oops\n{"droneId":"D3"}\n', N);
    expect(records[0]?.parseError).toBeUndefined();
    expect(records[1]?.parseError).toMatch(/invalid JSON/);
    expect(records[1]?.source).toBe('s3://bucket/batch.ndjson#L2');
    expect(records[2]?.value).toEqual({ droneId: 'D3' });
  });
});

describe('parsePayload (json)', () => {
  const J = { sourcePrefix: 'sqs:abc123' };

  it('accepts a single object', () => {
    expect(parsePayload('{"droneId":"D1"}', J)[0]?.value).toEqual({ droneId: 'D1' });
  });

  it('accepts an array and indexes each element', () => {
    const records = parsePayload('[{"droneId":"D1"},{"droneId":"D2"}]', J);
    expect(records).toHaveLength(2);
    expect(records[1]?.source).toBe('sqs:abc123#1');
  });

  it('quarantines rather than throwing on invalid JSON', () => {
    const records = parsePayload('{not json', J);
    expect(records[0]?.parseError).toMatch(/invalid JSON/);
    expect(records[0]?.rawText).toBe('{not json');
  });
});

describe('detectFormat', () => {
  it.each([
    ['data.csv', 'a,b', 'csv'],
    ['data.ndjson', '{}', 'ndjson'],
    ['data.jsonl', '{}', 'ndjson'],
    ['data.json', '{}', 'json'],
  ] as const)('uses the extension of %s', (key, body, expected) => {
    expect(detectFormat(key, body)).toBe(expected);
  });

  it('sniffs content when there is no useful extension', () => {
    expect(detectFormat('payload', '[{"a":1}]')).toBe('json');
    expect(detectFormat('payload', '{"a":1}\n{"a":2}')).toBe('ndjson');
    expect(detectFormat('payload', '{\n  "a": 1\n}')).toBe('json');
    expect(detectFormat('payload', 'droneId,eventType')).toBe('csv');
  });
});
