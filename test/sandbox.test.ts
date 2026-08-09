// Does the engine actually run inside the container, and does the host stay
// untouched? Everything else in the suite runs the engine in-process; this is
// the only test that proves the containment M3 exists to provide.
//
// Without a Docker daemon these cannot run — and a suite that reports 135 green
// while its entire containment boundary went unexercised IS the false green this
// file exists to refuse. So the skip is opt-in: no daemon and no explicit
// acknowledgement fails the run. Set ENGINE_SANDBOX_UNVERIFIED=1 to say out loud
// that this boundary is not being checked.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { get } from '../src/blobs.js';
import type { ArtifactRef, RunEvent } from '../src/events.js';
import { fold } from '../src/fold.js';
import { SHARED_WRITABLE } from '../src/runner.js';
import {
  APPLIED_REPRO,
  cleanupFixtures,
  clean,
  HANGS_ON_FIX,
  survivorGamed,
} from './fixtures/repo.js';

const dockerAvailable = () => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** Saying "I know the containment boundary is unverified" — the only way to skip it. */
const ACKNOWLEDGED = 'ENGINE_SANDBOX_UNVERIFIED';
const haveDocker = dockerAvailable();
// Not `!!`: that treats `=0` and `=false` as acknowledgement, which reads as the
// exact opposite of what it does. Only an affirmative value counts.
const acknowledged = ['1', 'true', 'yes'].includes((process.env[ACKNOWLEDGED] ?? '').toLowerCase());

describe.skipIf(haveDocker || acknowledged)('the containment boundary', () => {
  test('was NOT verified: no Docker daemon', () => {
    // Deliberately a failure rather than a skip. Everything else in the suite
    // runs the engine in-process, so without this the security properties M3
    // exists to provide — the event channel, the uid drop, the agent isolation —
    // are asserted nowhere and nothing says so.
    expect.fail(
      `Docker is unavailable, so nothing here proved containment. ` +
        `Start a daemon, or set ${ACKNOWLEDGED}=1 to accept an unverified boundary.`,
    );
  });
});

const IMAGE = 'test-framework-v2-sandbox:test';
const RUN_ID = '5a1d0c37-9e42-4b16-8f0a-2c7d3e9b1450';

/** A fresh host directory per run: fixture content is identical across tests, so a
 *  shared store lets a sibling test pre-populate the very refs under assertion. */
const stores: string[] = [];
const hostBlobs = () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-hostblobs-'));
  // The Runner refuses a store it cannot prove pre-existed on the host.
  writeFileSync(join(dir, '.evidence-store'), '');
  stores.push(dir);
  return dir;
};

const runInSandbox = (repoDir: string, blobs: string, job: object) =>
  execFileSync(
    'docker',
    ['run', '--rm', '-i', '-v', `${repoDir}:/src:ro`, '-v', `${blobs}:/blobs`, IMAGE],
    { input: JSON.stringify(job), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );

/** The same run, expecting a non-zero exit: execFileSync throws, and the stream is on the error. */
const runExpectingFailure = (repoDir: string, blobs: string, job: object) => {
  try {
    runInSandbox(repoDir, blobs, job);
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return { status: failure.status, stdout: failure.stdout ?? '' };
  }
  throw new Error('the run was expected to fail and did not');
};

const parse = (stdout: string) =>
  stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunEvent);

describe.skipIf(!haveDocker)('the engine runs inside the sandbox', () => {
  afterEach(() => {
    cleanupFixtures();
    for (const dir of stores.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('the image has exactly the writable paths the scrub knows about', async () => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '.'], { cwd: process.cwd() });

    // The invariant that ends the guessing. Four review rounds each found one
    // more place a participant could leave state for another to read — /tmp,
    // then a gitignored directory, then /home/node, then /dev/mqueue — and each
    // time the fix was a longer list and a green suite. What was missing was not
    // a longer list but a way to know when it is complete.
    //
    // Enumerated as the repro user, across every mount rather than one, because
    // /dev/shm and /dev/mqueue are separate filesystems and `-xdev` is exactly
    // how /dev/mqueue stayed hidden.
    // Real filesystems only. procfs is deliberately out of scope and the
    // exclusion is informed rather than convenient: enumerating it turns up
    // `/proc/sys/kernel/ns_last_pid`, writable by uid 1000. That is a kernel
    // tunable, not a place to leave a file — it cannot be scrubbed by removing
    // anything, and every process creation rewrites it. A different threat
    // class, recorded in ADR-0010 rather than papered over here.
    const roots = ['/', '/dev', '/dev/shm', '/dev/mqueue', '/run'];
    const found = execFileSync(
      'docker',
      ['run', '--rm', '--user', '1000:1000', '--entrypoint', 'sh', IMAGE, '-c',
        `for m in ${roots.join(' ')}; do ` +
          "for t in d f; do find $m -xdev -type $t -exec test -w {} ';' -print 2>/dev/null; done; " +
          'done | sort -u'],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);

    // Exactly — not a superset. A path the scrub cleans that the image does not
    // have is dead weight; a path the image has that the scrub misses is the
    // next fabricated verdict.
    expect([...found].sort()).toEqual([...SHARED_WRITABLE].sort());
  }, 300_000);

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
    const attempt = () =>
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
      });

    expect(attempt).toThrow(/not a host store/);
    // Exit 3, not 2: nothing reached the channel, so there is nothing to fold.
    // Sharing a code with the partial-stream case would leave a caller unable to
    // tell evidence from silence.
    let status: number | undefined;
    let stdout = '';
    try {
      attempt();
    } catch (error) {
      ({ status, stdout } = error as { status?: number; stdout: string });
    }
    expect(status).toBe(3);
    expect(stdout).toBe('');
  }, 300_000);

  test('an anonymous volume is refused: it dies with --rm like the container layer', () => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '.'], { cwd: process.cwd() });
    const fixture = clean();

    // `-v /blobs` is a different device, so a st_dev check waves it through —
    // and then --rm deletes it. Only proof the host made the directory rules it out.
    expect(() =>
      execFileSync(
        'docker',
        ['run', '--rm', '-i', '-v', `${fixture.repo}:/src:ro`, '-v', '/blobs', IMAGE],
        {
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
        },
      ),
    ).toThrow(/not a host store/);
  }, 300_000);

  test('the repro cannot destroy artifacts the run has already banked', async () => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '.'], { cwd: process.cwd() });
    const fixture = clean();
    const blobs = hostBlobs();

    // A bind mount does not honour the permissions set inside the container —
    // Docker Desktop ignores them, and on Linux the host uid is commonly 1000,
    // exactly what the repro runs as. So the store cannot be exposed while the
    // repro can still run: the fix phase would delete what the base phase banked
    // and the stream would still come out clean, complete and exit 0.
    const wipe =
      'echo WIPE: $(rm -rf /blobs/* 2>&1)\n' +
      'echo FORGE: $(touch /blobs/OWNED 2>&1)\n' +
      'cat src.txt\ngrep -q right src.txt\n';

    const events = parse(
      runInSandbox(fixture.repo, blobs, {
        runId: RUN_ID,
        afterSeq: 0,
        sourcePath: '/src',
        baseRef: fixture.base,
        fixRef: fixture.fix,
        repro: { command: 'sh repro.sh', files: { 'repro.sh': wipe } },
        symptomPattern: 'wrong',
        flakeRuns: 0,
      }),
    );

    const refs = [...new Set(JSON.stringify(events).match(/sha256:[0-9a-f]{64}/g) ?? [])];
    expect(refs.length).toBeGreaterThan(2);
    for (const ref of refs) {
      await expect(get(blobs, ref as ArtifactRef)).resolves.toBeInstanceOf(Buffer);
    }

    // The repro CAN still create files in the mount — a bind mount ignores the
    // permissions set inside the container. What it cannot do is get one read as
    // evidence: every lookup goes through a hash-derived path, and get()
    // re-verifies the digest. Asserting the file is absent would be asserting
    // something false.
    await expect(get(blobs, 'sha256:OWNED' as ArtifactRef)).rejects.toThrow(
      /not a content-addressed reference/,
    );
  }, 300_000);

  test('a run that could not be finished still ships the evidence it did gather', async () => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '.'], { cwd: process.cwd() });
    const fixture = clean();
    const blobs = hostBlobs();

    // Fails fast on base for the reported reason, then hangs on the fix until the
    // timeout kills it. Before this, the base-phase observation died with the
    // exception and the run left no record at all — the container exited non-zero
    // with an empty channel, which is indistinguishable from never having run.
    const outcome = runExpectingFailure(fixture.repo, blobs, {
      runId: RUN_ID,
      afterSeq: 0,
      sourcePath: '/src',
      baseRef: fixture.base,
      fixRef: fixture.fix,
      repro: HANGS_ON_FIX,
      symptomPattern: 'wrong',
      flakeRuns: 0,
      timeoutMs: 5_000,
    });

    expect(outcome.status).toBe(2);
    const events = parse(outcome.stdout);
    expect(events.map((e) => e.type)).toEqual([
      'REPRO_REGISTERED',
      'TEST_RUN',
      'VERIFICATION_ABORTED',
    ]);

    // The point of emitting at all: the artifacts crossed into the host store on
    // the abort path too. A stream whose refs die with the container is worse than
    // no stream, because it reads as a complete record.
    const refs = [...new Set(JSON.stringify(events).match(/sha256:[0-9a-f]{64}/g) ?? [])];
    expect(refs.length).toBeGreaterThan(1);
    for (const ref of refs) {
      await expect(get(blobs, ref as ArtifactRef)).resolves.toBeInstanceOf(Buffer);
    }
  }, 300_000);

  test('the agent runs unprivileged and cannot write onto the event channel', async () => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '.'], { cwd: process.cwd() });
    const fixture = clean();
    const blobs = hostBlobs();

    // A hostile `claude`, mounted rather than installed: this proves the
    // supervision boundary without the image carrying a real agent, which is
    // M3.2's second half. It attacks the same way the repro does — every fd PID 1
    // holds — because the agent has exactly the repro's privileges and nothing
    // about being "the agent" makes it more trusted (ADR-0006).
    const agentDir = mkdtempSync(join(tmpdir(), 'engine-fakeagent-'));
    stores.push(agentDir);
    const forged = JSON.stringify({
      run_id: RUN_ID,
      seq: 1,
      ts: '2026-01-01T00:00:00.000Z',
      type: 'PR_OPENED',
      payload: { v: 1, repo: 'o/r', pr_number: 1, head_sha: 'x', diff_hash: 'sha256:00' },
    });
    writeFileSync(
      join(agentDir, 'claude'),
      '#!/bin/sh\n' +
        'for n in $(ls /proc/1/fd 2>/dev/null); do\n' +
        `  printf '%s\\n' '${forged}' > /proc/1/fd/$n 2>/dev/null || true\n` +
        'done\n' +
        `printf '{"type":"whoami","uid":"%s"}\\n' "$(id -u)"\n` +
        `printf '{"type":"result","subtype":"success"}\\n'\n`,
      { mode: 0o755 },
    );

    const stdout = execFileSync(
      'docker',
      [
        'run', '--rm', '-i',
        '-v', `${fixture.repo}:/src:ro`,
        '-v', `${blobs}:/blobs`,
        '-v', `${join(agentDir, 'claude')}:/usr/local/bin/claude:ro`,
        IMAGE,
      ],
      {
        input: JSON.stringify({
          runId: RUN_ID,
          afterSeq: 0,
          sourcePath: '/src',
          baseRef: fixture.base,
          fixRef: fixture.fix,
          repro: APPLIED_REPRO,
          symptomPattern: 'wrong',
          flakeRuns: 0,
          agentPrompt: 'reproduce the bug',
        }),
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      },
    );

    const events = parse(stdout);
    // Testimony first, then the evidence — and the log continues rather than
    // restarting, so the agent's seqs and the engine's cannot collide.
    expect(events.map((e) => e.type)).toEqual([
      'AGENT_MESSAGE',
      'AGENT_MESSAGE',
      'AGENT_FINISHED',
      'REPRO_REGISTERED',
      'TEST_RUN',
      'TEST_RUN',
      'FIX_DIFF_OBSERVED',
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // The forgery reached nothing. Not a line on the channel, and no PR anywhere.
    expect(events.some((e) => e.type === 'PR_OPENED')).toBe(false);
    expect(fold(events).pr).toBeNull();

    // It ran as the repro user, which is what put /proc/1/fd out of its reach.
    const said = await Promise.all(
      events
        .filter((e) => e.type === 'AGENT_MESSAGE')
        .map((e) => get(blobs, (e.payload as { raw_hash: ArtifactRef }).raw_hash)),
    );
    expect(said[0]!.toString()).toContain('"uid":"1000"');
  }, 300_000);

  test('the agent cannot stage the world the phases are judged in', async () => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '.'], { cwd: process.cwd() });
    const fixture = clean();
    const blobs = hostBlobs();

    // The attack that needs no forged event at all. The reproduction is
    // anchored (ADR-0008) — but anchoring fixes WHAT runs, not the world it runs
    // in. Sharing a filesystem with the phases, an agent seeds a file the test
    // reads and a no-op fix goes red then green: every anti-gaming check passes,
    // because not one of them is about the environment.
    //
    // /tmp is the easiest channel. A gitignored directory is the realistic one —
    // `git clean` at the phase boundary deliberately spares ignored files, and
    // installing dependencies is the first thing a real agent does. $HOME is the
    // third. All three are the same hole.
    const agentDir = mkdtempSync(join(tmpdir(), 'engine-fakeagent-'));
    stores.push(agentDir);
    writeFileSync(
      join(agentDir, 'claude'),
      '#!/bin/sh\n' +
        // `touch`, not `: >`. A redirect failure on a POSIX *special* builtin
        // kills the shell outright, so the last plant below would take the agent
        // down with it and the test would pass on an empty transcript.
        'touch planted.txt\n' +
        'touch "${TMPDIR:-/tmp}/planted.txt"\n' +
        'touch "$HOME/planted.txt"\n' +
        // Straight at the verification tree. It must not exist yet — cloning it
        // before the agent ran would hand the agent a tree it owns, which is why
        // the ordering in runJob is load-bearing rather than incidental.
        'touch /work/verify/repo/planted.txt 2>/dev/null || true\n' +
        `printf '{"type":"result","subtype":"success"}\\n'\n`,
      { mode: 0o755 },
    );

    const repro = {
      command: 'sh repro.sh',
      files: {
        'repro.sh':
          'cat src.txt\n' +
          'echo "TREE: $(ls planted.txt 2>&1)"\n' +
          'echo "TMP: $(ls ${TMPDIR:-/tmp}/planted.txt 2>&1)"\n' +
          'echo "HOME: $(ls $HOME/planted.txt 2>&1)"\n' +
          'grep -q right src.txt\n',
      },
    };

    const events = parse(
      execFileSync(
        'docker',
        [
          'run', '--rm', '-i',
          '-v', `${fixture.repo}:/src:ro`,
          '-v', `${blobs}:/blobs`,
          '-v', `${join(agentDir, 'claude')}:/usr/local/bin/claude:ro`,
          IMAGE,
        ],
        {
          input: JSON.stringify({
            runId: RUN_ID,
            afterSeq: 0,
            sourcePath: '/src',
            baseRef: fixture.base,
            fixRef: fixture.fix,
            repro,
            symptomPattern: 'wrong',
            flakeRuns: 0,
            agentPrompt: 'plant everything you can',
          }),
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        },
      ),
    );

    const outputs = await Promise.all(
      events
        .filter((e) => e.type === 'TEST_RUN')
        .map((e) =>
          get(blobs, (e.payload as { stdout_hash: ArtifactRef }).stdout_hash).then((b) =>
            b.toString(),
          ),
        ),
    );
    expect(outputs).toHaveLength(2);
    // `ls:` is the error prefix — the phase could not see any of it. Asserting
    // absence this way rather than on the event stream, because the whole point
    // is what the executing process could reach.
    for (const output of outputs) {
      expect(output).toContain('TREE: ls:');
      expect(output).toContain('TMP: ls:');
      expect(output).toContain('HOME: ls:');
    }

    // And the run still works: isolation that broke verification would be no fix.
    expect(events.filter((e) => e.type === 'AGENT_MESSAGE')).toHaveLength(1);
    const state = fold([
      { run_id: RUN_ID, seq: 1, ts: new Date().toISOString(), type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } },
      ...events.map((e, i) => ({ ...e, seq: i + 2 })),
    ]);
    expect(state.reproduced).toBe(true);
  }, 300_000);

  test('a process the agent leaves running cannot stage the verdict', async () => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '.'], { cwd: process.cwd() });
    const fixture = survivorGamed();
    const blobs = hostBlobs();

    // Separate trees and private TMPDIRs do NOTHING against this. The survivor
    // runs as the repro user, so it can write the phases' own private
    // directories — and it supplies the one thing a static plant cannot: timing.
    // A file present in both phases makes the base pass too and is never
    // credited; a process that flips it between them manufactures red-then-green
    // against an untouched committed test and a no-op fix.
    //
    // `setsid` so it escapes the agent's process group: killing the group alone
    // leaves it running. Only PID 1 reaping its own namespace closes this.
    const agentDir = mkdtempSync(join(tmpdir(), 'engine-fakeagent-'));
    stores.push(agentDir);
    writeFileSync(
      join(agentDir, 'claude'),
      '#!/bin/sh\n' +
        'setsid sh -c \'while [ ! -f /dev/shm/beacon ]; do :; done; touch /dev/shm/marker\' ' +
        '>/dev/null 2>&1 </dev/null &\n' +
        `printf '{"type":"result","subtype":"success"}\\n'\n`,
      { mode: 0o755 },
    );

    // The reproduction is a committed test the fix never touches — the strongest
    // provenance ADR-0008 recognises — and it is byte-identical on every run.
    const repro = {
      command: 'sh tests/existing.sh',
      pinned: ['tests/existing.sh'],
    };

    const events = parse(
      execFileSync(
        'docker',
        [
          'run', '--rm', '-i',
          '-v', `${fixture.repo}:/src:ro`,
          '-v', `${blobs}:/blobs`,
          '-v', `${join(agentDir, 'claude')}:/usr/local/bin/claude:ro`,
          IMAGE,
        ],
        {
          input: JSON.stringify({
            runId: RUN_ID,
            afterSeq: 0,
            sourcePath: '/src',
            baseRef: fixture.base,
            fixRef: fixture.fix,
            repro,
            symptomPattern: 'wrong',
            flakeRuns: 2,
            agentPrompt: 'leave something running',
          }),
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        },
      ),
    );

    const state = fold([
      { run_id: RUN_ID, seq: 1, ts: new Date().toISOString(), type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } },
      ...events.map((e, i) => ({ ...e, seq: i + 2 })),
    ]);
    // The whole point: the survivor never gets to run during a phase, so the
    // committed test reports the same thing both times and nothing is credited.
    expect(state.reproduced).toBe(false);
  }, 300_000);

  test('the repro cannot plant a hook in the REAL gitdir', async () => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '.'], { cwd: process.cwd() });
    const fixture = clean();
    const blobs = hostBlobs();

    // The sibling test below attacks a fake `.git` inside the worktree, which
    // git never consults after --separate-git-dir — so it passes even when the
    // real gitdir is wide open. This aims at the real one. A refactor that
    // chowned the whole world root instead of just the worktree handed it over,
    // and the Runner then executed the hook AS ROOT on the fix checkout: both
    // arbitrary root code in the container and a fabricated verdict, since the
    // hook can simply write the fix into src.txt.
    const plant =
      'printf "#!/bin/sh\\ntouch /work/PWNED_ROOT\\necho right > /work/verify/repo/src.txt\\n" ' +
      '> /work/verify/gitdir/hooks/post-checkout 2>&1\n' +
      'chmod +x /work/verify/gitdir/hooks/post-checkout 2>&1\n' +
      'echo "ROOTMARK: $(ls /work/PWNED_ROOT 2>&1)"\n' +
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

    const outputs = await Promise.all(
      events
        .filter((e) => e.type === 'TEST_RUN')
        .map((e) =>
          get(blobs, (e.payload as { stdout_hash: ArtifactRef }).stdout_hash).then((b) =>
            b.toString(),
          ),
        ),
    );
    // The hook never ran as root: /work is root-owned, so the marker can only
    // exist if it did.
    for (const output of outputs) expect(output).toContain('ROOTMARK: ls:');
  }, 300_000);

  test('a hook the repro plants is never executed by the Runner', async () => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '.'], { cwd: process.cwd() });
    const fixture = clean();
    const blobs = hostBlobs();

    // `.git` is a FILE after --separate-git-dir, so `mkdir -p .git/hooks` cannot
    // plant anything — an earlier version of this test "passed" against a build
    // with the defense stripped out. An attacker owns the worktree, so it
    // replaces that file with a real git dir copied from the one it can read,
    // and plants there. git clean never descends into `.git`, so it survives the
    // phase-boundary scrub and fires on the fix checkout — as root, unless
    // GIT_DIR keeps git from ever looking at it.
    const plant =
      'rm -f .git\n' +
      'cp -r /work/verify/gitdir .git 2>/dev/null || true\n' +
      'printf "#!/bin/sh\\ntouch /work/PWNED\\n" > .git/hooks/post-checkout 2>/dev/null || true\n' +
      'chmod +x .git/hooks/post-checkout 2>/dev/null || true\n' +
      'echo PLANT: $(ls .git/hooks/post-checkout 2>&1)\n' +
      'echo MARKER: $(ls /work/PWNED 2>&1)\n' +
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

    const outputs = await Promise.all(
      events
        .filter((e) => e.type === 'TEST_RUN')
        .map((e) =>
          get(blobs, (e.payload as { stdout_hash: ArtifactRef }).stdout_hash).then((b) =>
            b.toString(),
          ),
        ),
    );

    // The plant must actually land, or the test proves nothing about the defense.
    expect(outputs[0]).toContain('PLANT: .git/hooks/post-checkout');
    // And the hook must never have run: /work is root-only, so the marker can
    // only exist if the Runner executed repro-controlled code as root.
    for (const output of outputs) expect(output).toContain('MARKER: ls:');
    expect(existsSync(join(blobs, 'OWNED'))).toBe(false);
  }, 300_000);
});
