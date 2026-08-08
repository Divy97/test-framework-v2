// What the engine OBSERVES on each fixture. It draws no conclusions here —
// turning these observations into a tier is the fold's job, and its tests'.
//
// Each adversarial case pins the one signal that distinguishes it from a clean
// red -> green: a wrong-reason failure, a fix that only sometimes passes, a diff
// that never reached the source, a bug that was never red to begin with.

import { describe, expect, test } from 'vitest';
import { get } from '../src/blobs.js';
import type { FixDiffObservedV1, RunEvent, TestRunV1 } from '../src/events.js';
import { fold } from '../src/fold.js';
import { verify } from '../src/verify.js';
import {
  clean,
  flakyFix,
  gamingAttempt,
  irreproducible,
  REPRO_COMMAND,
  symptomMismatch,
  type Fixture,
} from './fixtures/repo.js';

const RUN_ID = '7c2e1b90-4a3d-4f88-b1e2-90d5a6c3f014';

const observe = (fixture: Fixture, flakeRuns = 2) =>
  verify({
    runId: RUN_ID,
    afterSeq: 0,
    repoPath: fixture.repo,
    baseRef: fixture.base,
    fixRef: fixture.fix,
    reproCommand: REPRO_COMMAND,
    symptomPattern: /wrong/,
    blobRoot: fixture.blobRoot,
    flakeRuns,
  });

const testRuns = (events: RunEvent[]) =>
  events.filter((e) => e.type === 'TEST_RUN').map((e) => e.payload as TestRunV1);
const basePhase = (events: RunEvent[]) => testRuns(events).find((r) => r.phase === 'base')!;
const fixPhases = (events: RunEvent[]) => testRuns(events).filter((r) => r.phase === 'fix');
const fixDiff = (events: RunEvent[]) =>
  events.find((e) => e.type === 'FIX_DIFF_OBSERVED')!.payload as FixDiffObservedV1;

describe('clean red -> green', () => {
  test('records base failure, fix passes, flake re-runs, and the diff', async () => {
    const fixture = clean();
    const events = await observe(fixture);

    expect(events.map((e) => e.type)).toEqual([
      'TEST_RUN',
      'TEST_RUN',
      'TEST_RUN',
      'TEST_RUN',
      'FIX_DIFF_OBSERVED',
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);

    expect(basePhase(events)).toMatchObject({ exit_code: 1, symptom_matched: true });
    expect(fixPhases(events).every((r) => r.exit_code === 0)).toBe(true);
    expect(fixPhases(events).map((r) => r.repeat)).toEqual([0, 1, 2]);
    expect(fixDiff(events).changed_files).toEqual(['src.txt']);

    // The hashes resolve to the bytes the engine actually saw.
    expect((await get(fixture.blobRoot, basePhase(events).stdout_hash)).toString()).toContain(
      'wrong',
    );
    expect((await get(fixture.blobRoot, fixDiff(events).diff_hash)).toString()).toContain('+right');
  });

  test('the engine issues no verdict — the fold does', async () => {
    const fixture = clean();
    const events = await observe(fixture, 0);

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
    expect(state.fixDiff?.changed_files).toEqual(['src.txt']);
  });
});

describe('adversarial cases', () => {
  test('symptom mismatch: base failed for the wrong reason', async () => {
    const events = await observe(symptomMismatch());
    const base = basePhase(events);

    // Red and green look identical to the clean case — only the symptom differs.
    expect(base.exit_code).not.toBe(0);
    expect(fixPhases(events).every((r) => r.exit_code === 0)).toBe(true);
    expect(base.symptom_matched).toBe(false);
  });

  test('flaky fix: one green run would have believed it', async () => {
    const events = await observe(flakyFix());

    expect(basePhase(events)).toMatchObject({ exit_code: 1, symptom_matched: true });
    expect(fixPhases(events).map((r) => r.exit_code)).toEqual([0, 1, 0]);
  });

  test('gaming attempt: red to green without touching the source', async () => {
    const events = await observe(gamingAttempt());

    expect(basePhase(events)).toMatchObject({ exit_code: 1, symptom_matched: true });
    expect(fixPhases(events).every((r) => r.exit_code === 0)).toBe(true);
    // The whole fix is a weakened test. Nothing the repro exercises was changed.
    expect(fixDiff(events).changed_files).toEqual(['repro.sh']);
  });

  test('irreproducible: base was never red', async () => {
    const events = await observe(irreproducible());

    expect(basePhase(events).exit_code).toBe(0);
    expect(basePhase(events).symptom_matched).toBe(false);
  });
});

test('a hanging repro command fails the run rather than wedging it', async () => {
  const fixture = clean();

  await expect(
    verify({
      runId: RUN_ID,
      afterSeq: 0,
      repoPath: fixture.repo,
      baseRef: fixture.base,
      fixRef: fixture.fix,
      reproCommand: 'sleep 30',
      symptomPattern: /wrong/,
      blobRoot: fixture.blobRoot,
      timeoutMs: 300,
    }),
  ).rejects.toThrow(/exceeded 300ms/);
});
