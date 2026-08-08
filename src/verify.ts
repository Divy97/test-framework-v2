// The verification engine. Executes the phases itself and reports what it saw
// (ADR-0006): checkout base -> run repro -> checkout fix -> run repro -> flake
// re-runs -> observe the diff. Every fact originates at this process boundary,
// never from agent output.
//
// It emits fact-events and issues NO verdict. `reproduced`, tier, and
// confidence are the fold's job (ADR-0001, ADR-0004).
//
// The governing rule for error handling here: an event is only ever emitted for
// something actually observed. Anything that prevented observation throws — a
// missing run is recoverable, a fabricated one is not.
//
// Postcondition: the repo is left checked out at fixRef. Stated, not accidental.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { put } from './blobs.js';
import type { RunEvent } from './events.js';

const execFileAsync = promisify(execFile);

/** Output capture ceiling. Beyond this the engine refuses to record rather than truncate. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** The engine could not observe the outcome. Never confuse this with observing a failure. */
export class ObservationFailed extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ObservationFailed';
  }
}

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

type Execution = { exitCode: number; signal?: string; output: string; durationMs: number };

/**
 * Run a command, capturing merged output and the real exit status.
 *
 * A non-zero exit is the expected base-phase result, so it returns rather than
 * throws. Everything else execFile can reject with — spawn failure, missing cwd,
 * output overflow, our own timeout kill — is a failure to observe and throws,
 * because recording it would put a plausible-looking exit code on an execution
 * that never produced one.
 */
async function run(command: string, cwd: string, timeoutMs: number): Promise<Execution> {
  const startedAt = Date.now();
  // Merge stderr into stdout inside the child so the artifact preserves real
  // interleaving; concatenating two buffers would invent an ordering and let the
  // symptom regex match across the seam between them.
  const merged = `( ${command} ) 2>&1`;
  try {
    const { stdout } = await execFileAsync('sh', ['-c', merged], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return { exitCode: 0, output: stdout, durationMs: Date.now() - startedAt };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      signal?: string | null;
      killed?: boolean;
      stdout?: string;
    };

    // A string code is never an exit status: ENOENT, EACCES, and — the one that
    // matters most — ERR_CHILD_PROCESS_STDIO_MAXBUFFER, where Node hands back a
    // truncated buffer that would otherwise be hashed and stored as if complete.
    if (typeof failure.code === 'string') {
      throw new ObservationFailed(`could not run repro in ${cwd} (${failure.code}): ${command}`, {
        cause: error,
      });
    }
    if (failure.killed) {
      throw new ObservationFailed(`repro command exceeded ${timeoutMs}ms: ${command}`, {
        cause: error,
      });
    }
    if (typeof failure.code !== 'number') {
      // Killed from outside — OOM killer, docker stop, a crash. The process ran
      // and died; that is observable and worth recording, but it did not exit,
      // so -1 stands in and `signal` says what really happened.
      return {
        exitCode: -1,
        signal: failure.signal ?? 'unknown',
        output: failure.stdout ?? '',
        durationMs: Date.now() - startedAt,
      };
    }
    return {
      exitCode: failure.code,
      output: failure.stdout ?? '',
      durationMs: Date.now() - startedAt,
    };
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: MAX_OUTPUT_BYTES });
  return stdout;
}

/** Check out a ref and report the commit it actually resolved to. */
async function checkout(ref: string, cwd: string): Promise<string> {
  await git(['checkout', '--quiet', ref], cwd);
  return (await git(['rev-parse', 'HEAD'], cwd)).trim();
}

export async function verify(options: VerifyOptions): Promise<RunEvent[]> {
  const { runId, repoPath, baseRef, fixRef, reproCommand, blobRoot } = options;
  const flakeRuns = options.flakeRuns ?? 2;
  const timeoutMs = options.timeoutMs ?? 120_000;

  // A caller's /g or /y regex carries lastIndex between calls, so the same output
  // could be observed differently on a second run. Strip the stateful flags.
  const symptom = new RegExp(
    options.symptomPattern.source,
    options.symptomPattern.flags.replace(/[gy]/g, ''),
  );

  // Uncommitted work would silently ride along into both phases, so the result
  // would describe neither commit. Refuse rather than verify the wrong tree.
  const dirty = await git(['status', '--porcelain', '--untracked-files=all'], repoPath);
  if (dirty.trim()) {
    throw new ObservationFailed(
      `working tree at ${repoPath} is not clean; verification would not describe either commit`,
    );
  }

  const events: RunEvent[] = [];
  let seq = options.afterSeq;
  const emit = (event: Omit<RunEvent, 'run_id' | 'seq' | 'ts'>) => {
    events.push({ ...event, run_id: runId, seq: ++seq, ts: new Date().toISOString() } as RunEvent);
  };

  const baseSha = await checkout(baseRef, repoPath);
  const base = await run(reproCommand, repoPath, timeoutMs);
  emit({
    type: 'TEST_RUN',
    payload: {
      v: 1,
      phase: 'base',
      commit_sha: baseSha,
      exit_code: base.exitCode,
      ...(base.signal ? { signal: base.signal } : {}),
      stdout_hash: await put(blobRoot, base.output),
      duration_ms: base.durationMs,
      symptom_matched: symptom.test(base.output),
      repeat: 0,
    },
  });

  const fixSha = await checkout(fixRef, repoPath);
  // Whatever the base phase left behind — caches, generated files, a seeded DB —
  // could carry the fix phase to green on its own. Ignored files are deliberately
  // spared: they are usually installed dependencies, and removing them would
  // change what is under test far more than it isolates it.
  await git(['clean', '--quiet', '-dff'], repoPath);
  // Re-runs deliberately share a working tree: they are re-executions of the same
  // fix, not independent trials, and isolating them would hide order-dependent flake.
  for (let repeat = 0; repeat <= flakeRuns; repeat++) {
    const fix = await run(reproCommand, repoPath, timeoutMs);
    emit({
      type: 'TEST_RUN',
      payload: {
        v: 1,
        phase: 'fix',
        commit_sha: fixSha,
        exit_code: fix.exitCode,
        ...(fix.signal ? { signal: fix.signal } : {}),
        stdout_hash: await put(blobRoot, fix.output),
        duration_ms: fix.durationMs,
        repeat,
      },
    });
  }

  // Three-dot: what the fix side changed since the merge base. Two-dot would
  // attribute base-side commits to the fix, over-reporting the very paths the
  // overlap check trusts. -z avoids core.quotePath mangling non-ASCII names, and
  // --no-renames keeps the original path visible instead of only the destination.
  const range = `${baseSha}...${fixSha}`;
  const changed = await git(['diff', '--name-only', '-z', '--no-renames', range], repoPath);
  emit({
    type: 'FIX_DIFF_OBSERVED',
    payload: {
      v: 1,
      base_sha: baseSha,
      fix_sha: fixSha,
      changed_files: changed.split('\0').filter(Boolean),
      diff_hash: await put(blobRoot, await git(['diff', range], repoPath)),
    },
  });

  return events;
}
