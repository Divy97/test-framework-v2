// The pure fold: events -> RunState. This is the ONLY place interpretation
// happens (ADR-0001/0004): events say what occurred; the fold says what it means.
// Zero I/O, zero side effects. Replay (ADR-0003) is just this function.

import type {
  AgentFinishedV1,
  ArtifactRef,
  RunEndedV1,
  RunEvent,
  VerificationPhase,
} from './events.js';

/**
 * `unresolved` and `errored` are deliberately separate terminal states.
 *
 * "We could not reproduce it" is a real deliverable (ADR-0007) and belongs on the
 * dashboard as an outcome. "The sandbox fell over" is an operational failure and
 * belongs there as a fault. Folding them into one status would let an
 * infrastructure problem masquerade as a finding about the bug.
 */
export type RunStatus =
  | 'requested'
  | 'sandbox_ready'
  | 'attempting'
  | 'pr_opened'
  | 'unresolved'
  | 'errored';

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
  /**
   * Which attempt registered it. A run may register a fresh reproduction on each
   * attempt, and without this the fold judged every attempt's runs against
   * whichever registration happened to be last — crediting runs that never
   * executed the repro they were compared to, and destroying an earlier
   * attempt's honestly earned verdict when a later attempt merely re-registered.
   */
  attempt: number;
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
  /** The reproduction's identity, fixed before either phase ran. The latest, for display. */
  registeredRepro: RegisteredRepro | null;
  /** Every registration, so each attempt is judged against its own. */
  registrations: RegisteredRepro[];
  /** Interpretation: one attempt ran the same reproduction red on base, then green on the fix. */
  reproduced: boolean;
  /**
   * WHICH attempt earned that, or null. Recorded rather than left to be
   * re-derived: a second definition of "the credited attempt" living in a
   * consumer is free to disagree with this one, and did — the confidence
   * projection scored a later junk attempt as Tier 1 and cited its green base
   * run as proof the reproduction had failed (ADR-0009's rule against
   * reimplementing the fold).
   */
  reproducedAttempt: number | null;
  /** What the fix touched. Recorded for the confidence projection; the engine never judges it. */
  fixDiff: { changed_files: string[]; diff_hash: ArtifactRef } | null;
  /**
   * Attempts whose fix series provably ran to completion.
   *
   * FIX_DIFF_OBSERVED is emitted only once the flake loop has finished, so its
   * presence is the log's own witness that nothing was cut short — the run count
   * the log otherwise never states. Without it a stream that simply *stops* after
   * one green fix run is indistinguishable from a completed series, and no abort
   * need appear for that to happen: the Runner writes its events in one loop at
   * the end, and a host appending them as they arrive can die mid-stream. Events
   * are immutable, so that truncation is permanent.
   */
  completedAttempts: number[];
  /**
   * The agent's transcript. TESTIMONY (ADR-0006) — displayed, never trusted.
   *
   * Kept in its own field rather than mixed into the run's record so a consumer
   * cannot reach it by accident, and deliberately NOT added to `artifactHashes`:
   * that list feeds the evidence report, and what the agent said is not evidence.
   * Nothing here is read by `isReproduced`, and nothing here ever should be.
   */
  transcript: { n: number; claimed_type: string | null; raw_hash: ArtifactRef; bytes: number }[];
  /** How supervision ended. This one IS evidence: the Runner watched the process. */
  agent: Omit<AgentFinishedV1, 'v'> | null;
  pr: { repo: string; pr_number: number; head_sha: string } | null;
  /**
   * Every phase that stopped being observable, in order. Not terminal: an attempt
   * can abort and the next one can still reach a PR, so these are kept out of the
   * status — but a `base` or `fix` abort does disqualify its own attempt from
   * being credited a reproduction. See `isReproduced`.
   */
  aborts: { attempt: number; phase: VerificationPhase; reason: string }[];
  /**
   * Event types that arrived after RUN_ENDED, recorded and NOT applied.
   *
   * The store enforces unique `(run_id, seq)`; nothing enforces terminality at
   * write. A producer race can therefore append past the end, and events are
   * immutable — so throwing here would leave the run permanently unrenderable
   * with no repair path. A projection that refuses to render is worse than one
   * that renders the truth plus "this log is malformed".
   */
  afterEnd: string[];
  /**
   * What the run said stopped it, verbatim. Recorded as a stated cause, never read
   * as a verdict — `reproduced` and `status` are derived from the facts regardless
   * of what this claims.
   */
  endedReason: RunEndedV1['reason'] | null;
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
  registrations: [],
  reproduced: false,
  reproducedAttempt: null,
  fixDiff: null,
  completedAttempts: [],
  transcript: [],
  agent: null,
  pr: null,
  aborts: [],
  afterEnd: [],
  endedReason: null,
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
  // RUN_ENDED means it ended, so a stream that keeps going is malformed — two
  // runs interleaved, or a producer restarted against a closed log. Record the
  // anomaly and refuse to apply it, rather than throw. A racing append is a
  // plausible way to get here, events are immutable, and throwing would make the
  // run permanently unrenderable with no repair path.
  //
  // The checks above still throw, and the difference is what the fold can see. A
  // duplicate seq the store rejects outright; a *gap* it does not, and a gap
  // means events are missing — rendering a state from an admittedly incomplete
  // log is the one thing worse than refusing to render. Here nothing is missing:
  // there is simply more than there should be.
  if (state.endedReason !== null) {
    return { ...state, lastSeq: event.seq, afterEnd: [...state.afterEnd, event.type] };
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
    case 'REPRO_REGISTERED': {
      const registration = {
        attempt: state.currentAttempt,
        command: event.payload.command,
        files: event.payload.files,
        applied: event.payload.applied,
      };
      const registrations = [...state.registrations, registration];
      return {
        ...next,
        registeredRepro: registration,
        registrations,
        // Ordinarily a no-op — registration precedes the runs it anchors — but it
        // keeps the value derived from the current inputs rather than left over
        // from the last TEST_RUN.
        ...credited(state.testRuns, registrations, state.aborts, state.completedAttempts),
      };
    }
    case 'AGENT_MESSAGE':
      // Recorded and nothing else. No status change, no recompute of anything —
      // the agent talking cannot move the run forward, only the Runner's own
      // observations can.
      return {
        ...next,
        transcript: [
          ...state.transcript,
          {
            n: event.payload.n,
            claimed_type: event.payload.claimed_type,
            raw_hash: event.payload.raw_hash,
            bytes: event.payload.bytes,
          },
        ],
      };
    case 'AGENT_FINISHED': {
      const { v, ...finished } = event.payload;
      return { ...next, agent: finished };
    }
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
        // Passing `aborts` here is defence in depth and knowingly untested: with
        // the completion witness required, an attempt that aborted in base or fix
        // has no FIX_DIFF_OBSERVED either, so this argument cannot be the
        // deciding one on any stream `verify()` can emit. It is kept because the
        // fold does not get to assume event ordering (ADR-0009) — but no fixture
        // can make it load-bearing, and pretending otherwise would be decoration.
        ...credited(testRuns, state.registrations, state.aborts, state.completedAttempts),
        artifactHashes: [...state.artifactHashes, event.payload.stdout_hash],
      };
    }
    case 'FIX_DIFF_OBSERVED': {
      const completedAttempts = [...state.completedAttempts, state.currentAttempt];
      return {
        ...next,
        fixDiff: {
          changed_files: event.payload.changed_files,
          diff_hash: event.payload.diff_hash,
        },
        completedAttempts,
        // The completion witness arrives after the runs it vouches for, so a fold
        // that only recomputed on TEST_RUN would never see it.
        ...credited(state.testRuns, state.registrations, state.aborts, completedAttempts),
        artifactHashes: [...state.artifactHashes, event.payload.diff_hash],
      };
    }
    case 'VERIFICATION_ABORTED': {
      // Status deliberately untouched. The run is still attempting until something
      // says it ended, and a later attempt may yet succeed.
      const aborts = [
        ...state.aborts,
        {
          attempt: state.currentAttempt,
          phase: event.payload.phase,
          reason: event.payload.reason,
        },
      ];
      // An abort in `diff` or `cleanup` witnesses completion just as
      // FIX_DIFF_OBSERVED does. The engine's phase only advances past `fix` once
      // the flake loop has closed, so reaching either one proves every re-run was
      // recorded — same producer, same strength of evidence.
      //
      // Without this the witness is unobtainable exactly when the diff is what
      // failed: the phase is set to `diff` *before* the diff is computed, so a
      // diff-phase abort always lacks FIX_DIFF_OBSERVED. A genuine Tier 1
      // reproduction — red base, every fix run green, all observed — would be
      // thrown away because git could not describe two unrelated histories.
      const completed =
        event.payload.phase === 'diff' || event.payload.phase === 'cleanup'
          ? [...state.completedAttempts, state.currentAttempt]
          : state.completedAttempts;
      // Recomputed here, not only on TEST_RUN: the abort arrives *after* the runs
      // it truncates, so leaving `reproduced` alone would let a verdict earned by
      // an incomplete series stand.
      return {
        ...next,
        aborts,
        completedAttempts: completed,
        ...credited(state.testRuns, state.registrations, aborts, completed),
      };
    }
    case 'RUN_ENDED':
      return {
        ...next,
        endedReason: event.payload.reason,
        // The PR question is derived: a stream claiming `pr_opened` with no
        // PR_OPENED in it does not get to show a PR, and one claiming
        // `not_reproduced` after a PR was opened does not get to hide it.
        //
        // `errored` is the single thing the fold takes on the producer's word,
        // and that asymmetry is deliberate (ADR-0009). An infrastructure failure
        // is unevidenced by construction — the container is killed, the channel
        // dies, no event is written — so untrusted it could not exist at all, and
        // every operational fault would render as a finding about the bug. The
        // obvious alternative, deriving it from `aborts`, is worse: an abort is a
        // failure to observe and the repro can cause one, so the agent under
        // judgement could flip its own run out of `unresolved` by hanging.
        status: state.pr ? 'pr_opened' : event.payload.reason === 'error' ? 'errored' : 'unresolved',
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
/** `reproduced` and `reproducedAttempt` together, so they can never disagree. */
function credited(
  testRuns: TestRunRecord[],
  registrations: RegisteredRepro[],
  aborts: RunState['aborts'],
  completedAttempts: number[],
): { reproduced: boolean; reproducedAttempt: number | null } {
  const attempt = reproducedAttempt(testRuns, registrations, aborts, completedAttempts);
  return { reproduced: attempt !== null, reproducedAttempt: attempt };
}

function reproducedAttempt(
  testRuns: TestRunRecord[],
  registrations: RegisteredRepro[],
  aborts: RunState['aborts'],
  completedAttempts: number[],
): number | null {
  // An attempt whose base or fix phase stopped being observable is an attempt we
  // did not finish watching, and the fix series it produced is truncated. Nothing
  // in the log says how many re-runs there should have been, so `every` below
  // would really be asking "did every run we managed to see pass" — and the runs
  // we did not see are exactly the ones an agent would arrange to fail.
  //
  // Concretely: a repro that passes the first fix run and hangs on the re-run
  // would otherwise be credited off a single green run, handing the agent under
  // judgement the flake-survival criterion. An incomplete observation is not a
  // reproduction.
  //
  // `diff` and `cleanup` aborts are not disqualifying — they are the opposite.
  // Reaching either phase proves the flake loop closed, so they COUNT as the
  // completion witness (see the VERIFICATION_ABORTED case).
  const truncated = new Set(
    aborts.filter((a) => a.phase === 'base' || a.phase === 'fix').map((a) => a.attempt),
  );
  // Belt and braces, deliberately. The witness check below is the load-bearing
  // one — it needs no faith in event ordering — while this one catches an
  // announced truncation even if a producer somehow emitted a diff anyway.
  const completed = new Set(completedAttempts);
  // Each attempt is judged against the reproduction IT registered. A run may
  // register a fresh one per attempt, and comparing every attempt's runs to
  // whichever registration came last credits runs that never executed the repro
  // they are measured by — and erases an earlier attempt's honest verdict the
  // moment a later attempt re-registers.
  const registered = new Map(registrations.map((r) => [r.attempt, r]));
  const intact = (run: TestRunRecord, repro: RegisteredRepro) =>
    run.repro_hashes !== undefined &&
    Object.entries(repro.files).every(([path, hash]) => run.repro_hashes![path] === hash);

  const credit = testRuns.find((base) => {
    // attempt 0 means no ATTEMPT_STARTED was ever seen, so "within one attempt"
    // is unenforceable and runs from unrelated attempts could be paired.
    if (base.phase !== 'base' || base.attempt === 0) return false;
    if (truncated.has(base.attempt)) return false;
    // Nothing in the log states how many fix runs there should have been, so
    // "every run I can see passed" is only meaningful once something vouches
    // that I can see them all. FIX_DIFF_OBSERVED is that vouching — it is
    // emitted after the flake loop and nowhere else. A stream that merely stops
    // early carries no abort to give it away.
    if (!completed.has(base.attempt)) return false;
    // Red then green is only evidence if the same thing ran both times. Without a
    // registered reproduction there is nothing to compare against, and if any
    // run's repro hashes drifted from the registration, two different tests were
    // run — which is not weak evidence, it is none.
    // An empty registration is not an anchor: `.every()` over no files is
    // vacuously true, so this would degenerate into "repro_hashes was present".
    const repro = registered.get(base.attempt);
    if (!repro || Object.keys(repro.files).length === 0) return false;
    // A crash is not a test failure. A signalled death records exit_code -1,
    // which would otherwise sail through the "did it fail" test below — so an
    // OOM-killed base whose partial output happened to contain the symptom
    // string would be credited as a reproduction.
    if (base.signal) return false;
    if (base.exit_code === 0 || base.symptom_matched !== true) return false;
    if (!intact(base, repro)) return false;
    const fixes = testRuns.filter((r) => r.phase === 'fix' && r.attempt === base.attempt);
    // `signal` on the fix side for the same reason it is checked on the base: a
    // process killed by a signal records exit_code -1, and nothing else here
    // would notice a fix run that died rather than passed.
    return (
      fixes.length > 0 &&
      fixes.every((r) => r.exit_code === 0 && !r.signal && intact(r, repro))
    );
  });
  return credit ? credit.attempt : null;
}

export function fold(events: RunEvent[]): RunState {
  const first = events[0];
  if (!first) throw new Error('cannot fold an empty event stream');
  return events.reduce(apply, initialState(first.run_id));
}
