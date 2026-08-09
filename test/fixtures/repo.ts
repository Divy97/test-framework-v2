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

/**
 * Fails fast on base for the reported reason, then hangs forever on the fix.
 *
 * The only shape that makes the engine stop observing *after* it has already
 * observed something real — which is exactly the case the abort event exists for.
 * Every other failure-to-observe in the suite fires during setup, when there is
 * nothing yet to lose.
 *
 * It spins in the shell rather than calling `sleep`, and that is not a stylistic
 * choice: the engine's timeout kills the shell, not the process group, so a
 * `sleep` here is orphaned and outlives the run. This fixture would litter the
 * developer's machine on every pass — and, in the engine proper, a survivor keeps
 * executing while the *next* phase is being judged. That defect is real and
 * predates this fixture; it gets its own change rather than being smuggled in
 * here, and until then this hangs in a way that dies when it is killed.
 */
export const HANGS_ON_FIX: ReproSpec = {
  command: 'sh repro.sh',
  files: { 'repro.sh': 'cat src.txt\ngrep -q right src.txt || exit 1\nwhile :; do :; done\n' },
};

/** Hangs immediately, so the run stops with nothing observed at all. Pins `phase: 'base'`. */
export const HANGS_ON_BASE: ReproSpec = {
  command: 'sh repro.sh',
  files: { 'repro.sh': 'while :; do :; done\n' },
};

/**
 * Passes the first fix run and hangs on the flake re-run — the shape that turns
 * the abort into a way of *gaming* the gate rather than merely losing evidence.
 *
 * Nothing in the log says how many re-runs there should have been, so a
 * truncated series looks exactly like a complete one to anyone counting passes.
 * An agent authoring this repro gets red-then-green off a single green run and
 * the flake-survival criterion never executes. The counter is untracked, so it
 * survives the shared fix-phase worktree but is scrubbed at the phase boundary —
 * which is why the base run never reaches it.
 */
export const HANGS_ON_FLAKE_RERUN: ReproSpec = {
  command: 'sh repro.sh',
  files: {
    'repro.sh':
      'cat src.txt\ngrep -q right src.txt || exit 1\n' +
      'n=$(cat .runs 2>/dev/null || echo 0)\nn=$((n+1))\necho "$n" > .runs\n' +
      '[ "$n" = 2 ] && while :; do :; done\nexit 0\n',
  },
};

/**
 * Makes the postcondition tidy-up fail, and only the tidy-up.
 *
 * The unremovable directory is created solely on the fix commit, so the
 * phase-boundary scrub never meets it and the diff — which only reads committed
 * trees — still succeeds. `git clean -dff` is then the first thing that cannot
 * do its job, on a run where every phase completed and every fact was observed.
 *
 * Useless as root, which ignores the permission bits; the caller skips it there.
 */
export const LOCKS_THE_TREE_ON_FIX: ReproSpec = {
  command: 'sh repro.sh',
  files: {
    'repro.sh':
      'cat src.txt\ngrep -q right src.txt || exit 1\n' +
      'mkdir -p locked && : > locked/f && chmod 500 locked\n',
  },
};

/**
 * Two unrelated root commits. Every phase runs, and then `git diff base...fix`
 * fails outright for want of a merge base — the only way to reach a `diff`-phase
 * abort without breaking git itself.
 */
export function unrelatedHistories(): Fixture {
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
  git('commit', '--quiet', '-m', 'base: the bug');
  const base = head();

  // --orphan gives a second root with no ancestry in common.
  git('checkout', '--quiet', '--orphan', 'other');
  writeFileSync(join(repo, 'src.txt'), 'right\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'fix: an unrelated root');
  const fix = head();

  git('checkout', '--quiet', base);
  return { repo, base, fix, blobRoot };
}

/**
 * A committed test whose result depends on a process outside the repository.
 *
 * The fix commit touches one unrelated file, so nothing about the code under
 * test changes. The test is maintainer-authored, `pinned`, and byte-identical on
 * every run — the strongest provenance ADR-0008 recognises. Everything the
 * engine checks is therefore satisfied, and the verdict is decided entirely by
 * whether something outside the repo flips the marker between phases.
 *
 * It signals through /dev/shm rather than $TMPDIR precisely because a private
 * TMPDIR does not close this: the survivor runs as the repro user and could
 * write the phases' own directories just as easily.
 */
export const survivorGamed = () =>
  makeRepo(
    {
      'src.txt': 'wrong\n',
      'tests/existing.sh':
        'echo x >> /dev/shm/beacon\n' +
        '[ -f /dev/shm/marker ] && exit 0\n' +
        'echo "wrong: still broken"\n' +
        'exit 1\n',
    },
    { 'README.md': 'an unrelated change\n' },
  );

/**
 * Red the first time it runs and green every time after, on a flag it keeps
 * OUTSIDE the repository.
 *
 * The simplest possible fabrication, and the one the anchor cannot touch: the
 * bytes are identical across both checkouts and hash identically on every run,
 * so ADR-0008 is fully satisfied. The anchor fixes the reproduction's bytes; it
 * says nothing about its side effects. The git scrub at the phase boundary
 * cleans the tree and only the tree, so base and fix share a TMPDIR — and one
 * flag is the whole attack.
 *
 * Pair it with `noOpFix()` and the fix commit does not touch the code at all.
 */
export const ORDER_DEPENDENT_REPRO: ReproSpec = {
  command: 'sh repro.sh',
  files: {
    'repro.sh':
      'flag="${TMPDIR:-/tmp}/.seen"\n' +
      'cat src.txt\n' +
      'if [ -f "$flag" ]; then exit 0; fi\n' +
      'touch "$flag"\n' +
      'grep -q right src.txt\n',
  },
};

/** The bug is untouched; the "fix" edits an unrelated file. */
export const noOpFix = () =>
  makeRepo({ 'src.txt': 'wrong\n' }, { 'README.md': 'an unrelated change\n' });

/**
 * The same order-dependent trick, with the flag inside the repo — in a directory
 * `.gitignore` already covers.
 *
 * `git clean -dff` spares ignored files by design, because they are usually
 * installed dependencies. Between the phases of one repo that reasoning does not
 * hold: `node_modules/`, `dist/` and `coverage/` are ignored in every real
 * repository, and each is simply the easiest place for the base run to leave a
 * flag the fix run reads.
 */
export const IGNORED_PATH_REPRO: ReproSpec = {
  command: 'sh repro.sh',
  files: {
    'repro.sh':
      'flag=node_modules/.seen\n' +
      'cat src.txt\n' +
      'if [ -f "$flag" ]; then exit 0; fi\n' +
      'mkdir -p node_modules && touch "$flag"\n' +
      'grep -q right src.txt\n',
  },
};

export const noOpFixWithIgnores = () =>
  makeRepo(
    { 'src.txt': 'wrong\n', '.gitignore': 'node_modules/\n' },
    { 'README.md': 'an unrelated change\n' },
  );

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

/**
 * The whole fix is one symlink: `t -> .`. An applied path of `t/src.txt` matches
 * nothing tracked by name, passes containment (it resolves back inside the repo),
 * and lands on the tracked `src.txt` — so the engine itself writes the agent's
 * bytes over the code it is judging, and credits the result.
 */
export const symlinkToRoot = (): Fixture => {
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
  git('commit', '--quiet', '-m', 'base: the bug');
  const base = head();

  execFileSync('ln', ['-s', '.', join(repo, 't')]);
  git('add', '.');
  git('commit', '--quiet', '-m', 'fix: ship a symlink and nothing else');
  const fix = head();
  git('checkout', '--quiet', base);
  return { repo, base, fix, blobRoot };
};

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
