// The Runner on a machine we own but are not PID 1 of (M10, ADR-0021).
//
// Docker gives this engine a container it owns outright: PID 1, a Job on stdin, tool calls
// back down the same pipe, a bind-mounted store. A microVM gives none of those, and the
// three things that replace them are what this file tests — the spool that carries tool
// calls as files, the store mode that accepts a directory on this machine's own
// filesystem, and the fact that the SAME `runJob` produces the same stream either way.
//
// The last one is the claim that matters. If the VM path drifted from the container path
// the executor above would be demultiplexing two protocols while pretending it had one.

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, test } from 'vitest';
import type { RunEvent } from '../src/events.js';
import { flag, spoolRequests } from '../src/runner-vm.js';
import { APPLIED_REPRO, clean, cleanupFixtures } from './fixtures/repo.js';

const dirs: string[] = [];
const scratch = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => cleanupFixtures());

describe('tool calls arrive as files, in the order they were written', () => {
  const call = (id: string) => JSON.stringify({ call: { id, tool: 'read', input: {} } });

  test('numeric order, not lexicographic — call 10 follows call 9', async () => {
    // The trap this exists for: `sort()` on `['1.json','10.json','2.json']` puts the tenth
    // call second, so the host's reply for call 2 answers call 10 and the agent's session
    // silently interleaves.
    const dir = scratch('spool-order-');
    for (const n of [1, 2, 9, 10, 11]) await writeFile(join(dir, `${n}.json`), call(`h${n}`));

    const seen: string[] = [];
    for await (const line of spoolRequests(dir, { pollMs: 5 })) {
      seen.push((JSON.parse(line) as { call: { id: string } }).call.id);
      if (seen.length === 5) break;
    }
    expect(seen).toEqual(['h1', 'h2', 'h9', 'h10', 'h11']);
  });

  test('a call is deleted once it has been read, so a long session cannot fill the disk', async () => {
    const dir = scratch('spool-drain-');
    await writeFile(join(dir, '1.json'), call('h1'));
    for await (const _ of spoolRequests(dir, { pollMs: 5 })) break;
    expect(await readdir(dir)).toEqual([]);
  });

  test('a half-written call is retried, never read as garbage', async () => {
    // `writeFiles` promises nothing about atomicity. A truncated line parsed and dropped
    // would leave the host waiting forever for a reply to a call this end never saw whole,
    // which is the one failure with no diagnosis at all.
    const dir = scratch('spool-partial-');
    const path = join(dir, '1.json');
    await writeFile(path, '{"call":{"id":"h1","tool":"re');

    const seen: string[] = [];
    const reader = (async () => {
      for await (const line of spoolRequests(dir, { pollMs: 5 })) {
        seen.push(line);
        break;
      }
    })();
    // Still nothing after several polls: the fragment was left alone rather than consumed.
    await new Promise((done) => setTimeout(done, 60));
    expect(seen).toEqual([]);
    expect(await readdir(dir)).toEqual(['1.json']);

    await writeFile(path, call('h1'));
    await reader;
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]!)).toMatchObject({ call: { id: 'h1' } });
  });

  test('`done` travels the same channel, because ending is the host’s to say', async () => {
    const dir = scratch('spool-done-');
    await writeFile(join(dir, '1.json'), JSON.stringify({ done: true }));
    const seen: unknown[] = [];
    for await (const line of spoolRequests(dir, { pollMs: 5 })) {
      seen.push(JSON.parse(line));
      break;
    }
    expect(seen).toEqual([{ done: true }]);
  });
});

describe('the flags the worker starts this with', () => {
  test('both spellings, and a default that names the container path', () => {
    expect(flag(['--job', '/tmp/j.json'], 'job', '/work/job.json')).toBe('/tmp/j.json');
    expect(flag(['--job=/tmp/j.json'], 'job', '/work/job.json')).toBe('/tmp/j.json');
    expect(flag([], 'job', '/work/job.json')).toBe('/work/job.json');
    // A flag with nothing after it falls back rather than taking the next flag as a path.
    expect(flag(['--spool'], 'spool', '/work/rpc')).toBe('/work/rpc');
  });
});

const dockerAvailable = () => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const IMAGE = 'test-framework-v2-sandbox:test';

describe.skipIf(!dockerAvailable())('the same Runner, started the way a microVM starts it', () => {
  const build = () => execFileSync('docker', ['build', '-q', '-t', IMAGE, '.'], { cwd: process.cwd() });

  /**
   * The image, entered the way the executor will enter it: no stdin, a Job read from a
   * file, and `/blobs` an ordinary directory on the machine's own filesystem rather than a
   * mount. `sh -c` only to create the store the worker would have written first.
   */
  const runAsVm = (repo: string, job: object, extra: string[] = []) => {
    const spool = scratch('vm-spool-');
    mkdirSync(join(spool, 'in'), { recursive: true });
    writeFileSync(join(spool, 'job.json'), JSON.stringify(job));
    const args = [
      'run', '--rm', '--pull', 'never',
      '-v', `${repo}:/src:ro`,
      '-v', `${spool}:/spool`,
      '--entrypoint', 'sh',
      ...extra,
      IMAGE,
      '-c',
      'mkdir -p /blobs && : > /blobs/.evidence-store && ' +
        'exec node --import tsx src/runner-vm.ts --job /spool/job.json --spool /spool',
    ];
    return { spool, args };
  };

  test('a phase runs, and the events are the ones the container path emits', () => {
    build();
    const fixture = clean();
    const { args } = runAsVm(fixture.repo, {
      runId: '00000000-0000-4000-8000-000000000001',
      afterSeq: 0,
      sourcePath: '/src',
      baseRef: fixture.base,
      fixRef: fixture.fix,
      repro: APPLIED_REPRO,
      symptomPattern: 'wrong',
      only: 'base',
      flakeRuns: 0,
    });
    const stdout = execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const events = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunEvent);

    // The reproduction was registered and the base phase ran — the same two facts the
    // container path emits for this fixture, from the same code, reached a different way.
    expect(events.map((event) => event.type)).toContain('REPRO_REGISTERED');
    expect(events.filter((event) => event.type === 'TEST_RUN')).not.toHaveLength(0);
    // And nothing on the channel is a reply: this phase serves no tools.
    expect(stdout).not.toContain('"ready"');
  }, 300_000);

  test('the store is accepted here and refused on the container path, which is the whole change', () => {
    build();
    const fixture = clean();
    const job = {
      runId: '00000000-0000-4000-8000-000000000002',
      afterSeq: 0,
      sourcePath: '/src',
      baseRef: fixture.base,
      fixRef: fixture.fix,
      repro: APPLIED_REPRO,
      symptomPattern: 'wrong',
      only: 'base' as const,
      flakeRuns: 0,
    };

    // THE CONTROL. The same unmounted `/blobs`, entered the way Docker enters it: the
    // store check refuses, because on that path a store on the container's own filesystem
    // dies with `--rm` and the events would describe artifacts nobody can fetch. If this
    // ever passes, `collected` has stopped meaning anything.
    let refused = '';
    try {
      execFileSync(
        'docker',
        ['run', '--rm', '-i', '--pull', 'never', '-v', `${fixture.repo}:/src:ro`, '--entrypoint', 'sh', IMAGE,
         '-c', 'mkdir -p /blobs && : > /blobs/.evidence-store && exec node --import tsx src/runner.ts'],
        { input: JSON.stringify(job), encoding: 'utf8' },
      );
    } catch (error) {
      refused = String((error as { stderr?: string }).stderr ?? '');
    }
    expect(refused).toMatch(/is not a host store/);

    // And the VM path takes it, with the sentinel still required.
    const { args } = runAsVm(fixture.repo, { ...job, runId: '00000000-0000-4000-8000-000000000003' });
    const stdout = execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    expect(stdout).toContain('REPRO_REGISTERED');
  }, 300_000);

  test('an agent phase is driven entirely through the spool, and only the host may end it', async () => {
    build();
    const fixture = clean();
    const { spool, args } = runAsVm(fixture.repo, {
      runId: '00000000-0000-4000-8000-000000000004',
      afterSeq: 0,
      sourcePath: '/src',
      baseRef: fixture.base,
      fixRef: fixture.base,
      repro: { command: '' },
      symptomPattern: 'x',
      only: 'agent',
      serveTools: true,
    });

    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines: string[] = [];
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== '') lines.push(line);
        newline = buffer.indexOf('\n');
      }
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));

    const waitFor = async (matches: (line: string) => boolean, why: string) => {
      for (let i = 0; i < 600; i += 1) {
        const found = lines.find(matches);
        if (found) return found;
        await new Promise((done) => setTimeout(done, 100));
      }
      throw new Error(`${why}; saw:\n${lines.join('\n')}\nstderr:\n${stderr}`);
    };

    // The world stands up and the tools answer — the same `{ready}` the pipe carries.
    await waitFor((line) => line.includes('"ready"'), 'the runner never reported ready');

    // One tool call, as a file. Nothing is written to this process's stdin: there is none.
    await mkdir(join(spool, 'in'), { recursive: true });
    await writeFile(
      join(spool, 'in', '1.json'),
      JSON.stringify({ call: { id: 'h1', tool: 'write', input: { path: 'from-the-spool.txt', content: 'hello' } } }),
    );
    const reply = await waitFor((line) => line.includes('"h1"'), 'the tool call was never answered');
    expect(JSON.parse(reply)).toMatchObject({ result: { id: 'h1', ok: true } });

    // The reply is ALSO on disk, which is what recovery reads when the stream drops —
    // the spike found re-attaching to a command's output replays a window and then closes.
    const mirrored = JSON.parse(readFileSync(join(spool, 'out', 'h1.json'), 'utf8')) as unknown;
    expect(mirrored).toMatchObject({ result: { id: 'h1', ok: true } });

    // Ending is the host's to say, and it says it the same way.
    await writeFile(join(spool, 'in', '2.json'), JSON.stringify({ done: true }));
    const code = await new Promise<number>((resolve) => child.on('close', (value) => resolve(value ?? 1)));
    expect(code).toBe(0);
    expect(lines.some((line) => line.includes('"finished"'))).toBe(true);
  }, 300_000);
});
