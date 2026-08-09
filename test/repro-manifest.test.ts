// The reproduction the agent authored, read out of its commit.
//
// The manifest is the first thing in this engine an untrusted agent writes that
// the host PARSES, so every one of these is an attack on the reader rather than
// a happy path: the path becomes an argument to `git show <rev>:<path>`, which
// accepts no `--`, and the bytes become files the engine writes over both
// checkouts. Unit-level on purpose — a container proves none of this faster.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { readReproFromCommit, REPRO_MANIFEST } from '../src/orchestrate.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repo whose HEAD commit carries exactly `files`. */
function committed(files: Record<string, string>): { path: string; head: string } {
  const path = mkdtempSync(join(tmpdir(), 'engine-manifest-'));
  made.push(path);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf8' });
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'agent');
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), body);
  }
  git('add', '.');
  git('commit', '--quiet', '-m', 'the reproduction');
  return { path, head: git('rev-parse', 'HEAD').trim() };
}

const manifest = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

describe('the reproduction the agent committed', () => {
  test('names paths and a command; the engine reads the bytes itself', async () => {
    const repo = committed({
      [REPRO_MANIFEST]: manifest({ command: 'sh repro.sh', files: ['repro.sh'] }),
      'repro.sh': 'grep -q right src.txt\n',
    });

    const spec = await readReproFromCommit(repo.path, repo.head);
    expect(spec.command).toBe('sh repro.sh');
    // The BYTES, read out of the commit — not a hash the manifest asserted. A
    // manifest hash would be testimony wearing an evidence event's shape.
    expect(spec.files).toEqual({ 'repro.sh': 'grep -q right src.txt\n' });
  });

  test('refuses a commit that carries no manifest', async () => {
    const repo = committed({ 'src.txt': 'wrong\n' });
    await expect(readReproFromCommit(repo.path, repo.head)).rejects.toThrow(/committed no reproduction/);
  });

  test.each([
    ['not JSON at all', 'this is not json', /not JSON/],
    ['a JSON array', JSON.stringify([1, 2]), /not an object/],
    ['a bare string', JSON.stringify('nope'), /not an object/],
    ['no command', JSON.stringify({ files: ['repro.sh'] }), /names no command/],
    ['a blank command', JSON.stringify({ command: '   ', files: ['r'] }), /names no command/],
    ['no files', JSON.stringify({ command: 'x' }), /names no files/],
    ['an empty file list', JSON.stringify({ command: 'x', files: [] }), /names no files/],
    ['a non-string path', JSON.stringify({ command: 'x', files: [7] }), /non-string path/],
  ])('refuses a manifest that is %s', async (_label, body, expected) => {
    const repo = committed({ [REPRO_MANIFEST]: body });
    await expect(readReproFromCommit(repo.path, repo.head)).rejects.toThrow(expected);
  });

  test.each([
    ['absolute', '/etc/passwd'],
    ['parent-relative', '../../../etc/passwd'],
    ['an option', '--upload-pack=sh'],
    ['a bare dash', '-rf'],
    ['newline-injected', 'repro.sh\n--exec=sh'],
  ])('refuses %s paths before they can become a git argument', async (_label, path) => {
    const repo = committed({
      [REPRO_MANIFEST]: manifest({ command: 'x', files: [path] }),
      'repro.sh': 'true\n',
    });
    await expect(readReproFromCommit(repo.path, repo.head)).rejects.toThrow(/unusable path/);
  });

  test('refuses more files than a reproduction plausibly needs', async () => {
    const files: Record<string, string> = {};
    const names: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      names.push(`f${i}`);
      files[`f${i}`] = 'x';
    }
    const repo = committed({ ...files, [REPRO_MANIFEST]: manifest({ command: 'x', files: names }) });
    await expect(readReproFromCommit(repo.path, repo.head)).rejects.toThrow(/past the 32 ceiling/);
  });

  test('refuses a reproduction bigger than the byte ceiling', async () => {
    // Under the file-count ceiling, over the byte ceiling: the two limits have to
    // be independent or a payload arrives as a handful of large files.
    const big = 'x'.repeat(200 * 1024);
    const repo = committed({
      [REPRO_MANIFEST]: manifest({ command: 'x', files: ['a', 'b'] }),
      a: big,
      b: big,
    });
    await expect(readReproFromCommit(repo.path, repo.head)).rejects.toThrow(/more than \d+ bytes/);
  });

  test('refuses a symlink, whose content is its target string and not the file', async () => {
    // `git show <rev>:<link>` returns the LINK TARGET as blob content — it never
    // reads the pointed-at file, so no host byte escapes. But the reproduction's
    // bytes would then be a path string rather than the file the manifest named.
    const repo = committed({
      [REPRO_MANIFEST]: manifest({ command: 'sh repro.sh', files: ['repro.sh'] }),
      'real.sh': 'true\n',
    });
    execFileSync('ln', ['-sf', '/etc/passwd', join(repo.path, 'repro.sh')]);
    execFileSync('git', ['-C', repo.path, 'add', 'repro.sh']);
    execFileSync('git', ['-C', repo.path, 'commit', '--quiet', '-m', 'link']);
    const head = execFileSync('git', ['-C', repo.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await expect(readReproFromCommit(repo.path, head)).rejects.toThrow(/not a regular file/);
  });

  test('refuses a directory, which git happily prints as prose', async () => {
    const repo = committed({
      [REPRO_MANIFEST]: manifest({ command: 'x', files: ['d'] }),
      'd/a.txt': 'x\n',
    });
    await expect(readReproFromCommit(repo.path, repo.head)).rejects.toThrow(/not a regular file/);
  });

  test('refuses a manifest naming a file the commit does not carry', async () => {
    const repo = committed({ [REPRO_MANIFEST]: manifest({ command: 'x', files: ['missing.sh'] }) });
    await expect(readReproFromCommit(repo.path, repo.head)).rejects.toThrow();
  });
});
