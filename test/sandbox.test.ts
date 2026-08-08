// Does the engine actually run inside the container, and does the host stay
// untouched? Everything else in the suite runs the engine in-process; this is
// the only test that proves the containment M3 exists to provide.
//
// Skipped when Docker is unavailable rather than failing: a machine without a
// daemon should report "not verified", never a false green.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { get } from '../src/blobs.js';
import type { ArtifactRef, RunEvent } from '../src/events.js';
import { fold } from '../src/fold.js';
import { APPLIED_REPRO, cleanupFixtures, clean } from './fixtures/repo.js';

const dockerAvailable = () => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const IMAGE = 'test-framework-v2-sandbox:test';
const RUN_ID = '5a1d0c37-9e42-4b16-8f0a-2c7d3e9b1450';

/** A fresh host directory per run: fixture content is identical across tests, so a
 *  shared store lets a sibling test pre-populate the very refs under assertion. */
const hostBlobs = () => mkdtempSync(join(tmpdir(), 'engine-hostblobs-'));

const runInSandbox = (repoDir: string, blobs: string, job: object) =>
  execFileSync(
    'docker',
    ['run', '--rm', '-i', '-v', `${repoDir}:/src:ro`, '-v', `${blobs}:/blobs`, IMAGE],
    { input: JSON.stringify(job), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );

const parse = (stdout: string) =>
  stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunEvent);

describe.skipIf(!dockerAvailable())('the engine runs inside the sandbox', () => {
  afterEach(cleanupFixtures);

  test('a run executes in the container and the host tree is untouched', async () => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '.'], { cwd: process.cwd() });
    const fixture = clean();
    const before = readFileSync(`${fixture.repo}/src.txt`, 'utf8');
    // A path the host can see and the container cannot. Writing it from inside
    // lands harmlessly in the container's own filesystem; seeing it on the host
    // afterwards would mean the run escaped.
    const hostMarker = join(tmpdir(), `engine-escape-${process.pid}.txt`);

    // The repro carries the containment proof itself. "Left no trace" cannot
    // distinguish container from host — the engine scrubs the tree in both modes
    // by design, which is why the original assertion passed with no container at
    // all. Refusing to run outside one can.
    const repro = {
      command: 'sh repro.sh',
      files: {
        'repro.sh':
          'test -f /.dockerenv || exit 9\n' +
          `echo escaped > ${hostMarker} 2>/dev/null || true\n` +
          'cat src.txt\ngrep -q right src.txt\n',
      },
    };

    const job = {
      runId: RUN_ID,
      afterSeq: 0,
      sourcePath: '/src',
      baseRef: fixture.base,
      fixRef: fixture.fix,
      repro,
      symptomPattern: 'wrong',
      flakeRuns: 0,
    };

    // Read-only mount: the sandbox clones out of it and must never write back.
    const stdout = runInSandbox(fixture.repo, hostBlobs(), job);

    const events = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunEvent);

    // The same event stream the fold already understands — nothing about being
    // containerised changes the record.
    expect(events.map((e) => e.type)).toEqual([
      'REPRO_REGISTERED',
      'TEST_RUN',
      'TEST_RUN',
      'FIX_DIFF_OBSERVED',
    ]);

    const state = fold([
      {
        run_id: RUN_ID,
        seq: 1,
        ts: new Date().toISOString(),
        type: 'ATTEMPT_STARTED',
        payload: { v: 1, n: 1 },
      },
      ...events.map((e, i) => ({ ...e, seq: i + 2 })),
    ]);
    expect(state.reproduced).toBe(true);

    // The engine applied a repro, ran a fix phase and scrubbed a tree — all of it
    // inside the container. The host's checkout never moved.
    // Only true if every phase ran inside the container: the repro exits 9 on a
    // host, which makes the base phase fail for the wrong reason and the fold
    // refuse. And nothing the run wrote reached the host.
    expect(existsSync(hostMarker)).toBe(false);
    expect(readFileSync(`${fixture.repo}/src.txt`, 'utf8')).toBe(before);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: fixture.repo }).toString()).toBe(
      '',
    );
  }, 300_000);

  test('the repro cannot write onto the event channel', async () => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '.'], { cwd: process.cwd() });
    const fixture = clean();

    // /proc/1/fd/1 IS the container's stdout. The repro runs as root in the same
    // PID namespace, so unless PID 1 is the Runner itself — and it closes its own
    // fd 1 — the agent writes straight onto the evidence record. The second line
    // is the nastier half: no trailing newline, so it concatenates onto the next
    // real event and destroys REPRO_REGISTERED, the anchor everything rests on.
    // Enumerate EVERY descriptor PID 1 holds, not just fd 1. Closing fd 1 was not
    // enough: the private handle on the real stdout is simply a different number,
    // and it is listed in /proc/1/fd/ like any other. Only the repro running as a
    // different user makes those descriptors unopenable.
    const forge =
      'for n in $(ls /proc/1/fd 2>/dev/null); do\n' +
      '  printf \'{"type":"SANDBOX_CREATED","payload":{"v":1,"sandbox_id":"FORGED"}}\\n\' > /proc/1/fd/$n 2>/dev/null || true\n' +
      '  printf "PARTIAL_NO_NEWLINE" > /proc/1/fd/$n 2>/dev/null || true\n' +
      'done\n' +
      'cat src.txt\ngrep -q right src.txt\n';

    const stdout = runInSandbox(fixture.repo, hostBlobs(), {
      runId: RUN_ID,
      afterSeq: 0,
      sourcePath: '/src',
      baseRef: fixture.base,
      fixRef: fixture.fix,
      repro: { command: 'sh repro.sh', files: { 'repro.sh': forge } },
      symptomPattern: 'wrong',
      flakeRuns: 0,
    });

    const lines = stdout.trim().split('\n').filter(Boolean);
    // Every line is a real event, in the expected order, and none is corrupted.
    expect(lines.map((l) => (JSON.parse(l) as RunEvent).type)).toEqual([
      'REPRO_REGISTERED',
      'TEST_RUN',
      'TEST_RUN',
      'FIX_DIFF_OBSERVED',
    ]);
    expect(stdout).not.toContain('FORGED');
    expect(stdout).not.toContain('PARTIAL_NO_NEWLINE');
  }, 300_000);

  test('every artifact the events reference outlives the container', async () => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '.'], { cwd: process.cwd() });
    const fixture = clean();
    const blobs = hostBlobs();

    const events = parse(
      runInSandbox(fixture.repo, blobs, {
        runId: RUN_ID,
        afterSeq: 0,
        sourcePath: '/src',
        baseRef: fixture.base,
        fixRef: fixture.fix,
        repro: APPLIED_REPRO,
        symptomPattern: 'wrong',
        flakeRuns: 0,
      }),
    );

    // Every ref anywhere in the stream, not just stdout_hash: the registration's
    // files, each run's repro_hashes, and the diff all carry them.
    const refs = [...new Set(JSON.stringify(events).match(/sha256:[0-9a-f]{64}/g) ?? [])];
    expect(refs.length).toBeGreaterThan(2);
    for (const ref of refs) {
      // get() re-verifies the digest, so resolving is an integrity check too.
      await expect(get(blobs, ref as ArtifactRef)).resolves.toBeInstanceOf(Buffer);
    }

    // And the bytes are the real ones, so storing empty strings could not pass.
    const base = events.find(
      (e) => e.type === 'TEST_RUN' && e.payload.phase === 'base',
    )!.payload as { stdout_hash: ArtifactRef };
    expect((await get(blobs, base.stdout_hash)).toString()).toContain('wrong');
  }, 300_000);

  test('the run refuses rather than writing evidence into the container layer', () => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '.'], { cwd: process.cwd() });
    const fixture = clean();

    // No -v for /blobs. mkdir would happily create it in the container layer and
    // the run would look perfect while every artifact died with --rm.
    expect(() =>
      execFileSync('docker', ['run', '--rm', '-i', '-v', `${fixture.repo}:/src:ro`, IMAGE], {
        input: JSON.stringify({
          runId: RUN_ID,
          afterSeq: 0,
          sourcePath: '/src',
          baseRef: fixture.base,
          fixRef: fixture.fix,
          repro: APPLIED_REPRO,
          symptomPattern: 'wrong',
          flakeRuns: 0,
        }),
        encoding: 'utf8',
      }),
    ).toThrow(/not a mount point/);
  }, 300_000);

  test('a hook the repro plants is never executed by the Runner', async () => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '.'], { cwd: process.cwd() });
    const fixture = clean();
    const blobs = hostBlobs();

    // git clean never descends into .git, so the hook survives the phase-boundary
    // scrub and fires on the fix checkout — as ROOT. That defeats the uid-1000
    // boundary entirely: the blob store, and every /proc/1/fd descriptor with it.
    const plant =
      'mkdir -p .git/hooks 2>/dev/null || true\n' +
      'printf "#!/bin/sh\\ntouch /blobs/OWNED\\n" > .git/hooks/post-checkout 2>/dev/null || true\n' +
      'chmod +x .git/hooks/post-checkout 2>/dev/null || true\n' +
      'cat src.txt\ngrep -q right src.txt\n';

    const events = parse(
      runInSandbox(fixture.repo, blobs, {
        runId: RUN_ID,
        afterSeq: 0,
        sourcePath: '/src',
        baseRef: fixture.base,
        fixRef: fixture.fix,
        repro: { command: 'sh repro.sh', files: { 'repro.sh': plant } },
        symptomPattern: 'wrong',
        flakeRuns: 0,
      }),
    );

    expect(events.length).toBeGreaterThan(0);
    expect(existsSync(join(blobs, 'OWNED'))).toBe(false);
  }, 300_000);
});