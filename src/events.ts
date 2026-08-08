// Versioned event definitions (v1). Events are facts, never interpretations
// (ADR-0001): TEST_RUN carries an exit code — what it *means* lives in the fold.
// Large artifacts are never embedded; events carry sha256: references.

/** Content-addressed artifact reference, e.g. "sha256:ab12…" */
export type ArtifactRef = `sha256:${string}`;

export type RunRequestedV1 = {
  v: 1;
  source: string; // e.g. "slack", "github"
  thread_ref: string;
  raw_text: string;
};

export type SandboxCreatedV1 = {
  v: 1;
  sandbox_id: string;
  image_ref: string;
};

export type AttemptStartedV1 = {
  v: 1;
  n: number;
};

export type TestRunV1 = {
  v: 1;
  phase: 'base' | 'fix';
  /** The commit actually checked out. Without it the record cannot say what produced the result. */
  commit_sha: string;
  /**
   * The real exit status, or -1 when the process died by signal and never
   * returned one. -1 is not a status any process can exit with, so it can
   * never be mistaken for one; `signal` carries what actually happened.
   */
  exit_code: number;
  /** Set when the process was killed rather than exiting. A crash is not a test failure. */
  signal?: string;
  stdout_hash: ArtifactRef;
  duration_ms: number;
  /**
   * Whether the captured output matched the reported symptom. An observation,
   * not an interpretation: the engine ran a regex over output it captured
   * itself, the same class of act as recording an exit code. The fold cannot
   * re-derive this — the bytes live in the blob store and the fold is pure —
   * so the observation is recorded and the conclusion drawn from it is not.
   * Base phase only; meaningless on the fix phase.
   */
  symptom_matched?: boolean;
  /** Flake re-run index. 0 is the first execution of the phase. */
  repeat?: number;
};

/**
 * What the fix changed, observed by the engine. Carries changed paths rather
 * than a verdict so the fold can compute repro-path overlap purely.
 */
export type FixDiffObservedV1 = {
  v: 1;
  /** Resolved commits, not the symbolic refs — a branch name can move after the fact. */
  base_sha: string;
  fix_sha: string;
  changed_files: string[];
  diff_hash: ArtifactRef;
};

export type PrOpenedV1 = {
  v: 1;
  repo: string;
  pr_number: number;
  head_sha: string;
  diff_hash: ArtifactRef;
};

export type EventPayload =
  | { type: 'RUN_REQUESTED'; payload: RunRequestedV1 }
  | { type: 'SANDBOX_CREATED'; payload: SandboxCreatedV1 }
  | { type: 'ATTEMPT_STARTED'; payload: AttemptStartedV1 }
  | { type: 'TEST_RUN'; payload: TestRunV1 }
  | { type: 'FIX_DIFF_OBSERVED'; payload: FixDiffObservedV1 }
  | { type: 'PR_OPENED'; payload: PrOpenedV1 };

/** One row of the events table: envelope + typed payload. */
export type RunEvent = EventPayload & {
  run_id: string;
  seq: number;
  ts: string; // ISO 8601
};
