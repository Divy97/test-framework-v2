// Append-only access to the events table (ADR-0002). No update, no delete.
// Monotonic seq is the caller's claim; unique(run_id, seq) makes violations
// impossible rather than merely unlikely.

import pg from 'pg';
import type { RunEvent } from './events.js';

export const connect = () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — copy .env.example to .env');
  }
  return new pg.Client({ connectionString });
};

export async function appendEvent(client: pg.Client, event: RunEvent): Promise<void> {
  await client.query(
    'insert into events (run_id, seq, type, payload, ts) values ($1, $2, $3, $4, $5)',
    [event.run_id, event.seq, event.type, JSON.stringify(event.payload), event.ts],
  );
}

export async function readRun(client: pg.Client, runId: string): Promise<RunEvent[]> {
  const { rows } = await client.query(
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
export async function readRunAfter(client: pg.Client, runId: string, afterSeq: number): Promise<RunEvent[]> {
  const { rows } = await client.query(
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
