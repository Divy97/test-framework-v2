// The tool surface is the new fence (ADR-0011).
//
// The container used to be the boundary: the agent was a process with a
// filesystem, and the question was what it could reach. Now it can do exactly
// what these tools do, and the question is whether any tool does more than it
// should. So every test here removes a guard in its head and asserts what would
// happen — a `write` that accepts `..`, a `glob` that follows a symlink out, a
// `git` that can do anything but commit — because a boundary with no failing test
// behind it is a boundary nobody will keep.
//
// These run in-process, as the developer's own uid. That is not the sandbox, and
// it is deliberately the harshest place to make the claim: if a path check only
// holds because a container happened to be in the way, it fails here.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { PathRefused, resolveInside } from '../src/paths.js';
import { MAX_TOOL_OUTPUT, TOOL_SCHEMAS, ToolHost, type ToolWorld } from '../src/tools.js';

const dirs: string[] = [];
const hosts: ToolHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** A workspace with git state OUTSIDE the tree, as the Runner builds one. */
function world(files: Record<string, string> = { 'src.txt': 'wrong\n' }): ToolWorld {
  const root = temp('engine-tools-');
  const gitDir = temp('engine-toolsgit-');
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), body);
  }
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: root } });
  git('init', '--quiet', '--initial-branch=main');
  git('add', '-A', '--');
  git('-c', 'user.email=f@example.invalid', '-c', 'user.name=f', 'commit', '--quiet', '-m', 'base');
  return { root, gitDir, env: { TMPDIR: temp('engine-toolstmp-'), HOME: temp('engine-toolshome-') } };
}

const host = (w: ToolWorld) => {
  const created = new ToolHost(w);
  hosts.push(created);
  return created;
};

let ids = 0;
const callTool = (h: ToolHost, tool: string, input: Record<string, unknown>) =>
  h.run({ id: `c${++ids}`, tool, input });

describe('a path outside the workspace is refused, however it is spelled', () => {
  // Four spellings, because the container is no longer catching any of them. The
  // first three are the forms ADR-0011 names; the fourth is the one that is NOT a
  // traversal and must therefore be allowed to land harmlessly inside.
  test('a parent-relative path cannot be written, and nothing lands outside', async () => {
    const w = world();
    const outside = join(w.root, '..', 'escaped.txt');
    const result = await callTool(host(w), 'write', { path: '../escaped.txt', content: 'x' });

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/refused: path escapes the repository/);
    // The assertion that matters is not the message. It is that the byte never
    // arrived: a refusal that returns an error and writes anyway is worse than
    // no check at all, because the log then says the boundary held.
    expect(existsSync(outside)).toBe(false);
  });

  test('an absolute path is refused', async () => {
    const w = world();
    const target = join(temp('engine-victim-'), 'owned.txt');
    const result = await callTool(host(w), 'write', { path: target, content: 'x' });

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/refused/);
    expect(existsSync(target)).toBe(false);
  });

  test('a symlink out of the workspace is refused rather than followed', async () => {
    const w = world();
    const elsewhere = temp('engine-elsewhere-');
    writeFileSync(join(elsewhere, 'secret.txt'), 'the original bytes\n');
    symlinkSync(elsewhere, join(w.root, 'out'));

    const wrote = await callTool(host(w), 'write', { path: 'out/secret.txt', content: 'clobbered' });
    const read = await callTool(host(w), 'read', { path: 'out/secret.txt' });

    expect(wrote.ok).toBe(false);
    expect(read.ok).toBe(false);
    // Read AND write. A confinement check that only guards writes hands the agent
    // the filesystem as an oracle, and this agent's whole job is to be an oracle
    // over a tree it should not be able to see beyond.
    expect(readFileSync(join(elsewhere, 'secret.txt'), 'utf8')).toBe('the original bytes\n');
  });

  test('git state is not writable, so no hook can be planted', async () => {
    const w = world();
    // The hole `--separate-git-dir` was introduced to close, reopened at the tool
    // layer: a `post-checkout` hook the engine then runs as root. `.git` inside
    // the tree is refused by name even when the real gitdir is elsewhere, because
    // the check cannot know which repository a given `.git` belongs to.
    const result = await callTool(host(w), 'write', {
      path: '.git/hooks/post-checkout',
      content: '#!/bin/sh\ntouch /tmp/pwned\n',
    });

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/git's own state/);
    expect(existsSync(join(w.root, '.git'))).toBe(false);
  });

  test('an encoded traversal is refused, and it is refused fail-closed', async () => {
    // Nothing here URL-decodes, so `..%2f..%2f` is a legal if peculiar filename
    // that happens to START with two dots — and the lexical check is
    // `rel.startsWith('..')`, which refuses it.
    //
    // That is a false positive: `..%2f`, and `..anything`, are inside the
    // workspace and are turned away. It is kept deliberately. The alternative,
    // `rel === '..' || rel.startsWith('..' + sep)`, is more precise and is a
    // LOOSENING of a check four adversarial review rounds shaped — and the cost of
    // the imprecision is that an agent cannot create a filename beginning with two
    // dots, which no reproduction has ever needed. What matters is asserted below:
    // whichever way the string is spelled, nothing lands outside.
    const w = world();
    const result = await callTool(host(w), 'write', { path: '..%2f..%2fetc%2fpasswd', content: 'x' });

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/refused/);
    expect(readFileSync('/etc/passwd', 'utf8')).not.toBe('x');
    // And a name that is merely unusual, with no leading dots, still works — or
    // the check would be refusing on strangeness rather than on containment.
    const odd = await callTool(host(w), 'write', { path: 'a b%2fc..d.txt', content: 'x' });
    expect(odd.ok).toBe(true);
    expect(existsSync(join(w.root, 'a b%2fc..d.txt'))).toBe(true);
  });

  test('edit is confined too, not only write', async () => {
    const w = world();
    const elsewhere = temp('engine-elsewhere-');
    const victim = join(elsewhere, 'config');
    writeFileSync(victim, 'keep\n');
    symlinkSync(elsewhere, join(w.root, 'link'));

    const result = await callTool(host(w), 'edit', {
      path: 'link/config',
      old_string: 'keep',
      new_string: 'gone',
    });

    expect(result.ok).toBe(false);
    expect(readFileSync(victim, 'utf8')).toBe('keep\n');
  });

  test('glob and grep cannot report what is outside', async () => {
    const w = world({ 'src.txt': 'wrong\n' });
    const elsewhere = temp('engine-elsewhere-');
    writeFileSync(join(elsewhere, 'secrets.env'), 'TOKEN=hunter2\n');
    symlinkSync(elsewhere, join(w.root, 'out'));

    const globbed = await callTool(host(w), 'glob', { pattern: 'out/*' });
    const grepped = await callTool(host(w), 'grep', { pattern: 'hunter2', path: 'out' });

    expect(globbed.output).not.toMatch(/secrets\.env/);
    expect(grepped.output).not.toMatch(/hunter2/);
  });

  test('the shared check is the verification engine s own, not a copy of it', async () => {
    // Not a second implementation that looks similar. If this ever becomes two
    // functions, one of them will be fixed and the other will not — which is the
    // history of every enumeration in ADR-0010.
    const root = temp('engine-shared-');
    await expect(resolveInside(root, '../x', { subject: 'path' })).rejects.toBeInstanceOf(PathRefused);
    await expect(resolveInside(root, 'ok/x', { subject: 'path' })).resolves.toMatchObject({ rel: 'ok/x' });

    // And `verify.ts` really does call it, rather than keeping its own. Asserted
    // over the source because the alternative — trusting that the refactor
    // happened — is exactly what the paragraph above says not to do, and the
    // duplicate would be invisible from behaviour alone.
    const engine = readFileSync(join(process.cwd(), 'src/verify.ts'), 'utf8');
    expect(engine).toMatch(/from '\.\/paths\.js'/);
    expect(engine).not.toMatch(/isSymbolicLink\(\)/);
  });
});

describe('the git tool can commit and can do nothing else', () => {
  test('there is no push, no remote, no checkout — not even a refused one', () => {
    // The claim is an ABSENCE, so the test is over the surface itself. An
    // allowlist inside a general `git` tool would be a filter someone can widen;
    // a tool that was never written cannot be.
    const names = TOOL_SCHEMAS.map((t) => t.name);
    expect(names).toEqual([
      'shell_create',
      'shell_write',
      'read',
      'write',
      'edit',
      'grep',
      'glob',
      'git_commit',
    ]);
    for (const forbidden of ['push', 'remote', 'checkout', 'fetch', 'clone', 'reset']) {
      expect(names.some((name) => name.includes(forbidden))).toBe(false);
    }
  });

  test('a commit lands, and its message cannot become an argument', async () => {
    const w = world();
    const h = host(w);
    await callTool(h, 'write', { path: 'fix.txt', content: 'fixed\n' });
    // A message shaped like an option. `git commit -m <message>` passes it as one
    // argv element, so there is nothing to interpret — asserted rather than
    // assumed, because "it is only ever one argument" is exactly the sentence a
    // later refactor turns into a shell string.
    const result = await callTool(h, 'git_commit', { message: '--upload-pack=touch /tmp/pwned' });

    expect(result.ok).toBe(true);
    const log = execFileSync('git', ['log', '--format=%s', '-1'], {
      cwd: w.root,
      encoding: 'utf8',
      env: { ...process.env, GIT_DIR: w.gitDir, GIT_WORK_TREE: w.root },
    });
    expect(log.trim()).toBe('--upload-pack=touch /tmp/pwned');
    expect(existsSync('/tmp/pwned')).toBe(false);
  });
});

describe('named sessions are the Runner s, and outlive one command', () => {
  test('state set in one write is visible to the next', async () => {
    // ADR-0014's whole capability in one assertion: a recipe boots a service in a
    // session and later commands talk to it. One process per invocation cannot do
    // this, which is why the shell tool is not one.
    const h = host(world());
    expect((await callTool(h, 'shell_create', { name: 'web' })).ok).toBe(true);
    await callTool(h, 'shell_write', { name: 'web', input: 'MARKER=alive; cd /' });
    const result = await callTool(h, 'shell_write', { name: 'web', input: 'echo "$MARKER $(pwd)"' });

    expect(result.output).toMatch(/alive \//);
  });

  test('the exit status reported is the command s own', async () => {
    const h = host(world());
    await callTool(h, 'shell_create', { name: 's' });
    // `(exit 7)`, in a subshell. A bare `exit 7` terminates the SESSION — which is
    // correct shell behaviour and would make this a test of session death instead.
    const failed = await callTool(h, 'shell_write', { name: 's', input: '(exit 7)' });
    const passed = await callTool(h, 'shell_write', { name: 's', input: 'true' });

    // Not the sentinel's status, which is always 0. Reading that instead would
    // make every command look successful.
    expect(failed.ok).toBe(false);
    expect(failed.output).toMatch(/\[exit 7\]/);
    expect(passed.ok).toBe(true);
    expect(passed.output).toMatch(/\[exit 0\]/);
  });

  test('stderr is in the result, not thrown away', async () => {
    const h = host(world());
    await callTool(h, 'shell_create', { name: 's' });
    const result = await callTool(h, 'shell_write', { name: 's', input: 'echo boom >&2; exit 1' });

    expect(result.output).toMatch(/boom/);
  });

  test('a write to a session that does not exist is a result, not a crash', async () => {
    const result = await callTool(host(world()), 'shell_write', { name: 'ghost', input: 'echo hi' });

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/no live session called ghost/);
  });

  test('a command that never returns is bounded and says so', async () => {
    const h = host(world());
    await callTool(h, 'shell_create', { name: 's' });
    const result = await callTool(h, 'shell_write', {
      name: 's',
      input: 'while :; do :; done',
      timeout_ms: 500,
    });

    // Bounded, and honest about why: a truncated result that reads as complete is
    // the failure this project exists to refuse.
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/no result after 500ms/);
  });

  test('closing the host kills a service the agent backgrounded inside a session', async () => {
    const w = world();
    const h = host(w);
    const flag = join(w.env.TMPDIR!, 'still-running');
    await callTool(h, 'shell_create', { name: 'svc' });
    await callTool(h, 'shell_write', {
      name: 'svc',
      input: `sh -c 'while :; do : > ${flag}; sleep 0.05; done' & echo started`,
    });
    // It is alive now — otherwise the assertion below is vacuous.
    await new Promise((done) => setTimeout(done, 300));
    expect(existsSync(flag)).toBe(true);

    await h.close();
    rmSync(flag, { force: true });
    await new Promise((done) => setTimeout(done, 400));

    // The group, not the shell. A survivor here is exactly ADR-0010's timing
    // attack: it runs as the same uid and can stage the next phase's verdict.
    expect(existsSync(flag)).toBe(false);
  });
});

describe('every result is bounded', () => {
  test('a huge read is truncated and labelled', async () => {
    const w = world({ 'big.txt': 'a'.repeat(MAX_TOOL_OUTPUT * 3) });
    const result = await callTool(host(w), 'read', { path: 'big.txt' });

    expect(result.output).toMatch(/\[truncated at \d+ bytes\]/);
    expect(Buffer.byteLength(result.output)).toBeLessThan(MAX_TOOL_OUTPUT * 2);
  });

  test('a tool nobody defined is reported, not fatal', async () => {
    const result = await callTool(host(world()), 'browser_navigate', { url: 'http://example.invalid' });

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/there is no tool called browser_navigate/);
  });

  test('a non-string argument is a bad call, not a crash', async () => {
    const result = await callTool(host(world()), 'write', { path: { nested: true }, content: 'x' });

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/path must be a string/);
  });
});
