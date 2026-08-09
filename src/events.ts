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

/**
 * The reproduction's identity, fixed before either phase runs.
 *
 * A red-then-green comparison only means something if the same thing ran both
 * times, so the repro is anchored rather than left to the fix commit's mercy:
 * `applied` paths are bytes the engine wrote over both checkouts, and the rest
 * are paths already committed, hashed here so a later change is visible.
 *
 * Every hash is of bytes the engine itself wrote or read (ADR-0006) — a
 * caller-supplied hash would be testimony wearing an evidence event's shape.
 */
export type ReproRegisteredV1 = {
  v: 1;
  command: string;
  /** Every path the reproduction depends on → sha256 observed at the base checkout. */
  files: Record<string, ArtifactRef>;
  /** Which of those the engine wrote itself. The remainder were already committed. */
  applied: string[];
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
  /**
   * The repro's paths hashed again once this run finished. The engine hashes what
   * it wrote, not what executed — a pretest hook or a collection-time plugin can
   * rewrite the test before the assertion runs, and re-runs share a working tree,
   * so a mutation during run 0 would otherwise silently govern runs 1 and 2.
   */
  repro_hashes?: Record<string, ArtifactRef>;
};

/**
 * What the fix changed, observed by the engine. Carries changed paths rather
 * than a verdict so the fold can judge the fix's substance purely (ADR-0008).
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

/**
 * Where the engine was standing when it stopped.
 *
 * `cleanup` is separate from `diff` because the distinction is not cosmetic: the
 * tidy-up runs *after* FIX_DIFF_OBSERVED, so a failure there aborts a run in
 * which every phase completed and every fact was observed. Labelling that `diff`
 * would tell an orchestrator to retry a run that already produced valid evidence
 * — and the retry would then die on the dirty-tree refusal, because the tidy-up
 * is exactly what failed.
 */
export type VerificationPhase = 'setup' | 'base' | 'fix' | 'diff' | 'cleanup';

/**
 * Observation stopped before the phases finished.
 *
 * This is not a verification result and must never be read as one: it says the
 * engine could not finish looking, not that the fix is bad. The events that came
 * before it are still real observations and are kept — discarding them was the
 * bug this event exists to fix, because a run that died in the fix phase used to
 * throw away a perfectly good base-phase observation and emit nothing at all.
 *
 * It is not terminal either. An attempt can abort and the next one can succeed,
 * so the fold records it and leaves the run's status alone.
 *
 * What it DOES do is disqualify its own attempt from being credited a
 * reproduction when it lands in `base` or `fix`: the run series is truncated,
 * and an incomplete observation is not a reproduction. See `isReproduced`.
 */
export type VerificationAbortedV1 = {
  v: 1;
  phase: VerificationPhase;
  /**
   * Why observation stopped. Bounded, because the message can quote a repro
   * command the agent wrote. Display it; never parse it.
   *
   * Deliberately prose, and therefore deliberately unfoldable: the confidence
   * projection cannot tell "the repro hung" from "the repro tried to escape the
   * repo" without regexing English, which this field forbids. A machine-readable
   * `kind` lands with that projection (M2's 3c) rather than now — it is an
   * additive field, so the payload stays `v: 1` when it does, and shipping it
   * ahead of its only consumer would be guessing at the taxonomy.
   */
  reason: string;
};

/**
 * The run stopped, and what stopped it.
 *
 * `reason` records the *cause of the process halting* — a control-flow act with
 * consequences in the world, such as an agent that was never spawned because the
 * reproduce-first gate held. It is not a verdict on the evidence, and the fold
 * pointedly does not read it to decide whether anything was reproduced: that
 * stays derived from the TEST_RUNs.
 *
 * Half these values (`pr_opened`, `not_reproduced`) are conclusions the fold can
 * reach on its own, which by ADR-0001's letter means they do not belong in an
 * event. Why they are here anyway, and why `errored` is the one thing the fold
 * takes on trust, is ADR-0009.
 */
export type RunEndedV1 = {
  v: 1;
  reason: 'pr_opened' | 'not_reproduced' | 'attempts_exhausted' | 'error';
};

export type EventPayload =
  | { type: 'RUN_REQUESTED'; payload: RunRequestedV1 }
  | { type: 'REPRO_REGISTERED'; payload: ReproRegisteredV1 }
  | { type: 'SANDBOX_CREATED'; payload: SandboxCreatedV1 }
  | { type: 'ATTEMPT_STARTED'; payload: AttemptStartedV1 }
  | { type: 'TEST_RUN'; payload: TestRunV1 }
  | { type: 'FIX_DIFF_OBSERVED'; payload: FixDiffObservedV1 }
  | { type: 'VERIFICATION_ABORTED'; payload: VerificationAbortedV1 }
  | { type: 'PR_OPENED'; payload: PrOpenedV1 }
  | { type: 'RUN_ENDED'; payload: RunEndedV1 };

/** One row of the events table: envelope + typed payload. */
export type RunEvent = EventPayload & {
  run_id: string;
  seq: number;
  ts: string; // ISO 8601
};
