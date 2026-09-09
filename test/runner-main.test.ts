// The seam a live deploy depends on (M10, 10e).
//
// `runner-main.ts` is deliberately thin — the loop is in `daemon.ts`, the engine is in
// `orchestrate.ts` — but the two lines it owns are the ones that decide where a run
// happens, and neither had a test. Deleting the one line in `run.ts` that threads
// `executor` into `orchestrate` left the whole suite green, which meant the entire point
// of `ENGINE_EXECUTOR` was unverified on the only new code path a live deploy exercises.
//
// `runFromIssue` is mocked because what is under test is the HAND-OFF, not the engine: a
// real call would want containers, a repository and a plane. This is the one file that
// mocks it, which is why it is its own file.

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { DaemonIo } from '../src/daemon.js';
import type { ComputeRow } from '../src/readmodel.js';
import type { ComputeLog } from '../src/runner-main.js';
type ComputeRow2 = Omit<ComputeRow, 'run_id'>;

/** Typed with its one argument, so `mock.calls[0][0]` is a value and not `never`. */
const runFromIssue = vi.fn(async (_request: Record<string, unknown>) => {});
vi.mock('../src/run.js', () => ({ runFromIssue }));

const { engineExecute, executorFor, readRunnerConfig } = await import('../src/runner-main.js');

const BASE = {
  ENGINE_PLANE_URL: 'https://plane.test',
  ENGINE_RUNNER_TOKEN: 'tfr_x',
  OPENROUTER_API_KEY: 'sk-x',
} as NodeJS.ProcessEnv;

const job = {
  runId: '11111111-2222-4333-8444-555555555555',
  repo: 'o/r',
  intake: { source: 'github_issue', thread_ref: 'o/r#1' },
  recipe: null,
} as unknown as Parameters<ReturnType<typeof engineExecute>>[0];

const bills: { usage?: unknown[]; compute?: unknown[] }[] = [];
/**
 * TYPED, not cast.
 *
 * This was `as unknown as Parameters<...>[1]`, and the cast is what let it fall behind the
 * interface it stands in for: 10l added `secrets` to `DaemonIo`, `tsc` had nothing to say,
 * and four tests failed at run time with `io.secrets is not a function`. A fake that cannot
 * disagree with its own type is the whole value of having one — the same lesson
 * `src/vercel-client.ts` records about the SDK, arrived at from the other side.
 */
const stored: (Record<string, string> | null)[] = [null];
const io: DaemonIo = {
  append: async () => {},
  token: async () => 'an-installation-token',
  cost: async (spent) => void bills.push(spent),
  // `null` by default: the shape every test in this file was written under, which is a
  // deployment that does not inject. A test that wants values pushes them.
  secrets: async () => stored.at(-1) ?? null,
};

beforeEach(() => {
  runFromIssue.mockClear();
  bills.splice(0);
});

describe('what the runner chose is what the engine is handed', () => {
  test('a Docker runner builds no executor, and hands none over', async () => {
    const config = readRunnerConfig(BASE);
    // `undefined`, not `dockerExecutor()`: absent is what every caller already treats as
    // the default, and naming the default twice invites the two to disagree.
    expect(await executorFor(config)).toBeUndefined();

    await engineExecute(config, undefined)(job, io);
    const request = runFromIssue.mock.calls[0]![0];
    expect('executor' in request).toBe(false);
    // The rest of the hand-off, which nothing checked either.
    expect(request['runId']).toBe(job.runId);
    expect(request['image']).toBe(config.image);
  });

  test('and a chosen executor reaches the run', async () => {
    // THE assertion. Remove the `executor` line in `run.ts` and this is the test that
    // fails; before it existed, nothing did.
    const chosen = { kind: 'vercel' } as never;
    await engineExecute(readRunnerConfig(BASE), chosen)(job, io);
    expect(runFromIssue.mock.calls[0]![0]['executor']).toBe(chosen);
  });
});

describe('what a Vercel runner builds, without building one', () => {
  test('the ledger sits beside the store, never inside it', async () => {
    // `blobs.ts` refuses a store whose contents it did not write, so a bookkeeping file
    // in there is exactly that — and the ledger has to outlive a crash, which is the
    // whole reason it is on disk rather than in memory.
    const config = readRunnerConfig({
      ...BASE,
      ENGINE_EXECUTOR: 'vercel',
      ENGINE_BLOB_ROOT: '/var/lib/worker/blobs',
      ENGINE_IMAGE: 'vcr.example/sandbox@sha256:aa',
      ENGINE_AGENT_IMAGE: 'vcr.example/agent@sha256:bb',
    } as NodeJS.ProcessEnv);
    expect(config.executor).toBe('vercel');
    expect(config.vercel?.region).toBe('iad1');
    // Asserted as a path rather than by constructing the executor, which would resolve
    // the SDK and reach the network.
    const { join } = await import('node:path');
    expect(join(config.blobRoot, '..', 'sandboxes.jsonl')).toBe('/var/lib/worker/sandboxes.jsonl');
  });
});


describe('what the run spent is reported, and never dropped on the floor', () => {
  /**
   * One sandbox's row, in the shape the database takes.
   *
   * Whole rather than partial, because `ComputeLog` is typed against `ComputeRow` now —
   * that typing is the control on the write end agreeing with the read end, and a fixture
   * that opted out of it with a cast would be the test disabling the check it exists for.
   */
  const row = (sandbox_id: string, phase: string): ComputeRow2 => ({
    sandbox_id,
    phase,
    active_cpu_ms: 1,
    duration_ms: 2,
    ingress_bytes: 3,
    egress_bytes: 4,
  });
  const spent = (rows: ComputeRow2[]): ComputeLog => new Map([[job.runId, rows]]);

  test('the model AND the machines go out in one bill, and the buffer is drained', async () => {
    // Before 10f this return value was discarded outright: `saveUsage` had one caller,
    // `serve.ts`, so every run a WORKER drove lost what it spent — and the sandboxes were
    // never recorded anywhere at all.
    runFromIssue.mockResolvedValueOnce({
      usage: [{ phase: 'agent', usage: { turns: 7, input_tokens: 90, output_tokens: 8 } }],
    } as never);
    const machines = spent([row('sbx-1', 'base')]);
    await engineExecute(readRunnerConfig(BASE), undefined, machines)(job, io);

    expect(bills).toHaveLength(1);
    expect(bills[0]!.usage).toMatchObject([{ phase: 'agent', turns: 7, input_tokens: 90 }]);
    expect(bills[0]!.compute).toEqual([row('sbx-1', 'base')]);
    // DRAINED. A worker takes jobs forever, and a map that only ever grows is a leak
    // with a very slow fuse.
    expect(machines.has(job.runId)).toBe(false);
  });

  test('a run that ENDED BADLY still reports what it burned getting there', async () => {
    // The control on the `finally`. A failed run is the one whose cost is most worth
    // knowing — it is the shape that spends an hour of sandbox and produces nothing —
    // and reporting only on success would hide exactly those.
    runFromIssue.mockRejectedValueOnce(new Error('the environment build could not be run'));
    const machines = spent([row('sbx-env', 'env')]);
    await expect(engineExecute(readRunnerConfig(BASE), undefined, machines)(job, io)).rejects.toThrow(
      /environment build/,
    );
    expect(bills).toHaveLength(1);
    expect(bills[0]!.compute).toEqual([row('sbx-env', 'env')]);
    expect(machines.has(job.runId)).toBe(false);
  });

  test(`and one run never carries another run's machines`, async () => {
    // The buffer is keyed by run because the executor is built once per WORKER and
    // `onCompute` fires mid-run: a worker with two jobs in flight must not put one's
    // sandboxes on the other's bill.
    const machines = spent([row('sbx-mine', 'base')]);
    machines.set('99999999-2222-4333-8444-555555555555', [row('sbx-theirs', 'base')]);
    await engineExecute(readRunnerConfig(BASE), undefined, machines)(job, io);
    expect(bills[0]!.compute).toEqual([row('sbx-mine', 'base')]);
    // CLEARED rather than left: one job at a time means an entry under another key is an
    // orphan, and `delete` alone would keep it forever under a uuid nobody holds.
    expect(machines.size).toBe(0);
  });
});
