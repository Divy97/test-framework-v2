// Deleting somebody's evidence without editing anybody's history (9e).
//
// The log being append-only is the property this project is proudest of, and hosting the
// artifacts made "delete this run" a request somebody will actually make. The two are
// reconciled by deleting BYTES and never rows — so the assertions here are as much about
// what survives as about what goes.
//
// Real database and a real blob directory, because both halves of the claim are storage.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { get, put } from '../src/blobs.js';
import type { ArtifactRef, RunEvent } from '../src/events.js';
import { forgetRun, tombstoneFor } from '../src/forget.js';
import { appendEvent, connect, type Db } from '../src/store.js';

let client: Db | null = null;
let why = '';
const runs: string[] = [];
let root = '';

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'engine-forget-blobs-'));
  if (!process.env.DATABASE_URL) {
    why = 'DATABASE_URL is not set (copy .env.example to .env and `docker compose up -d`)';
    return;
  }
  try {
    const candidate = connect();
    await candidate.query('select 1 from forgotten limit 1');
    client = candidate;
  } catch (error) {
    why = `no usable database: ${String((error as Error).message ?? error)} — run \`npm run db:schema\``;
  }
});

afterAll(async () => {
  if (client) {
    await client.query('delete from forgotten where run_id = any($1)', [runs]).catch(() => {});
    await client.query('delete from events where run_id = any($1)', [runs]).catch(() => {});
  }
  await client?.end();
  rmSync(root, { recursive: true, force: true });
});

const withDb = (): boolean => {
  if (client) return false;
  expect.fail(`forgetting was NOT verified: ${why}`);
};

/** A run of two events, the second citing whatever refs are given. */
const runCiting = async (refs: ArtifactRef[]): Promise<string> => {
  const runId = randomUUID();
  runs.push(runId);
  const event = (seq: number, payload: Record<string, unknown>): RunEvent =>
    ({ run_id: runId, seq, ts: new Date().toISOString(), type: 'TEST_RUN', payload }) as unknown as RunEvent;
  await appendEvent(client!, event(1, { v: 1, source: 'github_issue', thread_ref: 'o/r#1' }));
  await appendEvent(client!, event(2, { v: 1, phase: 'base', exit_code: 1, refs }));
  return runId;
};

describe('forgetting destroys bytes and keeps history', () => {
  test('the artifacts go, and every event stays exactly as it was', async () => {
    if (withDb()) return;
    const ref = await put(root, `only this run has these bytes ${randomUUID()}`);
    const runId = await runCiting([ref]);

    const before = await client!.query('select seq, payload from events where run_id = $1 order by seq', [runId]);
    const tomb = await forgetRun(client!, { runId, requestedBy: 'divy97', blobRoot: root });

    expect(tomb.removed).toBe(1);
    await expect(get(root, ref)).rejects.toThrow();

    // THE assertion. Deleting from the log would make every other claim about it worth
    // less, so the answer to "did you edit my history" has to be a flat no.
    const after = await client!.query('select seq, payload from events where run_id = $1 order by seq', [runId]);
    expect(after.rows).toEqual(before.rows);
    // Including the reference itself, which now points at nothing — that IS what
    // deleting the bytes means, and hiding it would be the edit we just refused to make.
    expect(JSON.stringify(after.rows)).toContain(ref);
  });

  test('bytes another run also cites are kept, because they are the same bytes', async () => {
    if (withDb()) return;
    // Content addressing means two runs with identical output share one file. Deleting
    // everything the forgotten run cites would silently break a run nobody asked about,
    // and it would surface much later as an evidence page whose hashes do not resolve —
    // exactly the state this feature exists to make legible.
    const shared = await put(root, `two runs produced this ${randomUUID()}`);
    const mine = await put(root, `only mine ${randomUUID()}`);
    const forgotten = await runCiting([shared, mine]);
    await runCiting([shared]);

    const tomb = await forgetRun(client!, { runId: forgotten, requestedBy: 'divy97', blobRoot: root });

    expect(tomb.removed).toBe(1);
    await expect(get(root, mine)).rejects.toThrow();
    expect((await get(root, shared)).toString()).toContain('two runs produced this');
  });

  test('a blob shared only with an already-forgotten run does go', async () => {
    if (withDb()) return;
    // The other half of the same rule: "somebody still needs these" must not be
    // satisfied by a run that has itself been deleted, or the last citation would
    // preserve bytes nobody can see forever.
    const shared = await put(root, `both of these are going ${randomUUID()}`);
    const first = await runCiting([shared]);
    const second = await runCiting([shared]);

    await forgetRun(client!, { runId: first, requestedBy: 'divy97', blobRoot: root });
    expect((await get(root, shared)).toString()).toContain('both of these are going');

    await forgetRun(client!, { runId: second, requestedBy: 'divy97', blobRoot: root });
    await expect(get(root, shared)).rejects.toThrow();
  });

  test('forgetting twice does not rewrite who asked, or when', async () => {
    if (withDb()) return;
    const ref = await put(root, `once ${randomUUID()}`);
    const runId = await runCiting([ref]);

    const first = await forgetRun(client!, { runId, requestedBy: 'divy97', blobRoot: root });
    const again = await forgetRun(client!, { runId, requestedBy: 'somebody-else', blobRoot: root });

    expect(again).toEqual(first);
    expect(again.requestedBy).toBe('divy97');
  });

  test('a run nobody forgot has no tombstone, so the page renders normally', async () => {
    if (withDb()) return;
    expect(await tombstoneFor(client!, await runCiting([]))).toBeNull();
  });
});
