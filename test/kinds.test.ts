// Three kinds of work, one worker (10h).
//
// The gap this closes was invisible for four milestones because of where it lived. The
// plane holds no model key and starts no containers (ADR-0011, ADR-0019), so on the hosted
// deployment approving a recipe proved nothing and installing the App drafted nothing — the
// onboarding screen had a permanent "reload in a minute" for a proving run that was never
// going to start. Both worked perfectly on a laptop, where `serve.ts` has Docker and a key,
// and the laptop was the only deployment anybody onboarded against.
//
// So `jobs` gained a `kind`, the plane queues `prove` and `draft` instead of doing them, and
// a worker claims them the way it claims a run. What is asserted here is the dispatch and
// its boundaries; whether proving and drafting themselves work is `sandbox.test.ts`'s
// question, and it answers it with real containers.

import { afterAll, describe, expect, it } from 'vitest';
import { JOB_KINDS, type JobKind } from '../src/plane.js';
import { engineExecute } from '../src/runner-main.js';
import type { DaemonIo, DaemonJob } from '../src/daemon.js';
import type { RunnerConfig } from '../src/runner-main.js';
import { claimJob, enqueueJob, pairRunner, revokeRunner } from '../src/plane.js';
import { close, connect, ready } from '../src/store.js';

const CONFIG = {
  planeUrl: 'https://plane.invalid',
  token: 'tfr_x',
  image: 'engine:test',
  agentImage: 'engine-agent:test',
  blobRoot: '/tmp/unused',
  executor: 'docker',
  loop: { provider: 'openrouter', apiKey: 'k', model: 'm', effort: 'low' },
} as unknown as RunnerConfig;

const job = (over: Partial<DaemonJob> = {}): DaemonJob => ({
  runId: '3f1c9a52-7b0e-4d2f-9c41-8a6e5d0b21c7',
  installationId: 1,
  repo: 'acme/widgets',
  intake: { source: 'github_issue', thread_ref: 'acme/widgets#1' },
  recipe: { services: [], test: 'npm test' },
  kind: 'run',
  ...over,
});

/** A typed fake — never a cast, for the reason `runner-main.test.ts` records at length. */
const fakeIo = (over: Partial<DaemonIo> = {}): DaemonIo & { findings: unknown[] } => {
  const findings: unknown[] = [];
  return {
    findings,
    append: async () => {},
    token: async () => 'an-installation-token',
    cost: async () => {},
    secrets: async () => null,
    finding: async (of) => void findings.push(of),
    // `null`: nobody pressed Start on these, so the worker falls back to its own key —
    // which is what a webhook-era job and the local product both do.
    modelKey: async () => null,
    ...over,
  } as DaemonIo & { findings: unknown[] };
};

describe('the three kinds are a closed set, and the database agrees', () => {
  it('is exactly run, prove and draft', () => {
    // `db/schema.sql` carries the matching CHECK. Two definitions of what is dispatchable
    // would let the plane queue a kind no worker can claim, which is a job that sits open
    // forever and a repository that never onboards.
    expect([...JOB_KINDS]).toEqual(['run', 'prove', 'draft']);
  });
});

describe('a worker does the thing its job says', () => {
  it('a prove job clones, proves, and sends the proof home — never an event', async () => {
    const io = fakeIo();
    const cloned: string[] = [];
    const proved: unknown[] = [];
    await engineExecute(CONFIG, undefined, undefined, {
      clone: async (remote, into) => void cloned.push(`${remote} -> ${into}`),
      prove: async (plan) => {
        proved.push(plan.recipe);
        return { state: 'ready', provedAt: 'T', caveats: [], unproved: [] } as never;
      },
    })(job({ kind: 'prove' }), io);

    expect(cloned).toHaveLength(1);
    expect(cloned[0]).toContain('acme/widgets');
    // The recipe that travelled with the DISPATCH, read fresh by the plane — so a proof is
    // about what is approved now, not what was approved when the job was queued.
    expect(proved).toEqual([{ services: [], test: 'npm test' }]);
    expect(io.findings).toEqual([{ proof: { state: 'ready', provedAt: 'T', caveats: [], unproved: [] } }]);
  });

  it('a draft job proposes, and what it proposes goes to the drafts table', async () => {
    const io = fakeIo();
    await engineExecute(CONFIG, undefined, undefined, {
      clone: async () => {},
      draft: async () => ({ ok: true, draft: { install: 'npm ci', services: [] } }) as never,
    })(job({ kind: 'draft', recipe: null }), io);

    expect(io.findings).toEqual([{ draft: { install: 'npm ci', services: [] } }]);
  });

  it('a drafting session that proposed nothing stores nothing', async () => {
    // An ordinary outcome — the agent explored and had nothing it was willing to propose —
    // and an empty draft would put a box in front of a human saying an agent filled it in.
    const io = fakeIo();
    await engineExecute(CONFIG, undefined, undefined, {
      clone: async () => {},
      draft: async () => ({ ok: false, reason: 'it could not find a test command' }) as never,
    })(job({ kind: 'draft', recipe: null }), io);

    expect(io.findings).toEqual([]);
  });

  it('a prove job for a repository whose recipe was withdrawn does nothing, quietly', async () => {
    // Withdrawn between the approval that queued this and now. Not a failure: there is
    // nothing to prove and nobody to tell, and a proving run that could not start must
    // never look like an approval that did not take.
    const io = fakeIo();
    const proved: unknown[] = [];
    await engineExecute(CONFIG, undefined, undefined, {
      clone: async () => {},
      prove: async () => {
        proved.push(1);
        return {} as never;
      },
    })(job({ kind: 'prove', recipe: null }), io);

    expect(proved).toEqual([]);
    expect(io.findings).toEqual([]);
  });

  it('and a run job is untouched by any of it', async () => {
    // THE control. Every job written before 10h is `kind: 'run'` by the column's default,
    // and this asserts the new branch does not swallow them: `runFromIssue` is reached and
    // neither onboarding path is.
    const io = fakeIo();
    const ran: unknown[] = [];
    const proved: unknown[] = [];
    await engineExecute(CONFIG, undefined, undefined, {
      clone: async () => {},
      prove: async () => {
        proved.push(1);
        return {} as never;
      },
      run: async () => {
        ran.push(1);
        return { runId: 'r', state: {} } as never;
      },
    })(job(), io);

    expect(ran).toHaveLength(1);
    expect(proved).toEqual([]);
    expect(io.findings).toEqual([]);
  });
});

/**
 * The queue, by kind, against a real database.
 *
 * `claimJob` filters in SQL rather than after the fact, and the difference is not cosmetic:
 * a claim that fetched a job and then rejected it in JavaScript would already have written
 * `runner_id` and bumped `dispatches` — it would have DISPATCHED the job to a runner that
 * cannot serve it, and the job would then sit stranded until the two-minute reclaim.
 */
/**
 * Skip, loudly, rather than fail — the house rule from `test/store.test.ts`.
 *
 * AND A SECOND GATE, which is the one worth reading. A test that writes to `jobs` needs a
 * queue nobody else is draining, and `vitest.config.ts` loads `.env` — which on this
 * repository points at the PRODUCTION database, where a live global worker long-polls
 * `/runner/jobs` every 500ms and takes any installation's job of any kind.
 *
 * So this is not flakiness, it is a race with a real worker, and it goes both ways: the test
 * loses jobs it queued, and the worker is handed `acme/kinds-run` — a repository that does
 * not exist — which it dutifully claims, fails to clone, and logs. Verified in the worker's
 * own output while writing this file, alongside `o/r`: `test/plane.test.ts`'s repository,
 * which means **that file's long-standing 10–15 failures are this, not contention with
 * itself.**
 *
 * `ENGINE_TEST_QUEUE=1` is the opt-in, and the right way to set it is a database of your
 * own: `docker compose up -d` and a `DATABASE_URL` pointing at it. Then this is
 * deterministic, and nothing a test queues reaches a machine that will try to run it.
 */
let client: ReturnType<typeof connect> | null = null;
let why = '';
try {
  if (!process.env.DATABASE_URL) why = 'DATABASE_URL is not set (copy .env.example to .env)';
  else if (process.env.ENGINE_TEST_QUEUE !== '1') {
    why =
      'this test writes to `jobs`, and a live worker drains the queue that `.env` points at — ' +
      'set ENGINE_TEST_QUEUE=1 against a database of your own (`docker compose up -d`)';
  } else client = connect();
} catch (error) {
  why = String(error);
}
if (why) console.log(`SKIPPED (the job queue): ${why}`);

describe('a runner takes the kinds it asked for and no others', () => {
  const made: { runs: string[]; runners: string[] } = { runs: [], runners: [] };
  afterAll(async () => {
    if (!client) return;
    await client.query('delete from jobs where run_id = any($1)', [made.runs]).catch(() => {});
    for (const id of made.runners) {
      await revokeRunner(client, id, 424243).catch(() => {});
      await revokeRunner(client, id, 424244).catch(() => {});
    }
    await client.query('delete from runners where id = any($1)', [made.runners]).catch(() => {});
    await close(client);
  });

  /** An installation of its own, so these jobs cannot be taken by anything else running. */
  const INSTALLATION = 424243;

  const queue = async (kind: JobKind) => {
    const runId = await enqueueJob(client!, {
      installationId: INSTALLATION,
      repo: `acme/kinds-${kind}`,
      intake: { kind },
      kind,
    });
    made.runs.push(runId);
    return runId;
  };

  it('claims only the kind it named, and leaves the rest queued', async () => {
    if (!client) return void console.log(`SKIPPED (the job queue): ${why}`);
    await ready(client);
    const runJob = await queue('run');
    const proveJob = await queue('prove');

    const { runner } = await pairRunner(client, { installationId: INSTALLATION, name: 'kinds-test' });
    made.runners.push(runner.id);

    // Asks for `prove` only — and gets the prove job, not the run job that was queued
    // FIRST. `order by queued_at` would have handed over the run without the filter.
    const claimed = await claimJob(client, runner, { kinds: ['prove'] });
    expect(claimed?.runId).toBe(proveJob);
    expect(claimed?.kind).toBe('prove');

    // And the run job was not touched — not claimed, not dispatched, not counted.
    const { rows } = await client.query('select runner_id, dispatches from jobs where run_id = $1', [runJob]);
    expect(rows[0]!.runner_id).toBeNull();
    expect(Number(rows[0]!.dispatches)).toBe(0);
  });

  it('and a runner that names nothing takes any of them, which is what every older one does', async () => {
    if (!client) return void console.log(`SKIPPED (the job queue): ${why}`);
    // ITS OWN INSTALLATION, and the queue drained before the assertion.
    //
    // The first version of this asked only "did it claim something" on the shared
    // installation above, which the previous test had already left a `run` job on — so it
    // passed or failed depending on the order two tests ran in, against a database this
    // suite shares with itself. A test whose subject is "the default takes any kind" has to
    // control what kinds are there.
    const alone = 424244;
    const drained: string[] = [];
    const { runner } = await pairRunner(client, { installationId: alone, name: 'kinds-test-any' });
    made.runners.push(runner.id);
    // Anything left from an earlier interrupted run of this file.
    for (let i = 0; i < 10; i += 1) {
      const stale = await claimJob(client, runner);
      if (!stale) break;
      drained.push(stale.runId);
      await client.query('update jobs set finished_at = now() where run_id = $1', [stale.runId]);
    }

    const draftJob = await enqueueJob(client, {
      installationId: alone,
      repo: 'acme/kinds-any',
      intake: { kind: 'draft' },
      kind: 'draft',
    });
    made.runs.push(draftJob);

    const claimed = await claimJob(client, runner);
    // The `draft` job specifically — a runner that names no kinds gets one it never asked
    // for, which is the pre-10h behaviour kept by defaulting to all three rather than by a
    // special case.
    expect(claimed?.runId).toBe(draftJob);
    expect(claimed?.kind).toBe('draft');
    expect(JOB_KINDS).toContain(claimed!.kind);
  });

  it('the kind survives the round trip, so a worker does what was queued', async () => {
    if (!client) return void console.log(`SKIPPED (the job queue): ${why}`);
    const id = await queue('draft');
    const { runner } = await pairRunner(client, { installationId: INSTALLATION, name: 'kinds-test-rt' });
    made.runners.push(runner.id);
    const claimed = await claimJob(client, runner, { kinds: ['draft'] });
    expect(claimed?.runId).toBe(id);
    // THE assertion. Without `kind` on the returning clause the worker would default it to
    // `run` and re-explore a repository as though somebody had reported a bug in it.
    expect(claimed?.kind).toBe('draft');
  });
});
