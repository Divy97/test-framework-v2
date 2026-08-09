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

  // One table, not three near-identical tests. Each of these is a single flag on
  // the push, indistinguishable from noise to a future reader, and a tidy-up that
  // drops one would otherwise go green everywhere.
  test.each([
    ['push.followTags', '[push]\n\tfollowTags = true\n'],
    ['push.gpgSign', '[push]\n\tgpgSign = true\n'],
    ['core.hooksPath with a pre-push hook', null],
  ])('ignores an ambient %s', async (_label, contents) => {
    const fixture = repo();
    execFileSync('git', ['-C', fixture.path, 'tag', '-a', 'v1', '-m', 'v1', fixture.base]);
    const out = join(dir('agent'), 'a');

    const home = dir('home');
    const config = join(home, '.gitconfig');
    if (contents === null) {
      const hooks = dir('hooks');
      writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      writeFileSync(config, `[core]\n\thooksPath = ${hooks}\n`);
    } else {
      writeFileSync(config, contents);
    }

    // `GIT_CONFIG_GLOBAL`, not `HOME` alone. Git resolves global config through
    // that variable INSTEAD of `$HOME/.gitconfig` when it is set, and it is the
    // standard way tooling isolates git — so a test that only sets `HOME` stops
    // injecting anything on such a machine, and then passes whether or not the
    // flag that makes it pass is there at all. Review demonstrated exactly that:
    // guard removed, ambient GIT_CONFIG_GLOBAL, all four green.
    const before = { ...process.env };
    process.env.HOME = home;
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    try {
      // The test proves its own premise. Without this it can pass for the reason
      // it is meant to detect — a safety net that cannot fail is worse than none,
      // because it is read as one.
      expect(
        execFileSync('git', ['config', '--get', _label.split(' ')[0]!], { encoding: 'utf8' }).trim(),
      ).not.toBe('');
      await buildAgentSource(mirror(fixture.path), fixture.base, out);
    } finally {
      // Restoring from a captured value writes the literal string "undefined"
      // when the variable was unset, poisoning it for every later test in this
      // worker.
      if (before.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = before.HOME;
      delete process.env.GIT_CONFIG_GLOBAL;
      delete process.env.GIT_CONFIG_SYSTEM;
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
