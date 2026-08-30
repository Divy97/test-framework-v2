// Forgetting a run, without editing history.
//
// Hosting the blobs made "delete this" a request somebody will actually make, and it
// collides with the property this project is proudest of: the log is append-only, and
// deleting from it would make every other claim about it worth less.
//
// So nothing is deleted from the log. The bytes go; the events stay exactly as they
// were; and a row in `forgotten` explains why the hashes they carry no longer resolve.
// The distinction the rendering has to preserve is between a run whose evidence was
// DESTROYED ON REQUEST and one whose evidence went missing — the first is a promise
// kept, the second is a bug, and a page that showed them identically would turn one
// into the other.

import { rm } from 'node:fs/promises';
import type { Db } from './store.js';
import { blobPath } from './blobs.js';
import type { ArtifactRef } from './events.js';

export type Tombstone = { runId: string; requestedBy: string; forgottenAt: string; removed: number };

/** Every `sha256:` ref a run's events mention, read straight out of the payloads. */
async function refsOf(client: Db, runId: string): Promise<ArtifactRef[]> {
  const { rows } = await client.query('select payload from events where run_id = $1', [runId]);
  const found = JSON.stringify(rows.map((row) => row.payload)).match(/sha256:[0-9a-f]{64}/g) ?? [];
  return [...new Set(found)] as ArtifactRef[];
}

/**
 * Destroy a run's artifacts, keep its log, and record that we did.
 *
 * The subtlety worth the query below: blobs are content-addressed, so two runs that
 * produced identical bytes — the same stdout, the same empty diff — share one file.
 * Deleting everything this run cites would silently break a run nobody asked to forget,
 * and the failure would surface much later as an evidence page whose hashes do not
 * resolve, which is exactly the state this whole feature exists to make legible.
 *
 * Idempotent: forgetting an already-forgotten run is a no-op that returns the original
 * tombstone, because a retried request must not rewrite who asked or when.
 */
export async function forgetRun(
  client: Db,
  options: { runId: string; requestedBy: string; blobRoot: string },
): Promise<Tombstone> {
  const existing = await tombstoneFor(client, options.runId);
  if (existing) return existing;

  const refs = await refsOf(client, options.runId);
  let removed = 0;
  for (const ref of refs) {
    // Cited by a run that is NOT this one and has not been forgotten? Then these bytes
    // are still somebody's evidence.
    const { rows } = await client.query(
      `select 1 from events e
         where e.run_id <> $1
           and e.payload::text like $2
           and not exists (select 1 from forgotten f where f.run_id = e.run_id)
         limit 1`,
      [options.runId, `%${ref}%`],
    );
    if (rows.length > 0) continue;
    await rm(blobPath(options.blobRoot, ref), { force: true });
    removed += 1;
  }

  await client.query(
    'insert into forgotten (run_id, requested_by, removed) values ($1, $2, $3) on conflict (run_id) do nothing',
    [options.runId, options.requestedBy, removed],
  );
  return (await tombstoneFor(client, options.runId))!;
}

/** The tombstone for a run, or null. Read on every render of a run's page. */
export async function tombstoneFor(client: Db, runId: string): Promise<Tombstone | null> {
  const { rows } = await client.query(
    'select run_id, requested_by, forgotten_at, removed from forgotten where run_id = $1',
    [runId],
  );
  const row = rows[0] as
    | { run_id: string; requested_by: string; forgotten_at: Date; removed: number }
    | undefined;
  return row
    ? {
        runId: row.run_id,
        requestedBy: row.requested_by,
        forgottenAt: new Date(row.forgotten_at).toISOString(),
        removed: Number(row.removed),
      }
    : null;
}
