// What the engine OBSERVES on each fixture, and what the fold concludes from it.
//
// The central claim under test: red then green is only evidence if the same
// thing ran both times. Everything here either demonstrates that anchor holding,
// or demonstrates precisely where it does not reach.

import { chmodSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import { get } from '../src/blobs.js';
import type {
  FixDiffObservedV1,
  ReproRegisteredV1,
  RunEvent,
  TestRunV1,
  VerificationAbortedV1,
} from '../src/events.js';
import { fold, type RunState } from '../src/fold.js';
import { MAX_REASON_CHARS, ObservationFailed, verify, type VerifyOptions } from '../src/verify.js';
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
  rewritesTheReproOnBase,
  SELF_REWRITING_REPRO,
  symlinkInFix,
  symlinkToRoot,
  unrelatedHistories,
  pinnedSymlink,
  gitignoredWorkDir,
  HANGS_ON_BASE,
  HANGS_ON_FIX,
  HANGS_ON_FLAKE_RERUN,
  LOCKS_THE_TREE_ON_FIX,
  REPRO_PLANTING_SYMLINK,
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

  test('a repro rewritten during the BASE run is caught too', async () => {
    const events = await observe(rewritesTheReproOnBase(), { repro: SELF_REWRITING_REPRO });
    const registered = registration(events).files;

    // Everything else looks like a clean reproduction: the base failed for the
    // reported reason and the fix is genuinely green.
    expect(basePhase(events)).toMatchObject({ exit_code: 1, symptom_matched: true });
    expect(fixPhases(events).every((r) => r.exit_code === 0)).toBe(true);
    expect(fixPhases(events).every((r) => r.repro_hashes!['repro.sh'] === registered['repro.sh'])).toBe(
      true,
    );
    // Only the base run's own hash gives it away.
    expect(basePhase(events).repro_hashes!['repro.sh']).not.toBe(registered['repro.sh']);
    expect(conclude(events).reproduced).toBe(false);
  });

  test('a divergent repro hash resolves to the bytes that actually ran', async () => {
    const fixture = rewritesTheRepro();
    const events = await observe(fixture, { repro: SELF_REWRITING_REPRO });
    const tampered = fixPhases(events)[0]!.repro_hashes!['repro.sh']!;

    // The tampered version is the artifact a reviewer most needs to open.
    expect((await get(fixture.blobRoot, tampered)).toString()).toContain('exit 0');
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

  // A `./` prefix used to slip past every guard: `./.git/config` reached git's own
  // config — which `core.fsmonitor` turns into command execution — and
  // `./tests/existing.sh` overwrote the code under test while the engine went on
  // recording commit_sha events for a tree that was neither commit.
  test.each([
    ['../escape.sh'],
    ['/tmp/escape.sh'],
    ['.git/hooks/pre-commit'],
    ['./.git/config'],
    ['.//.git/config'],
    ['.Git/config'],
    ['sub/.git/hooks/pre-commit'],
    ['a/../../escape.sh'],
    ['.'],
    [''],
  ])('refuses to write a repro to %j', async (path) => {
    await expect(
      observe(clean(), { repro: { command: 'x', files: { [path]: 'echo hi\n' } } }),
    ).rejects.toThrow(ObservationFailed);
  });

  test.each([['./tests/existing.sh'], ['tests/./existing.sh'], ['./Tests/Existing.sh']])(
    'refuses %j, which normalises onto a committed path',
    async (path) => {
      await expect(
        observe(committedTest(), { repro: { command: 'x', files: { [path]: 'tampered\n' } } }),
      ).rejects.toThrow(/is committed/);
    },
  );

  test('a pinned path outside the repo is refused rather than silently unanchored', async () => {
    // It would read a file the commits cannot change, so intact() would hold
    // unconditionally and the pinned anchor would be quietly disarmed.
    await expect(
      observe(clean(), { repro: { command: 'x', pinned: ['../../etc/hosts'] } }),
    ).rejects.toThrow(ObservationFailed);
  });

  // Containment is proved against the base checkout, but the fix commit controls
  // the tree's shape by the time the second write happens. Each fixture leaves
  // HEAD on base so the fix-phase re-resolution is what actually fires.
  test('a redirected write is refused before it happens, not after', async () => {
    const { mkdtempSync, readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const outside = mkdtempSync(`${tmpdir()}/engine-outside-`);

    await expect(
      observe(symlinkInFix(outside, 'link'), {
        repro: { command: 'true', files: { 'link/repro.sh': 'tampered\n' } },
      }),
    ).rejects.toThrow(ObservationFailed);

    // Throwing is not enough: a guard that only fires downstream of the write
    // reports the same error while the bytes have already escaped.
    expect(readdirSync(outside)).toEqual([]);
  });

  test.each([
    ['a symlink into .git', '.git', 'link', 'link/config'],
    ['a symlink into .git at depth 2', '../.git/hooks', 'a/b', 'a/b/post-checkout'],
    ['a symlink into .git at depth 3', '../../../.git/hooks', 'd0/d1/esc', 'd0/d1/esc/post-checkout'],
  ])('the fix commit cannot redirect a write through %s', async (_label, target, at, path) => {
    // Assert on the message, not the type: a generic "could not apply repro file"
    // wrapper around ENOENT is also an ObservationFailed, and would let a fixture
    // pass without any guard having fired.
    await expect(
      observe(symlinkInFix(target, at), {
        repro: { command: 'true', files: { [path]: 'tampered\n' } },
      }),
    ).rejects.toThrow(/traverses a symlink|resolves outside the repository|into git's own state/);
  });

  test('a symlinked ancestor cannot make the engine overwrite the code under test', async () => {
    const { readFileSync } = await import('node:fs');
    const fixture = symlinkToRoot();

    // Containment holds — `t/src.txt` resolves back inside the repo — and the
    // committed-path guard compares names, which `t/src.txt` does not match.
    // Only refusing symlinked components catches this.
    await expect(
      observe(fixture, {
        repro: { command: 'grep -q right src.txt', files: { 't/src.txt': 'right\n' } },
      }),
    ).rejects.toThrow(/traverses a symlink/);

    // The forged fix must not have landed: the tracked source is untouched.
    expect(readFileSync(`${fixture.repo}/src.txt`, 'utf8')).toBe('wrong\n');
  });

  test('a tracked symlink offered as a pinned path is not read through', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const secret = `${mkdtempSync(`${tmpdir()}/engine-outside-`)}/secret.txt`;
    writeFileSync(secret, 'exfiltrated\n');

    // Reading through it would store the secret's bytes in the blob store, and
    // would disarm the pinned anchor: a target no commit can change never drifts.
    const fixture = pinnedSymlink(secret);
    await expect(
      observe(fixture, { repro: { command: 'true', pinned: ['leak.sh'] } }),
    ).rejects.toThrow(ObservationFailed);

    // Nothing was stored, so the secret never entered the evidence record.
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(fixture.blobRoot)).toEqual([]);
  });

  test('a symlink the repro command plants is caught before the next phase reads or writes it', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const outside = `${mkdtempSync(`${tmpdir()}/engine-outside-`)}/planted.txt`;
    // The target must exist, or the run aborts on a failed *read* and the write
    // path this test exists for is never reached.
    writeFileSync(outside, 'untouched\n');

    // work/ is gitignored, so the phase-boundary clean spares it by design. The
    // O_NOFOLLOW read fires first, before the fix phase could write through it —
    // which is why the O_EXCL write guard has no reachable fixture of its own.
    await expect(
      observe(gitignoredWorkDir(), { repro: REPRO_PLANTING_SYMLINK(outside) }),
    ).rejects.toThrow(ObservationFailed);

    expect(readFileSync(outside, 'utf8')).toBe('untouched\n');
  });

  test('a missing pinned path is an ObservationFailed, not a raw fs error', async () => {
    await expect(
      observe(clean(), { repro: { command: 'x', pinned: ['tests/nope.sh'] } }),
    ).rejects.toThrow(ObservationFailed);
  });
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

/**
 * Failing to observe is not a reason to destroy what was observed.
 *
 * The engine still throws — a caller must never mistake "could not look" for
 * "looked and saw nothing wrong" — but the error now carries the real events that
 * preceded it, so a run that dies halfway leaves a record instead of a silence.
 */
describe('an abort keeps what was already observed', () => {
  const abortOf = async (promise: Promise<unknown>): Promise<ObservationFailed> => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ObservationFailed);
    return error as ObservationFailed;
  };

  const abortOn = (events: RunEvent[]) => events.at(-1)!.payload as VerificationAbortedV1;

  test('a fix phase that never returns still leaves the base observation on the record', async () => {
    const fixture = clean();
    const error = await abortOf(observe(fixture, { repro: HANGS_ON_FIX, timeoutMs: 2_000 }));

    expect(error.observed.map((e) => e.type)).toEqual([
      'REPRO_REGISTERED',
      'TEST_RUN',
      'VERIFICATION_ABORTED',
    ]);
    expect(basePhase(error.observed)).toMatchObject({ exit_code: 1, symptom_matched: true });

    // The exit code and the symptom flag are trivially forgeable, so asserting
    // them proves only that *something* was written. Resolving the artifact does
    // the real work: these are the bytes the base run actually produced, and a
    // stub invented by the abort handler could not satisfy it.
    const output = await get(fixture.blobRoot, basePhase(error.observed).stdout_hash);
    expect(output.toString()).toContain('wrong');
    expect(registration(error.observed).command).toBe('sh repro.sh');

    expect(abortOn(error.observed).phase).toBe('fix');
    expect(abortOn(error.observed).reason).toMatch(/exceeded 2000ms/);
    // The abort continues the log rather than restarting it: a consumer appending
    // these must not collide with the seq the base observation already took.
    expect(error.observed.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  test('a partial run is still not a reproduction', async () => {
    const error = await abortOf(observe(clean(), { repro: HANGS_ON_FIX, timeoutMs: 2_000 }));
    // Red with no green is not red-then-green, and the abort must not paper over
    // the missing half.
    expect(conclude(error.observed).reproduced).toBe(false);
  });

  /**
   * The dangerous shape, and the reason the fold consults the abort record at all.
   *
   * Here the fix DOES go green — once — and then the re-run hangs. Everything the
   * fold can count looks like a clean reproduction: a red base matching the
   * symptom, a green fix, repro hashes intact throughout. Only the truncation
   * gives it away, and nothing in the log says how many re-runs there should have
   * been. Credit this and the flake-survival criterion belongs to the agent.
   */
  test('a fix that goes green once and then stops being observable is NOT reproduced', async () => {
    const error = await abortOf(
      observe(clean(), { repro: HANGS_ON_FLAKE_RERUN, timeoutMs: 2_000, flakeRuns: 2 }),
    );

    // The trap is real: a green fix run is on the record, and the series is short.
    expect(fixPhases(error.observed).map((r) => r.exit_code)).toEqual([0]);
    expect(basePhase(error.observed)).toMatchObject({ exit_code: 1, symptom_matched: true });
    expect(abortOn(error.observed).phase).toBe('fix');

    expect(conclude(error.observed).reproduced).toBe(false);
  });

  test('an abort in a later attempt cannot rescue an attempt that was fully observed', async () => {
    // The disqualification is scoped to its own attempt, or one bad attempt would
    // erase a good one — and `reproduced` scans the whole history.
    const events = await observe(clean(), { flakeRuns: 0 });
    const withLateAbort: RunEvent[] = [
      ...events,
      {
        run_id: RUN_ID,
        seq: events.length + 1,
        ts: new Date().toISOString(),
        type: 'VERIFICATION_ABORTED',
        payload: { v: 1, phase: 'fix', reason: 'ObservationFailed: a later attempt died' },
      },
    ];
    // Folded inside ONE attempt, the abort shares it and disqualifies it.
    expect(conclude(withLateAbort).reproduced).toBe(false);
    // Given its own attempt, the first attempt's verdict stands.
    expect(
      fold([
        { run_id: RUN_ID, seq: 1, ts: 'T', type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } },
        ...events.map((e, i) => ({ ...e, seq: i + 2 })),
        {
          run_id: RUN_ID,
          seq: events.length + 2,
          ts: 'T',
          type: 'ATTEMPT_STARTED',
          payload: { v: 1, n: 2 },
        },
        {
          run_id: RUN_ID,
          seq: events.length + 3,
          ts: 'T',
          type: 'VERIFICATION_ABORTED',
          payload: { v: 1, phase: 'fix', reason: 'ObservationFailed: attempt 2 died' },
        },
      ]).reproduced,
    ).toBe(true);
  });

  test('a setup failure aborts with nothing before it, since nothing was observed', async () => {
    const fixture = clean();
    writeFileSync(`${fixture.repo}/stray.txt`, 'uncommitted\n');
    const error = await abortOf(observe(fixture));

    expect(error.observed.map((e) => e.type)).toEqual(['VERIFICATION_ABORTED']);
    expect(abortOn(error.observed).phase).toBe('setup');
  });

  test('a base phase that never returns is labelled base, not setup', async () => {
    const error = await abortOf(observe(clean(), { repro: HANGS_ON_BASE, timeoutMs: 2_000 }));

    expect(error.observed.map((e) => e.type)).toEqual(['REPRO_REGISTERED', 'VERIFICATION_ABORTED']);
    expect(abortOn(error.observed).phase).toBe('base');
  });

  test('a ref that cannot be diffed is labelled diff — every run had already finished', async () => {
    // Unrelated roots: each phase runs and is recorded, then `git diff a...b`
    // fails for want of a merge base.
    const error = await abortOf(observe(unrelatedHistories(), { flakeRuns: 0 }));

    expect(error.observed.map((e) => e.type)).toEqual([
      'REPRO_REGISTERED',
      'TEST_RUN',
      'TEST_RUN',
      'VERIFICATION_ABORTED',
    ]);
    expect(abortOn(error.observed).phase).toBe('diff');
  });

  // Root ignores the permission bits the fixture relies on.
  test.skipIf(process.getuid?.() === 0)(
    'a failed tidy-up is labelled cleanup, and does not void what was observed',
    async () => {
      // Every phase completed and every fact was observed; only the postcondition
      // failed. Called `diff` this would tell an orchestrator to retry a run that
      // already produced valid evidence — and the retry would die immediately on
      // the dirty-tree refusal, because the tidy-up is what failed.
      const fixture = clean();
      try {
        const error = await abortOf(
          observe(fixture, { repro: LOCKS_THE_TREE_ON_FIX, flakeRuns: 0 }),
        );

        expect(error.observed.map((e) => e.type)).toEqual([
          'REPRO_REGISTERED',
          'TEST_RUN',
          'TEST_RUN',
          'FIX_DIFF_OBSERVED',
          'VERIFICATION_ABORTED',
        ]);
        expect(abortOn(error.observed).phase).toBe('cleanup');
        // The reproduction stands: nothing about it was left unobserved.
        expect(conclude(error.observed).reproduced).toBe(true);
      } finally {
        // The fixture defeats `git clean`, so it defeats the temp-dir teardown too.
        chmodSync(`${fixture.repo}/locked`, 0o700);
      }
    },
  );

  test('the reason is bounded: the agent chose the text it quotes', async () => {
    // The message embeds the repro path verbatim, and the event channel is one
    // JSON object per line — so an unbounded reason is an unbounded line.
    const error = await abortOf(
      observe(clean(), { repro: { command: 'true', files: { [`../${'a'.repeat(10_000)}`]: 'x' } } }),
    );
    const { reason } = error.observed[0]!.payload as VerificationAbortedV1;

    // Pinned to the constant, so a wrong bound is caught rather than "short enough".
    expect(reason.length).toBe(MAX_REASON_CHARS + '… (truncated)'.length);
    // And truncation must keep the beginning. Discarding the text and emitting the
    // marker alone would satisfy a length check while destroying the diagnosis.
    expect(reason.startsWith('ObservationFailed: repro path escapes the repository: ../aaa')).toBe(
      true,
    );
    expect(reason.endsWith('… (truncated)')).toBe(true);
  });

  test('a bug in the engine is not dressed up as an abort', async () => {
    // Only "I could not look" earns an event. A TypeError means the engine is
    // broken, and turning that into a plausible VERIFICATION_ABORTED would put a
    // fabricated record on the log — the one failure this project cannot have.
    //
    // Asserting the error TYPE is not enough: with the guard removed the throw is
    // still a TypeError, it just acquires an invented event first. The claim is
    // about the payload, so that is what is checked.
    const error = await observe(clean(), { symptomPattern: undefined as unknown as RegExp }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(TypeError);
    expect((error as { observed?: RunEvent[] }).observed).toBeUndefined();
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
