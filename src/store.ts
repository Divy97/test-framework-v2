// Append-only access to the events table (ADR-0002). No update, no delete.
// Monotonic seq is the caller's claim; unique(run_id, seq) makes violations
// impossible rather than merely unlikely.

import pg from 'pg';
import type { RunEvent } from './events.js';

/**
 * Read `.env` if there is one, and shrug if there is not.
 *
 * `process.loadEnvFile` THROWS on a missing file — the `?.` guards against an old Node,
 * not against ENOENT — and a container has no `.env` by design: its environment IS the
 * environment. Unguarded, the plane's image died on its first start with a stack trace
 * about a file that is deliberately absent, before it could print the list naming what
 * each missing variable costs.
 *
 * Here rather than in each entry point because there are three of them now, and the one
 * added last is the one that met the bug. `vitest.config.ts` has been wrapping this call
 * for the same reason since M6.
 */
export function loadEnv(path = '.env'): void {
  try {
    process.loadEnvFile?.(path);
  } catch {
    // No `.env`. Every program here refuses legibly on what it is actually missing.
  }
}

/**
 * A handle on the database. A POOL, not a connection, and the distinction is the whole
 * of ADR-0020.
 *
 * Everything here used to take a `pg.Client`: one connection, opened at boot, held for
 * the life of the process. That works exactly as long as the connection never drops —
 * which is true on a laptop for an afternoon, and false everywhere this is going. A
 * managed Postgres suspends idle compute; a load balancer reaps a quiet socket; a
 * network blips. When that connection died, `pg.Client` emitted `'error'` with nothing
 * listening, and an unhandled `'error'` event in Node is a process exit. On a
 * `restart: always` container that is not degradation, it is a crash loop that starts
 * every night when the traffic stops.
 *
 * A pool answers each query on some live connection and opens a new one when the old
 * one is gone, so the drop costs a query rather than the process.
 *
 * Deliberately "something you can query" rather than the pool itself. Everything below
 * needs exactly `query`, and saying so lets a caller that genuinely needs one connection
 * — a transaction, which means a client checked out and released in a `finally` — hand
 * that client in instead. `connect()` returns the concrete pool, so shutdown still has
 * the `end()` that this type does not expose.
 */
export type Db = Pick<pg.Pool, 'query'>;

export const connect = (): pg.Pool => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — copy .env.example to .env');
  }
  const pool = new pg.Pool({
    connectionString,
    // A hosted database that has scaled its compute to zero answers a connection
    // eventually rather than never. Without this, `connectionTimeoutMillis` is 0 —
    // no timeout — and a connect that will never complete hangs the request holding it.
    connectionTimeoutMillis: 10_000,
  });

  // THE LISTENER THAT IS THE POINT. A pool emits `'error'` when a connection sitting
  // IDLE in it dies — nobody is awaiting that one, so there is no promise to reject and
  // no caller to tell. Unhandled, it takes the process down; handled, it is a log line
  // and a connection the pool will not hand out again.
  pool.on('error', (error) => {
    console.error(`database connection dropped while idle (the pool will open another): ${error.message}`);
  });

  return pool;
};

/**
 * Prove the database is actually reachable, now, rather than at the first request.
 *
 * A pool is lazy: `connect()` above opens nothing, so a wrong `DATABASE_URL` would be
 * discovered by whoever made the first query — a webhook delivery, at 3am, reported as
 * a failed delivery. Every entry point calls this at boot so the failure lands in the
 * terminal of the person who just started it.
 */
export async function ready(db: Db): Promise<void> {
  await db.query('select 1');
}

export async function appendEvent(db: Db, event: RunEvent): Promise<void> {
  await db.query(
    'insert into events (run_id, seq, type, payload, ts) values ($1, $2, $3, $4, $5)',
    [event.run_id, event.seq, event.type, JSON.stringify(event.payload), event.ts],
  );
}

export async function readRun(db: Db, runId: string): Promise<RunEvent[]> {
  const { rows } = await db.query(
    'select run_id, seq, type, payload, ts from events where run_id = $1 order by seq',
    [runId],
  );
  return rows.map((r) => ({
    run_id: r.run_id,
    seq: r.seq,
    type: r.type,
    payload: r.payload,
    ts: r.ts instanceof Date ? r.ts.toISOString() : r.ts,
  }));
}

/**
 * The tail's one query (ADR-0005): everything after a seq the client already has.
 *
 * `Last-Event-ID` maps 1:1 onto `seq`, so resumption is this `>` and nothing else —
 * no cursor of ours, no replay buffer, no acknowledgement. The store IS the buffer,
 * because the log is append-only and immutable, which is why a dropped connection
 * resumes with no missed and no duplicated events without anything being careful.
 */
export async function readRunAfter(db: Db, runId: string, afterSeq: number): Promise<RunEvent[]> {
  const { rows } = await db.query(
    'select run_id, seq, type, payload, ts from events where run_id = $1 and seq > $2 order by seq',
    [runId, afterSeq],
  );
  return rows.map((r) => ({
    run_id: r.run_id,
    seq: r.seq,
    type: r.type,
    payload: r.payload,
    ts: r.ts instanceof Date ? r.ts.toISOString() : r.ts,
  }));
}

/**
 * Shut the pool down without hanging on a query that will never answer.
 *
 * `Client.end()` used to destroy the socket when a query was in flight — its own comment
 * said "a hung query could block end forever". `Pool.end()` has no such escape hatch: it
 * waits for every checked-out client to come back, with no timeout, and a query checks a
 * client out for its whole duration. So the exact failure this pool exists to survive — a
 * black-holed socket, a database suspending mid-statement — would leave SIGTERM waiting
 * on a reply that is not coming, until Docker's grace period turned it into SIGKILL.
 *
 * Bounded here rather than at four call sites. Draining is the polite path and it is
 * tried first; the timeout only decides how long politeness lasts.
 */
export async function close(pool: pg.Pool, graceMs = 5_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    // A second `end()` rejects with "Called end on pool more than once" where the old
    // `Client.end()` simply resolved, and a shutdown path is exactly where something
    // gets called twice. Swallowed: the pool is closing either way.
    pool.end().catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, graceMs);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
}
