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
  /**
   * The GitHub login of the person who pressed Start (M10).
   *
   * Optional because it did not exist before runs were started by hand, and a log
   * written by an older engine is still a valid log — its absence reads as "the
   * webhook", which is exactly what it was. `source` stays `github_issue`: that is
   * where the report lives and what `thread_ref` keys on; this is who asked.
   */
  requested_by?: string;
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
 * The environment came up. The one event class v1.5 adds to the spine.
 *
 * It exists because of a distinction ADR-0013 turns on: **the recipe is testimony,
 * and the healthcheck passing is evidence.** An agent's claim about how to boot a
 * project is worth nothing on its own; a service answering on its port is a fact
 * the Runner observed at its own process boundary. This event is emitted for the
 * second, never the first — so `services` carries what was OBSERVED (`HTTP 200`,
 * `port 8080 accepted a connection`) rather than what the recipe promised.
 *
 * It is an event rather than a precondition nobody records because recipes rot, and
 * the fold has to be able to tell "the start command no longer boots the app" from
 * "we tried to reproduce the bug and could not". A run that never reaches this ends
 * `errored`, never `not_reproduced` (ADR-0007's v1.5 amendment): our infrastructure
 * being wrong about someone's project is not a finding about their bug.
 */
export type EnvReadyV1 = {
  v: 1;
  /** Every declared service, and how its answer was observed. */
  services: { name: string; port: number; healthcheck?: string; detail: string }[];
  /**
   * The recipe steps that ran and what they returned. A fact about the replay, not
   * a fact about the project: `install` exiting 0 says the command succeeded, and
   * nothing about whether it installed the right thing.
   */
  steps: { step: string; exit_code: number }[];
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
  /** Which of those the engine wrote itself. The rest it only read. */
  applied: string[];
  /**
   * Which of those paths git had at the BASE commit — observed at registration,
   * against the base tree, before anything ran.
   *
   * An observation rather than the conclusion drawn from it (ADR-0001): "the
   * repository authored this reproduction" is an interpretation, and it belongs in
   * the fold, which combines this with `applied` and with the project's own test
   * command. What could not live in the fold is this: a log carries no tree, so
   * nothing downstream can ask git what was tracked at a commit that no longer
   * exists on any disk.
   *
   * Optional because it did not exist before 8d, and a log written by an older
   * engine is still a valid log — its absence reads as "not observed", which is
   * exactly what it means.
   */
  committed?: string[];
};

export type TestRunV1 = {
  v: 1;
  /**
   * `control` is a SHAM-FIX run: the engine perturbed base itself and ran the
   * reproduction again, to see whether it was testing the bug or the commit's
   * identity. It is evidence, not a phase under judgement — every fold filter
   * keys on `base` or `fix` explicitly, so a control run is excluded from credit
   * by construction rather than by remembering to exclude it.
   *
   * It is recorded because the engine's strongest anti-gaming mechanism was
   * otherwise invisible: nothing said it had run, which file it perturbed, or
   * what came back, so "the sham stayed red because the reproduction is honest"
   * and "the sham stayed red because it corrupted something and the harness died"
   * were the same silence.
   */
  phase: 'base' | 'fix' | 'control';
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
   *
   * Recorded on BOTH phases, and the fold wants opposite answers from them: present
   * on base is what ties the failure to the report, and absent on the fix is what
   * makes that tie mean something. While only base was matched, the check was
   * satisfied by printing the string unconditionally — which the repro prompt asked
   * for — so it certified nothing at all.
   *
   * Absent on streams written before the fix side was observed. The fold reads that
   * as "not observed" and does not hold it against them.
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
 * The project's OWN test suite, run by the engine on each commit under judgement.
 *
 * The second arm of the comparison, and the one that was missing entirely. The
 * reproduction arm asks "did this change repair the reported bug"; nothing asked "did
 * it break anything else", so a fix that turned the repro green and forty other tests
 * red was credited at 80/85 and opened as a pull request. That is the one question a
 * maintainer always asks before merging, and the PR was silent on it.
 *
 * A SEPARATE event class rather than another `TEST_RUN.phase`, deliberately. Every fold
 * filter that decides credit keys on `phase === 'base' | 'fix'`, so a new phase value
 * would enter the reproduction's credit path by default and have to be excluded
 * everywhere by hand — the mistake `control` avoided by being explicit about it. A
 * different kind of observation gets a different fact class.
 *
 * `command` is carried on the event because the recipe lives outside the log: a reader
 * replaying this stream in a year cannot otherwise know what was run. It is the
 * recipe's own `test`, which is testimony — that the engine executed it and observed
 * this exit code is the evidence (ADR-0006).
 */
export type SuiteRunV1 = {
  v: 1;
  phase: 'base' | 'fix';
  command: string;
  /** -1 when the process died by signal without returning a status. */
  exit_code: number;
  signal?: string;
  stdout_hash: ArtifactRef;
  duration_ms: number;
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
 * One line the agent wrote. TESTIMONY, not evidence (ADR-0006).
 *
 * Nothing here is a fact about the world — only a fact about what arrived on a
 * pipe. The Runner observed the bytes; it did not observe that they are true.
 * The timeline renders this class visibly apart from everything the Runner
 * executed itself, and no projection may draw a verification conclusion from it.
 *
 * The agent cannot forge a sibling event by writing one: the Runner re-serialises
 * every line through `JSON.stringify`, so a message whose text happens to look
 * like a RunEvent lands inside a string field and stays there.
 */
export type AgentMessageV1 = {
  v: 1;
  /** Index in this run's transcript. The count is the record. */
  n: number;
  /**
   * The `type` the agent's own JSON claimed, or null when the line was not JSON
   * or carried no type. Named as a claim on purpose — it steers the timeline's
   * grouping and must never steer a verdict.
   */
  claimed_type: string | null;
  /** The line exactly as it arrived. The only thing anyone should trust to BE what arrived. */
  raw_hash: ArtifactRef;
  bytes: number;
};

/**
 * How supervision ended. An evidence-class fact: the Runner watched the process.
 *
 * `stopped` distinguishes a transcript that finished from one that was cut off.
 * A silently truncated transcript reads exactly like a complete one — the same
 * failure the verification stream was hardened against.
 */
export type AgentFinishedV1 = {
  v: 1;
  messages: number;
  /** -1 when the process died by signal without returning a status. */
  exit_code: number;
  signal?: string;
  /**
   * `turn_cap` was added after the first real webhook-driven run. The loop fell out of
   * its iteration ceiling with `stopped: 'exit'` and `exit_code: 0` — indistinguishable
   * from a model that finished — and the log therefore reported an agent cut off
   * mid-sentence as one that had chosen to stop. It had edited the file, verified the fix
   * through the browser, said "let me run the tests", and never committed; the run
   * aborted on a handover the repository already had, and nothing anywhere named the
   * ceiling. A ceiling that reports itself as success is the failure class this project
   * exists to refuse, and it was in our own loop.
   */
  /**
   * `malformed_tool_call` joined them for the same reason `turn_cap` did, and was found
   * the same way — by running a real model rather than by reading.
   *
   * A reasoning model can end a turn *inside* its reasoning: no content, no tool call,
   * `finish_reason: 'stop'`, nowhere near a length cap. It has not decided to stop; it
   * has failed to emit what it was about to do. Reported as `exit`, that became "the
   * agent handed over a commit the repository already had" — an accusation of idleness
   * against a model that had explored the repository, driven the browser, seen the bug
   * and written the reproduction, and got as far as planning the commit.
   */
  stopped: 'exit' | 'line_cap' | 'byte_cap' | 'timeout' | 'turn_cap' | 'malformed_tool_call' | 'spawn_failed';
};

/**
 * The commit an agent handed over, observed by the orchestrator at its own
 * boundary (ADR-0006) — not claimed by the agent.
 *
 * Without this the log said what was VERIFIED and never what the agent
 * AUTHORED, so a run that judged the repository's own commit while crediting
 * the agent was not merely unchecked at the time: it was unauditable afterwards
 * from the immutable record, which is the artifact this project sells.
 */
export type AgentHandedOverV1 = {
  v: 1;
  commit: string;
  /**
   * Which agent authored it. A run now has two, and without this the log carried
   * two indistinguishable events whose meaning was recoverable only from their
   * position relative to `REPRO_REGISTERED` — position is not a discriminator,
   * for the same reason prose is not one.
   *
   * Absent on streams written before there were two, which the fold reads as the
   * fix: that is what the single handover always was.
   */
  kind?: 'repro' | 'fix';
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
 * and an incomplete observation is not a reproduction. See `reproducedAttempt`.
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
  /**
   * What CLASS of thing went wrong, for the one consumer that must not guess.
   *
   * `reason` is prose and says so; a projection that regexed it for
   * `/handed over/` matched three of the six strings this abort can carry and
   * missed every one produced when the agent hands over no bundle at all —
   * including the failure the Runner records precisely so it would be readable.
   * The tier deliverable then reported `no reproduction was ever registered` for
   * a run that was refused, which is the shadowing bug the refusal clause was
   * added to close.
   *
   * Prose cannot be a discriminator. This can: it is set by the producer, not
   * inferred, and `reason` stays display-only as documented.
   *
   * Absent means `verify()` itself — the engine with the phase machine. That
   * distinction is load-bearing: the fold reads a `diff` or `cleanup` abort as
   * PROOF the flake loop closed, and that inference holds only for the producer
   * whose phase advances past `fix` when the loop ends. A second producer
   * emitting the same phase label hands the fold a completion witness it has no
   * standing to assert (ADR-0009), which is exactly what happened when the host
   * started recording collection failures as `cleanup`.
   *
   * `environment` is the third, and it is the one that must never read as a finding
   * about the bug: the recipe did not boot the project (ADR-0013's "recipes rot").
   * The fold disqualifies the attempt and the run ends `errored`, which is exactly
   * what ADR-0007's amendment asks for — a boot that never happened produces no
   * tier at all, because tiers describe reproductions and there was never an
   * attempt.
   *
   * `missing_env` is the fourth (M10) and is not a failure at all. The other three
   * describe something that was tried and did not work; this one is written before
   * anything is tried, by `run.ts` rather than by `verify()`, because a name the
   * recipe marks required had no value. Nothing booted, nothing was cloned, and the
   * run ends `blocked` rather than `errored` — a fault on nobody's side, with one
   * action attached. `missing` beside it carries the names.
   */
  cause?: 'handover' | 'collection' | 'environment' | 'missing_env';
  /**
   * The environment variable names a run was missing, when `cause` is `missing_env` (M10).
   *
   * Machine-readable, beside the prose, because this is the one abort a person is
   * expected to ACT on: the comment lists the names, and a UI links them to the form
   * that supplies them. Reading them back out of `reason` would be the regex-the-English
   * mistake the field above forbids.
   *
   * Additive, so the payload stays `v: 1` — absent means an abort that is not about a
   * missing name, which is every abort written before M10.
   */
  missing?: string[];
};

/**
 * The run stopped, and what stopped it.
 *
 * `reason` records the *cause of the process halting* — a control-flow act with
 * consequences in the world, such as a fix that was never attempted because the
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
  /**
   * `blocked` (M10) is the run that never started: a name the recipe marks required had
   * no value, so no sandbox was created and nothing about the report was tested.
   *
   * A reason rather than a status the fold derives, for the same reason `error` is one:
   * it is a decision the producer made and acted on — the required list is configuration,
   * like the attempt cap — and there is no evidence to derive it from, because the point
   * is that nothing ran. The fold still refuses to take it on trust alone: it demands the
   * `missing_env` abort beside it AND a log carrying no test run and no registration,
   * since "nothing ran" is a claim about the whole stream and not about one event in it.
   */
  reason: 'pr_opened' | 'not_reproduced' | 'attempts_exhausted' | 'error' | 'blocked';
};

export type EventPayload =
  | { type: 'RUN_REQUESTED'; payload: RunRequestedV1 }
  | { type: 'REPRO_REGISTERED'; payload: ReproRegisteredV1 }
  | { type: 'SANDBOX_CREATED'; payload: SandboxCreatedV1 }
  | { type: 'ATTEMPT_STARTED'; payload: AttemptStartedV1 }
  | { type: 'ENV_READY'; payload: EnvReadyV1 }
  | { type: 'AGENT_MESSAGE'; payload: AgentMessageV1 }
  | { type: 'AGENT_FINISHED'; payload: AgentFinishedV1 }
  | { type: 'AGENT_HANDED_OVER'; payload: AgentHandedOverV1 }
  | { type: 'TEST_RUN'; payload: TestRunV1 }
  | { type: 'SUITE_RUN'; payload: SuiteRunV1 }
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
