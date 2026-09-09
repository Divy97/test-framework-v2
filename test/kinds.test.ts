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

import { describe, expect, it, vi } from 'vitest';
import { JOB_KINDS, type JobKind } from '../src/plane.js';
import { engineExecute } from '../src/runner-main.js';
import type { DaemonIo, DaemonJob } from '../src/daemon.js';
import type { RunnerConfig } from '../src/runner-main.js';

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
