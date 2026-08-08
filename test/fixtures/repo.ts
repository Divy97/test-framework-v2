// Generated two-commit git repos: base is the bug, fix is what an agent claims
// fixes it. Tiny on purpose — these are the engine's unit fixtures, not the
// demo app. The adversarial ones are the point: an engine that only handles
// clean red -> green proves nothing.
//
// The reproduction itself is NOT committed here. It is applied by the engine to
// both checkouts (see ReproSpec), which is what stops the fix commit from
// rewriting the test that judges it. The fixtures that used to tamper with a
// committed repro now attack what the repro *invokes* instead — the same attack,
// one level down, and still open.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ReproSpec } from '../../src/verify.js';

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
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, name)), { recursive: true });
      writeFileSync(join(repo, name), body);
    }
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

/**
 * The standard applied reproduction: reads the source under test and fails on it,
 * so a red base means the bug rather than an echo. Written by the engine over
 * both checkouts, never committed.
 *
 * Applied files land 0644, so the repro is invoked through an interpreter rather
 * than executed directly.
 */
export const APPLIED_REPRO: ReproSpec = {
  command: 'sh repro.sh',
  files: { 'repro.sh': 'cat src.txt\ngrep -q right src.txt\n' },
};

/** Clean red -> green. The only case where every check should be satisfied. */
export const clean = () => makeRepo({ 'src.txt': 'wrong\n' }, { 'src.txt': 'right\n' });

/**
 * A genuine fix whose repro output never echoes the words the human used.
 *
 * NOT an agent behaving badly — the fix is real and the base failed for the real
 * reason. This is the false-positive risk of the symptom check itself, and the
 * most common real shape: a human reports "the total is wrong", the suite prints
 * `AssertionError: assert 42 == 40`. It is here to keep that cost visible.
 */
export const NOISY_REPRO: ReproSpec = {
  command: 'sh repro.sh',
  files: { 'repro.sh': 'echo "assert 42 == 40"\ngrep -q right src.txt\n' },
};

/**
 * The repro needs a helper that only exists in the fix commit, so on base it
 * errors before testing anything. Applying the repro to both checkouts makes this
 * MORE likely, not less: the file now exists on base and fails at load instead of
 * being absent. Exit code alone calls it a red base; only the symptom disagrees.
 */
export const REPRO_NEEDING_FIX_HELPER: ReproSpec = {
  command: 'sh repro.sh',
  files: { 'repro.sh': '. ./helper.sh\ncheck_answer\n' },
};

export const helperOnlyInFix = () =>
  makeRepo(
    { 'src.txt': 'wrong\n' },
    { 'src.txt': 'right\n', 'helper.sh': 'check_answer() { grep -q right src.txt; }\n' },
  );

/**
 * The fix passes, fails, then passes. The counter is untracked, so it survives
 * the fix-phase re-runs (which share a working tree by design) but not the phase
 * boundary scrub.
 */
export const FLAKY_REPRO: ReproSpec = {
  command: 'sh repro.sh',
  files: {
    'repro.sh':
      'cat src.txt\ngrep -q right src.txt || exit 1\n' +
      'n=$(cat .runs 2>/dev/null || echo 0)\nn=$((n+1))\necho "$n" > .runs\necho "run $n"\n[ "$n" != "2" ]\n',
  },
};

/**
 * Gaming, ported down a level. The fix commit cannot touch the applied repro, so
 * it rewrites the helper the repro sources — the assertion is neutered without a
 * byte of the reproduction changing. Applying the repro raises the bar; it does
 * not end the game.
 */
export const REPRO_VIA_HELPER: ReproSpec = {
  command: 'sh repro.sh',
  files: { 'repro.sh': 'cat src.txt\n. ./helper.sh\ncheck_answer\n' },
};

export const helperTampering = () =>
  makeRepo(
    { 'src.txt': 'wrong\n', 'helper.sh': 'check_answer() { grep -q right src.txt; }\n' },
    { 'helper.sh': 'check_answer() { return 0; }\n' },
  );

/**
 * The fix rewrites the applied reproduction at run time — a pretest hook in
 * spirit. The engine hashes what it wrote, so only re-hashing after each run
 * catches it. Note the mutation lands during run 0, which means re-runs 1 and 2
 * execute the weakened version and report green.
 */
export const SELF_REWRITING_REPRO: ReproSpec = {
  command: 'sh runner.sh',
  files: {
    'runner.sh': 'sh mutate.sh 2>/dev/null || true\nsh repro.sh\n',
    'repro.sh': 'cat src.txt\ngrep -q right src.txt\n',
  },
};

export const rewritesTheRepro = () =>
  makeRepo(
    { 'src.txt': 'wrong\n' },
    { 'src.txt': 'wrong\n', 'mutate.sh': 'echo "exit 0" > repro.sh\n' },
  );

/**
 * The BASE commit rewrites the reproduction mid-run. The base still fails for the
 * reported reason, and the fix is genuinely green — so nothing except the base
 * run's own repro hash distinguishes this from a clean reproduction.
 */
export const rewritesTheReproOnBase = () =>
  makeRepo(
    { 'src.txt': 'wrong\n', 'mutate.sh': 'echo "# tampered" >> repro.sh\n' },
    { 'src.txt': 'right\n', 'mutate.sh': 'true\n' },
  );

/**
 * The FIX commit ships a symlink at `link`, so the redirect only exists once the
 * engine switches phases. HEAD is left on the BASE commit: otherwise the up-front
 * guard fires before the base phase and the fix-phase re-resolution — the thing
 * under test — never runs at all.
 */
export const symlinkInFix = (target: string, at = 'link') => {
  const fixture = makeRepo({ 'src.txt': 'wrong\n' }, { 'src.txt': 'right\n' });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture.repo });
  mkdirSync(dirname(join(fixture.repo, at)), { recursive: true });
  execFileSync('ln', ['-s', target, join(fixture.repo, at)]);
  git('add', '.');
  git('commit', '--quiet', '-m', 'fix: add a symlink');
  fixture.fix = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: fixture.repo,
    encoding: 'utf8',
  }).trim();
  git('checkout', '--quiet', fixture.base);
  return fixture;
};

/**
 * A tracked symlink pointing outside the repo, offered as a pinned repro path.
 * Built commit-by-commit rather than by amending: amending the base detaches the
 * fix commit from it, and the run would then fail on a missing merge base — a
 * throw that has nothing to do with the symlink under test.
 */
export const pinnedSymlink = (target: string): Fixture => {
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
  execFileSync('ln', ['-s', target, join(repo, 'leak.sh')]);
  git('add', '.');
  git('commit', '--quiet', '-m', 'base: the bug');
  const base = head();

  writeFileSync(join(repo, 'src.txt'), 'right\n');
  git('commit', '--quiet', '-am', 'fix: the claim');
  return { repo, base, fix: head(), blobRoot };
};

/**
 * The repro command itself plants a symlink where the next phase will write. The
 * directory is gitignored, so the phase-boundary clean deliberately spares it —
 * no race needed, just the arbitrary shell the design already assumes is hostile.
 */
export const REPRO_PLANTING_SYMLINK = (target: string): ReproSpec => ({
  command: 'rm -f work/repro.sh; ln -s ' + target + ' work/repro.sh; exit 1',
  files: { 'work/repro.sh': 'exit 1\n' },
});

export const gitignoredWorkDir = () =>
  makeRepo({ 'src.txt': 'wrong\n', '.gitignore': 'work/\n' }, { 'src.txt': 'right\n' });

/** Base already passes: nothing was reproduced, so no fix should ever be credited. */
export const irreproducible = () => makeRepo({ 'src.txt': 'right\n' }, { 'notes.md': 'nope\n' });

/**
 * The reproduction is a test the repo already contains, authored before the fix.
 * Nothing is applied, so tampering cannot be prevented — only detected, by
 * hashing the pinned path at base and after every run.
 */
export const PINNED_REPRO: ReproSpec = {
  command: 'sh tests/existing.sh',
  pinned: ['tests/existing.sh'],
};

export const committedTest = () =>
  makeRepo(
    { 'src.txt': 'wrong\n', 'tests/existing.sh': 'cat src.txt\ngrep -q right src.txt\n' },
    { 'src.txt': 'right\n' },
  );

/** The fix rewrites the committed test it is judged by. Detectable, not preventable. */
export const pinnedTampering = () =>
  makeRepo(
    { 'src.txt': 'wrong\n', 'tests/existing.sh': 'cat src.txt\ngrep -q right src.txt\n' },
    { 'tests/existing.sh': 'cat src.txt\nexit 0\n' },
  );

/** A changed path git would C-quote and escape unless asked not to. */
export const nonAsciiPath = () =>
  makeRepo({ 'src.txt': 'wrong\n', 'café.txt': 'a\n' }, { 'src.txt': 'right\n', 'café.txt': 'b\n' });

/**
 * The base run poisons the working tree two ways: it writes an untracked file and
 * it edits a tracked file both commits share. Neither may reach the fix phase.
 */
export const RESIDUE_REPRO: ReproSpec = {
  command: 'sh repro.sh',
  files: {
    'repro.sh':
      'cat src.txt\n' +
      'test -f residue.txt && echo RESIDUE_SURVIVED\n' +
      'test "$(cat shared.txt)" = pristine || echo TRACKED_POISONED\n' +
      'echo poison > residue.txt\n' +
      'echo poisoned > shared.txt\n' +
      'grep -q right src.txt\n',
  },
};

export const residueFromBase = () =>
  makeRepo({ 'src.txt': 'wrong\n', 'shared.txt': 'pristine\n' }, { 'src.txt': 'right\n' });

/**
 * The fix does not descend from the base: both branch off a shared root, and the
 * base side carries an unrelated commit. A two-dot range would report that
 * unrelated file as something the fix touched.
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
