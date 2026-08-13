// Tier and confidence: a pure projection over RunState (ADR-0004, ADR-0007).
//
// Zero I/O, zero side effects, recomputable at any time, disposable like every
// projection. Verification is the process that emits facts; this is the fold
// that assigns them meaning, and the two never mix.
//
// The governing rule is ADR-0004's: every point is traceable to a
// content-addressed artifact. No vibes. A ground that cannot name the bytes a
// reviewer would open to check it does not belong here — which is why the score
// stops short of 100 (`CEILING`) and says what the missing points were for.

import type { ArtifactRef } from './events.js';
import type { RunState } from './fold.js';

/**
 * ADR-0007's ladder, as amended by that ADR's own M3.2b note.
 *
 * Tier 2 is REACHABLE now, and this comment said the opposite 180 lines above
 * the line that returns it. It has widened from "reproduced by a scripted
 * scenario" to "reproduced, but the reproduction's independence is unverified" —
 * a scripted scenario is one case of that, and a reproduction the agent under
 * judgement wrote is another. The scripted-scenario case is still unreachable
 * for the original reason: no event distinguishes a browser script from a test.
 */
export type Tier = 1 | 2 | 3;

/** One component of the score, and the bytes that justify it. */
export type Ground = {
  claim: string;
  points: number;
  /**
   * Artifacts a reviewer can open. Empty only where the log genuinely holds no
   * bytes for the claim — a run so malformed the runs behind it are missing.
   * Every scored ground cites something; a point that cannot be checked is the
   * vibe ADR-0004 forbids.
   */
  evidence: ArtifactRef[];
};

export type Confidence = {
  /**
   * Bump when the scoring changes. Old runs re-fold under the new version
   * without history being touched, which is the point of keeping the score out
   * of the log (ADR-0004).
   *
   * **2** — the regression arm (+10) and the symptom's disappearance from the fix
   * output (+8) became grounds, the base ground now cites every base draw rather than
   * one, and the ceiling moved from 85 to 103. A `80/85` recorded anywhere against
   * version 1 is still a true statement about that run under that scale; this number is
   * how a reader knows which scale it was. It was left at 1 through the whole of that
   * change and caught only by re-reading ADR-0015's record of the first real run —
   * which is the exact drift this field exists to prevent.
   */
  scoring: 2;
  tier: Tier;
  /** 0–`ceiling`. See `unmeasured` for the rest. */
  score: number;
  /**
   * The most a run can score, and therefore the denominator to print.
   *
   * A field rather than the literal `85` it replaces. That number was written out in
   * `report.ts` twice, in `cli.ts`, in this file's own doc comments and in the README,
   * so every change to the grounds silently made five statements false — and
   * `scripts/real-run.mts` was already reading `verdict.ceiling` off a type that did
   * not have it, printing `80/undefined`. One derived number, one place.
   */
  ceiling: number;
  grounds: Ground[];
  /** What the number does not account for. Named so nobody reads a full score as "perfect". */
  unmeasured: string[];
};

/** The ceiling a run can actually reach, and the reason it is not 100. */
const DIFF_COVERAGE_POINTS = 15;

/**
 * Every ground at its maximum. The denominator, derived rather than restated.
 *
 * It is no longer 85 and no longer lands on 100, because two grounds were added and
 * rescaling the others to preserve a round number would change what every existing
 * ground claims in order to make a denominator prettier. `scoring` is the field that
 * makes numbers from different versions comparable; the total is just their sum.
 */
const CEILING = 45 + 3 * 5 + 15 + 7 + 3 + 8 + 10;

const hashesOf = (record: Record<string, ArtifactRef> | undefined): ArtifactRef[] =>
  record ? Object.values(record) : [];

export function confidence(state: RunState): Confidence {
  const unmeasured = [
    `diff-coverage of the fix against the reproduction path (worth ${DIFF_COVERAGE_POINTS})` +
      ' — retired as a filename check by ADR-0008 and not yet rebuilt with instrumentation',
    'whether a scripted scenario was used: no event distinguishes one from a test, so that ' +
      "case of ADR-0007's Tier 2 stays unrecordable",
  ];

  // The gate, first and alone. Everything below is quality ABOVE the bar, so a
  // run that did not clear it scores nothing however good the rest looks — no
  // reproduction, no fix, no partial credit (ADR-0007).
  if (!state.reproduced) {
    return {
      scoring: 2,
      tier: 3,
      score: 0,
      ceiling: CEILING,
      grounds: [
        {
          claim: notReproducedBecause(state),
          points: 0,
          evidence: state.testRuns.map((run) => run.stdout_hash),
        },
      ],
      unmeasured,
    };
  }

  // The attempt the fold credited — taken from the fold, never re-derived. A
  // second definition of "which attempt" is free to disagree with the first, and
  // an earlier version of this file proved it: it picked the LAST completed
  // attempt, so a junk attempt appended after a genuine one was scored Tier 1
  // with its green base run cited as proof the reproduction had failed.
  const attempt = state.reproducedAttempt;
  // EVERY base run, not the first. The base phase repeats now, the fold requires all of
  // them red for the reported reason, and a ground that cited one draw while the score
  // rested on several would be citing less than it claims.
  const bases = state.testRuns.filter((r) => r.phase === 'base' && r.attempt === attempt);
  const base = bases[0];
  const fixes = state.testRuns.filter((r) => r.phase === 'fix' && r.attempt === attempt);
  // The LAST registration of the attempt, matching the fold's own Map, which
  // later entries overwrite. `.find` would take the first and score a run
  // against a registration nothing was compared to.
  const registration = state.registrations.filter((r) => r.attempt === attempt).at(-1);

  // A projection must render, not throw (ADR-0009's reasoning about the fold).
  // `cli.ts` calls this straight after replay, and one malformed log should not
  // make a run permanently unviewable.
  if (!base || !registration) {
    return {
      scoring: 2,
      tier: 3,
      score: 0,
      ceiling: CEILING,
      grounds: [
        {
          claim: 'the log says a reproduction was credited but does not contain the runs behind it',
          points: 0,
          evidence: [],
        },
      ],
      unmeasured,
    };
  }

  const grounds: Ground[] = [
    {
      claim:
        `the reproduction ran red on the base commit ${bases.length} time(s), every one of them with ` +
        'output matching the reported symptom',
      points: 45,
      evidence: bases.map((r) => r.stdout_hash),
    },
  ];

  // Flake survival. The first fix run is the bar; every green re-run beyond it
  // is evidence the pass was not luck, which is what the criterion is for.
  const reruns = Math.min(Math.max(fixes.length - 1, 0), 3);
  grounds.push({
    claim: `the fix passed ${fixes.length} time(s): the first, and ${reruns} re-run(s) that could have caught a flake`,
    points: reruns * 5,
    evidence: fixes.map((r) => r.stdout_hash),
  });

  // How the reproduction was anchored. Applied bytes cannot be tampered with —
  // the engine overwrites the fix commit's version before it runs. A pinned path
  // is only ever hashed, so tampering is detectable rather than preventable
  // (ADR-0008), and that is genuinely less evidence.
  // Every registered file, not merely one. A spec may mix `files` and `pinned`,
  // and an applied wrapper around a pinned test is only as strong as the pinned
  // test — which is exactly what a fix commit rewrites.
  const registered = Object.keys(registration.files);
  const applied =
    registered.length > 0 && registered.every((path) => registration.applied.includes(path));
  grounds.push({
    claim: applied
      ? 'every file of the reproduction was written by the engine over both checkouts, so the fix commit could not touch it'
      : 'part of the reproduction was a committed path, hashed rather than applied: tampering there is detectable, not preventable',
    points: applied ? 15 : 8,
    evidence: Object.values(registration.files),
  });

  // The anchor actually holding, run by run — the hashes matching is a separate
  // fact from the anchoring strategy, and it is the one that would catch a
  // pretest hook rewriting the test between runs.
  grounds.push({
    claim: 'every run reported the reproduction byte-identical to its registration',
    points: 7,
    evidence: [...bases, ...fixes].flatMap((r) => hashesOf(r.repro_hashes)),
  });

  // Did the reported symptom actually GO AWAY?
  //
  // Base's output had to contain it, which ties the failure to the report. Nothing
  // looked at the fix's output at all — so a reproduction that printed the symptom
  // unconditionally satisfied the tie while proving nothing, and `prompts/repro.md`
  // asked for precisely that print ("on its own line, alongside whatever else you want
  // to say"). The engine handed the agent the string and then treated the echo as
  // evidence.
  //
  // Priced rather than gated, because `eofBug` proves the absence of the symptom is not
  // a necessary property of an honest reproduction: when the reported string also
  // occurs in correct output, it survives a real fix. So this ground says which
  // situation the run is in and lets the number carry it — a reproduction whose output
  // no longer mentions the symptom is strictly better evidence than one that does, and
  // neither is disqualifying.
  const symptomGone = fixes.length > 0 && fixes.every((r) => r.symptom_matched === false);
  const symptomObserved = fixes.some((r) => r.symptom_matched !== undefined);
  grounds.push({
    claim: symptomGone
      ? 'the reported symptom is present in the base output and gone from every fix run, so the ' +
        'output tracks the bug rather than being printed regardless of it'
      : symptomObserved
        ? 'the reported symptom still appears in the output of the passing fix runs: either the ' +
          'reproduction prints it regardless of the bug, or the reported wording also occurs in ' +
          'correct output — this run cannot tell which'
        : 'the fix runs predate this check, so nothing observed whether the symptom survived',
    points: symptomGone ? 8 : 0,
    evidence: fixes.map((r) => r.stdout_hash),
  });

  // THE SECOND ARM. The reproduction says the bug is gone; this says nothing else went
  // with it, and it is the question a maintainer asks first.
  //
  // Scored rather than merely reported, because until it existed a fix that turned the
  // reproduction green and the rest of the project red earned every point above and was
  // opened as a pull request that said nothing about it. `already_red` and `unmeasured`
  // score zero and say which: not knowing is not the same as knowing it is fine, and a
  // repository that arrived broken must not be told its own state is the fix's fault.
  const suites = state.suiteRuns.filter((r) => r.attempt === attempt);
  grounds.push({
    claim: {
      clean: "the project's own test suite passed on the base commit and passed again on the fix",
      broken:
        "the project's own test suite passed on the base commit and FAILS on the fix — this change " +
        'breaks something else',
      already_red:
        "the project's own test suite was already failing on the base commit, so it can say nothing " +
        'about what this fix broke',
      unmeasured:
        "the project's own test suite was not run on both commits, so no regression check stands " +
        'behind this fix',
    }[state.regression],
    points: state.regression === 'clean' ? 10 : 0,
    evidence: suites.map((r) => r.stdout_hash),
  });

  // Only `base` and `fix` aborts mean something went unwatched. Reaching `diff`
  // or `cleanup` proves the flake loop closed — the fold treats those as the
  // completion witness itself — so docking for them would contradict the fold
  // and call a fully observed run half-seen.
  const unwatched = state.aborts.some(
    (a) => a.attempt === attempt && (a.phase === 'base' || a.phase === 'fix'),
  );
  grounds.push({
    claim: unwatched
      ? 'an observation in this attempt stopped early, so part of it went unwatched'
      : 'the fix series ran to completion, witnessed by the diff observed after it',
    points: unwatched ? 0 : 3,
    // The witness has bytes, so this ground cites them like every other. An
    // unevidenced point is the vibe ADR-0004 forbids, whatever it is scoring.
    evidence: state.fixDiff ? [state.fixDiff.diff_hash] : [],
  });

  // Tier 1 is not available when the AGENT wrote the reproduction.
  //
  // Not a penalty for the agent's work — a statement about what this engine can
  // and cannot show. A reproduction supplied by a caller is a fixed artifact; one
  // authored by the agent is a COMMAND the agent chose, and a command can test
  // which commit it is standing on rather than whether the bug is present. Red on
  // base, green on a fix that changes nothing, with every anchor satisfied.
  //
  // Six versions of the sham-fix control were defeated — by oracles keyed on the
  // FIX, which it is blind to by construction, and by oracles keyed on BASE that
  // simply out-guessed it. It is advisory now: it records what it saw and decides
  // nothing, so this cap is what withholds the claim, and it does not depend on
  // any sham working.
  //
  // So the engine stops claiming what it cannot demonstrate. These runs are Tier
  // 2 — reproduced, with the reproduction's independence unverified — until
  // diff-coverage exists, which is the one measurement that separates a
  // reproduction of the bug from a test of the commit's identity, because an
  // identity oracle executes none of the lines the fix changed.
  if (state.reproAuthoredByAgent) {
    return {
      scoring: 2,
      tier: 2,
      ceiling: CEILING,
      score: grounds.reduce((total, ground) => total + ground.points, 0),
      grounds: [
        ...grounds,
        {
          claim:
            'the reproduction was written by the agent under judgement, so it cannot be shown to ' +
            'test the bug rather than which commit it is running on',
          points: 0,
          evidence: [],
        },
      ],
      unmeasured: [
        ...unmeasured,
        'the independence of an agent-authored reproduction: nothing here shows it tests the bug ' +
          'rather than which commit it is running on, and the sham-fix control is advisory — it ' +
          'records what it saw and decides nothing (ADR-0008 amendment)',
      ],
    };
  }

  return {
    scoring: 2,
    tier: 1,
    ceiling: CEILING,
    score: grounds.reduce((total, ground) => total + ground.points, 0),
    grounds,
    unmeasured,
  };
}

/**
 * Why the gate held. A Tier 3 outcome is a deliverable (ADR-0007), and "no
 * reproduction" tells whoever reads it nothing — the value is in which clause
 * failed, because that is what a follow-up would have to change.
 */
function notReproducedBecause(state: RunState): string {
  // First, because a refused handover leaves no registration at all and the
  // clause below would otherwise shadow it with 'no reproduction was ever
  // registered' — true, useless, and silent about the one finding that most
  // needs auditing: the agent handed over work it did not do.
  //
  // On `cause`, never on `reason`. The regex that stood here matched only the
  // three strings a SUCCESSFUL bundle can produce and missed every one from a
  // run that handed over no bundle — so the Runner's newly recorded bundling
  // failure reached no projection either, and the clause's own headline case
  // still reported 'no reproduction was ever registered'. Both strings it did
  // match for a null handover turned out to be dead code. It also parsed a field
  // documented `Display it; never parse it` (events.ts), which quotes
  // agent-influenced text: a repro named `./handed over` short-circuited this
  // whole ladder, and 3b.2b hands the agent authorship of that spec.
  // The LAST attempt's refusal, not the run's first. With attempts bounded, an
  // early refusal became every later attempt's Tier 3 explanation — so a run
  // whose second attempt honestly failed to reproduce reported attempt 1's "the
  // agent handed over a commit the repository already had" instead. The
  // deliverable is what this projection is for (ADR-0007); describing the wrong
  // attempt makes it worse than terse.
  //
  // Tying it to `currentAttempt` alone was too tight and dropped genuine
  // refusals: attempt 1 refused, attempt 2 starts and its agent container dies
  // before registering anything, and the run reported "no reproduction was ever
  // registered" — true, useless, and silent about the agent handing over work it
  // did not do, which is the sentence this clause exists to prevent. So it also
  // reports when the LAST attempt produced no diagnosis of its own to displace it.
  const refused = state.aborts.filter((a) => a.cause === 'handover').at(-1);
  const lastSpoke =
    state.registrations.some((r) => r.attempt === state.currentAttempt) ||
    state.testRuns.some((r) => r.attempt === state.currentAttempt);
  if (refused && (refused.attempt === state.currentAttempt || !lastSpoke)) return refused.reason;
  if (state.registrations.length === 0) return 'no reproduction was ever registered';
  if (state.testRuns.length === 0) return 'the reproduction was registered but never ran';

  // The LAST base run, because a later attempt is the one a follow-up would act
  // on. Taking the first describes an attempt that has already been superseded.
  const base = state.testRuns.filter((r) => r.phase === 'base').at(-1);
  if (!base) return 'no base-commit run was recorded, so there is nothing the fix could be compared against';
  // The ordinary shape of a raw Runner stream: `verify()` emits no
  // ATTEMPT_STARTED, so nothing declares an attempt and the fold refuses to pair
  // runs that might belong to different ones. Without this branch a flawless run
  // was reported as tampering, which is a worse lie than saying nothing.
  if (base.attempt === 0) {
    return 'no attempt was ever declared, so these runs cannot be shown to belong to the same one';
  }
  if (base.signal) return `the base run died on ${base.signal} rather than failing: a crash is not a reproduction`;
  if (base.exit_code === 0) return 'the reproduction passed on the base commit, so it does not reproduce the report';
  if (base.symptom_matched !== true) {
    return 'the base run failed, but its output did not match the reported symptom: it reproduces some other problem';
  }

  const fixes = state.testRuns.filter((r) => r.phase === 'fix' && r.attempt === base.attempt);
  if (fixes.length === 0) return 'the base run failed as reported, but no fix was ever run against it';
  if (fixes.some((r) => r.exit_code !== 0)) {
    return `the fix passed ${fixes.filter((r) => r.exit_code === 0).length} of ${fixes.length} runs: a flake is not a fix`;
  }
  const killed = fixes.find((r) => r.signal);
  if (killed) return `a fix run died on ${killed.signal} rather than passing: a crash is not a pass`;
  const registration = state.registrations.filter((r) => r.attempt === base.attempt).at(-1);
  if (!registration || Object.keys(registration.files).length === 0) {
    return 'the reproduction was registered against no files, so there is nothing it could be anchored to';
  }
  if (!state.completedAttempts.includes(base.attempt)) {
    return 'the run stopped before the fix series finished, so the passes that were seen prove nothing about the ones that were not';
  }
  // The fold gained a reason to withhold credit and this was not taught it, so
  // every such run fell through to the last line and accused the reproduction of
  // tampering that had not happened — repro hashes byte-identical across both
  // phases, and the Tier 3 deliverable, the artifact a human actually reads,
  // asserting otherwise while concealing the real finding. That is exactly the
  // "a second definition is free to disagree" failure this file's header
  // commemorates; a clause has to land here whenever one lands in the fold.
  // THIS attempt's handovers, not the run's last one. The scalar meant a later
  // attempt's commit was reported as a swap against an earlier clean attempt —
  // a fabricated accusation that also CONCEALED the real finding below it. The
  // fold gained a per-attempt rule and this projection did not, which is the
  // failure the comment above warns about, one commit later.
  const handed = state.handovers.filter(
    (h) => (h.attempt === base.attempt || h.attempt === 0) && h.kind === 'fix',
  );
  const wrong = handed
    .flatMap((h) => fixes.filter((r) => r.commit_sha !== h.commit).map((r) => ({ r, h })))
    .at(0);
  if (wrong) {
    return `the fix runs judged ${wrong.r.commit_sha}, but the agent handed over ${wrong.h.commit}: the commit verified is not the commit authored`;
  }
  return 'the reproduction that ran was not the one registered: two different tests were compared';
}
