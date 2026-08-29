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
import { digest, put } from './blobs.js';
import type { ArtifactRef, RunEvent } from './events.js';
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

/**
 * The largest blob this accepts in one request.
 *
 * ponytail: buffered in memory, so the ceiling is a memory decision rather than a
 * storage one. It covers every blob this engine actually produces — an 8KB stdout tail,
 * a diff, a screenshot — and refuses the pathological case loudly instead of quietly
 * inventing a swap file. Stream to a temp file and rename if a real repository ever
 * produces a 64MB test log worth keeping.
 */
const MAX_BLOB_BYTES = 16 * 1024 * 1024;

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
export function runnerRoutes(options: { client: pg.Client; blobRoot: string }): Route {
  const { client, blobRoot } = options;

  return async ({ method, path, query, headers, body, raw }) => {
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

    // Blobs (9b). Under the RUN they belong to, not a bare content-addressed endpoint:
    // the store dedups by hash anyway, and routing the upload through the run makes it
    // the same authorization question as an append rather than a second, weaker one.
    const blob = /^\/runner\/runs\/([^/]+)\/blobs\/(sha256:[0-9a-f]{64})$/.exec(path);
    if (method === 'PUT' && blob) {
      const runId = decodeURIComponent(blob[1]!);
      const claimed = blob[2] as ArtifactRef;
      const authorized = await appendFromRunner(client, runner, runId, []);
      if ('refused' in authorized) {
        return json({ error: authorized.refused }, authorized.refused.includes('no such run') ? 404 : 403);
      }

      const bytes = await raw(MAX_BLOB_BYTES);
      if (bytes === null) return json({ error: `a blob may not exceed ${MAX_BLOB_BYTES} bytes` }, 413);

      // Named BEFORE stored, and the order is the point. `digest` says what these bytes
      // are; if that is not what the runner claimed, nothing is written at all. Storing
      // first and refusing afterwards would be a check that reports rather than one that
      // holds — the bytes would already be on our disk, under a name nobody asked for.
      const actual = digest(bytes);
      if (actual !== claimed) {
        return json({ error: `these bytes are ${actual}, not ${claimed}` }, 400);
      }
      const stored = await put(blobRoot, bytes);
      return json({ ref: stored, bytes: bytes.length }, 201);
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
