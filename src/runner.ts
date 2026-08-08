// The Runner: PID 1 inside the sandbox (ADR-0006). It clones the repo, executes
// the verification engine, and pushes the resulting events out through one
// channel — stdout, one JSON object per line.
//
// It does not interpret anything. Whatever `verify()` observed goes out verbatim,
// and the fold decides what it means.
//
// No agent yet: M3.1 proves containment and the event path with nothing
// non-deterministic in the loop.

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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

export async function runJob(job: Job, workDir = WORK): Promise<number> {
  const repoPath = `${workDir}/repo`;
  const blobRoot = `${workDir}/blobs`;
  await mkdir(blobRoot, { recursive: true });

  // Clone rather than work in the mounted directory. The mount is the host's
  // tree; verifying in place would put host state inside the evidence and let
  // the run write back out through it.
  await execFileAsync('git', ['clone', '--quiet', '--no-local', job.sourcePath, repoPath]);

  const events = await verify({
    runId: job.runId,
    afterSeq: job.afterSeq,
    repoPath,
    baseRef: job.baseRef,
    fixRef: job.fixRef,
    repro: job.repro,
    symptomPattern: new RegExp(job.symptomPattern),
    blobRoot,
    ...(job.flakeRuns === undefined ? {} : { flakeRuns: job.flakeRuns }),
    ...(job.timeoutMs === undefined ? {} : { timeoutMs: job.timeoutMs }),
  });

  // One event per line: the channel is append-only in shape as well as intent,
  // and a consumer can fold it as it arrives without waiting for the run to end.
  for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
  return 0;
}

// Only run when executed directly, so the tests can import runJob.
if (process.argv[1]?.endsWith('runner.ts') || process.argv[1]?.endsWith('runner.js')) {
  try {
    process.exit(await runJob(JSON.parse(await readStdin()) as Job));
  } catch (error) {
    // A failure to observe is not a verification result. It leaves on stderr so
    // it can never be mistaken for an event on the channel.
    const failed = error instanceof ObservationFailed;
    process.stderr.write(`${failed ? 'ObservationFailed' : 'RunnerError'}: ${String(error)}\n`);
    process.exit(failed ? 2 : 1);
  }
}
