// The pure fold: events -> RunState. This is the ONLY place interpretation
// happens (ADR-0001/0004): events say what occurred; the fold says what it means.
// Zero I/O, zero side effects. Replay (ADR-0003) is just this function.

import type { ArtifactRef, RunEvent } from './events.js';

export type RunStatus = 'requested' | 'sandbox_ready' | 'attempting' | 'pr_opened';

export type TestRunRecord = {
  attempt: number;
  phase: 'base' | 'fix';
  commit_sha: string;
  exit_code: number;
  signal?: string;
  stdout_hash: ArtifactRef;
  duration_ms: number;
  symptom_matched?: boolean;
  repeat?: number;
  repro_hashes?: Record<string, ArtifactRef>;
};

export type RegisteredRepro = {
  command: string;
  files: Record<string, ArtifactRef>;
  applied: string[];
};

export type RunState = {
  runId: string;
  status: RunStatus;
  source: string | null;
  threadRef: string | null;
  currentAttempt: number; // 0 until the first ATTEMPT_STARTED
  testRuns: TestRunRecord[];
  /** The reproduction's identity, fixed before either phase ran. */
  registeredRepro: RegisteredRepro | null;
  /** Interpretation: one attempt ran the same reproduction red on base, then green on the fix. */
  reproduced: boolean;
  /** What the fix touched. Recorded for the confidence projection; the engine never judges it. */
  fixDiff: { changed_files: string[]; diff_hash: ArtifactRef } | null;
  pr: { repo: string; pr_number: number; head_sha: string } | null;
  artifactHashes: ArtifactRef[];
  lastSeq: number;
};

const initialState = (runId: string): RunState => ({
  runId,
  status: 'requested',
  source: null,
  threadRef: null,
  currentAttempt: 0,
  testRuns: [],
  registeredRepro: null,
  reproduced: false,
  fixDiff: null,
  pr: null,
  artifactHashes: [],
  lastSeq: 0,
});

export function apply(state: RunState, event: RunEvent): RunState {
  if (event.run_id !== state.runId) {
    throw new Error(`event run_id ${event.run_id} does not match run ${state.runId}`);
  }
  if (event.seq !== state.lastSeq + 1) {
    throw new Error(`seq gap in run ${state.runId}: expected ${state.lastSeq + 1}, got ${event.seq}`);
  }

  const next: RunState = { ...state, lastSeq: event.seq };

  switch (event.type) {
    case 'RUN_REQUESTED':
      return {
        ...next,
        status: 'requested',
        source: event.payload.source,
        threadRef: event.payload.thread_ref,
      };
    case 'REPRO_REGISTERED':
      return {
        ...next,
        registeredRepro: {
          command: event.payload.command,
          files: event.payload.files,
          applied: event.payload.applied,
        },
      };
    case 'SANDBOX_CREATED':
      return { ...next, status: 'sandbox_ready' };
    case 'ATTEMPT_STARTED':
      return { ...next, status: 'attempting', currentAttempt: event.payload.n };
    case 'TEST_RUN': {
      const testRuns = [
        ...state.testRuns,
        {
          attempt: state.currentAttempt,
          phase: event.payload.phase,
          commit_sha: event.payload.commit_sha,
          exit_code: event.payload.exit_code,
          signal: event.payload.signal,
          stdout_hash: event.payload.stdout_hash,
          duration_ms: event.payload.duration_ms,
          symptom_matched: event.payload.symptom_matched,
          repeat: event.payload.repeat,
          repro_hashes: event.payload.repro_hashes,
        },
      ];
      return {
        ...next,
        testRuns,
        reproduced: isReproduced(testRuns, state.registeredRepro),
        artifactHashes: [...state.artifactHashes, event.payload.stdout_hash],
      };
    }
    case 'FIX_DIFF_OBSERVED':
      return {
        ...next,
        fixDiff: {
          changed_files: event.payload.changed_files,
          diff_hash: event.payload.diff_hash,
        },
        artifactHashes: [...state.artifactHashes, event.payload.diff_hash],
      };
    case 'PR_OPENED':
      return {
        ...next,
        status: 'pr_opened',
        pr: {
          repo: event.payload.repo,
          pr_number: event.payload.pr_number,
          head_sha: event.payload.head_sha,
        },
        artifactHashes: [...state.artifactHashes, event.payload.diff_hash],
      };
    default: {
      const unknown = event as { type: string };
      throw new Error(`unknown event type: ${unknown.type}`);
    }
  }
}

/**
 * A reproduction is a base that failed *for the reported reason*, and a fix that
 * passed *every* time, within one attempt.
 *
 * Each clause exists because the engine collects a signal that would otherwise be
 * decorative. `symptom_matched` rejects a base that failed for some unrelated
 * reason — including the common case of a repro that errors because the test file
 * only exists in the fix commit. `every` rather than `some` rejects a fix that
 * passed two runs in three; a flake that happens to pass once is not a fix.
 *
 * This deliberately errs toward *not* crediting a reproduction. A false negative
 * costs an info-request (ADR-0007's Tier 3, which the design already treats as a
 * real deliverable); a false positive puts a fabricated verdict on a PR.
 */
function isReproduced(testRuns: TestRunRecord[], repro: RegisteredRepro | null): boolean {
  // Red then green is only evidence if the same thing ran both times. Without a
  // registered reproduction there is nothing to compare against, and if any run's
  // repro hashes drifted from the registration, two different tests were run —
  // which is not weak evidence, it is none.
  // An empty registration is not an anchor: `.every()` over no files is vacuously
  // true, so this would degenerate into "repro_hashes was present".
  if (!repro || Object.keys(repro.files).length === 0) return false;
  const intact = (run: TestRunRecord) =>
    run.repro_hashes !== undefined &&
    Object.entries(repro.files).every(([path, hash]) => run.repro_hashes![path] === hash);

  return testRuns.some((base) => {
    // attempt 0 means no ATTEMPT_STARTED was ever seen, so "within one attempt"
    // is unenforceable and runs from unrelated attempts could be paired.
    if (base.phase !== 'base' || base.attempt === 0) return false;
    // A crash is not a test failure. A signalled death records exit_code -1,
    // which would otherwise sail through the "did it fail" test below — so an
    // OOM-killed base whose partial output happened to contain the symptom
    // string would be credited as a reproduction.
    if (base.signal) return false;
    if (base.exit_code === 0 || base.symptom_matched !== true) return false;
    if (!intact(base)) return false;
    const fixes = testRuns.filter((r) => r.phase === 'fix' && r.attempt === base.attempt);
    return fixes.length > 0 && fixes.every((r) => r.exit_code === 0 && intact(r));
  });
}

export function fold(events: RunEvent[]): RunState {
  const first = events[0];
  if (!first) throw new Error('cannot fold an empty event stream');
  return events.reduce(apply, initialState(first.run_id));
}
