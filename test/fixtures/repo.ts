// Generated two-commit git repos: base is the bug, fix is what an agent claims
// fixes it. Tiny on purpose — these are the engine's unit fixtures, not the
// demo app. The adversarial ones are the point: an engine that only handles
// clean red -> green proves nothing.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Fixture = { repo: string; base: string; fix: string; blobRoot: string };

const created: string[] = [];

/** Remove every temp dir this module made. Call from afterEach. */
export function cleanupFixtures(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** `fixFiles` is layered over the base commit, so it names exactly what the fix touched. */
export function makeRepo(
  baseFiles: Record<string, string>,
  fixFiles: Record<string, string>,
): Fixture {
  const repo = mkdtempSync(join(tmpdir(), 'engine-fixture-'));
  const blobRoot = mkdtempSync(join(tmpdir(), 'engine-blobs-'));
  created.push(repo, blobRoot);

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  const head = () =>
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const write = (files: Record<string, string>) => {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body);
  };

  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture');

  write(baseFiles);
  git('add', '.');
  git('commit', '--quiet', '-m', 'base: the bug');
  const base = head();

  write(fixFiles);
  git('add', '.');
  git('commit', '--quiet', '-m', 'fix: the claim');
  const fix = head();

  return { repo, base, fix, blobRoot };
}

/** The repro every fixture runs. Its body is committed, so a fix can tamper with it. */
export const REPRO_COMMAND = 'sh repro.sh';

/** Reads the source under test and fails on it — so a red base means the bug, not an echo. */
const failingRepro = 'cat src.txt\ngrep -q right src.txt\n';

/** Clean red -> green. The only case where every check should be satisfied. */
export const clean = () =>
  makeRepo({ 'src.txt': 'wrong\n', 'repro.sh': failingRepro }, { 'src.txt': 'right\n' });

/**
 * A genuine fix whose repro output never echoes the words the human used.
 *
 * NOT an agent behaving badly — the fix is real and the base failed for the real
 * reason. This is the false-positive risk of the symptom check itself, and the
 * most common real shape: a human reports "the total is wrong", the suite prints
 * `AssertionError: assert 42 == 40`. It is here to keep that cost visible.
 */
export const noisySymptom = () =>
  makeRepo(
    { 'src.txt': 'wrong\n', 'repro.sh': 'echo "assert 42 == 40"\ngrep -q right src.txt\n' },
    { 'src.txt': 'right\n' },
  );

/**
 * The base run errors before it ever tests anything — the regression test exists
 * only in the fix commit, so on base the runner exits 127 having asserted nothing.
 * Exit code alone calls this a red base; only the symptom tells the truth.
 */
export const wrongReasonFailure = () =>
  makeRepo(
    { 'src.txt': 'wrong\n', 'repro.sh': 'sh test_bug.sh\n' },
    { 'src.txt': 'right\n', 'test_bug.sh': 'cat src.txt\ngrep -q right src.txt\n' },
  );

/**
 * The fix passes, fails, then passes. The fix commit touches ONLY the source —
 * decontaminated on purpose, so this exercises the flake signal and nothing else.
 * The counter is untracked, so it survives the fix-phase re-runs (which share a
 * working tree by design) but not the phase boundary clean.
 */
export const flakyFix = () => makeRepo({ 'src.txt': 'wrong\n', 'repro.sh': flakyRepro }, { 'src.txt': 'right\n' });

// On base the grep fails and the script exits before the counter exists, so the
// base is red for the real reason. Only once the source is fixed does the counter
// run, failing the second execution.
const flakyRepro =
  'cat src.txt\ngrep -q right src.txt || exit 1\n' +
  'n=$(cat .runs 2>/dev/null || echo 0)\nn=$((n+1))\necho "$n" > .runs\necho "run $n"\n[ "$n" != "2" ]\n';

/** Red then green, achieved by weakening the test and never touching the source. */
export const gamingAttempt = () =>
  makeRepo(
    { 'src.txt': 'wrong\n', 'repro.sh': failingRepro },
    { 'repro.sh': 'cat src.txt\nexit 0\n' },
  );

/**
 * The one that defeats a naive overlap check: the fix weakens the repro AND makes
 * a cosmetic edit to the source. `changed_files` then intersects the repro path,
 * so "the diff touched the code under test" returns the wrong answer. Real agents
 * touch source and test in the same commit, so the singleton diff in
 * `gamingAttempt` is the easy case, not the representative one.
 */
export const collateralGaming = () =>
  makeRepo(
    { 'src.txt': 'wrong\n', 'repro.sh': failingRepro },
    { 'src.txt': 'wrong\n\n', 'repro.sh': 'cat src.txt\nexit 0\n' },
  );

/**
 * The base run poisons the working tree two ways: it writes an untracked file and
 * it edits a tracked file both commits share. Neither may reach the fix phase —
 * but residue must still survive *between* fix re-runs, which is what makes the
 * flake signal meaningful.
 */
export const residueFromBase = () =>
  makeRepo(
    { 'src.txt': 'wrong\n', 'shared.txt': 'pristine\n', 'repro.sh': residueRepro },
    { 'src.txt': 'right\n' },
  );

const residueRepro =
  'cat src.txt\n' +
  'test -f residue.txt && echo RESIDUE_SURVIVED\n' +
  'test "$(cat shared.txt)" = pristine || echo TRACKED_POISONED\n' +
  'echo poison > residue.txt\n' +
  'echo poisoned > shared.txt\n' +
  'grep -q right src.txt\n';

/**
 * The base prints the symptom and *then* dies by signal. Every other signal
 * points at a reproduction — the symptom matched, the fix went green — so only
 * the crash itself can disqualify it.
 */
export const crashingBase = () =>
  makeRepo(
    { 'src.txt': 'wrong\n', 'repro.sh': 'cat src.txt\nkill -9 $$\n' },
    { 'src.txt': 'right\n', 'repro.sh': failingRepro },
  );

/** A changed path git would C-quote and escape unless asked not to. */
export const nonAsciiPath = () =>
  makeRepo(
    { 'src.txt': 'wrong\n', 'café.txt': 'a\n', 'repro.sh': failingRepro },
    { 'src.txt': 'right\n', 'café.txt': 'b\n' },
  );

/**
 * The fix does not descend from the base: both branch off a shared root, and the
 * base side carries an unrelated commit. A two-dot range would report that
 * unrelated file as something the fix touched, inflating the overlap check with
 * paths the fix never went near.
 */
export function divergentHistory(): Fixture {
  const repo = mkdtempSync(join(tmpdir(), 'engine-fixture-'));
  const blobRoot = mkdtempSync(join(tmpdir(), 'engine-blobs-'));
  created.push(repo, blobRoot);

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  const head = () =>
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture');

  writeFileSync(join(repo, 'src.txt'), 'wrong\n');
  writeFileSync(join(repo, 'repro.sh'), failingRepro);
  git('add', '.');
  git('commit', '--quiet', '-m', 'root');
  const root = head();

  writeFileSync(join(repo, 'base_only.txt'), 'unrelated work on the base side\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'base: unrelated');
  const base = head();

  git('checkout', '--quiet', '-b', 'fix-side', root);
  writeFileSync(join(repo, 'src.txt'), 'right\n');
  git('commit', '--quiet', '-am', 'fix: the claim');
  const fix = head();

  return { repo, base, fix, blobRoot };
}

/** Base already passes: nothing was reproduced, so no fix should ever be credited. */
export const irreproducible = () =>
  makeRepo({ 'src.txt': 'right\n', 'repro.sh': failingRepro }, { 'notes.md': 'could not repro\n' });
