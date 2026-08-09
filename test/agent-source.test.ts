// The agent's source holds base's ancestry and NOTHING else — asserted against
// the object store, because a ref listing is what every earlier round of the
// authorship check kept believing.
//
// These run without docker on purpose. Both regressions this construction has
// had were invisible to the container suite and are provable here in
// milliseconds: a SHA-256 repository, where `git init` defaults to SHA-1 and the
// push fails outright, and a global `push.followTags`, which quietly brings
// annotated tag objects along. Verifying a repository build by running a
// container is verifying it where it is slowest and least legible.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { buildAgentSource } from '../src/orchestrate.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const dir = (name: string) => {
  const path = mkdtempSync(join(tmpdir(), `engine-${name}-`));
  made.push(path);
  return path;
};

/** base -> fix, with the fix on a branch the agent must never be able to reach. */
function repo(extra: string[] = []): { path: string; base: string; fix: string } {
  const path = dir('src');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf8' });
  git('init', '--quiet', '--initial-branch=main', ...extra);
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'fixture');
  writeFileSync(join(path, 'f'), 'wrong\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  writeFileSync(join(path, 'f'), 'right\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'the fix');
  const fix = git('rev-parse', 'HEAD').trim();
  return { path, base, fix };
}

const mirror = (from: string) => {
  const path = join(dir('mirror'), 'm');
  execFileSync('git', ['clone', '--quiet', '--no-local', '--mirror', '--', from, path]);
  return path;
};

const objects = (repoPath: string) =>
  execFileSync('git', ['-C', repoPath, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);

const refs = (repoPath: string) =>
  execFileSync('git', ['-C', repoPath, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

const has = (repoPath: string, sha: string) => {
  try {
    execFileSync('git', ['-C', repoPath, 'cat-file', '-e', sha], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe("the agent's source", () => {
  test('carries base and not the fix, by object store and not by ref listing', async () => {
    const fixture = repo();
    const out = join(dir('agent'), 'a');
    await buildAgentSource(mirror(fixture.path), fixture.base, out);

    expect(has(out, fixture.base)).toBe(true);
    expect(has(out, fixture.fix)).toBe(false);
    // Commit, tree, blob. Nothing else was ever written — the objects off base's
    // ancestry are not pruned, they are never sent.
    expect(objects(out)).toHaveLength(3);
    expect(refs(out)).toEqual(['refs/heads/main']);
  });

  test('works on a SHA-256 repository', async () => {
    // `git init` makes a SHA-1 repository whatever the source is, and pushing a
    // SHA-256 repository into one dies with "the receiving end does not support
    // this repository's hash algorithm". This broke twice: once when the history
    // was parsed with a hard-coded 40-hex regex, and again one construction
    // later, in the same commit that deleted the comment recording the first.
    const fixture = repo(['--object-format=sha256']);
    const out = join(dir('agent'), 'a');
    await buildAgentSource(mirror(fixture.path), fixture.base, out);

    expect(has(out, fixture.base)).toBe(true);
    expect(has(out, fixture.fix)).toBe(false);
    expect(objects(out)).toHaveLength(3);
  });

  test('ignores a global push.followTags', async () => {
    // `push` reads ambient config; the `clone` it replaced did not. With this set,
    // annotated tags reachable from base come along, and the postcondition then
    // reports an ordinary repository as a violation.
    const fixture = repo();
    execFileSync('git', ['-C', fixture.path, 'tag', '-a', 'v1', '-m', 'v1', fixture.base]);
    const out = join(dir('agent'), 'a');

    const home = dir('home');
    writeFileSync(join(home, '.gitconfig'), '[push]\n\tfollowTags = true\n');
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      await buildAgentSource(mirror(fixture.path), fixture.base, out);
    } finally {
      process.env.HOME = previous;
    }

    expect(refs(out)).toEqual(['refs/heads/main']);
    expect(objects(out)).toHaveLength(3);
  });

  test('finds base wherever it is reachable, not only on refs/heads', async () => {
    // `clone --bare` takes only refs/heads and tags, so a base reachable solely
    // from refs/remotes — any repository that is itself a clone — used to leave
    // the object out and die on a bare exception. Push by sha does not care.
    const fixture = repo();
    const src = mirror(fixture.path);
    execFileSync('git', ['-C', src, 'update-ref', 'refs/remotes/origin/legacy', fixture.base]);
    execFileSync('git', ['-C', src, 'update-ref', '-d', 'refs/heads/main']);
    const out = join(dir('agent'), 'a');

    await buildAgentSource(src, fixture.base, out);
    expect(has(out, fixture.base)).toBe(true);
    expect(refs(out)).toEqual(['refs/heads/main']);
  });
});
