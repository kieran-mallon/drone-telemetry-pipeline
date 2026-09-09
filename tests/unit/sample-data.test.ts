import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { processPayload } from '../../src/core/pipeline.js';

/**
 * The sample files are documentation, and documentation rots. These tests pin
 * the numbers quoted in sample-data/README.md to what the pipeline actually
 * does, so the two cannot drift apart.
 */

const sampleDir = fileURLToPath(new URL('../../sample-data/', import.meta.url));

function run(file: string) {
  const body = readFileSync(`${sampleDir}${file}`, 'utf8');
  return processPayload(body, { sourcePrefix: `s3://drone-telemetry-raw/${file}` });
}

describe('the clean sample files', () => {
  it.each(['telemetry-batch.csv', 'telemetry-batch.ndjson'])('%s parses entirely', (file) => {
    const result = run(file);
    expect(result.stats.received).toBe(40);
    expect(result.stats.valid).toBe(40);
    expect(result.stats.quarantined).toBe(0);
  });

  it('produces identical events from the CSV and NDJSON versions of the same data', () => {
    const csvIds = run('telemetry-batch.csv').events.map((e) => e.eventId).sort();
    const ndjsonIds = run('telemetry-batch.ndjson').events.map((e) => e.eventId).sort();

    // Same 40 facts, two formats, same 40 event ids. If these ever diverge, the
    // two ingestion paths would double-count anything sent over both.
    expect(csvIds).toEqual(ndjsonIds);
  });
});

describe('telemetry-corrupt.csv exercises every failure mode', () => {
  const result = run('telemetry-corrupt.csv');

  it('matches the totals documented in sample-data/README.md', () => {
    expect(result.stats).toEqual({
      received: 13,
      valid: 6,
      quarantined: 6,
      duplicatesInBatch: 1,
    });
  });

  it('quarantines exactly the rows expected, each with the right reason', () => {
    const byLine = Object.fromEntries(
      result.quarantined.map((q) => [q.source.split('#L')[1], q.errors[0]]),
    );

    expect(byLine['3']).toMatchObject({ path: 'droneId' });
    expect(byLine['4']).toMatchObject({ path: 'timestamp' });
    expect(byLine['5']).toMatchObject({ path: 'telemetryData.batteryPct' });
    expect(byLine['6']).toMatchObject({ path: 'telemetryData.lat' });
    expect(byLine['7']).toMatchObject({ code: 'parse_error' });
    expect(byLine['11']?.message).toMatch(/future/);
  });

  it('keeps the record with an unrecognised event type rather than dropping it', () => {
    const unknown = result.events.find((e) => e.eventType === 'UNKNOWN');
    expect(unknown).toBeDefined();
    // The original value survives in raw, so a backfill is a SQL update later.
    expect(JSON.stringify(unknown?.raw)).toContain('PARACHUTE_DEPLOYED');
  });

  it('keeps the record whose optional fields are all empty', () => {
    const sparse = result.events.find((e) => e.batteryPct === null && e.statusCode === null);
    expect(sparse).toBeDefined();
    expect(sparse?.droneId).toBe('DRONE-002');
  });

  it('resolves the epoch-seconds timestamp to 2026, not 1970', () => {
    const routeAdjusted = result.events.find((e) => e.eventType === 'ROUTE_ADJUSTED');
    expect(routeAdjusted?.eventTime.getFullYear()).toBe(2026);
  });

  it('marks the motor fault as an error', () => {
    expect(result.events.find((e) => e.eventType === 'MOTOR_FAULT')?.severity).toBe('error');
  });
});
