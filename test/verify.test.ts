// Smoke test for the engine against a generated git fixture: the clean
// red -> green case. The adversarial cases (symptom mismatch, flaky fix,
// gaming attempt, irreproducible) arrive with the fixture harness.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { get } from '../src/blobs.js';
import type { FixDiffObservedV1, TestRunV1 } from '../src/events.js';
import { fold } from '../src/fold.js';
import { verify } from '../src/verify.js';

const RUN_ID = '7c2e1b90-4a3d-4f88-b1e2-90d5a6c3f014';

/** A repo whose repro prints "wrong" and exits 1 on base, prints "right" and exits 0 on the fix. */
function makeFixture() {
  const repo = mkdtempSync(join(tmpdir(), 'verify-fixture-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });

  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture');

  writeFileSync(join(repo, 'answer.txt'), 'wrong\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'base: the bug');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

  writeFileSync(join(repo, 'answer.txt'), 'right\n');
  git('commit', '--quiet', '-am', 'fix: the bug');
  const fix = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

  return { repo, base, fix, blobRoot: mkdtempSync(join(tmpdir(), 'verify-blobs-')) };
}

test('records base failure, fix passes, flake re-runs, and the diff', async () => {
  const { repo, base, fix, blobRoot } = makeFixture();

  const events = await verify({
    runId: RUN_ID,
    afterSeq: 0,
    repoPath: repo,
    baseRef: base,
    fixRef: fix,
    reproCommand: 'cat answer.txt && grep -q right answer.txt',
    symptomPattern: /wrong/,
    blobRoot,
    flakeRuns: 2,
  });

  // 1 base + 3 fix (first + 2 flake re-runs) + 1 diff, seq contiguous from 1.
  expect(events.map((e) => e.type)).toEqual([
    'TEST_RUN',
    'TEST_RUN',
    'TEST_RUN',
    'TEST_RUN',
    'FIX_DIFF_OBSERVED',
  ]);
  expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);

  const runs = events.slice(0, 4).map((e) => e.payload as TestRunV1);
  const baseRun = runs[0]!;
  const rest = runs.slice(1);
  expect(baseRun).toMatchObject({ phase: 'base', exit_code: 1, symptom_matched: true });
  expect(rest.every((r) => r.phase === 'fix' && r.exit_code === 0)).toBe(true);
  expect(rest.map((r) => r.repeat)).toEqual([0, 1, 2]);

  const diff = events[4]!.payload as FixDiffObservedV1;
  expect(diff.changed_files).toEqual(['answer.txt']);

  // The hashes resolve to the bytes the engine actually saw.
  expect((await get(blobRoot, baseRun.stdout_hash)).toString()).toContain('wrong');
  expect((await get(blobRoot, diff.diff_hash)).toString()).toContain('+right');
});

test('the engine issues no verdict — the fold does', async () => {
  const { repo, base, fix, blobRoot } = makeFixture();

  const events = await verify({
    runId: RUN_ID,
    afterSeq: 0,
    repoPath: repo,
    baseRef: base,
    fixRef: fix,
    reproCommand: 'cat answer.txt && grep -q right answer.txt',
    symptomPattern: /wrong/,
    blobRoot,
    flakeRuns: 0,
  });

  // No event carries "reproduced" — it exists only as an interpretation.
  expect(JSON.stringify(events)).not.toContain('reproduced');

  const state = fold([
    {
      run_id: RUN_ID,
      seq: 1,
      ts: new Date().toISOString(),
      type: 'ATTEMPT_STARTED',
      payload: { v: 1, n: 1 },
    },
    ...events.map((e, i) => ({ ...e, seq: i + 2 })),
  ]);
  expect(state.reproduced).toBe(true);
  expect(state.fixDiff?.changed_files).toEqual(['answer.txt']);
});

test('a hanging repro command fails the run rather than wedging it', async () => {
  const { repo, base, fix, blobRoot } = makeFixture();

  await expect(
    verify({
      runId: RUN_ID,
      afterSeq: 0,
      repoPath: repo,
      baseRef: base,
      fixRef: fix,
      reproCommand: 'sleep 30',
      symptomPattern: /wrong/,
      blobRoot,
      timeoutMs: 300,
    }),
  ).rejects.toThrow(/exceeded 300ms/);
});
