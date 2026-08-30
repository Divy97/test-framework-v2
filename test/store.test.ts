// The two paths that need a real database, executed against one.
//
// Everything else in this repository takes its I/O as an injected function and is
// tested without Postgres — deliberately, because the interesting properties of the
// SSE tail (resumption, no duplicates) have nothing to do with where events are
// stored. But that leaves two pieces of SQL whose only test would otherwise be that
// they compile: the recipe store, and the tail's `seq > $2`.
//
// So this file runs them. Without a database it SKIPS, naming what is missing — a
// suite that silently drops its only database coverage is the false green this
// project exists to refuse, and the skip message is what stops a green run reading
// as a verified one.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { RunEvent } from '../src/events.js';
import { loadRecipe, saveRecipe, type Recipe } from '../src/recipe.js';
import type pg from 'pg';
import { appendEvent, connect, readRunAfter } from '../src/store.js';
import { resumeFrom, tailRun } from '../src/sse.js';

let client: pg.Pool | null = null;
let why = '';

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    why = 'DATABASE_URL is not set (copy .env.example to .env and `docker compose up -d`)';
    return;
  }
  try {
    const candidate = connect();
    // The schema, not just the connection. A database with no tables would fail
    // every test below with a confusing error instead of skipping.
    await candidate.query('select 1 from events limit 1');
    await candidate.query('select 1 from recipes limit 1');
    client = candidate;
  } catch (error) {
    why = `no usable database: ${String((error as Error).message ?? error)} — run \`npm run db:schema\``;
  }
});

afterAll(async () => {
  await client?.end();
});

describe('the recipe store, against a real database', () => {
  test('a recipe round-trips, and a second approval replaces the first', async () => {
    if (!client) {
      // An explicit skip with the reason in it, rather than a silent pass. This is
      // the only coverage the recipe store's SQL has.
      console.log(`SKIPPED (recipe store): ${why}`);
      return;
    }
    const repo = `owner/repo-${randomUUID().slice(0, 8)}`;
    const first: Recipe = {
      install: 'npm install',
      services: [{ name: 'web', command: 'node server.mjs', port: 8080, healthcheck: 'http://127.0.0.1:8080/healthz' }],
      test: 'node --test',
    };

    expect(await loadRecipe(client, repo)).toBeNull();
    await saveRecipe(client, repo, first);
    expect(await loadRecipe(client, repo)).toEqual(first);

    // Recipes rot, so replacing one is the ordinary case rather than an edge —
    // `recipes` is current configuration, unlike `events`, which is append-only.
    const second: Recipe = { ...first, install: 'pnpm install' };
    await saveRecipe(client, repo, second);
    expect(await loadRecipe(client, repo)).toEqual(second);

    // And it comes back through the validator, so a row someone edited by hand into
    // a shape the engine cannot run is refused at read time rather than inside a
    // container.
    await client.query('update recipes set recipe = $2 where repo = $1', [repo, JSON.stringify({ services: 'web' })]);
    await expect(loadRecipe(client, repo)).rejects.toThrow(/must be an array/);

    await client.query('delete from recipes where repo = $1', [repo]);
  });
});

describe('the tail s query, against a real database', () => {
  test('seq > $2 is the whole of resumption', async () => {
    if (!client) {
      console.log(`SKIPPED (event tail): ${why}`);
      return;
    }
    const runId = randomUUID();
    const events: RunEvent[] = [
      {
        run_id: runId,
        seq: 1,
        ts: new Date().toISOString(),
        type: 'RUN_REQUESTED',
        payload: { v: 1, source: 'github_issue', thread_ref: 'o/r#1', raw_text: 'Ordres' },
      },
      { run_id: runId, seq: 2, ts: new Date().toISOString(), type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } },
      {
        run_id: runId,
        seq: 3,
        ts: new Date().toISOString(),
        type: 'ENV_READY',
        payload: { v: 1, services: [{ name: 'web', port: 8080, detail: 'HTTP 200' }], steps: [] },
      },
    ];

    try {
      for (const event of events) await appendEvent(client, event);

      // The query the tail runs, at three cursors.
      expect((await readRunAfter(client, runId, 0)).map((e) => e.seq)).toEqual([1, 2, 3]);
      expect((await readRunAfter(client, runId, 2)).map((e) => e.seq)).toEqual([3]);
      expect(await readRunAfter(client, runId, 3)).toEqual([]);
      // A different run's events are not this run's, which is the other half of the
      // `where` clause and the one a single-run test would never catch.
      expect(await readRunAfter(client, randomUUID(), 0)).toEqual([]);

      // The payload survives the jsonb round-trip intact, including the event class
      // v1.5 added. A tail that delivered a mangled payload would fold to nonsense.
      const [, , envReady] = await readRunAfter(client, runId, 0);
      expect(envReady!.payload).toEqual({
        v: 1,
        services: [{ name: 'web', port: 8080, detail: 'HTTP 200' }],
        steps: [],
      });

      // And the tail itself, over the real store: a client that already has seq 1
      // gets 2 and 3 and nothing else.
      let body = '';
      let open = true;
      await tailRun({
        runId,
        afterSeq: resumeFrom('1'),
        read: (id, afterSeq) => readRunAfter(client!, id, afterSeq),
        write: (chunk) => (body += chunk),
        connected: () => open,
        pollMs: 5,
        until: (event) => event.seq === 3,
      });
      open = false;
      expect([...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual([2, 3]);
    } finally {
      await client.query('delete from events where run_id = $1', [runId]);
    }
  });
});

/**
 * The property the pool exists for (ADR-0020).
 *
 * These do not test `pg`. They test that THIS process survives a database connection
 * dying underneath it — which the plane did not, because a `pg.Client` that loses its
 * connection emits `'error'` with nobody listening, and an unhandled `'error'` event in
 * Node exits the process. The bug never appeared on a laptop because a laptop's
 * Postgres does not go away mid-afternoon. A managed database that suspends idle
 * compute does, every night, on a schedule.
 *
 * `pg_terminate_backend` is how a connection is made to die on purpose. It is the same
 * FATAL the server sends when it decides on its own that a socket has been quiet
 * long enough.
 */
describe('a database connection that dies under the process', () => {
  test('a connection killed while IDLE in the pool does not take the process down', async () => {
    if (!client) {
      console.log(`SKIPPED (idle connection): ${why}`);
      return;
    }
    // Serve a query so a connection exists, and note which one. It goes back into the
    // pool idle the moment this resolves — nobody is awaiting it any more, which is
    // precisely why its death has no promise to reject and used to reach the process.
    const { rows } = await client.query('select pg_backend_pid() as pid');
    const idlePid = Number(rows[0].pid);

    // WATCH THE PROCESS, not just the pool. Without the listener in `connect()` the pool
    // still recovers — it opens another connection and every other assertion here passes
    // — so a test that only queried again would stay green while the bug it exists for
    // was fully present. What actually differs is that the dead connection's `'error'`
    // reaches the process as an uncaught exception, and in production that is the exit.
    // So the uncaught exception is the thing asserted on.
    //
    // Armed BEFORE the kill. `pg_terminate_backend` returns when the signal is sent, so
    // the victim's FATAL arrives a beat after the executioner's reply — measured at 0-1ms
    // behind. Arming afterwards worked on that margin; arming first has no margin to be
    // on the wrong side of.
    //
    // This depends on a real vitest behaviour worth naming, because it looks like the
    // assertion is redundant and it is not: while a test is running and a SECOND
    // `uncaughtException` listener exists, vitest reports nothing and defers to that
    // listener. Inside this window `escaped` is the only judge. Delete the `expect` on
    // the theory that vitest would have caught it anyway and the coverage disappears
    // with no failure to tell you.
    const escaped: Error[] = [];
    const watch = (error: Error) => escaped.push(error);
    process.on('uncaughtException', watch);
    try {
      // Killed from OUTSIDE the pool, the way the server would do it.
      const executioner = connect();
      try {
        await executioner.query('select pg_terminate_backend($1)', [idlePid]);
      } finally {
        await executioner.end();
      }
      // The FATAL reaches the idle socket asynchronously.
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      process.off('uncaughtException', watch);
    }
    expect(escaped.map((error) => error.message)).toEqual([]);

    // And the pool opened another one, so the drop cost a connection, not the process.
    const after = await client.query('select pg_backend_pid() as pid');
    expect(Number(after.rows[0].pid)).not.toBe(idlePid);
  });

  test('every connection the pool holds can die at once and the process still does not', async () => {
    if (!client) {
      console.log(`SKIPPED (pool recovery): ${why}`);
      return;
    }
    // The hosted failure this whole change is about: not one reaped socket, but the
    // database going away and taking every connection with it. Concurrent queries force
    // the pool to open more than one, and each reports the backend serving it.
    const served = await Promise.all([
      client.query('select pg_backend_pid() as pid'),
      client.query('select pg_backend_pid() as pid'),
      client.query('select pg_backend_pid() as pid'),
    ]);
    const mine = [...new Set(served.map((result) => Number(result.rows[0].pid)))];
    expect(mine.length).toBeGreaterThan(1);

    const escaped: Error[] = [];
    const watch = (error: Error) => escaped.push(error);
    process.on('uncaughtException', watch);
    try {
      const executioner = connect();
      try {
        // EXACTLY this pool's connections, by pid.
        //
        // The first version of this said `where datname = current_database()`, which is
        // every backend on the database — and vitest runs test files in parallel forks
        // against ONE database, so it reaped the connections of whatever else was
        // running. It failed other files roughly a third of the time, from here, with
        // an error naming them rather than this test. A test that breaks its neighbours
        // is worse than the bug it was written for.
        await executioner.query(
          'select pg_terminate_backend(pid) from pg_stat_activity where pid = any($1::int[])',
          [mine],
        );
      } finally {
        await executioner.end();
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      process.off('uncaughtException', watch);
    }
    // Several connections died at once, so the listener was called several times. None
    // of them reached the process.
    expect(escaped.map((error) => error.message)).toEqual([]);

    // And the next request is served, with no restart and nothing for an operator to do.
    const recovered = await client.query('select 1 as ok');
    expect(recovered.rows[0].ok).toBe(1);
  });
});
