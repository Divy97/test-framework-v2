// What the pull request and the issue comment say.
//
// The PR description is the product. Everything else in this repository exists so
// that these five sections can be written from the immutable log rather than from
// anybody's summary: the bug, the failing test, base red and fix green, the diff,
// and the tier reached. A reader who trusts none of it can open every artifact by
// hash and check.
//
// Two rules govern the text:
//
//   1. **Every claim is derived, never restated.** The fold decides what happened
//      (ADR-0009); this file renders `RunState` and `confidence()` and adds no
//      judgement of its own. A second definition of "reproduced" living in a
//      report is exactly what that ADR forbids.
//   2. **Testimony is labelled.** The agent's transcript and its screenshots go in
//      because they are useful to a reviewer, under a heading that says what they
//      are worth (ADR-0006). Nothing here presents them as evidence.

import { confidence } from './confidence.js';
import type { RunState } from './fold.js';

/** Everything outside the log that the text needs. */
export type ReportContext = {
  /** The issue as it was written. Attacker-influenced text — quoted, never parsed. */
  issue: string;
  threadRef: string;
  /** Where a reader can fetch a blob by ref, when there is somewhere. */
  artifactBase?: string;
  /**
   * The last thing the agent said, in its own words, read out of the transcript by
   * the caller. Attacker-influenced like the issue is — quoted, never parsed.
   *
   * TESTIMONY, and admissible here for a reason worth stating precisely: ADR-0006
   * forbids testimony becoming a FACT, not testimony being shown as a question. An
   * info request is not a verdict. The agent that spent twenty turns is the only
   * thing in the system that knows which single fact it was missing, and until now
   * that knowledge died with the run while the reporter got a four-item checklist
   * identical to everyone else's.
   */
  lastWord?: string;
};

/**
 * How a supervision ceiling reads to the person who filed the issue.
 *
 * `stopped` is an evidence-class fact — the Runner watched the process — and every
 * value but `exit` means the agent was cut off rather than finished. A run that
 * ended that way concluded NOTHING about the bug, and asking its reporter for more
 * steps would be billing them for our own ceiling. Milestone 7 shipped exactly that
 * accusation: two runs ended inside a model's own reasoning and the comment implied
 * the agent had been idle.
 */
const CUT_OFF: Record<string, string> = {
  timeout: 'it ran out of time',
  turn_cap: 'it reached the limit on how many turns we allow',
  line_cap: 'it produced more output than we accept',
  byte_cap: 'it produced more output than we accept',
  malformed_tool_call: 'it ended a turn inside its own reasoning, without making the call it had planned',
  spawn_failed: 'the agent never started',
};

const TIER_MEANING: Record<number, string> = {
  1: 'reproduced by a failing test whose independence is established',
  2: "reproduced, but the reproduction's independence is unverified",
  3: 'not reproduced — no fix was attempted',
};

/** A `sha256:` ref, as a link when there is a base for one and as text otherwise. */
const artifact = (context: ReportContext, ref: string): string =>
  context.artifactBase ? `[\`${ref}\`](${context.artifactBase}/${ref.replace('sha256:', '')})` : `\`${ref}\``;

/**
 * The pull request body: five sections, in this order, always all five.
 *
 * "Always all five" is the contract rather than a style preference. A description
 * that drops the tier when the tier is awkward, or the diff when the diff is
 * embarrassing, is a description a reviewer cannot calibrate — and calibration is
 * the only thing this system sells.
 */
export function pullRequestBody(state: RunState, context: ReportContext): string {
  const score = confidence(state);
  const attempt = state.reproducedAttempt;
  const bases = state.testRuns.filter((run) => run.phase === 'base' && run.attempt === attempt);
  const fixes = state.testRuns.filter((run) => run.phase === 'fix' && run.attempt === attempt);
  const repro = state.registrations.find((registration) => registration.attempt === attempt);

  const sections: string[] = [];

  // BEFORE the bug, before the evidence, before the tier. A fix that breaks the
  // project's own suite is the one thing a reviewer must not have to scroll for, and
  // burying it in the tier section beside eight other bullet points is burying it.
  // Nothing else in this document is allowed to precede it.
  if (state.regression === 'broken') {
    const broke = state.suiteRuns.find((run) => run.phase === 'fix' && run.attempt === attempt);
    sections.push(
      `> [!WARNING]\n` +
        `> **This fix breaks the project's own test suite.** \`${broke?.command ?? 'the suite'}\` ` +
        `passed on the base commit and exits ${broke?.exit_code ?? 'non-zero'} on this one.\n` +
        `>\n> The reproduction below is genuine and the evidence for it holds. What does not hold ` +
        `is that this change is safe to merge as it stands.` +
        (broke ? ` Output: ${artifact(context, broke.stdout_hash)}` : '') +
        `\n`,
    );
  }

  sections.push(
    `## The bug\n\nReported in ${context.threadRef}:\n\n` +
      `${quote(context.issue)}\n`,
  );

  sections.push(
    `## The failing test\n\n` +
      (repro
        ? `\`\`\`\n${repro.command}\n\`\`\`\n\n` +
          `Written by the repro agent and registered before the fix agent existed — ` +
          `the log proves that by \`seq\`, not by assertion. The engine wrote these bytes over ` +
          `both checkouts, so the same reproduction provably ran in both:\n\n` +
          Object.entries(repro.files)
            .map(([path, ref]) => `- \`${path}\` — ${artifact(context, ref)}`)
            .join('\n') +
          '\n'
        : 'No reproduction was registered for the credited attempt.\n'),
  );

  sections.push(
    `## Base red, fix green\n\n` +
      (bases.length > 0
        ? `| phase | commit | exit | symptom in output | output |\n|---|---|---|---|---|\n` +
          [...bases, ...fixes]
            .map(
              (run) =>
                `| ${run.phase} (run ${run.repeat ?? 0}) | \`${run.commit_sha.slice(0, 12)}\` | ` +
                `${run.exit_code} | ${run.symptom_matched === true ? 'yes' : 'no'} | ` +
                `${artifact(context, run.stdout_hash)} |`,
            )
            .join('\n') +
          `\n\nEach row is a command the engine executed itself, in a container of its own, ` +
          `with no network and no agent in it. The reproduction ran ${bases.length} time` +
          `${bases.length === 1 ? '' : 's'} on base — every one red, so the failure is not a flake — ` +
          `and ${fixes.length} time${fixes.length === 1 ? '' : 's'} on the fix: one green run is not a fix.\n\n` +
          `The **symptom** column is the anchor in both directions. The reported symptom has to appear ` +
          `in the base output, which ties the failure to the report, and has to be **gone** from every ` +
          `fix run — otherwise the reproduction printed it regardless of the bug and proved nothing.\n`
        : 'No phase runs were credited to a single attempt.\n'),
  );

  sections.push(
    `## The diff\n\n` +
      (state.fixDiff
        ? `${state.fixDiff.changed_files.map((file) => `- \`${file}\``).join('\n')}\n\n` +
          `Full diff: ${artifact(context, state.fixDiff.diff_hash)}\n`
        : 'No diff was observed.\n'),
  );

  sections.push(
    `## The tier\n\n` +
      `**Tier ${score.tier}** — ${TIER_MEANING[score.tier] ?? 'unknown'}. ` +
      `Confidence ${score.score}/${score.ceiling}.\n\n` +
      score.grounds.map((ground) => `- +${ground.points} ${ground.claim}`).join('\n') +
      `\n\nNot measured:\n\n` +
      score.unmeasured.map((gap) => `- ${gap}`).join('\n') +
      // `score.tier`, not `reproAuthoredByAgent` alone. A reproduction the repository
      // already contained is Tier 1 with an agent in the run (ADR-0018), and keying
      // this paragraph on the agent's presence made the document tell a reviewer the
      // tier could not be 1 directly underneath the line saying it was.
      (state.reproAuthoredByAgent && score.tier === 2
        ? `\n\nTier 1 is **not available** here: the reproduction was written by the party under ` +
          `judgement, so it could be an oracle over the commit rather than over the bug. That cap ` +
          `does not depend on any control working, and it is the reason this says 2 and not 1.\n`
        : '\n'),
  );

  sections.push(
    `---\n\n` +
      `The agent's transcript is **testimony**: ${state.transcript.length} message` +
      `${state.transcript.length === 1 ? '' : 's'}, stored and displayable, and an input to no ` +
      `verdict above. Merging is always human.\n`,
  );

  return sections.join('\n');
}

/** One line, for the PR title. Conventional, because the squash commit is the changelog. */
export const pullRequestTitle = (state: RunState, context: ReportContext): string => {
  const first = context.issue.split('\n')[0]?.trim() ?? 'a reported bug';
  const subject = first.length > 60 ? `${first.slice(0, 57)}…` : first;
  return `fix: ${subject.toLowerCase().replace(/^fix:?\s*/i, '')} (${context.threadRef})`;
};

/**
 * The issue comment, for EVERY terminal outcome.
 *
 * Four shapes, and the differences between them are the point: a Tier 3 is a
 * deliverable with a structured info-request, an `errored` run is our
 * infrastructure being wrong about someone's project and must never be presented
 * as a finding about their bug (ADR-0007's v1.5 amendment), and a PR is a link.
 */
/**
 * A blocked run whose abort named nothing. Unreachable through this engine — `run.ts`
 * only emits the abort with a non-empty list — and written anyway, because the fold
 * accepts any producer's stream and a sentence with a hole in it is worse than a vaguer
 * true one.
 */
const blockedWithoutNames =
  'This run did not start: the environment recipe for this repository requires a value ' +
  'that is not stored, so nothing about the report was tested and no fix was attempted. ' +
  'The run log records which one.';

export function issueComment(state: RunState, context: ReportContext): string {
  if (state.pr) {
    const score = confidence(state);
    return (
      `Opened #${state.pr.pr_number} for this.\n\n` +
      `The reproduction failed on \`${state.pr.head_sha.slice(0, 12)}\`'s parent and passes on it — ` +
      `Tier ${score.tier}, confidence ${score.score}/${score.ceiling}. The pull request carries the failing test, ` +
      `both exit codes, the diff, and every artifact by hash.\n\n` +
      `Nothing has been merged. That is always yours.`
    );
  }

  // NOTHING RAN (M10). Above `errored` on purpose: this run also failed on our side of
  // the line, but it failed for a reason the reporter can fix in one action, and burying
  // that under "a fault on our side" would hide the one sentence worth reading. Below the
  // PR branch, because a run that opened one is not blocked by definition.
  if (state.status === 'blocked') {
    // `.at(-1)`, as every other branch here reads its abort, and only when it names
    // something: an abort with no names would render "marks  as required", which is a
    // sentence about nothing.
    const missing = [...state.aborts].reverse().find((abort) => abort.cause === 'missing_env')?.missing ?? [];
    if (missing.length === 0) return blockedWithoutNames;
    return (
      `This run did not start, and nothing about the report was tested.\n\n` +
      `The environment recipe for this repository marks ` +
      `${missing.map((name: string) => `\`${name}\``).join(', ')} as required, and no value is stored ` +
      `for ${missing.length === 1 ? 'it' : 'them'}. Without ${missing.length === 1 ? 'it' : 'them'} ` +
      `the project boots half-configured, and a reproduction that fails for that reason would be ` +
      `reported as a finding about your bug, which it is not.\n\n` +
      `Add ${missing.length === 1 ? 'the value' : 'the values'} to this repository's environment ` +
      `and start the run again. **Do not paste ${missing.length === 1 ? 'it' : 'them'} into this ` +
      `issue** — anything that authenticates to another system belongs in the encrypted store, ` +
      `not in a public thread.\n\n` +
      `No fix was attempted and no pull request was opened.`
    );
  }

  if (state.status === 'errored') {
    const abort = state.aborts.at(-1);
    return (
      `This run could not be completed, and that is a fault on our side rather than a finding ` +
      `about the bug.\n\n` +
      (abort ? `Where it stopped: \`${abort.phase}\` — ${abort.reason}\n\n` : '') +
      `Nothing about whether the reported behaviour is real follows from this. The environment ` +
      `recipe for this repository may need correcting, or the run may have died before it could ` +
      `look. No fix was attempted.`
    );
  }

  if (state.shownOnBase) {
    return (
      `The bug reproduces, and the fix did not hold.\n\n` +
      `A reproduction was registered and failed on the base commit as reported, so this is a real ` +
      `bug. What could not be produced is a change that makes it pass every time — one green run ` +
      `in a series is not a fix, and the engine refuses to credit one.\n\n` +
      `No pull request has been opened. The evidence trail for the attempt is kept.`
    );
  }

  // A run the agent never finished. Ours, not the reporter's — and it is put first
  // because everything below it asks them for something, which would be the wrong
  // question. Nothing about the report has been tested.
  const cutOff = state.agent && state.agent.stopped !== 'exit' ? CUT_OFF[state.agent.stopped] : undefined;
  if (cutOff) {
    return (
      `We could not reproduce this, and the reason is on our side: the agent did not finish — ` +
      `${cutOff}.\n\n` +
      `**No fix was attempted, and nothing here is a finding about your report.** It was not ` +
      `tested to a conclusion. The evidence trail for what did happen is kept, including ` +
      `${state.transcript.length} transcript messages.\n\n` +
      `Start a new run from the dashboard when you want another attempt. If it stops here ` +
      `twice, the report is probably fine and the bug is ours.`
    );
  }

  // Tier 3, which the gate never bends on and which is a deliverable rather than a
  // failure. The info-request is structured because "we could not reproduce it" on
  // its own puts the work back on the reporter with no direction.
  const tried =
    `What was tried:\n\n` +
    (state.registeredRepro
      ? `- a reproduction was written and registered: \`${state.registeredRepro.command}\`\n` +
        `- it did **not** fail on the base commit, or it failed for a reason that did not match the ` +
        `reported symptom\n`
      : `- no reproduction could be written from the report as it stands\n`) +
    (state.transcript.length > 0 ? `- ${state.transcript.length} transcript messages are stored\n` : '');

  const opening =
    `We could not reproduce this, so **no fix was attempted**. That is deliberate: a fix for a bug ` +
    `that was never reproduced is a guess with a diff attached.\n\n` +
    tried;

  // The specific ask, when there is one. The generic list is what everybody gets
  // when there is not — and the whole point of this branch is that it should not be
  // what everybody gets.
  if (context.lastWord) {
    return (
      opening +
      `\nThe agent that looked said this, in its own words:\n\n` +
      `${quote(context.lastWord)}\n\n` +
      `That is the agent's account, not a finding: nothing here checked it. It is quoted because ` +
      `the run that just spent twenty turns on your issue is the only thing that knows which fact ` +
      `it was missing.\n\n` +
      `Add what it asked for to this issue, then start a new run from the dashboard.`
    );
  }

  return (
    opening +
    `\nWhat would most help, in order:\n\n` +
    `1. The exact steps, including anything you did before the ones that fail.\n` +
    `2. What you saw and what you expected instead — a screenshot or the literal text is ideal.\n` +
    `3. The account or data state involved, if the behaviour depends on it.\n` +
    `4. Where it happened: which environment, which version or commit.\n\n` +
    `Add any of that to this issue, then start a new run from the dashboard.`
  );
}

/**
 * The comment posted at t=0, when triage found something worth asking (8e).
 *
 * It says a run has started as well as asking, because those two facts belong in the
 * same message: a question with no context reads as a bot demanding homework, and the
 * engine currently says nothing at all until it is finished. And it says where the
 * question came from — a model, reading their report — because a question the
 * reporter can see the provenance of is one they can also dismiss.
 */
export const triageComment = (question: string): string =>
  `A run has started on this. A sandbox is coming up, the reported behaviour is being reproduced, ` +
  `and you will get either a pull request carrying the evidence or an explanation of why not.\n\n` +
  `One thing would help while that happens:\n\n` +
  `${quote(question)}\n\n` +
  `That question came from a model reading your report against this repository, so it may be wrong ` +
  `or already answered above — the run does not wait for it either way.`;

/** Quote attacker-influenced text so it cannot restructure the document around it. */
const quote = (text: string): string =>
  text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
