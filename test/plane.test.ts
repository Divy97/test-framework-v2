// The trust boundary that replaces topology, against a real database.
//
// Locally, "one writer" is a fact about deployment: one process, one machine (ADR-0009).
// Hosted, that mechanism is gone and the rule has to be a check — so every test here is
// an attempt to write somebody else's evidence, and the assertion is that it fails and
// leaves nothing behind. A boundary tested with a mocked `query` would be a boundary
// asserted against a fixture of my own writing; these run the SQL that will run.
//
// Skips loudly without a database, for the reason `store.test.ts` gives: a suite that
// silently drops its only coverage of an authorization rule is the false green this
// project exists to refuse.

import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type pg from 'pg';
import type { RunEvent } from '../src/events.js';
import { digest, get } from '../src/blobs.js';
import type { ArtifactRef } from '../src/events.js';
import { enqueueJob, pairRunner, revokeRunner, type Runner } from '../src/plane.js';
import { runnerRoutes } from '../src/runner-api.js';
import { connect } from '../src/store.js';

/** One blob root for the file, made on demand so a run with no upload makes no directory. */
let blobs: string | null = null;
const blobRoot = (): string => (blobs ??= mkdtempSync(join(tmpdir(), 'engine-plane-blobs-')));

let client: pg.Client | null = null;
let why = '';

/** Every row this file makes, so it cleans up after itself in somebody's dev database. */
const madeRunners: string[] = [];
const madeRuns: string[] = [];

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    why = 'DATABASE_URL is not set (copy .env.example to .env and `docker compose up -d`)';
    return;
  }
  try {
    const candidate = connect();
    await candidate.connect();
    await candidate.query('select 1 from runners limit 1');
    await candidate.query('select 1 from jobs limit 1');
    client = candidate;
  } catch (error) {
    why = `no usable database: ${String((error as Error).message ?? error)} — run \`npm run db:schema\``;
  }
});

afterAll(async () => {
  if (client) {
    await client.query('delete from events where run_id = any($1)', [madeRuns]).catch(() => {});
    await client.query('delete from run_projection where run_id = any($1)', [madeRuns]).catch(() => {});
    await client.query('delete from jobs where run_id = any($1)', [madeRuns]).catch(() => {});
    await client.query('delete from runners where id = any($1)', [madeRunners]).catch(() => {});
  }
  await client?.end();
  if (blobs) rmSync(blobs, { recursive: true, force: true });
});

/** A fresh installation id per test, so nothing here can claim another test's work. */
const installation = () => Math.floor(Math.random() * 1_000_000_000) + 1;

const pair = async (installationId: number, name = 'laptop') => {
  const { runner, token } = await pairRunner(client!, { installationId, name });
  madeRunners.push(runner.id);
  return { runner, token };
};

const queue = async (installationId: number) => {
  const runId = await enqueueJob(client!, {
    installationId,
    repo: 'o/r',
    intake: { source: 'github_issue', thread_ref: 'o/r#1' },
  });
  madeRuns.push(runId);
  return runId;
};

/** Drive the routes directly: the contract is the `Route`, not a socket. */
const call = async (
  token: string | undefined,
  method: string,
  path: string,
  options: { body?: unknown; raw?: Buffer; query?: string } = {},
) => {
  const route = runnerRoutes({ client: client!, blobRoot: blobRoot() });
  const text = options.body === undefined ? '' : JSON.stringify(options.body);
  const response = await route({
    method,
    path,
    query: new URLSearchParams(options.query ?? ''),
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    body: async () => text,
    // The ceiling is the ROUTE's to choose, so the fake honours it the way the server
    // does: over the limit is `null`, never a truncated buffer.
    raw: async (limit = 256 * 1024) => {
      const bytes = options.raw ?? Buffer.from(text);
      return bytes.length > limit ? null : bytes;
    },
  });
  const body = response?.body;
  return {
    status: response?.status ?? 0,
    body: body ? (JSON.parse(body.toString()) as Record<string, unknown>) : {},
  };
};

const event = (runId: string, seq: number, text = 'the shipped filter returns everything'): RunEvent =>
  ({
    run_id: runId,
    seq,
    ts: new Date().toISOString(),
    type: 'RUN_REQUESTED',
    payload: { v: 1, source: 'github_issue', thread_ref: 'o/r#1', raw_text: text },
  }) as RunEvent;

const skipped = (): boolean => {
  if (client) return false;
  expect.fail(`the runner boundary was NOT verified: ${why}`);
};

describe('a machine has to be paired to say anything', () => {
  test('an unknown token is nobody', async () => {
    if (skipped()) return;
    const response = await call('tfr_not-a-real-token', 'GET', '/runner/jobs');
    expect(response.status).toBe(401);
  });

  test('a missing header is nobody, and says how to be somebody', async () => {
    if (skipped()) return;
    const response = await call(undefined, 'GET', '/runner/jobs');
    expect(response.status).toBe(401);
    expect(String(response.body['error'])).toContain('Authorization: Bearer');
  });

  test('a revoked runner stops being able to write, and stays in the table', async () => {
    if (skipped()) return;
    const id = installation();
    const { runner, token } = await pair(id);
    expect((await call(token, 'GET', '/runner/jobs')).status).toBe(204);

    expect(await revokeRunner(client!, runner.id, runner.installationId)).toBe(true);
    expect((await call(token, 'GET', '/runner/jobs')).status).toBe(401);

    // The row survives: the events it wrote are in the log forever, and a reader
    // asking "who wrote this" deserves an answer after the laptop is sold.
    const { rows } = await client!.query('select revoked_at from runners where id = $1', [runner.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked_at).not.toBeNull();
  });

  test('a runner belonging to another installation cannot be revoked by id', async () => {
    // Found by review after it shipped. The route authorized the REPOSITORY in its path
    // and then passed the runner id from the URL straight through, so anyone with access
    // to any repository could revoke somebody else's machine — a cross-tenant denial of
    // service, and the same shape as the run-id checks that were done correctly two
    // routes away.
    //
    // Asserted here rather than only at the route, because the fix is that the data
    // layer requires the installation: a future caller cannot forget an argument it has
    // to supply.
    const victim = await pair(installation(), 'somebody else s laptop');
    const attacker = installation();

    expect(await revokeRunner(client!, victim.runner.id, attacker)).toBe(false);

    const { rows } = await client!.query('select revoked_at from runners where id = $1', [victim.runner.id]);
    expect(rows[0].revoked_at).toBeNull();
    // And it still works, which is what makes the refusal above about ownership rather
    // than about the runner being unrevokable.
    expect((await call(victim.token, 'GET', '/runner/jobs')).status).toBe(204);
  });

  test('polling stamps presence, so "nobody is online" is different from "nobody is paired"', async () => {
    if (skipped()) return;
    const { runner, token } = await pair(installation());
    const before = await client!.query('select last_seen from runners where id = $1', [runner.id]);
    expect(before.rows[0].last_seen).toBeNull();

    await call(token, 'GET', '/runner/jobs');
    const after = await client!.query('select last_seen from runners where id = $1', [runner.id]);
    expect(after.rows[0].last_seen).not.toBeNull();
  });
});

describe('work goes to the machine it was dispatched to', () => {
  test('a runner claims its own installation s job and nobody else s', async () => {
    if (skipped()) return;
    const mine = installation();
    const theirs = installation();
    const runId = await queue(mine);
    await queue(theirs);

    const { token } = await pair(mine);
    const claimed = await call(token, 'GET', '/runner/jobs');
    expect(claimed.status).toBe(200);
    expect(claimed.body['runId']).toBe(runId);
    expect(claimed.body['repo']).toBe('o/r');

    // And that is all there was for it. The other installation's job is still queued,
    // which is the assertion that matters: a claim is scoped, not first-come.
    expect((await call(token, 'GET', '/runner/jobs')).status).toBe(204);
  });

  test('two runners on one installation never take the same job', async () => {
    if (skipped()) return;
    const id = installation();
    const runId = await queue(id);
    const a = await pair(id, 'a');
    const b = await pair(id, 'b');

    const [first, second] = await Promise.all([
      call(a.token, 'GET', '/runner/jobs'),
      call(b.token, 'GET', '/runner/jobs'),
    ]);
    const claims = [first, second].filter((r) => r.status === 200);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.body['runId']).toBe(runId);
  });
});

describe('the log admits one writer per run, and it is a check now', () => {
  test('the dispatched runner appends, and the events are in the log', async () => {
    if (skipped()) return;
    const id = installation();
    const runId = await queue(id);
    const { token } = await pair(id);
    await call(token, 'GET', '/runner/jobs');

    const response = await call(token, 'POST', `/runner/runs/${runId}/events`, {
      body: { events: [event(runId, 1), event(runId, 2)] },
    });
    expect(response.status).toBe(200);
    expect(response.body['appended']).toBe(2);

    const { rows } = await client!.query('select seq from events where run_id = $1 order by seq', [runId]);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
  });

  test('ANOTHER runner is refused, and writes nothing', async () => {
    if (skipped()) return;
    // The test this whole module exists for. Same installation — so it is not enough to
    // check the tenant — and a valid, unrevoked token.
    const id = installation();
    const runId = await queue(id);
    const mine = await pair(id, 'mine');
    const theirs = await pair(id, 'theirs');
    await call(mine.token, 'GET', '/runner/jobs');

    const response = await call(theirs.token, 'POST', `/runner/runs/${runId}/events`, {
      body: { events: [event(runId, 1, 'forged')] },
    });
    expect(response.status).toBe(403);
    expect(String(response.body['error'])).toContain('another runner');

    const { rows } = await client!.query('select count(*)::int as n from events where run_id = $1', [runId]);
    expect(rows[0].n).toBe(0);
  });

  test('a run nobody was dispatched is not a run', async () => {
    if (skipped()) return;
    const { token } = await pair(installation());
    const invented = randomUUID();
    const response = await call(token, 'POST', `/runner/runs/${invented}/events`, {
      body: { events: [event(invented, 1)] },
    });
    expect(response.status).toBe(404);
  });
});

  test('an accepted batch reaches the dashboard, not just the log', async () => {
    // Found by running a runner against a plane: 124 events landed and `run_projection`
    // was empty, so the completed run 404'd on the screen that IS the product. The log
    // was perfect and invisible.
    //
    // Asserted on the ROW rather than on a call, because "the projection was updated" is
    // the claim; whether it happened in the route or a job somewhere is not.
    const id = installation();
    const runId = await queue(id);
    const { token } = await pair(id);
    await call(token, 'GET', '/runner/jobs');

    await call(token, 'POST', `/runner/runs/${runId}/events`, {
      body: { events: [event(runId, 1)] },
    });

    const { rows } = await client!.query('select repo, status from run_projection where run_id = $1', [runId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].repo).toBe('o/r');
  });

  test('a refused batch projects nothing, because nothing was recorded', async () => {
    // The control. Projecting unconditionally would rebuild a row for a run this runner
    // was never allowed to write, which is the authorization hole one layer down.
    const id = installation();
    const runId = await queue(id);
    const mine = await pair(id, 'mine');
    const theirs = await pair(id, 'theirs');
    await call(mine.token, 'GET', '/runner/jobs');

    await call(theirs.token, 'POST', `/runner/runs/${runId}/events`, {
      body: { events: [event(runId, 1)] },
    });

    const { rows } = await client!.query('select 1 from run_projection where run_id = $1', [runId]);
    expect(rows).toHaveLength(0);
  });

describe('an append is idempotent, and history is not', () => {
  test('replaying the identical batch appends nothing and succeeds', async () => {
    if (skipped()) return;
    // A runner on a home connection retries. If a retry were an error, operators would
    // stop retrying, and the events lost would be the evidence.
    const id = installation();
    const runId = await queue(id);
    const { token } = await pair(id);
    await call(token, 'GET', '/runner/jobs');
    const batch = { events: [event(runId, 1), event(runId, 2)] };

    expect((await call(token, 'POST', `/runner/runs/${runId}/events`, { body: batch })).body['appended']).toBe(2);
    const again = await call(token, 'POST', `/runner/runs/${runId}/events`, { body: batch });
    expect(again.status).toBe(200);
    expect(again.body['appended']).toBe(0);

    const { rows } = await client!.query('select count(*)::int as n from events where run_id = $1', [runId]);
    expect(rows[0].n).toBe(2);
  });

  test('the same seq with different bytes is refused, and the original stands', async () => {
    if (skipped()) return;
    // The append-only claim, made real against the one participant with a legitimate
    // reason to write here. Without this, "immutable" means "nobody has tried yet".
    const id = installation();
    const runId = await queue(id);
    const { token } = await pair(id);
    await call(token, 'GET', '/runner/jobs');
    await call(token, 'POST', `/runner/runs/${runId}/events`, { body: { events: [event(runId, 1, 'as reported')] } });

    const rewrite = await call(token, 'POST', `/runner/runs/${runId}/events`, {
      body: { events: [event(runId, 1, 'something else entirely')] },
    });
    expect(rewrite.status).toBe(409);

    const { rows } = await client!.query('select payload from events where run_id = $1 and seq = 1', [runId]);
    expect(JSON.stringify(rows[0].payload)).toContain('as reported');
    expect(JSON.stringify(rows[0].payload)).not.toContain('something else entirely');
  });

  test('an event naming a different run is refused before it is written', async () => {
    if (skipped()) return;
    // The batch is authorized once, by path. Without this check a single authorized
    // batch could carry events for any run in the database.
    const id = installation();
    const runId = await queue(id);
    const elsewhere = await queue(id);
    const { token } = await pair(id);
    await call(token, 'GET', '/runner/jobs');

    const response = await call(token, 'POST', `/runner/runs/${runId}/events`, {
      body: { events: [event(elsewhere, 1)] },
    });
    expect(response.status).toBe(400);
    const { rows } = await client!.query('select count(*)::int as n from events where run_id = $1', [elsewhere]);
    expect(rows[0].n).toBe(0);
  });

  test.each([
    ['not an object', { events: 'nope' }],
    ['empty', { events: [] }],
    ['no seq', { events: [{ run_id: 'x', type: 'RUN_REQUESTED', ts: 't', payload: {} }] }],
    ['a fractional seq', { events: [{ run_id: 'x', seq: 1.5, type: 'X', ts: 't', payload: {} }] }],
    ['a payload that is not an object', { events: [{ run_id: 'x', seq: 1, type: 'X', ts: 't', payload: 'no' }] }],
  ])('a malformed batch (%s) is refused rather than folded later', async (_name, body) => {
    if (skipped()) return;
    const id = installation();
    const runId = await queue(id);
    const { token } = await pair(id);
    await call(token, 'GET', '/runner/jobs');
    const response = await call(token, 'POST', `/runner/runs/${runId}/events`, { body });
    expect(response.status).toBe(400);
  });
});

describe('blobs cross the boundary, or do not land at all (9b)', () => {
  /** A dispatched run, which is the only thing a blob can be uploaded under. */
  const dispatched = async () => {
    const id = installation();
    const runId = await queue(id);
    const { token } = await pair(id);
    await call(token, 'GET', '/runner/jobs');
    return { runId, token, id };
  };

  test('bytes upload under the run that owns them, and are readable by ref', async () => {
    if (skipped()) return;
    const { runId, token } = await dispatched();
    const bytes = Buffer.from('not ok 3 - totals\n  expected 300, got 297\n');
    const ref = digest(bytes);

    const response = await call(token, 'PUT', `/runner/runs/${runId}/blobs/${ref}`, { raw: bytes });
    expect(response.status).toBe(201);
    expect(response.body['ref']).toBe(ref);

    // Through `get`, which re-verifies the digest on read — so this asserts the bytes
    // are both present and the bytes that ref names.
    expect((await get(blobRoot(), ref)).toString()).toContain('expected 300, got 297');
  });

  test('a screenshot survives, which the string body would have destroyed', async () => {
    if (skipped()) return;
    // The reason `Route` grew a bytes body at all. Every value 0x00–0xFF, which is what
    // a PNG is and what UTF-8 decoding silently rewrites — the old `body()` would have
    // hashed to something else and been refused as a forgery.
    const { runId, token } = await dispatched();
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, n) => n));
    const ref = digest(bytes);

    expect((await call(token, 'PUT', `/runner/runs/${runId}/blobs/${ref}`, { raw: bytes })).status).toBe(201);
    expect(Buffer.compare(await get(blobRoot(), ref), bytes)).toBe(0);
  });

  test('bytes that are not what they claim to be are refused, and nothing is written', async () => {
    if (skipped()) return;
    const { runId, token } = await dispatched();
    const honest = Buffer.from('what actually happened');
    const lie = digest(Buffer.from('what somebody would rather had happened'));

    const response = await call(token, 'PUT', `/runner/runs/${runId}/blobs/${lie}`, { raw: honest });
    expect(response.status).toBe(400);

    // Neither name resolves: not the claimed one, and not the true one either. Storing
    // first and refusing afterwards would leave the honest bytes on our disk under a
    // name nobody asked for.
    await expect(get(blobRoot(), lie)).rejects.toThrow();
    await expect(get(blobRoot(), digest(honest))).rejects.toThrow();
  });

  test('a blob for somebody else s run is refused', async () => {
    if (skipped()) return;
    const id = installation();
    const runId = await queue(id);
    const mine = await pair(id, 'mine');
    const theirs = await pair(id, 'theirs');
    await call(mine.token, 'GET', '/runner/jobs');

    const bytes = Buffer.from('planted');
    const response = await call(theirs.token, 'PUT', `/runner/runs/${runId}/blobs/${digest(bytes)}`, { raw: bytes });
    expect(response.status).toBe(403);
    await expect(get(blobRoot(), digest(bytes))).rejects.toThrow();
  });

  test('an oversized body says it is too large, rather than failing its digest', async () => {
    if (skipped()) return;
    // The failure this closes: the old reader truncated silently at its ceiling, so an
    // oversized upload arrived as a digest mismatch — an operational limit wearing a
    // tamper signal's clothes, on the one check that is supposed to mean tampering.
    const { runId, token } = await dispatched();
    const bytes = Buffer.alloc(17 * 1024 * 1024, 7);
    const response = await call(token, 'PUT', `/runner/runs/${runId}/blobs/${digest(bytes)}`, { raw: bytes });
    expect(response.status).toBe(413);
    expect(String(response.body['error'])).toContain('may not exceed');
  });

  test('a re-upload is a no-op that succeeds, because a retry must not be an error', async () => {
    if (skipped()) return;
    const { runId, token } = await dispatched();
    const bytes = Buffer.from('the same output twice');
    const ref = digest(bytes) as ArtifactRef;

    expect((await call(token, 'PUT', `/runner/runs/${runId}/blobs/${ref}`, { raw: bytes })).status).toBe(201);
    expect((await call(token, 'PUT', `/runner/runs/${runId}/blobs/${ref}`, { raw: bytes })).status).toBe(201);
    expect((await get(blobRoot(), ref)).toString()).toBe('the same output twice');
  });

  test('a ref that is not content-addressed is not a route at all', async () => {
    if (skipped()) return;
    const { runId, token } = await dispatched();
    const response = await call(token, 'PUT', `/runner/runs/${runId}/blobs/sha256:nope`, {
      raw: Buffer.from('x'),
    });
    expect(response.status).toBe(404);
  });
});
