// What the engine OBSERVES on each fixture, and what the fold concludes from it.
//
// Each adversarial case pins the one signal that distinguishes it from a clean
// red -> green, and then asserts the fold actually acts on that signal — a
// signal nothing consults is decoration.

import { afterEach, describe, expect, test } from 'vitest';
import { get } from '../src/blobs.js';
import type { FixDiffObservedV1, RunEvent, TestRunV1 } from '../src/events.js';
import { fold, type RunState } from '../src/fold.js';
import { ObservationFailed, verify, type VerifyOptions } from '../src/verify.js';
import {
  cleanupFixtures,
  clean,
  collateralGaming,
  flakyFix,
  gamingAttempt,
  irreproducible,
  noisySymptom,
  REPRO_COMMAND,
  wrongReasonFailure,
  type Fixture,
} from './fixtures/repo.js';

const RUN_ID = '7c2e1b90-4a3d-4f88-b1e2-90d5a6c3f014';

afterEach(cleanupFixtures);

const observe = (fixture: Fixture, overrides: Partial<VerifyOptions> = {}) =>
  verify({
    runId: RUN_ID,
    afterSeq: 0,
    repoPath: fixture.repo,
    baseRef: fixture.base,
    fixRef: fixture.fix,
    reproCommand: REPRO_COMMAND,
    symptomPattern: /wrong/,
    blobRoot: fixture.blobRoot,
    flakeRuns: 2,
    ...overrides,
  });

const testRuns = (events: RunEvent[]) =>
  events.filter((e) => e.type === 'TEST_RUN').map((e) => e.payload as TestRunV1);
const basePhase = (events: RunEvent[]) => testRuns(events).find((r) => r.phase === 'base')!;
const fixPhases = (events: RunEvent[]) => testRuns(events).filter((r) => r.phase === 'fix');
const fixDiff = (events: RunEvent[]) =>
  events.find((e) => e.type === 'FIX_DIFF_OBSERVED')!.payload as FixDiffObservedV1;

/** Fold the engine's output as a real run would: inside a declared attempt. */
const conclude = (events: RunEvent[]): RunState =>
  fold([
    {
      run_id: RUN_ID,
      seq: 1,
      ts: new Date().toISOString(),
      type: 'ATTEMPT_STARTED',
      payload: { v: 1, n: 1 },
    },
    ...events.map((e, i) => ({ ...e, seq: i + 2 })),
  ]);

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
    expect(basePhase(events).commit_sha).toBe(fixture.base);
    expect(fixPhases(events).every((r) => r.exit_code === 0)).toBe(true);
    expect(fixPhases(events).every((r) => r.commit_sha === fixture.fix)).toBe(true);
    expect(fixDiff(events)).toMatchObject({
      changed_files: ['src.txt'],
      base_sha: fixture.base,
      fix_sha: fixture.fix,
    });

    expect((await get(fixture.blobRoot, basePhase(events).stdout_hash)).toString()).toContain(
      'wrong',
    );
    expect((await get(fixture.blobRoot, fixDiff(events).diff_hash)).toString()).toContain('+right');
    expect(conclude(events).reproduced).toBe(true);
  });

  test('the engine emits observations only — no payload carries a verdict', async () => {
    const events = await observe(clean(), { flakeRuns: 0 });

    // Pin the exact key set of every payload. A grep for the word "reproduced"
    // would pass while the engine emitted `verdict: 'tier1'` right beside it.
    const keys = events.map((e) => Object.keys(e.payload).sort().join(','));
    expect(keys).toEqual([
      'commit_sha,duration_ms,exit_code,phase,repeat,stdout_hash,symptom_matched,v',
      'commit_sha,duration_ms,exit_code,phase,repeat,stdout_hash,v',
      'base_sha,changed_files,diff_hash,fix_sha,v',
    ]);
  });

  test('emits from afterSeq + 1 so it can append to an existing log', async () => {
    const events = await observe(clean(), { afterSeq: 17, flakeRuns: 0 });
    expect(events.map((e) => e.seq)).toEqual([18, 19, 20]);
  });
});

describe('adversarial cases', () => {
  test('wrong-reason failure: the base errored before testing anything', async () => {
    const events = await observe(wrongReasonFailure());

    // Exit code alone calls this a red base — 127 from a missing test file.
    expect(basePhase(events).exit_code).not.toBe(0);
    expect(fixPhases(events).every((r) => r.exit_code === 0)).toBe(true);
    // Only the symptom tells the truth, and the fold must refuse on it.
    expect(basePhase(events).symptom_matched).toBe(false);
    expect(conclude(events).reproduced).toBe(false);
  });

  test('flaky fix: one green run would have believed it', async () => {
    const events = await observe(flakyFix());

    expect(basePhase(events)).toMatchObject({ exit_code: 1, symptom_matched: true });
    expect(fixPhases(events).map((r) => r.exit_code)).toEqual([0, 1, 0]);
    // Distinct hashes prove three real executions, not one result emitted thrice.
    expect(new Set(fixPhases(events).map((r) => r.stdout_hash)).size).toBe(3);
    // The fix commit touches only the source, so nothing here is a diff signal.
    expect(fixDiff(events).changed_files).toEqual(['src.txt']);
    expect(conclude(events).reproduced).toBe(false);
  });

  test('gaming attempt: red to green without touching the source', async () => {
    const events = await observe(gamingAttempt());

    expect(basePhase(events)).toMatchObject({ exit_code: 1, symptom_matched: true });
    expect(fixPhases(events).every((r) => r.exit_code === 0)).toBe(true);
    expect(fixDiff(events).changed_files).toEqual(['repro.sh']);
  });

  test('collateral gaming: a weakened test smuggled in beside a real source edit', async () => {
    const events = await observe(collateralGaming());

    // Indistinguishable from a genuine fix on every signal except the diff's shape.
    expect(basePhase(events)).toMatchObject({ exit_code: 1, symptom_matched: true });
    expect(fixPhases(events).every((r) => r.exit_code === 0)).toBe(true);
    expect(fixDiff(events).changed_files).toEqual(['repro.sh', 'src.txt']);
    // Documents the live gap: filename intersection alone credits this fix.
    expect(conclude(events).reproduced).toBe(true);
  });

  test('irreproducible: base was never red', async () => {
    const events = await observe(irreproducible());

    expect(basePhase(events).exit_code).toBe(0);
    expect(conclude(events).reproduced).toBe(false);
  });
});

describe('the symptom check has a cost', () => {
  test('a genuine fix is refused when its output never echoes the reported words', async () => {
    const events = await observe(noisySymptom());

    // A real bug, really fixed — the base failed for exactly the right reason.
    expect(basePhase(events).exit_code).toBe(1);
    expect(fixPhases(events).every((r) => r.exit_code === 0)).toBe(true);
    // And it is still refused, because the output said "assert 42 == 40".
    expect(basePhase(events).symptom_matched).toBe(false);
    expect(conclude(events).reproduced).toBe(false);
  });
});

describe('failures to observe never become observations', () => {
  test('a hanging repro fails the run rather than wedging it', async () => {
    await expect(
      observe(clean(), { reproCommand: 'sleep 30', timeoutMs: 300 }),
    ).rejects.toThrow(ObservationFailed);
  });

  test('a repro that cannot be executed is not recorded as a failing test', async () => {
    // Exit 127 would look exactly like a legitimately failing suite.
    await expect(observe(clean(), { repoPath: '/nonexistent-repo-path' })).rejects.toThrow();
  });

  test('a dirty working tree is refused, since the result would describe neither commit', async () => {
    const fixture = clean();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${fixture.repo}/stray.txt`, 'uncommitted\n');

    await expect(observe(fixture)).rejects.toThrow(ObservationFailed);
  });
});
