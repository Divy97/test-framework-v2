// The surface a runner dials out to, and the only way into the log from outside.
//
// Everything here is one bearer token away from writing somebody's evidence, so the
// module is deliberately thin: authenticate, authorize, hand to `plane.ts`, and turn a
// refusal into the status code that says which refusal it was. No business logic, no
// second definition of who may write.
//
// It is a `Route` — the same contract the dashboard uses — so the plane serves both
// from one port and one process. That is not just convenience: the runner API and the
// human UI have to agree about who owns an installation, and two servers is how they
// start disagreeing.

import type pg from 'pg';
import type { RunEvent } from './events.js';
import {
  appendFromRunner,
  claimJob,
  finishJob,
  sawRunner,
  verifyRunner,
  type Runner,
} from './plane.js';
import type { Route } from './sse.js';

/** The longest a runner may hold a poll open. Long enough to be cheap, short enough to notice a deploy. */
const MAX_WAIT_MS = 30_000;

/** A batch bigger than this is a client that has stopped streaming and started dumping. */
const MAX_BATCH = 500;

const json = (body: unknown, status = 200) => ({
  status,
  type: 'application/json',
  body: JSON.stringify(body),
});

/** `Bearer <token>`, and nothing else. */
const bearer = (headers: Record<string, string | string[] | undefined>): string | undefined => {
  const raw = headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : undefined;
};

/**
 * Is this a stream of events, or is it something else wearing the shape?
 *
 * The runner is trusted for its own installation (ADR-0019) and not trusted to be
 * correct: a bug there must produce a refusal, never an exception in the plane or a row
 * that `fold()` throws on later. Every field the append path touches is checked here.
 */
const asEvents = (value: unknown): RunEvent[] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH) return null;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const event = item as Partial<RunEvent>;
    if (typeof event.run_id !== 'string' || typeof event.type !== 'string') return null;
    if (typeof event.seq !== 'number' || !Number.isInteger(event.seq) || event.seq < 1) return null;
    if (typeof event.ts !== 'string') return null;
    if (typeof event.payload !== 'object' || event.payload === null) return null;
  }
  return value as RunEvent[];
};

/**
 * The routes a paired machine may call.
 *
 * `null` for anything else, so this composes with the dashboard's routes and neither
 * has to know about the other.
 */
export function runnerRoutes(options: { client: pg.Client }): Route {
  const { client } = options;

  return async ({ method, path, query, headers, body }) => {
    if (!path.startsWith('/runner/')) return null;

    // One authentication, before any routing below it, so a route added later cannot
    // forget it — the same reason the dashboard checks its origin above its own table.
    const runner: Runner | null = await verifyRunner(client, bearer(headers));
    if (!runner) {
      return json({ error: 'unpaired: send a runner token as `Authorization: Bearer tfr_…`' }, 401);
    }
    await sawRunner(client, runner.id);

    // Take work, or wait for it. 204 means "nothing for you", which is the ordinary
    // answer and must not read as an error in a runner's logs.
    if (method === 'GET' && path === '/runner/jobs') {
      const asked = Number(query.get('wait') ?? '0') * 1000;
      const waitMs = Number.isFinite(asked) ? Math.min(Math.max(asked, 0), MAX_WAIT_MS) : 0;
      const job = await claimJob(client, runner, { waitMs });
      return job ? json(job) : { status: 204, type: 'application/json', body: '' };
    }

    const events = /^\/runner\/runs\/([^/]+)\/events$/.exec(path);
    if (method === 'POST' && events) {
      const runId = decodeURIComponent(events[1]!);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await body()) as unknown;
      } catch {
        return json({ error: 'body is not JSON' }, 400);
      }
      const batch = asEvents((parsed as { events?: unknown } | null)?.events);
      if (!batch) return json({ error: `expected {"events": [...]}, at most ${MAX_BATCH}` }, 400);

      const result = await appendFromRunner(client, runner, runId, batch);
      if ('refused' in result) {
        // The refusals are distinguishable on purpose. A runner operator has to be able
        // to tell a client bug from a stale process from an attack, and run ids are
        // uuids, so "this run exists but is not yours" leaks nothing worth having.
        const status = result.refused.includes('no such run')
          ? 404
          : result.refused.includes('another runner')
            ? 403
            : result.refused.includes('already recorded')
              ? 409
              : 400;
        return json({ error: result.refused, appended: result.appended ?? 0 }, status);
      }
      return json(result);
    }

    const finished = /^\/runner\/runs\/([^/]+)\/finished$/.exec(path);
    if (method === 'POST' && finished) {
      const runId = decodeURIComponent(finished[1]!);
      // Authorized through the same door as an append: finishing somebody else's job is
      // not a lesser thing to be allowed to do than writing to it.
      const check = await appendFromRunner(client, runner, runId, []);
      if ('refused' in check) return json({ error: check.refused }, 403);
      await finishJob(client, runId);
      return { status: 204, type: 'application/json', body: '' };
    }

    return json({ error: 'no such runner route' }, 404);
  };
}
