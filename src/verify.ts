// The verification engine. Executes the phases itself and reports what it saw
// (ADR-0006): checkout base -> run repro -> checkout fix -> run repro -> flake
// re-runs -> observe the diff. Every fact originates at this process boundary,
// never from agent output.
//
// It emits fact-events and issues NO verdict. `reproduced`, tier, and
// confidence are the fold's job (ADR-0001, ADR-0004).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { put } from './blobs.js';
import type { RunEvent } from './events.js';

const execFileAsync = promisify(execFile);

export type VerifyOptions = {
  runId: string;
  /** Seq of the last event already in the log; the engine emits from afterSeq + 1. */
  afterSeq: number;
  repoPath: string;
  baseRef: string;
  fixRef: string;
  /** Shell command that reproduces the bug: non-zero on base, zero on the fix. */
  reproCommand: string;
  /** The reported symptom. Base output must match it, or the repro is of some other bug. */
  symptomPattern: RegExp;
  blobRoot: string;
  /** Extra fix-phase executions beyond the first, to catch a flaky pass. */
  flakeRuns?: number;
  /** Per-command ceiling. A repro that hangs must fail the run, not wedge it. */
  timeoutMs?: number;
};

type Execution = { exitCode: number; output: string; durationMs: number };

/** Run a command, capturing merged output and exit code without throwing on failure. */
async function run(command: string, cwd: string, timeoutMs: number): Promise<Execution> {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync('sh', ['-c', command], { cwd, timeout: timeoutMs });
    return { exitCode: 0, output: stdout + stderr, durationMs: Date.now() - startedAt };
  } catch (error) {
    // execFile rejects on non-zero exit, which is the expected base-phase result.
    const failure = error as { code?: number; killed?: boolean; stdout?: string; stderr?: string };
    if (failure.killed) {
      throw new Error(`repro command exceeded ${timeoutMs}ms: ${command}`);
    }
    return {
      exitCode: failure.code ?? 1,
      output: (failure.stdout ?? '') + (failure.stderr ?? ''),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

export async function verify(options: VerifyOptions): Promise<RunEvent[]> {
  const { runId, repoPath, baseRef, fixRef, reproCommand, symptomPattern, blobRoot } = options;
  const flakeRuns = options.flakeRuns ?? 2;
  const timeoutMs = options.timeoutMs ?? 120_000;

  const events: RunEvent[] = [];
  let seq = options.afterSeq;
  const emit = (event: Omit<RunEvent, 'run_id' | 'seq' | 'ts'>) => {
    events.push({ ...event, run_id: runId, seq: ++seq, ts: new Date().toISOString() } as RunEvent);
  };

  await git(['checkout', '--quiet', baseRef], repoPath);
  const base = await run(reproCommand, repoPath, timeoutMs);
  emit({
    type: 'TEST_RUN',
    payload: {
      v: 1,
      phase: 'base',
      exit_code: base.exitCode,
      stdout_hash: await put(blobRoot, base.output),
      duration_ms: base.durationMs,
      symptom_matched: symptomPattern.test(base.output),
      repeat: 0,
    },
  });

  await git(['checkout', '--quiet', fixRef], repoPath);
  for (let repeat = 0; repeat <= flakeRuns; repeat++) {
    const fix = await run(reproCommand, repoPath, timeoutMs);
    emit({
      type: 'TEST_RUN',
      payload: {
        v: 1,
        phase: 'fix',
        exit_code: fix.exitCode,
        stdout_hash: await put(blobRoot, fix.output),
        duration_ms: fix.durationMs,
        repeat,
      },
    });
  }

  const range = `${baseRef}..${fixRef}`;
  const changed = await git(['diff', '--name-only', range], repoPath);
  emit({
    type: 'FIX_DIFF_OBSERVED',
    payload: {
      v: 1,
      changed_files: changed.split('\n').filter(Boolean),
      diff_hash: await put(blobRoot, await git(['diff', range], repoPath)),
    },
  });

  return events;
}
