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
  exit_code: number;
  stdout_hash: ArtifactRef;
  duration_ms: number;
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
  | { type: 'PR_OPENED'; payload: PrOpenedV1 };

/** One row of the events table: envelope + typed payload. */
export type RunEvent = EventPayload & {
  run_id: string;
  seq: number;
  ts: string; // ISO 8601
};
