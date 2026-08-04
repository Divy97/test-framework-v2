// The pure fold: events -> RunState. This is the ONLY place interpretation
// happens (ADR-0001/0004): events say what occurred; the fold says what it means.
// Zero I/O, zero side effects. Replay (ADR-0003) is just this function.

import type { ArtifactRef, RunEvent } from './events.js';

export type RunStatus = 'requested' | 'sandbox_ready' | 'attempting' | 'pr_opened';

export type TestRunRecord = {
  attempt: number;
  phase: 'base' | 'fix';
  exit_code: number;
  stdout_hash: ArtifactRef;
  duration_ms: number;
};

export type RunState = {
  runId: string;
  status: RunStatus;
  source: string | null;
  threadRef: string | null;
  currentAttempt: number; // 0 until the first ATTEMPT_STARTED
  testRuns: TestRunRecord[];
  /** Interpretation: some attempt saw base fail (exit_code != 0) then fix pass (exit_code == 0). */
  reproduced: boolean;
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
  reproduced: false,
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
          exit_code: event.payload.exit_code,
          stdout_hash: event.payload.stdout_hash,
          duration_ms: event.payload.duration_ms,
        },
      ];
      return {
        ...next,
        testRuns,
        reproduced: isReproduced(testRuns),
        artifactHashes: [...state.artifactHashes, event.payload.stdout_hash],
      };
    }
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

/** Base failed, then fix passed, within the same attempt. */
function isReproduced(testRuns: TestRunRecord[]): boolean {
  return testRuns.some(
    (fix) =>
      fix.phase === 'fix' &&
      fix.exit_code === 0 &&
      testRuns.some(
        (base) => base.attempt === fix.attempt && base.phase === 'base' && base.exit_code !== 0,
      ),
  );
}

export function fold(events: RunEvent[]): RunState {
  const first = events[0];
  if (!first) throw new Error('cannot fold an empty event stream');
  return events.reduce(apply, initialState(first.run_id));
}
