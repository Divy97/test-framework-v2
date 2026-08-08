// The Runner: PID 1 inside the sandbox (ADR-0006). It clones the repo, executes
// the verification engine, and pushes the resulting events out through one
// channel — stdout, one JSON object per line.
//
// It does not interpret anything. Whatever `verify()` observed goes out verbatim,
// and the fold decides what it means.
//
// No agent yet: M3.1 proves containment and the event path with nothing
// non-deterministic in the loop.

import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ObservationFailed, verify, type ReproSpec } from './verify.js';

const execFileAsync = promisify(execFile);

/** What the host asks the sandbox to verify. Read as JSON on stdin. */
export type Job = {
  runId: string;
  afterSeq: number;
  /** Path to the source repo, mounted read-only. Cloned rather than used in place. */
  sourcePath: string;
  baseRef: string;
  fixRef: string;
  repro: ReproSpec;
  /** Serialised as a string: JSON has no regex, and the source must survive the wire. */
  symptomPattern: string;
  flakeRuns?: number;
  timeoutMs?: number;
};

const WORK = '/work';
/** Matches the `repro` user created in the Dockerfile. */
const REPRO_UID = 1000;
const REPRO_GID = 1000;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

export async function runJob(
  job: Job,
  workDir = WORK,
  emit: (line: string) => void = (line) => process.stdout.write(line),
): Promise<number> {
  const repoPath = `${workDir}/repo`;
  const blobRoot = `${workDir}/blobs`;
  await mkdir(blobRoot, { recursive: true });

  // Clone rather than work in the mounted directory. The mount is the host's
  // tree; verifying in place would put host state inside the evidence and let
  // the run write back out through it.
  // `--` so a sourcePath cannot be read as an option: `--upload-pack=…` and
  // `ext::sh -c …` are both command execution.
  await execFileAsync('git', ['clone', '--quiet', '--no-local', '--', job.sourcePath, repoPath]);

  // The repro runs as this user, not as the Runner. Root in the Runner's own
  // namespace can reach the event channel through /proc/1/fd/N whatever the
  // Runner does with its own descriptors.
  const runAs = { uid: REPRO_UID, gid: REPRO_GID };
  await execFileAsync('chown', ['-R', `${REPRO_UID}:${REPRO_GID}`, workDir]);
  // The Runner stays root, so git now sees a tree owned by someone else and
  // refuses it as "dubious ownership". Scoped to this path, inside a container
  // built for exactly one run.
  await execFileAsync('git', ['config', '--global', '--add', 'safe.directory', repoPath]);

  const events = await verify({
    runId: job.runId,
    afterSeq: job.afterSeq,
    repoPath,
    baseRef: job.baseRef,
    fixRef: job.fixRef,
    repro: job.repro,
    symptomPattern: new RegExp(job.symptomPattern),
    blobRoot,
    runAs,
    ...(job.flakeRuns === undefined ? {} : { flakeRuns: job.flakeRuns }),
    ...(job.timeoutMs === undefined ? {} : { timeoutMs: job.timeoutMs }),
  });

  // One event per line: the channel is append-only in shape as well as intent,
  // and a consumer can fold it as it arrives without waiting for the run to end.
  for (const event of events) emit(`${JSON.stringify(event)}\n`);
  return 0;
}

// Only run when executed directly, so the tests can import runJob.
if (process.argv[1]?.endsWith('runner.ts') || process.argv[1]?.endsWith('runner.js')) {
  // The repro runs as root in this PID namespace, so `/proc/1/fd/1` is reachable
  // — and that file *is* the event channel. An agent could write straight onto
  // it: forged events, and a write without a trailing newline concatenates onto
  // the next real one and destroys REPRO_REGISTERED, the anchor everything else
  // rests on. So take a private handle on the real stdout and leave fd 1 as a
  // dead end. The agent must never be able to append (ADR-0006).
  const channel = openSync('/proc/self/fd/1', 'w');
  closeSync(1);
  openSync('/dev/null', 'w'); // reuses fd 1, so /proc/1/fd/1 now goes nowhere

  try {
    const job = JSON.parse(await readStdin()) as Job;
    // Set the code, never call process.exit: stdout on a pipe is asynchronous,
    // and exiting discards whatever is still queued. A large FIX_DIFF_OBSERVED
    // was being cut mid-JSON while the run reported success — silent evidence
    // loss presented as a clean record, which is the worst failure this project
    // has.
    process.exitCode = await runJob(job, WORK, (line) => writeSync(channel, line));
  } catch (error) {
    // A failure to observe is not a verification result. It leaves on stderr so
    // it can never be mistaken for an event on the channel.
    const failed = error instanceof ObservationFailed;
    process.stderr.write(`${failed ? 'ObservationFailed' : 'RunnerError'}: ${String(error)}\n`);
    process.exitCode = failed ? 2 : 1;
  }
}
