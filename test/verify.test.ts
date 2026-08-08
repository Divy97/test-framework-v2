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
  crashingBase,
  divergentHistory,
  flakyFix,
  gamingAttempt,
  irreproducible,
  noisySymptom,
  nonAsciiPath,
  REPRO_COMMAND,
  residueFromBase,
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

  test('runs outside a declared attempt are never paired into a reproduction', async () => {
    // Without ATTEMPT_STARTED every run lands in attempt 0, and "within one
    // attempt" stops being enforceable — a red base from one attempt could be
    // paired with a green fix from an unrelated later one.
    const events = await observe(clean(), { flakeRuns: 0 });
    expect(fold(events).reproduced).toBe(false);
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

describe('the repro command is run verbatim', () => {
  test('a command ending in a comment keeps its real exit code', async () => {
    // Wrapping the command in `( … )` made sh swallow the paren and report a
    // syntax error as exit 2 with empty output — a fabricated TEST_RUN.
    const events = await observe(clean(), {
      reproCommand: 'exit 6 # the reported repro',
      flakeRuns: 0,
    });
    expect(basePhase(events).exit_code).toBe(6);
  });

  test('stderr is captured in real order, not appended after stdout', async () => {
    const fixture = clean();
    const events = await observe(fixture, {
      reproCommand: 'echo first; echo second >&2; echo third; exit 1',
      flakeRuns: 0,
    });

    const output = (await get(fixture.blobRoot, basePhase(events).stdout_hash)).toString();
    expect(output).toBe('first\nsecond\nthird\n');
  });
});

describe('failures to observe never become observations', () => {
  test('a hanging repro fails the run rather than wedging it', async () => {
    await expect(observe(clean(), { reproCommand: 'sleep 30', timeoutMs: 300 })).rejects.toThrow(
      ObservationFailed,
    );
  });

  test('output past the ceiling aborts rather than storing a truncated artifact', async () => {
    // Node hands back a truncated buffer here; hashing it would produce a blob
    // that is internally consistent and factually a lie.
    await expect(
      observe(clean(), {
        reproCommand: 'yes padding | head -c 200000',
        maxOutputBytes: 4096,
        flakeRuns: 0,
      }),
    ).rejects.toThrow(ObservationFailed);
  });

  test('a git failure is an ObservationFailed, not a bare Error', async () => {
    await expect(observe(clean(), { baseRef: 'no-such-ref' })).rejects.toThrow(ObservationFailed);
  });

  test('a dirty working tree is refused, since the result would describe neither commit', async () => {
    const fixture = clean();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${fixture.repo}/stray.txt`, 'uncommitted\n');

    await expect(observe(fixture)).rejects.toThrow(ObservationFailed);
  });
});

describe('a crash is not a test failure', () => {
  test('a signalled death records -1 and the signal rather than a plausible exit code', async () => {
    const events = await observe(clean(), { reproCommand: 'kill -9 $$', flakeRuns: 0 });

    // -1 is not a status any process can exit with, so it cannot be mistaken for one.
    expect(basePhase(events)).toMatchObject({ exit_code: -1, signal: 'SIGKILL' });
  });

  test('a crash is refused even when every other signal says reproduction', async () => {
    const events = await observe(crashingBase());

    // The symptom matched and the fix went green: nothing but the crash itself
    // stands between this and a Tier 1 verdict.
    expect(basePhase(events)).toMatchObject({
      exit_code: -1,
      signal: 'SIGKILL',
      symptom_matched: true,
    });
    expect(fixPhases(events).every((r) => r.exit_code === 0)).toBe(true);
    expect(conclude(events).reproduced).toBe(false);
  });
});

describe('the working tree the fix phase sees', () => {
  test('base-phase residue is scrubbed at the boundary but survives between re-runs', async () => {
    const fixture = residueFromBase();
    const events = await observe(fixture);
    const outputs = await Promise.all(
      fixPhases(events).map((r) => get(fixture.blobRoot, r.stdout_hash).then((b) => b.toString())),
    );

    expect(basePhase(events)).toMatchObject({ exit_code: 1, symptom_matched: true });
    // The first fix run sees neither the untracked file the base wrote nor its
    // edit to the tracked file both commits share.
    expect(outputs[0]).not.toContain('RESIDUE_SURVIVED');
    expect(outputs[0]).not.toContain('TRACKED_POISONED');
    // Re-runs deliberately share a tree — isolating them would hide order-dependent flake.
    expect(outputs[1]).toContain('RESIDUE_SURVIVED');
    expect(outputs[1]).toContain('TRACKED_POISONED');
  });
});

describe('the diff the overlap check will read', () => {
  test('non-ASCII paths arrive intact rather than C-quoted', async () => {
    const events = await observe(nonAsciiPath(), { flakeRuns: 0 });
    expect(fixDiff(events).changed_files).toEqual(['café.txt', 'src.txt']);
  });

  test('unrelated base-side commits are not attributed to the fix', async () => {
    const events = await observe(divergentHistory(), { flakeRuns: 0 });
    // Two-dot would also list base_only.txt, inflating the overlap check with a
    // path the fix never went near.
    expect(fixDiff(events).changed_files).toEqual(['src.txt']);
  });
});

describe('the symptom observation cannot depend on call order', () => {
  test('a sticky regex still matches a symptom that is not at position 0', async () => {
    // /y anchors the match at lastIndex, so without stripping it the engine would
    // report symptom_matched: false for output that plainly contains the symptom.
    const events = await observe(clean(), {
      reproCommand: 'echo "FAILED: the total is wrong"; exit 1',
      symptomPattern: /wrong/y,
      flakeRuns: 0,
    });

    expect(basePhase(events).symptom_matched).toBe(true);
  });

  test('a global regex reused across runs observes both the same', async () => {
    const shared = /wrong/g;
    const first = await observe(clean(), { symptomPattern: shared, flakeRuns: 0 });
    const second = await observe(clean(), { symptomPattern: shared, flakeRuns: 0 });

    expect(basePhase(first).symptom_matched).toBe(true);
    expect(basePhase(second).symptom_matched).toBe(true);
  });
});
