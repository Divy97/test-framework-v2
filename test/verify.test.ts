// What the engine OBSERVES on each fixture, and what the fold concludes from it.
//
// The central claim under test: red then green is only evidence if the same
// thing ran both times. Everything here either demonstrates that anchor holding,
// or demonstrates precisely where it does not reach.

import { afterEach, describe, expect, test } from 'vitest';
import { get } from '../src/blobs.js';
import type { FixDiffObservedV1, ReproRegisteredV1, RunEvent, TestRunV1 } from '../src/events.js';
import { fold, type RunState } from '../src/fold.js';
import { ObservationFailed, verify, type VerifyOptions } from '../src/verify.js';
import {
  APPLIED_REPRO,
  cleanupFixtures,
  clean,
  committedTest,
  divergentHistory,
  FLAKY_REPRO,
  helperOnlyInFix,
  helperTampering,
  irreproducible,
  NOISY_REPRO,
  nonAsciiPath,
  PINNED_REPRO,
  pinnedTampering,
  REPRO_NEEDING_FIX_HELPER,
  REPRO_VIA_HELPER,
  RESIDUE_REPRO,
  residueFromBase,
  rewritesTheRepro,
  SELF_REWRITING_REPRO,
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
    repro: APPLIED_REPRO,
    symptomPattern: /wrong/,
    blobRoot: fixture.blobRoot,
    flakeRuns: 2,
    ...overrides,
  });

const testRuns = (events: RunEvent[]) =>
  events.filter((e) => e.type === 'TEST_RUN').map((e) => e.payload as TestRunV1);
const basePhase = (events: RunEvent[]) => testRuns(events).find((r) => r.phase === 'base')!;
const fixPhases = (events: RunEvent[]) => testRuns(events).filter((r) => r.phase === 'fix');
const registration = (events: RunEvent[]) =>
  events.find((e) => e.type === 'REPRO_REGISTERED')!.payload as ReproRegisteredV1;
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
  test('registers the repro first, then records both phases and the diff', async () => {
    const fixture = clean();
    const events = await observe(fixture);

    // Registration precedes every observation: the reproduction is fixed before
    // anything is judged by it.
    expect(events.map((e) => e.type)).toEqual([
      'REPRO_REGISTERED',
      'TEST_RUN',
      'TEST_RUN',
      'TEST_RUN',
      'TEST_RUN',
      'FIX_DIFF_OBSERVED',
    ]);

    expect(registration(events)).toMatchObject({
      command: 'sh repro.sh',
      applied: ['repro.sh'],
    });
    expect(basePhase(events)).toMatchObject({ exit_code: 1, symptom_matched: true });
    expect(fixPhases(events).every((r) => r.exit_code === 0)).toBe(true);
    expect(fixDiff(events).changed_files).toEqual(['src.txt']);
    expect(conclude(events).reproduced).toBe(true);
  });

  test('the registered bytes are retrievable, not just their hash', async () => {
    const fixture = clean();
    const events = await observe(fixture, { flakeRuns: 0 });

    // A hash nothing can resolve is not evidence — "the same test ran in both
    // phases" would be the one claim a reviewer could not open.
    const ref = registration(events).files['repro.sh']!;
    expect((await get(fixture.blobRoot, ref)).toString()).toContain('grep -q right src.txt');
  });

  test('every run reports the repro unchanged', async () => {
    const events = await observe(clean(), { flakeRuns: 0 });
    const registered = registration(events).files;

    for (const run of testRuns(events)) expect(run.repro_hashes).toEqual(registered);
  });

  test('leaves the tree clean so a later attempt can run', async () => {
    const fixture = clean();
    await observe(fixture, { flakeRuns: 0 });

    // The applied repro is untracked; without cleanup the next attempt would trip
    // the dirty-tree refusal on this run's leftovers.
    await expect(observe(fixture, { flakeRuns: 0 })).resolves.toBeDefined();
  });
});

describe('the anchor holds', () => {
  test('a fix that rewrites the repro at run time is caught by re-hashing', async () => {
    const events = await observe(rewritesTheRepro(), { repro: SELF_REWRITING_REPRO });
    const registered = registration(events).files;

    // Base ran the real repro; the fix phase rewrote it before asserting.
    expect(basePhase(events).repro_hashes).toEqual(registered);
    expect(fixPhases(events).every((r) => r.exit_code === 0)).toBe(true);
    expect(fixPhases(events).some((r) => r.repro_hashes!['repro.sh'] !== registered['repro.sh'])).toBe(
      true,
    );
    expect(conclude(events).reproduced).toBe(false);
  });

  test('a pinned test rewritten by the fix is detected, though it cannot be prevented', async () => {
    const events = await observe(pinnedTampering(), { repro: PINNED_REPRO });
    const registered = registration(events).files;

    expect(registration(events).applied).toEqual([]);
    expect(basePhase(events)).toMatchObject({ exit_code: 1, symptom_matched: true });
    expect(fixPhases(events).every((r) => r.exit_code === 0)).toBe(true);
    expect(fixPhases(events)[0]!.repro_hashes).not.toEqual(registered);
    expect(conclude(events).reproduced).toBe(false);
  });

  test('a committed test left alone by the fix is a valid reproduction', async () => {
    const events = await observe(committedTest(), { repro: PINNED_REPRO });

    expect(registration(events).applied).toEqual([]);
    expect(conclude(events).reproduced).toBe(true);
  });
});

describe('the anchor does not reach this far', () => {
  test('tampering with what the repro invokes still passes every check', async () => {
    const events = await observe(helperTampering(), { repro: REPRO_VIA_HELPER });
    const registered = registration(events).files;

    // The reproduction is byte-identical throughout — the fix rewrote the helper
    // it sources instead. Gaming got harder, not impossible.
    expect(testRuns(events).every((r) => r.repro_hashes!['repro.sh'] === registered['repro.sh'])).toBe(
      true,
    );
    expect(basePhase(events)).toMatchObject({ exit_code: 1, symptom_matched: true });
    expect(fixPhases(events).every((r) => r.exit_code === 0)).toBe(true);
    expect(conclude(events).reproduced).toBe(true);
  });
});

describe('adversarial cases', () => {
  test('wrong-reason failure: the repro needs a helper only the fix commit has', async () => {
    const events = await observe(helperOnlyInFix(), { repro: REPRO_NEEDING_FIX_HELPER });

    expect(basePhase(events).exit_code).not.toBe(0);
    expect(fixPhases(events).every((r) => r.exit_code === 0)).toBe(true);
    expect(basePhase(events).symptom_matched).toBe(false);
    expect(conclude(events).reproduced).toBe(false);
  });

  test('flaky fix: one green run would have believed it', async () => {
    const events = await observe(clean(), { repro: FLAKY_REPRO });

    expect(fixPhases(events).map((r) => r.exit_code)).toEqual([0, 1, 0]);
    expect(new Set(fixPhases(events).map((r) => r.stdout_hash)).size).toBe(3);
    expect(conclude(events).reproduced).toBe(false);
  });

  test('irreproducible: base was never red', async () => {
    const events = await observe(irreproducible());

    expect(basePhase(events).exit_code).toBe(0);
    expect(conclude(events).reproduced).toBe(false);
  });

  test('runs outside a declared attempt are never paired into a reproduction', async () => {
    const events = await observe(clean(), { flakeRuns: 0 });
    expect(fold(events).reproduced).toBe(false);
    expect(conclude(events).reproduced).toBe(true);
  });
});

describe('the symptom check has a cost', () => {
  test('a genuine fix is refused when its output never echoes the reported words', async () => {
    const events = await observe(clean(), { repro: NOISY_REPRO });

    expect(basePhase(events).exit_code).toBe(1);
    expect(fixPhases(events).every((r) => r.exit_code === 0)).toBe(true);
    expect(basePhase(events).symptom_matched).toBe(false);
    expect(conclude(events).reproduced).toBe(false);
  });
});

describe('the repro must be anchored to something', () => {
  test('a reproduction with nothing applied and nothing pinned is refused', async () => {
    await expect(
      observe(clean(), { repro: { command: 'sh repro.sh' } }),
    ).rejects.toThrow(/anchored to nothing/);
  });

  test('applying over a committed path is refused rather than silently overwriting', async () => {
    await expect(
      observe(committedTest(), {
        repro: { command: 'x', files: { 'tests/existing.sh': 'echo hi\n' } },
      }),
    ).rejects.toThrow(/is committed/);
  });

  test('a committed path is matched case-insensitively', async () => {
    // darwin's filesystem would let Tests/Existing.sh clobber tests/existing.sh.
    await expect(
      observe(committedTest(), {
        repro: { command: 'x', files: { 'Tests/Existing.sh': 'echo hi\n' } },
      }),
    ).rejects.toThrow(/is committed/);
  });

  test.each([['../escape.sh'], ['/tmp/escape.sh'], ['.git/hooks/pre-commit']])(
    'refuses to write a repro to %s',
    async (path) => {
      await expect(
        observe(clean(), { repro: { command: 'x', files: { [path]: 'echo hi\n' } } }),
      ).rejects.toThrow(ObservationFailed);
    },
  );
});

describe('the repro command is run verbatim', () => {
  test('a command ending in a comment keeps its real exit code', async () => {
    const events = await observe(clean(), {
      repro: { ...APPLIED_REPRO, command: 'exit 6 # the reported repro' },
      flakeRuns: 0,
    });
    expect(basePhase(events).exit_code).toBe(6);
  });

  test('stderr is captured in real order, not appended after stdout', async () => {
    const fixture = clean();
    const events = await observe(fixture, {
      repro: { ...APPLIED_REPRO, command: 'echo first; echo second >&2; echo third; exit 1' },
      flakeRuns: 0,
    });

    const output = (await get(fixture.blobRoot, basePhase(events).stdout_hash)).toString();
    expect(output).toBe('first\nsecond\nthird\n');
  });
});

describe('failures to observe never become observations', () => {
  test('a hanging repro fails the run rather than wedging it', async () => {
    await expect(
      observe(clean(), { repro: { ...APPLIED_REPRO, command: 'sleep 30' }, timeoutMs: 300 }),
    ).rejects.toThrow(ObservationFailed);
  });

  test('output past the ceiling aborts rather than storing a truncated artifact', async () => {
    await expect(
      observe(clean(), {
        repro: { ...APPLIED_REPRO, command: 'yes padding | head -c 200000' },
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
    const events = await observe(clean(), {
      repro: { ...APPLIED_REPRO, command: 'kill -9 $$' },
      flakeRuns: 0,
    });

    expect(basePhase(events)).toMatchObject({ exit_code: -1, signal: 'SIGKILL' });
  });
});

describe('the working tree the fix phase sees', () => {
  test('base-phase residue is scrubbed at the boundary but survives between re-runs', async () => {
    const fixture = residueFromBase();
    const events = await observe(fixture, { repro: RESIDUE_REPRO });
    const outputs = await Promise.all(
      fixPhases(events).map((r) => get(fixture.blobRoot, r.stdout_hash).then((b) => b.toString())),
    );

    expect(basePhase(events)).toMatchObject({ exit_code: 1, symptom_matched: true });
    expect(outputs[0]).not.toContain('RESIDUE_SURVIVED');
    expect(outputs[0]).not.toContain('TRACKED_POISONED');
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
    expect(fixDiff(events).changed_files).toEqual(['src.txt']);
  });

  test('the applied repro never appears in the diff', async () => {
    const events = await observe(clean(), { flakeRuns: 0 });
    expect(fixDiff(events).changed_files).not.toContain('repro.sh');
  });
});

describe('the symptom observation cannot depend on call order', () => {
  test('a sticky regex still matches a symptom that is not at position 0', async () => {
    const events = await observe(clean(), {
      repro: { ...APPLIED_REPRO, command: 'echo "FAILED: the total is wrong"; exit 1' },
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
