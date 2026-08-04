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
