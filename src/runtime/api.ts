import '../load-env.js';

import Fastify from 'fastify';
import { z } from 'zod';

import {
  findErrors,
  findEventsByDrone,
  findQuarantined,
} from '../adapters/postgres/queries.js';
import { createRuntime } from './dependencies.js';

/**
 * A small read API.
 *
 * Not required by the brief, but the brief does ask how the data would be
 * queried later, and a working endpoint answers that better than a paragraph.
 * It exists to demonstrate that the schema and its indexes actually serve the
 * two access patterns the design was built around.
 *
 * Read-only on purpose. Ingestion goes through the queue, not through HTTP:
 * a write endpoint here would be a second, unbuffered path into the database
 * that bypasses every retry and backpressure guarantee the queue provides.
 */

const runtime = createRuntime();
const logger = runtime.dependencies.logger.child({ runtime: 'api' });

const querySchema = z.object({
  from: z.iso.datetime({ error: 'from must be an ISO 8601 datetime' }).optional(),
  to: z.iso.datetime({ error: 'to must be an ISO 8601 datetime' }).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().optional(),
});

function parseQuery(query: unknown) {
  const result = querySchema.safeParse(query);
  if (!result.success) {
    return {
      ok: false as const,
      issues: result.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    };
  }

  const { from, to, limit, cursor } = result.data;
  return {
    ok: true as const,
    options: {
      from: from !== undefined ? new Date(from) : undefined,
      to: to !== undefined ? new Date(to) : undefined,
      limit,
      cursor,
    },
  };
}

const app = Fastify({ logger: false });

/**
 * Liveness and readiness in one. It touches the database on purpose: a process
 * that is running but cannot reach Postgres is not ready to serve, and a health
 * check that only proves the event loop is turning will happily keep a broken
 * instance in the load balancer.
 */
app.get('/health', async (_request, reply) => {
  try {
    await runtime.pool.query('SELECT 1');
    return { status: 'ok' };
  } catch (error) {
    return reply.code(503).send({
      status: 'degraded',
      database: error instanceof Error ? error.message : 'unreachable',
    });
  }
});

/** GET /drones/:droneId/events?from=&to=&limit=&cursor= */
app.get('/drones/:droneId/events', async (request, reply) => {
  const { droneId } = request.params as { droneId: string };
  const parsed = parseQuery(request.query);
  if (!parsed.ok) return reply.code(400).send({ error: 'invalid query', issues: parsed.issues });

  const page = await findEventsByDrone(runtime.pool, droneId, parsed.options);
  return { droneId, count: page.items.length, nextCursor: page.nextCursor, events: page.items };
});

/** GET /events/errors?from=&to=&limit=&cursor= */
app.get('/events/errors', async (request, reply) => {
  const parsed = parseQuery(request.query);
  if (!parsed.ok) return reply.code(400).send({ error: 'invalid query', issues: parsed.issues });

  const page = await findErrors(runtime.pool, parsed.options);
  return { count: page.items.length, nextCursor: page.nextCursor, events: page.items };
});

/** GET /quarantine?limit= : the operational view of what is failing, and why. */
app.get('/quarantine', async (request, reply) => {
  const parsed = parseQuery(request.query);
  if (!parsed.ok) return reply.code(400).send({ error: 'invalid query', issues: parsed.issues });

  const rows = await findQuarantined(runtime.pool, parsed.options.limit);
  return { count: rows.length, records: rows };
});

app.setErrorHandler((error, _request, reply) => {
  logger.error({ err: error instanceof Error ? error.message : String(error) }, 'request failed');
  // Never leak a database error message to the caller.
  return reply.code(500).send({ error: 'internal error' });
});

try {
  await app.listen({ port: runtime.config.apiPort, host: runtime.config.apiHost });
  logger.info({ port: runtime.config.apiPort }, 'api listening');
} catch (error) {
  logger.error({ err: error instanceof Error ? error.message : String(error) }, 'api failed to start');
  process.exitCode = 1;
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void app.close().then(() => runtime.pool.end());
  });
}
