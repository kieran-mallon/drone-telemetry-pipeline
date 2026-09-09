import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresEventStore } from '../../src/adapters/postgres/event-store.js';
import { runMigrations } from '../../src/adapters/postgres/migrate.js';
import type { TelemetryEvent } from '../../src/core/schema.js';
import { startTestDatabase, truncateAll, type TestDatabase } from './helpers.js';

let db: TestDatabase;
let store: PostgresEventStore;

beforeAll(async () => {
  db = await startTestDatabase();
  // Small chunk size so the chunking path is actually exercised by modest batches.
  store = new PostgresEventStore(db.pool, 50);
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

beforeEach(async () => {
  await truncateAll(db.pool);
});

function event(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    eventId: 'evt-1',
    droneId: 'DRONE-001',
    eventTime: new Date('2026-09-01T10:00:00.000Z'),
    eventType: 'DELIVERY_COMPLETED',
    statusCode: 200,
    severity: 'info',
    batteryPct: 87.5,
    latitude: 54.597,
    longitude: -5.93,
    telemetry: { batteryPct: 87.5, altitudeM: 90 },
    raw: { original: true },
    source: 's3://bucket/batch.csv#L2',
    ...overrides,
  };
}

describe('migrations', () => {
  it('are idempotent, so a redeploy or a restarted container is safe', async () => {
    // Already applied once in setup.
    const second = await runMigrations(db.pool);
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBeGreaterThan(0);
  });
});

describe('inserting events', () => {
  it('writes every column back exactly as given', async () => {
    await store.insertEvents([event()]);

    const { rows } = await db.pool.query('SELECT * FROM telemetry_events');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_id: 'evt-1',
      drone_id: 'DRONE-001',
      event_type: 'DELIVERY_COMPLETED',
      status_code: 200,
      severity: 'info',
      // NUMERIC comes back as a string from node-postgres unless a type parser
      // is registered; client.ts registers one, and this asserts it works.
      battery_pct: 87.5,
      source: 's3://bucket/batch.csv#L2',
    });
    expect(rows[0].telemetry).toEqual({ batteryPct: 87.5, altitudeM: 90 });
    expect(rows[0].raw).toEqual({ original: true });
  });

  it('deduplicates on event_id, which is what makes at-least-once safe', async () => {
    const first = await store.insertEvents([event()]);
    const second = await store.insertEvents([event()]);

    expect(first).toEqual({ attempted: 1, inserted: 1, duplicates: 0 });
    expect(second).toEqual({ attempted: 1, inserted: 0, duplicates: 1 });

    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM telemetry_events');
    expect(rows[0].n).toBe(1);
  });

  it('reports the duplicate count correctly for a partially new batch', async () => {
    await store.insertEvents([event({ eventId: 'a' }), event({ eventId: 'b' })]);

    const result = await store.insertEvents([
      event({ eventId: 'b' }),
      event({ eventId: 'c' }),
      event({ eventId: 'd' }),
    ]);

    expect(result).toEqual({ attempted: 3, inserted: 2, duplicates: 1 });
  });

  it('chunks large batches rather than exceeding the bind parameter limit', async () => {
    // 500 rows at 12 parameters each is 6000 parameters, well past what a single
    // statement would take if the chunking were removed.
    const events = Array.from({ length: 500 }, (_, i) => event({ eventId: `bulk-${i}` }));

    const result = await store.insertEvents(events);

    expect(result.inserted).toBe(500);
  });

  it('accepts null for every optional field', async () => {
    await store.insertEvents([
      event({
        eventId: 'sparse',
        statusCode: null,
        batteryPct: null,
        latitude: null,
        longitude: null,
        telemetry: {},
      }),
    ]);

    const { rows } = await db.pool.query(
      `SELECT status_code, battery_pct, latitude FROM telemetry_events WHERE event_id = 'sparse'`,
    );
    expect(rows[0]).toEqual({ status_code: null, battery_pct: null, latitude: null });
  });

  it('is a no-op for an empty batch, without a round trip', async () => {
    expect(await store.insertEvents([])).toEqual({ attempted: 0, inserted: 0, duplicates: 0 });
  });

  /**
   * Regression test.
   *
   * node-postgres returns NUMERIC as a string by default. The parser that fixes
   * that used to be registered as a side effect of importing client.ts, so any
   * pool built without importing that file got strings back and the read API
   * served {"battery_pct": "87.50"}. The registration is now explicit and this
   * asserts the result rather than trusting the import graph.
   */
  it('returns NUMERIC as a number, not a string', async () => {
    await store.insertEvents([event({ eventId: 'numeric-check', batteryPct: 87.5 })]);

    const { rows } = await db.pool.query(
      `SELECT battery_pct FROM telemetry_events WHERE event_id = 'numeric-check'`,
    );

    expect(typeof rows[0].battery_pct).toBe('number');
    expect(rows[0].battery_pct).toBe(87.5);
  });
});

describe('database constraints are a second line of defence', () => {
  /**
   * Validation happens in the application, so these should never fire in
   * practice. They are here because a constraint is the only thing that still
   * protects the data when someone writes a one-off backfill script and skips
   * the pipeline entirely.
   */
  it('rejects an impossible battery level', async () => {
    await expect(store.insertEvents([event({ batteryPct: 900 })])).rejects.toThrow(
      /battery_range/,
    );
  });

  it('rejects an impossible latitude', async () => {
    await expect(store.insertEvents([event({ latitude: 999 })])).rejects.toThrow(
      /latitude_range/,
    );
  });

  it('rejects an unknown severity', async () => {
    await expect(
      store.insertEvents([event({ severity: 'catastrophic' as 'error' })]),
    ).rejects.toThrow(/severity_check/);
  });
});

describe('quarantine', () => {
  it('stores payloads that are not valid JSON, which is the whole point', async () => {
    await store.insertQuarantined([
      {
        source: 's3://bucket/bad.csv#L7',
        rawPayload: 'D5,2026-09-01T10:00:00Z',
        errors: [{ path: '(root)', code: 'parse_error', message: 'malformed CSV row' }],
      },
    ]);

    const { rows } = await db.pool.query('SELECT * FROM telemetry_quarantine');
    expect(rows[0].raw_payload).toBe('D5,2026-09-01T10:00:00Z');
    expect(rows[0].errors[0].code).toBe('parse_error');
  });

  it('makes "which field fails most often" a query rather than a grep', async () => {
    await store.insertQuarantined([
      { source: 'a', rawPayload: 'x', errors: [{ path: 'droneId', code: 'too_small', message: '' }] },
      { source: 'b', rawPayload: 'y', errors: [{ path: 'droneId', code: 'too_small', message: '' }] },
      { source: 'c', rawPayload: 'z', errors: [{ path: 'timestamp', code: 'invalid_type', message: '' }] },
    ]);

    const { rows } = await db.pool.query(`
      SELECT issue->>'path' AS path, count(*)::int AS n
        FROM telemetry_quarantine, jsonb_array_elements(errors) AS issue
       GROUP BY 1 ORDER BY n DESC
    `);

    expect(rows[0]).toEqual({ path: 'droneId', n: 2 });
  });
});
