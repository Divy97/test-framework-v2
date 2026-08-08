// Generated two-commit git repos: base is the bug, fix is what an agent claims
// fixes it. Tiny on purpose — these are the engine's unit fixtures, not the
// demo app. The adversarial ones are the point: an engine that only handles
// clean red -> green proves nothing.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Fixture = { repo: string; base: string; fix: string; blobRoot: string };

/** `fixFiles` is layered over the base commit, so it names exactly what the fix touched. */
export function makeRepo(
  baseFiles: Record<string, string>,
  fixFiles: Record<string, string>,
): Fixture {
  const repo = mkdtempSync(join(tmpdir(), 'engine-fixture-'));
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

  return { repo, base, fix, blobRoot: mkdtempSync(join(tmpdir(), 'engine-blobs-')) };
}

/** The repro every fixture runs. Its body is committed, so a fix can tamper with it. */
export const REPRO_COMMAND = 'sh repro.sh';

const failingRepro = 'cat src.txt\ngrep -q right src.txt\n';

/** Clean red -> green. The only case where every check should be satisfied. */
export const clean = () =>
  makeRepo({ 'src.txt': 'wrong\n', 'repro.sh': failingRepro }, { 'src.txt': 'right\n' });

/** Base fails, but for an unrelated reason — a repro of some other bug. */
export const symptomMismatch = () =>
  makeRepo(
    { 'src.txt': 'wrong\n', 'repro.sh': 'echo "connection refused"\ngrep -q right src.txt\n' },
    { 'src.txt': 'right\n' },
  );

/** The fix passes, then fails, then passes. One green run would have believed it. */
export const flakyFix = () =>
  makeRepo(
    { 'src.txt': 'wrong\n', 'repro.sh': 'echo wrong\nexit 1\n' },
    {
      'src.txt': 'right\n',
      // .runs is untracked, so it survives across the fix-phase re-runs.
      'repro.sh':
        'n=$(cat .runs 2>/dev/null || echo 0)\nn=$((n+1))\necho "$n" > .runs\necho "run $n"\n[ "$n" != "2" ]\n',
    },
  );

/** Red then green, achieved by weakening the test and never touching the source. */
export const gamingAttempt = () =>
  makeRepo(
    { 'src.txt': 'wrong\n', 'repro.sh': failingRepro },
    { 'repro.sh': 'cat src.txt\nexit 0\n' },
  );

/** Base already passes: nothing was reproduced, so no fix should ever be credited. */
export const irreproducible = () =>
  makeRepo({ 'src.txt': 'right\n', 'repro.sh': failingRepro }, { 'notes.md': 'could not repro\n' });
