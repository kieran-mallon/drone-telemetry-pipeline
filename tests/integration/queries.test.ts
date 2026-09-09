import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresEventStore } from '../../src/adapters/postgres/event-store.js';
import { findErrors, findEventsByDrone } from '../../src/adapters/postgres/queries.js';
import type { TelemetryEvent } from '../../src/core/schema.js';
import { startTestDatabase, type TestDatabase } from './helpers.js';

let db: TestDatabase;

const DRONE_COUNT = 25;
const EVENT_COUNT = 5000;
const TARGET_DRONE = 'DRONE-007';

beforeAll(async () => {
  db = await startTestDatabase();

  const store = new PostgresEventStore(db.pool, 500);
  const events: TelemetryEvent[] = Array.from({ length: EVENT_COUNT }, (_, i) => {
    // Roughly 1 in 20 is an error, so the partial index stays genuinely partial.
    const severity = i % 20 === 0 ? 'error' : i % 7 === 0 ? 'warning' : 'info';
    return {
      eventId: `evt-${i}`,
      droneId: `DRONE-${String((i % DRONE_COUNT) + 1).padStart(3, '0')}`,
      eventTime: new Date(Date.UTC(2026, 8, 1) + i * 60_000),
      eventType: severity === 'error' ? 'MOTOR_FAULT' : 'SENSOR_READING',
      statusCode: severity === 'error' ? 500 : 200,
      severity,
      batteryPct: 100 - ((i * 3) % 95),
      latitude: 54.5 + (i % 100) / 1000,
      longitude: -5.9 - (i % 100) / 1000,
      telemetry: { altitudeM: 40 + (i % 90) },
      raw: { i },
      source: `s3://bucket/seed.ndjson#L${i}`,
    };
  });

  await store.insertEvents(events);

  // Without fresh statistics the planner has no idea how selective these
  // predicates are and may reasonably choose a sequential scan, which would
  // make the plan assertions below meaningless.
  await db.pool.query('ANALYZE telemetry_events');
}, 240_000);

afterAll(async () => {
  await db?.stop();
});

async function explain(sql: string, params: unknown[]): Promise<string> {
  const { rows } = await db.pool.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params);
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

describe('the indexes actually serve the queries they were built for', () => {
  /**
   * These are the tests that make the comments in
   * migrations/001_telemetry_events.sql true rather than aspirational. An index
   * the planner ignores is dead weight: it costs write throughput and disk and
   * buys nothing, and nothing else in a test suite will notice.
   */
  it('uses idx_telemetry_events_drone_time for the per-drone query', async () => {
    const plan = await explain(
      `SELECT * FROM telemetry_events
        WHERE drone_id = $1
        ORDER BY event_time DESC, id DESC
        LIMIT 50`,
      [TARGET_DRONE],
    );

    expect(plan).toContain('idx_telemetry_events_drone_time');
    expect(plan).not.toContain('Seq Scan');
  });

  it('uses the partial idx_telemetry_events_errors_time for the errors query', async () => {
    const plan = await explain(
      `SELECT * FROM telemetry_events
        WHERE severity = 'error' AND event_time >= $1
        ORDER BY event_time DESC, id DESC
        LIMIT 50`,
      [new Date(Date.UTC(2026, 8, 1)).toISOString()],
    );

    expect(plan).toContain('idx_telemetry_events_errors_time');
    expect(plan).not.toContain('Seq Scan');
  });

  it('keeps the partial index far smaller than a full one would be', async () => {
    const { rows } = await db.pool.query<{ name: string; bytes: string }>(`
      SELECT indexrelname AS name, pg_relation_size(indexrelid) AS bytes
        FROM pg_stat_user_indexes
       WHERE relname = 'telemetry_events'
    `);

    const sizes = Object.fromEntries(rows.map((r) => [r.name, Number(r.bytes)]));

    // It indexes ~5% of the rows, so it should be a small fraction of the size
    // of the index that covers every row.
    expect(sizes['idx_telemetry_events_errors_time']).toBeLessThan(
      sizes['idx_telemetry_events_drone_time']! / 2,
    );
  });
});

describe('findEventsByDrone', () => {
  it('returns only that drone, newest first', async () => {
    const page = await findEventsByDrone(db.pool, TARGET_DRONE, { limit: 25 });

    expect(page.items).toHaveLength(25);
    expect(page.items.every((e) => e.drone_id === TARGET_DRONE)).toBe(true);

    const times = page.items.map((e) => e.event_time.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('honours a time window', async () => {
    const from = new Date(Date.UTC(2026, 8, 1) + 1000 * 60_000);
    const to = new Date(Date.UTC(2026, 8, 1) + 2000 * 60_000);

    const page = await findEventsByDrone(db.pool, TARGET_DRONE, { from, to, limit: 500 });

    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      expect(item.event_time.getTime()).toBeGreaterThanOrEqual(from.getTime());
      expect(item.event_time.getTime()).toBeLessThan(to.getTime());
    }
  });

  it('pages through every event exactly once', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;

    // Keyset pagination: each page reads the same number of rows regardless of
    // how deep it is, and the window does not shift under concurrent inserts.
    for (let page = 0; page < 50; page += 1) {
      const result = await findEventsByDrone(db.pool, TARGET_DRONE, { limit: 20, cursor });
      seen.push(...result.items.map((e) => e.event_id));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }

    expect(seen.length).toBe(EVENT_COUNT / DRONE_COUNT);
    // No duplicates and no gaps.
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('returns an empty page for an unknown drone rather than failing', async () => {
    const page = await findEventsByDrone(db.pool, 'DRONE-DOES-NOT-EXIST', { limit: 10 });
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it('ignores a malformed cursor instead of throwing', async () => {
    const page = await findEventsByDrone(db.pool, TARGET_DRONE, {
      limit: 5,
      cursor: 'not-a-real-cursor',
    });
    expect(page.items).toHaveLength(5);
  });
});

describe('findErrors', () => {
  it('returns only errors', async () => {
    const page = await findErrors(db.pool, { limit: 50 });

    expect(page.items).toHaveLength(50);
    expect(page.items.every((e) => e.severity === 'error')).toBe(true);
  });

  it('restricts to the requested window', async () => {
    const from = new Date(Date.UTC(2026, 8, 1) + 4000 * 60_000);

    const page = await findErrors(db.pool, { from, limit: 200 });

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((e) => e.event_time.getTime() >= from.getTime())).toBe(true);
  });
});
