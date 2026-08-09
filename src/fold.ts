// The pure fold: events -> RunState. This is the ONLY place interpretation
// happens (ADR-0001/0004): events say what occurred; the fold says what it means.
// Zero I/O, zero side effects. Replay (ADR-0003) is just this function.

import type {
  AgentFinishedV1,
  ArtifactRef,
  RunEndedV1,
  RunEvent,
  VerificationPhase,
  VerificationAbortedV1,
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
  /**
   * The reproduce-first gate (ADR-0007): some attempt's base run demonstrated the
   * reported bug. This is what decides whether a fix is attempted at all — no
   * reproduction, no fix — and it is true well before `reproduced` can be.
   */
  shownOnBase: boolean;
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
   * Nothing here is read when crediting a reproduction, and nothing ever should be.
   */
  transcript: { n: number; claimed_type: string | null; raw_hash: ArtifactRef; bytes: number }[];
  /** How supervision ended. This one IS evidence: the Runner watched the process. */
  agent: Omit<AgentFinishedV1, 'v'> | null;
  /** The commit the agent authored, if it authored one. Evidence, not testimony. */
  handedOver: string | null;
  /**
   * The reproduction was written by the agent under judgement, not by a caller.
   *
   * Load-bearing for the tier, not decorative. An agent-authored reproduction is
   * a COMMAND the agent chose, and a command can test which commit it is standing
   * on instead of whether the bug is present — see ADR-0008's amendment. The
   * sham-fix control catches the naive forms and provably cannot catch one that
   * keys on the fix rather than on base, so a run built this way cannot claim the
   * same thing a caller-supplied reproduction claims.
   */
  reproAuthoredByAgent: boolean;
  pr: { repo: string; pr_number: number; head_sha: string } | null;
  /**
   * Every phase that stopped being observable, in order. Not terminal: an attempt
   * can abort and the next one can still reach a PR, so these are kept out of the
   * status — but a `base` or `fix` abort does disqualify its own attempt from
   * being credited a reproduction. See `reproducedAttempt`.
   */
  aborts: { attempt: number; phase: VerificationPhase; reason: string; cause?: VerificationAbortedV1['cause'] }[];
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
  shownOnBase: false,
  fixDiff: null,
  completedAttempts: [],
  transcript: [],
  agent: null,
  handedOver: null,
  reproAuthoredByAgent: false,
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
        ...credited(state.testRuns, registrations, state.aborts, state.completedAttempts, state.handedOver),
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
    case 'AGENT_HANDED_OVER': {
      // Recomputes like every other input to the verdict. It is emitted before
      // any TEST_RUN today, so nothing changes — but "safe because of the order
      // the producer happens to use" is precisely the assumption this file has
      // been bitten by, and the fold is meant to be order-robust.
      // The FIX handover, never the repro's. Taking the last one was right only
      // by accident of event order, and `reproPrompt` without `agentPrompt` —
      // which typechecks and nothing refuses — left the repro commit standing
      // here. `reproducedAttempt` then compared the fix runs against the commit
      // that carried the TEST, denied a clean red-then-green, and `confidence`
      // wrote an accusation of a commit swap into a log where nothing was
      // swapped.
      const handedOver = event.payload.kind === 'repro' ? state.handedOver : event.payload.commit;
      const reproAuthoredByAgent = state.reproAuthoredByAgent || event.payload.kind === 'repro';
      return {
        ...next,
        handedOver,
        reproAuthoredByAgent,
        ...credited(state.testRuns, state.registrations, state.aborts, state.completedAttempts, handedOver),
      };
    }
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
        // `aborts` IS load-bearing here, since `shownOnBase` needs no completion
        // witness: a base-phase abort is the only thing that can shut the gate on
        // an attempt whose base run otherwise looks clean.
        ...credited(testRuns, state.registrations, state.aborts, state.completedAttempts, state.handedOver),
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
        ...credited(state.testRuns, state.registrations, state.aborts, completedAttempts, state.handedOver),
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
          ...(event.payload.cause ? { cause: event.payload.cause } : {}),
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
      //
      // `cause === undefined` is what makes "same producer" true rather than
      // merely intended. The host emits `cleanup` for EVERY container, including
      // the agent's and the base's — written before the fix series has run at
      // all — so without this gate a failed blob copy in an early container
      // handed the fold the one witness that exists to stop a truncated fix
      // series being credited. Red base, one green fix run, no
      // FIX_DIFF_OBSERVED, and the run folded to Tier 1.
      //
      // The phase label is prose to a second producer. The discriminator has to
      // be explicit — the same lesson as `cause` itself.
      const completed =
        event.payload.cause === undefined &&
        (event.payload.phase === 'diff' || event.payload.phase === 'cleanup')
          ? [...state.completedAttempts, state.currentAttempt]
          : state.completedAttempts;
      // Recomputed here, not only on TEST_RUN: the abort arrives *after* the runs
      // it truncates, so leaving `reproduced` alone would let a verdict earned by
      // an incomplete series stand.
      return {
        ...next,
        aborts,
        completedAttempts: completed,
        ...credited(state.testRuns, state.registrations, aborts, completed, state.handedOver),
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
/**
 * Everything the fold concludes about whether the bug was reproduced, computed
 * once so the parts cannot disagree.
 *
 * `shownOnBase` is the reproduce-first gate (ADR-0007): the bug was demonstrated
 * on the base commit, which is what decides whether a fix is attempted at all.
 * It is deliberately NOT re-derivable by the orchestrator — a second definition
 * living in a producer is exactly what ADR-0009 forbids, and this projection has
 * already been bitten once by exactly that.
 *
 * The two differ by the fix half: `shownOnBase` says the bug is real,
 * `reproducedAttempt` says a fix made it go away and survived the re-runs.
 */
function credited(
  testRuns: TestRunRecord[],
  registrations: RegisteredRepro[],
  aborts: RunState['aborts'],
  completedAttempts: number[],
  handedOver: string | null,
): { reproduced: boolean; reproducedAttempt: number | null; shownOnBase: boolean } {
  const attempt = reproducedAttempt(testRuns, registrations, aborts, completedAttempts, handedOver);
  return {
    reproduced: attempt !== null,
    reproducedAttempt: attempt,
    shownOnBase: demonstrated(testRuns, registrations, aborts).length > 0,
  };
}

/**
 * The attempts whose BASE run demonstrated the reported bug: it failed, for the
 * reported reason, running the reproduction it registered, with nothing about
 * that observation cut short.
 *
 * No completion witness here — that vouches for the fix series, which has not
 * run yet when this question is asked.
 */
function demonstrated(
  testRuns: TestRunRecord[],
  registrations: RegisteredRepro[],
  aborts: RunState['aborts'],
): TestRunRecord[] {
  // BASE aborts only. A fix-phase abort cuts short a different observation, and
  // disqualifying on it made this field retro-flip: the orchestrator runs the
  // fix container only when the gate is open, so an abort in there left the log
  // saying the gate had been shut — denying the control-flow act recorded inside
  // it, and making the field unstable under replay.
  //
  // It was also agent-choosable, which is the precise objection ADR-0009 raises
  // against deriving anything from aborts: a repro that hangs in the fix phase
  // would erase the record that the bug WAS demonstrated on base. And once
  // attempts are bounded, attempt 2's gate would read false and deny a fix for a
  // reproduction attempt 1 had genuinely shown.
  const truncated = new Set(
    aborts.filter((a) => a.phase === 'base').map((a) => a.attempt),
  );
  const registered = new Map(registrations.map((r) => [r.attempt, r]));
  return testRuns.filter((base) => {
    // attempt 0 means no ATTEMPT_STARTED was ever seen, so "within one attempt"
    // is unenforceable and runs from unrelated attempts could be paired.
    if (base.phase !== 'base' || base.attempt === 0) return false;
    if (truncated.has(base.attempt)) return false;
    // Red then green is only evidence if the same thing ran both times. An empty
    // registration is not an anchor: `.every()` over no files is vacuously true,
    // so this would degenerate into "repro_hashes was present".
    const repro = registered.get(base.attempt);
    if (!repro || Object.keys(repro.files).length === 0) return false;
    // A crash is not a test failure. A signalled death records exit_code -1,
    // which would otherwise sail through the "did it fail" test below — so an
    // OOM-killed base whose partial output happened to contain the symptom
    // string would be credited as a reproduction.
    if (base.signal) return false;
    if (base.exit_code === 0 || base.symptom_matched !== true) return false;
    return intact(base, repro);
  });
}

/** The registered bytes and the bytes that ran are the same bytes. */
const intact = (run: TestRunRecord, repro: RegisteredRepro) =>
  run.repro_hashes !== undefined &&
  Object.entries(repro.files).every(([path, hash]) => run.repro_hashes![path] === hash);

function reproducedAttempt(
  testRuns: TestRunRecord[],
  registrations: RegisteredRepro[],
  aborts: RunState['aborts'],
  completedAttempts: number[],
  handedOver: string | null,
): number | null {
  // The completion witness is the fix half's own guard. Nothing in the log states
  // how many fix runs there should have been, so "every run I can see passed" is
  // only meaningful once something vouches that I can see them all.
  // FIX_DIFF_OBSERVED is that vouching — emitted after the flake loop and nowhere
  // else — and a stream that merely stops early carries no abort to give it away.
  const completed = new Set(completedAttempts);
  const registered = new Map(registrations.map((r) => [r.attempt, r]));
  // The fix half's own truncation check, which `demonstrated()` deliberately
  // does not apply: a fix-phase abort says nothing about whether the bug was
  // shown, but it says the series judging the fix was cut short.
  const cutShort = new Set(
    aborts.filter((a) => a.phase === 'fix').map((a) => a.attempt),
  );

  const credit = demonstrated(testRuns, registrations, aborts).find((base) => {
    if (cutShort.has(base.attempt)) return false;
    if (!completed.has(base.attempt)) return false;
    const repro = registered.get(base.attempt)!;
    const fixes = testRuns.filter((r) => r.phase === 'fix' && r.attempt === base.attempt);
    // `signal` on the fix side for the same reason it is checked on the base: a
    // process killed by a signal records exit_code -1, and nothing else here
    // would notice a fix run that died rather than passed.
    // The fix runs have to be judging the commit the AGENT handed over.
    //
    // Without this the invariant lived in a test rather than in the fold that
    // ADR-0009 says owns interpretation: a producer could hand over commit A,
    // verify commit B, and still fold to `reproduced: true` with the log's own
    // record of the discrepancy sitting inert beside it.
    //
    // Only when there IS a handover — a run with no agent has nothing to tie to.
    // Scalar for now, which is only sound while there is one attempt; the 3b.2
    // attempt loop has to make it per-attempt, exactly as `RegisteredRepro`
    // already is.
    if (handedOver && fixes.some((r) => r.commit_sha !== handedOver)) return false;
    return (
      fixes.length > 0 && fixes.every((r) => r.exit_code === 0 && !r.signal && intact(r, repro))
    );
  });
  return credit ? credit.attempt : null;
}

export function fold(events: RunEvent[]): RunState {
  const first = events[0];
  if (!first) throw new Error('cannot fold an empty event stream');
  return events.reduce(apply, initialState(first.run_id));
}
