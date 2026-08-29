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

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type pg from 'pg';
import type { RunEvent } from '../src/events.js';
import { enqueueJob, pairRunner, revokeRunner, type Runner } from '../src/plane.js';
import { runnerRoutes } from '../src/runner-api.js';
import { connect } from '../src/store.js';

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
    await client.query('delete from jobs where run_id = any($1)', [madeRuns]).catch(() => {});
    await client.query('delete from runners where id = any($1)', [madeRunners]).catch(() => {});
  }
  await client?.end();
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
  options: { body?: unknown; query?: string } = {},
) => {
  const route = runnerRoutes({ client: client! });
  const response = await route({
    method,
    path,
    query: new URLSearchParams(options.query ?? ''),
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    body: async () => (options.body === undefined ? '' : JSON.stringify(options.body)),
  });
  return {
    status: response?.status ?? 0,
    body: response?.body ? (JSON.parse(response.body) as Record<string, unknown>) : {},
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

    await revokeRunner(client!, runner.id);
    expect((await call(token, 'GET', '/runner/jobs')).status).toBe(401);

    // The row survives: the events it wrote are in the log forever, and a reader
    // asking "who wrote this" deserves an answer after the laptop is sold.
    const { rows } = await client!.query('select revoked_at from runners where id = $1', [runner.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked_at).not.toBeNull();
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
