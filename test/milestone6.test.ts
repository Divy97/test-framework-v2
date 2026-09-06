// Milestone 6: the onboarding gate, the installation record, and the read model.
//
// Three of these cover claims that are silent by construction. `intake()` gained a second
// arm, and an arm that mapped the wrong actions would quietly resurrect a repository the
// user had just removed. The onboarding gate is a NEGATIVE: nothing happens, and the only
// way to tell "we refused to start a run" from "the wiring is broken" is to assert the run
// function was never called AND the comment was. And 6c's done-when is a property nobody
// can see by reading — that dropping the projection and replaying produces byte-identical
// rows — so it is asserted here rather than claimed in a README.
//
// Group 4 needs a real database and SKIPS without one, naming the table that is missing.
// A suite that silently drops its only coverage of `installations`, `run_usage` and
// `run_projection` is the false green this project exists to refuse.

import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { confidence } from '../src/confidence.js';
import type { RunEvent } from '../src/events.js';
import { demoRunEvents } from '../src/fixtures/demo-run.js';
import { fold } from '../src/fold.js';
import { intake } from '../src/github.js';
import {
  listInstallations,
  loadInstallation,
  recordInstallation,
  removeInstallation,
} from '../src/installations.js';
import { projectRun, splitThreadRef } from '../src/projection.js';
import { readRunRow, readUsage, rebuildProjection, saveUsage } from '../src/readmodel.js';
import type { RunRequest, RunResult } from '../src/run.js';
import { serve, type Config, type Service } from '../src/serve.js';
import type pg from 'pg';
import { appendEvent, connect, type Db } from '../src/store.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SECRET = 'a-webhook-secret';

const dirs: string[] = [];
const services: Service[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-m6-'));
  dirs.push(dir);
  return dir;
};

const config = (over: Partial<Config> = {}): Config => ({
  appId: '123456',
  privateKeyPem: PEM,
  webhookSecret: SECRET,
  image: 'sandbox:test',
  agentImage: 'agent:test',
  blobRoot: join(temp(), 'blobs'),
  webhookPort: 0,
  eventsPort: 0,
  loop: { provider: 'openrouter', apiKey: 'sk-or-test', model: 'moonshotai/kimi-k2-thinking', effort: 'low' },
  ...over,
});

/** A `Db` that answers only what the service actually asks it. */
/**
 * A `Db` that answers per QUERY rather than one shape for everything.
 *
 * The issue path asks two questions now — is this repository still installed (M6a's third
 * done-when), and does it have an approved recipe — and a single-shape fake makes them
 * indistinguishable, so a test about the recipe gate silently exercises the installation
 * gate instead and passes for the wrong reason.
 */
const fakeClient = (options: { installed?: boolean; recipe?: unknown } = {}) => {
  const installed = options.installed ?? true;
  return {
    query: vi.fn(async (sql: string) => {
      const rows =
        typeof sql === 'string' && sql.includes('from installations')
          ? installed
            ? [{ repo: 'o/r', installation_id: 987654, account: 'o', connected_at: new Date(), removed_at: null }]
            : []
          : typeof sql === 'string' && sql.includes('from recipes')
            ? options.recipe === undefined
              ? []
              : [{ recipe: options.recipe }]
            : [];
      return { rows, rowCount: rows.length };
    }),
  } as unknown as Db;
};

const delivery = (issueNumber = 41) => ({
  action: 'opened',
  issue: {
    number: issueNumber,
    title: 'The shipped filter returns everything',
    body: '/api/orders?status=shipped returns every order, including pending ones.',
    html_url: `https://github.com/o/r/issues/${issueNumber}`,
  },
  repository: { full_name: 'o/r', default_branch: 'main' },
  installation: { id: 987654 },
});

/** POST a delivery the way GitHub does: raw bytes, signed. */
const deliver = async (port: number, payload: unknown, options: { secret?: string; event?: string } = {}) => {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', options.secret ?? SECRET).update(body).digest('hex')}`;
  return fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': options.event ?? 'issues',
      'x-hub-signature-256': signature,
    },
    body,
  });
};

const ok = (runId: string) => ({ runId, state: { status: 'solved' } }) as unknown as RunResult;

const RECIPE = { install: 'npm ci', services: [{ name: 'web', command: 'node s.mjs', port: 8080 }], test: 'npm test' };

// ---------------------------------------------------------------------------------------
// 1 · intake maps installation deliveries
// ---------------------------------------------------------------------------------------

describe('intake tells an installation from an issue, and refuses the rest', () => {
  const installed = {
    action: 'created',
    installation: { id: 987654, account: { login: 'acme' } },
    repositories: [{ full_name: 'acme/store' }, { full_name: 'acme/api' }],
  };

  it('records what the App was installed on, and by whom', () => {
    const mapped = intake('installation', installed)!;
    expect(mapped).toEqual({
      kind: 'installation',
      action: 'added',
      // WHICH event this was, and it decides behaviour rather than describing it: an
      // `app`-scoped removal is an uninstall, where the installation no longer exists to
      // be asked about, and a `repositories`-scoped one is a selection change, where it
      // does. Routing the first through the second meant an uninstall removed nothing.
      scope: 'app',
      installationId: 987654,
      account: 'acme',
      repos: ['acme/store', 'acme/api'],
    });
  });

  it('maps an uninstall to `removed`, because a delete and an install are not the same fact', () => {
    const mapped = intake('installation', { ...installed, action: 'deleted' })!;
    if (mapped.kind !== 'installation') throw new Error('an installation delivery must map to an installation');
    expect(mapped.action).toBe('removed');
    // And scoped to the APP, not to a selection change. The hosted plane branches on
    // this: an uninstall is swept directly, because minting a token for an installation
    // that no longer exists 404s, and asking anyway meant nothing was ever marked removed.
    expect(mapped.scope).toBe('app');
    // The repository list still travels: uninstalling has to name what it took away, or
    // the local path's `removeInstallation` has nothing to mark.
    expect(mapped.repos).toEqual(['acme/store', 'acme/api']);
  });

  it('reads the two per-repository fields GitHub actually sends', () => {
    // `installation_repositories` does not carry `repositories` at all — it carries
    // `repositories_added` and `repositories_removed`, and reading the wrong one produces
    // an intake naming zero repositories that looks like a delivery we simply ignored.
    const added = intake('installation_repositories', {
      action: 'added',
      installation: { id: 987654, account: { login: 'acme' } },
      repositories_added: [{ full_name: 'acme/web' }],
      repositories_removed: [],
    })!;
    if (added.kind !== 'installation') throw new Error('unreachable');
    expect(added.action).toBe('added');
    expect(added.repos).toEqual(['acme/web']);

    const removed = intake('installation_repositories', {
      action: 'removed',
      installation: { id: 987654, account: { login: 'acme' } },
      repositories_added: [],
      repositories_removed: [{ full_name: 'acme/web' }],
    })!;
    if (removed.kind !== 'installation') throw new Error('unreachable');
    expect(removed.action).toBe('removed');
    expect(removed.repos).toEqual(['acme/web']);
  });

  it('refuses the actions that say nothing about which repositories we hold', () => {
    // The refusals are the load-bearing half. `suspend` and `new_permissions_accepted` are
    // real deliveries about a live installation, and mapping either one to `added` would
    // re-record — and so RESURRECT — a repository the user had just removed, using
    // whatever `repositories` list happened to ride along.
    expect(intake('installation', { ...installed, action: 'suspend' })).toBeNull();
    expect(intake('installation', { ...installed, action: 'unsuspend' })).toBeNull();
    expect(intake('installation', { ...installed, action: 'new_permissions_accepted' })).toBeNull();
  });

  it('refuses a delivery it cannot key by repository or attribute to an account', () => {
    // A row with no account is a row the repositories page cannot label.
    //
    // An add naming NOTHING used to be refused here too, and M9 reversed that: the
    // repository list is now reconciled against GitHub rather than accumulated from
    // deltas, so a delivery with an empty list still matters — it says this installation
    // changed, go and look. GitHub sends exactly that when a selection widens to "all
    // repositories", and refusing it was what kept a hosted plane's list stale.
    expect(
      intake('installation_repositories', {
        action: 'added',
        installation: { id: 987654, account: { login: 'acme' } },
        repositories_added: [],
      })?.kind,
    ).toBe('installation');
    expect(intake('installation', { ...installed, installation: { id: 987654 } })).toBeNull();
    expect(intake('installation', { ...installed, installation: { id: 987654, account: {} } })).toBeNull();
    // And an entry with no `full_name` is dropped rather than stored under a placeholder:
    // a repository we cannot name is one we cannot key a recipe by.
    const partial = intake('installation', { ...installed, repositories: [{ id: 5 }, { full_name: 'acme/api' }] })!;
    if (partial.kind !== 'installation') throw new Error('unreachable');
    expect(partial.repos).toEqual(['acme/api']);
  });

  it('still maps an issue to an issue — the discriminant is the whole point', () => {
    // Two shapes now leave this function, and every consumer switches on `kind`. An arm
    // that swallowed `issues` would stop every run in the product with no error anywhere.
    const mapped = intake('issues', delivery())!;
    expect(mapped.kind).toBe('issue');
    if (mapped.kind !== 'issue') throw new Error('unreachable');
    expect(mapped.repo).toBe('o/r');
    expect(mapped.issueNumber).toBe(41);
    expect(mapped.event.thread_ref).toBe('o/r#41');
  });
});

// ---------------------------------------------------------------------------------------
// 2 · the onboarding gate (6a's done-when)
// ---------------------------------------------------------------------------------------

describe('an un-onboarded repository gets an answer, not a run', () => {
  it('starts ZERO runs and says why, over real HTTP', async () => {
    // The bug this exists for: an issue on a repository with no approved recipe used to
    // start a run anyway. Nothing boots with `recipe: null`, so the overwhelmingly likely
    // outcome was a Tier 3 — "we could not reproduce this" — written onto a stranger's
    // issue and into an append-only log, about a bug we never had the means to look at.
    // A user's first experience of the product was a wrong answer, and a confident one.
    //
    // Both halves are asserted because either alone is satisfied by a broken service: a
    // service that dropped the delivery on the floor also starts zero runs.
    const runs: RunRequest[] = [];
    const comments: { repo: string; issueNumber: number; body: string; installationId: number }[] = [];
    const service = await serve({
      config: config(),
      client: fakeClient(),
      log: () => {},
      run: async (request) => {
        runs.push(request);
        return ok('never');
      },
      comment: async (repo, issueNumber, body, installationId) => {
        comments.push({ repo, issueNumber, body, installationId });
      },
    });
    services.push(service);

    const response = await deliver(service.webhookPort, delivery());
    expect(response.status).toBe(202);
    await service.drain();

    expect(runs).toEqual([]);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.repo).toBe('o/r');
    expect(comments[0]!.issueNumber).toBe(41);
    // The installation id has to survive to here, or the real `comment` cannot mint a
    // token and the one message this product owes the user is never delivered.
    expect(comments[0]!.installationId).toBe(987654);
    expect(comments[0]!.body).toMatch(/not onboarded/i);
    expect(comments[0]!.body).toMatch(/no run was started/i);
    // It names what has to happen next. A message about our own gap that leaves the
    // reader with no action is the open-ended update this project refuses.
    expect(comments[0]!.body).toMatch(/approve a recipe/i);
  });

  it('starts the run once a recipe exists, so the gate is a gate and not a wall', async () => {
    const runs: RunRequest[] = [];
    const comments: string[] = [];
    const service = await serve({
      config: config(),
      client: fakeClient({ recipe: RECIPE }),
      log: () => {},
      run: async (request) => {
        runs.push(request);
        return ok('run-1');
      },
      comment: async (_repo, _issueNumber, body) => {
        comments.push(body);
      },
    });
    services.push(service);

    await deliver(service.webhookPort, delivery());
    await service.drain();

    expect(runs).toHaveLength(1);
    expect(runs[0]!.intake.repo).toBe('o/r');
    expect(runs[0]!.recipe).toMatchObject({ install: 'npm ci' });
    // And no un-onboarded message: telling a user their repository is not set up while
    // starting a run on it is worse than either outcome on its own.
    expect(comments).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// 3 · the read model, as a pure function of the log
// ---------------------------------------------------------------------------------------

/** The demo run, re-keyed and given the GitHub thread ref `intake()` writes. */
const githubRun = (runId: string): RunEvent[] =>
  demoRunEvents.map((event) =>
    event.seq === 1 && event.type === 'RUN_REQUESTED'
      ? {
          ...event,
          run_id: runId,
          payload: { ...event.payload, source: 'github_issue', thread_ref: 'demo-org/demo-app#41' },
        }
      : { ...event, run_id: runId },
  );

describe('a run row is derived from its events and authors nothing', () => {
  const runId = demoRunEvents[0]!.run_id;

  it('splits the thread ref, and takes every score from the projection that owns it', () => {
    const events = githubRun(runId);
    const row = projectRun(events)!;
    const score = confidence(fold(events));

    // `owner/repo#41` is the only place a run's repository and issue number exist — the
    // log carries no other record of either, which is why the split is a column here.
    expect(row.repo).toBe('demo-org/demo-app');
    expect(row.issue_number).toBe(41);
    expect(row.run_id).toBe(runId);
    expect(row.status).toBe('pr_opened');
    expect(row.last_seq).toBe(8);

    // Copied, never recomputed. A second definition of the tier living in the read model
    // would be free to disagree with `confidence()` — the exact failure ADR-0009 exists
    // about, and one this codebase has already been bitten by twice.
    expect(row.tier).toBe(score.tier);
    expect(row.confidence).toBe(score.score);
    expect(row.ceiling).toBe(score.ceiling);
    expect(row.scoring).toBe(score.scoring);
    expect(row.regression).toBe(fold(events).regression);
    // The fixture is a genuine reproduction, so a row scoring zero would mean the fold
    // and this projection had come apart rather than that the demo changed.
    expect(row.tier).toBe(1);
    expect(row.confidence).toBeGreaterThan(0);

    // `pr_url` is not in the log. PR_OPENED carries the repo and the number, which is what
    // a link is built from — deriving it keeps the rule that every column is recomputable.
    expect(row.pr_url).toBe('https://github.com/demo-org/demo-app/pull/42');

    // Off the events, not off the clock. A rebuild months later has to produce the same
    // bytes, and `now()` would not.
    expect(row.started_at).toBe(events[0]!.ts);
    // No RUN_ENDED in this fixture, so nothing has said the run finished.
    expect(row.ended_at).toBeNull();
  });

  it('degrades a thread ref it cannot parse rather than losing the run', () => {
    // The demo fixture's own ref is a Slack one (`C0DEMO/p175…`), and a projection that
    // threw on it would make every pre-GitHub run permanently invisible — which is
    // indistinguishable from a run that never happened, and the log is what says which.
    const row = projectRun(demoRunEvents)!;
    expect(row.repo).toBe('(unknown)');
    expect(row.issue_number).toBe(0);
    expect(row.run_id).toBe(runId);

    expect(splitThreadRef(null)).toEqual({ repo: '(unknown)', issue: 0 });
    expect(splitThreadRef('')).toEqual({ repo: '(unknown)', issue: 0 });
    expect(splitThreadRef('owner/repo')).toEqual({ repo: '(unknown)', issue: 0 });
    expect(splitThreadRef('owner/repo#not-a-number')).toEqual({ repo: '(unknown)', issue: 0 });
    expect(splitThreadRef('owner/repo#41')).toEqual({ repo: 'owner/repo', issue: 41 });
  });

  it('has no row for a run with no events', () => {
    // `rebuildProjection` reads run ids out of `events` and writes only what comes back,
    // so a null here is what stops an empty row being invented for a deleted run.
    expect(projectRun([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// 4 · against a real database, or skipped by name
// ---------------------------------------------------------------------------------------

/** The tables milestone 6 added, plus the one they are derived from. */
const TABLES = ['events', 'installations', 'run_usage', 'run_projection'] as const;

let client: pg.Pool | null = null;
let why = '';

/** Whatever the driver actually said, including the `AggregateError` it hides it in. */
const reason = (error: unknown): string => {
  const nested = (error as { errors?: unknown[] }).errors;
  if (Array.isArray(nested) && nested.length > 0) return nested.map((e) => reason(e)).join('; ');
  return String((error as Error)?.message || error);
};

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    why = 'DATABASE_URL is not set (copy .env.example to .env and `docker compose up -d`)';
    return;
  }
  let candidate: pg.Pool;
  try {
    candidate = connect();
  } catch (error) {
    // Unwrapped, because a refused TCP connection arrives as an `AggregateError` whose own
    // `message` is empty and whose `toString()` is the bare word `AggregateError`. Both
    // earlier forms produced a skip line that named nothing, which is the silent skip this
    // whole mechanism exists to prevent — the cause (`ECONNREFUSED ::1:5432`) is in
    // `.errors` and nowhere else.
    why = `no usable database: ${reason(error)} — is \`docker compose up -d\` running?`;
    return;
  }
  // Every table by name, one query each. A single probe would report whichever relation
  // Postgres happened to complain about first, and milestone 6 added three — so a schema
  // applied before this milestone must skip saying WHICH table is missing, not fail the
  // suite with a message about a column nobody has heard of.
  for (const table of TABLES) {
    try {
      await candidate.query(`select 1 from ${table} limit 1`);
    } catch (error) {
      why = `the \`${table}\` table is missing — run \`npm run db:schema\` (${reason(error)})`;
      await candidate.end();
      return;
    }
  }
  client = candidate;
});

afterAll(async () => {
  await client?.end();
});

describe('the installation record, against a real database', () => {
  it('round-trips, and a removal is a mark rather than a delete', async () => {
    if (!client) {
      console.log(`SKIPPED (installations): ${why}`);
      return;
    }
    const repo = `owner/repo-${randomUUID().slice(0, 8)}`;
    try {
      expect(await loadInstallation(client, repo)).toBeNull();

      await recordInstallation(client, { repo, installationId: 987654, account: 'acme' });
      const stored = (await loadInstallation(client, repo))!;
      expect(stored.repo).toBe(repo);
      // `bigint` arrives from node-postgres as a STRING. Untyped, it would be interpolated
      // into a token URL as one and every mint would 404 with a message that does not say
      // why, so the mapping is asserted rather than assumed.
      expect(stored.installationId).toBe(987654);
      expect(typeof stored.installationId).toBe('number');
      expect(stored.account).toBe('acme');
      expect(stored.removedAt).toBeNull();
      expect(new Date(stored.connectedAt).getTime()).toBeGreaterThan(0);
      expect((await listInstallations(client)).map((row) => row.repo)).toContain(repo);

      await removeInstallation(client, repo);
      // "We were installed and then removed" and "we have never heard of this repository"
      // are different answers to a delivery arriving, and only one is worth a message —
      // so the row stays and the reader stops seeing it.
      expect(await loadInstallation(client, repo)).toBeNull();
      expect((await listInstallations(client)).map((row) => row.repo)).not.toContain(repo);
      const { rows } = await client.query('select removed_at from installations where repo = $1', [repo]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.removed_at).not.toBeNull();

      // Reinstalling is ordinary, and it issues a NEW installation id. An insert would
      // collide on the primary key; an upsert that kept the old id would mint tokens for
      // an installation that no longer exists.
      await recordInstallation(client, { repo, installationId: 111222, account: 'acme-renamed' });
      const again = (await loadInstallation(client, repo))!;
      expect(again.removedAt).toBeNull();
      expect(again.installationId).toBe(111222);
      expect(again.account).toBe('acme-renamed');
    } finally {
      await client.query('delete from installations where repo = $1', [repo]);
    }
  });
});

describe('what a run cost, against a real database', () => {
  it('round-trips including the cache columns, which are the whole point of the table', async () => {
    if (!client) {
      console.log(`SKIPPED (run usage): ${why}`);
      return;
    }
    const runId = randomUUID();
    const row = {
      run_id: runId,
      phase: 'agent',
      turns: 12,
      input_tokens: 48_000,
      output_tokens: 3_100,
      cache_read_input_tokens: 120_000,
      cache_creation_input_tokens: 9_000,
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2-thinking',
    };
    try {
      await saveUsage(client, row);
      // 6d's done-when is "a real run's row matches what the provider billed, to the
      // token", and cached input is billed at a different rate — a row without these two
      // columns cannot be reconciled against a bill, which is the only thing this table
      // is for. They are also the columns most likely to be dropped as noise.
      // `n` defaults to 0 — see below for what it is for.
      expect(await readUsage(client, runId)).toEqual([{ ...row, n: 0 }]);

      // Re-saving the same phase replaces it. A run whose usage was written twice would
      // double the reported spend, and this table has no event log to reconcile against.
      await saveUsage(client, { ...row, output_tokens: 3_200 });
      const after = await readUsage(client, runId);
      expect(after).toHaveLength(1);
      expect(after[0]!.output_tokens).toBe(3_200);

      // AND THE SECOND AGENT PHASE IS A DIFFERENT ROW (M10, 10f). A run has two — the
      // repro agent and the fix agent — and both report `phase: 'agent'`. Keyed
      // `(run_id, phase)` the second landed on the first with a `do update`, so the repro
      // agent's spend was replaced rather than added and half the model bill vanished.
      // Wrong since this table was written, and invisible for as long as the only runs
      // anybody read closely were local ones.
      await saveUsage(client, { ...row, n: 1, turns: 5, output_tokens: 900 });
      const both = await readUsage(client, runId);
      expect(both).toHaveLength(2);
      expect(both.map((one) => [one.n, one.output_tokens])).toEqual([
        [0, 3_200],
        [1, 900],
      ]);
      // Numbers, not strings. `integer` is deliberate in the schema for exactly this:
      // node-postgres hands back `bigint` as text and every sum would silently concatenate.
      expect(typeof after[0]!.input_tokens).toBe('number');
    } finally {
      await client.query('delete from run_usage where run_id = $1', [runId]);
    }
  });
});

describe('the projection can be dropped and replayed', () => {
  it('rebuilds byte-identical rows, which is the claim the README rests on', async () => {
    if (!client) {
      console.log(`SKIPPED (projection rebuild): ${why}`);
      return;
    }
    const runId = randomUUID();
    const events: RunEvent[] = [
      ...githubRun(runId),
      // A terminal event, so `ended_at` is exercised too. Without one it is null and the
      // timestamptz round-trip on that column is never executed — the column most likely
      // to come back as a `Date` where the row says `string`.
      { run_id: runId, seq: 9, ts: new Date(Date.UTC(2026, 7, 5, 12, 4, 20)).toISOString(), type: 'RUN_ENDED', payload: { v: 1, reason: 'pr_opened' } },
    ];

    // Inside a transaction that is always rolled back. `rebuildProjection` deletes EVERY
    // row by design, and a test that wiped a developer's dashboard to prove a property
    // about it would be a bad trade. `delete` rather than `truncate` is what makes this
    // possible, and this is the case it was written for.
    //
    // ON ONE CONNECTION, checked out and released, and that is not ceremony. `Db` is a
    // pool (ADR-0020): each query goes to whichever connection is free, so a `begin` here
    // and a `rollback` twenty lines down are not promised to reach the same one. Split
    // across two connections, the `delete` inside `rebuildProjection` autocommits and the
    // `rollback` lands where no transaction is open — which Postgres answers with a
    // WARNING that `query()` RESOLVES. The wipe this transaction exists to prevent would
    // happen for real, to a developer's actual dashboard, and the test would pass.
    const held = await client.connect();
    try {
      await held.query('begin');
      for (const event of events) await appendEvent(held, event);

      // `{ rebuilt, skipped }`, not a bare count: the rebuild now survives a malformed
      // stream per-run rather than dying on the first one, and a caller has to be able
      // to see what it could not replay. A silent skip would make the property look
      // stronger than it is.
      const outcome = await rebuildProjection(held);
      expect(outcome.rebuilt).toBeGreaterThan(0);
      // Nothing skipped. The rebuild survives a malformed stream per-run now rather than
      // dying on the first one, and a silent skip would make this property look stronger
      // than it is — so the count of what could NOT be replayed is part of the assertion.
      expect(outcome.skipped).toEqual([]);
      const first = await readRunRow(held, runId);
      expect(first).not.toBeNull();
      expect(first!.repo).toBe('demo-org/demo-app');
      expect(first!.issue_number).toBe(41);
      expect(first!.pr_url).toBe('https://github.com/demo-org/demo-app/pull/42');
      expect(first!.ended_at).toBe(events.at(-1)!.ts);

      // THE DONE-WHEN. Drop the whole table, replay the log, and compare the bytes rather
      // than the shape: `toEqual` would pass on a row whose timestamps had drifted through
      // a Date round-trip, and drifted timestamps are exactly how a "disposable cache"
      // quietly becomes a source of truth nobody can rebuild.
      await rebuildProjection(held);
      const second = await readRunRow(held, runId);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    } finally {
      await held.query('rollback');
      held.release();
    }
  });
});
