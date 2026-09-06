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

const io = {
  append: async () => {},
  token: async () => 'an-installation-token',
} as unknown as Parameters<ReturnType<typeof engineExecute>>[1];

beforeEach(() => runFromIssue.mockClear());

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
