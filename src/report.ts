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
  const base = state.testRuns.find((run) => run.phase === 'base' && run.attempt === attempt);
  const fixes = state.testRuns.filter((run) => run.phase === 'fix' && run.attempt === attempt);
  const repro = state.registrations.find((registration) => registration.attempt === attempt);

  const sections: string[] = [];

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
      (base
        ? `| phase | commit | exit | symptom matched | output |\n|---|---|---|---|---|\n` +
          `| base | \`${base.commit_sha.slice(0, 12)}\` | ${base.exit_code} | ` +
          `${base.symptom_matched === true ? 'yes' : 'no'} | ${artifact(context, base.stdout_hash)} |\n` +
          fixes
            .map(
              (run) =>
                `| fix (run ${run.repeat ?? 0}) | \`${run.commit_sha.slice(0, 12)}\` | ${run.exit_code} | — | ` +
                `${artifact(context, run.stdout_hash)} |`,
            )
            .join('\n') +
          `\n\nEach row is a command the engine executed itself, in a container of its own, ` +
          `with no network and no agent in it. The fix ran ${fixes.length} time` +
          `${fixes.length === 1 ? '' : 's'}: one green run is not a fix.\n`
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
      `Confidence ${score.score}/85.\n\n` +
      score.grounds.map((ground) => `- +${ground.points} ${ground.claim}`).join('\n') +
      `\n\nNot measured:\n\n` +
      score.unmeasured.map((gap) => `- ${gap}`).join('\n') +
      (state.reproAuthoredByAgent
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
export function issueComment(state: RunState, context: ReportContext): string {
  if (state.pr) {
    const score = confidence(state);
    return (
      `Opened #${state.pr.pr_number} for this.\n\n` +
      `The reproduction failed on \`${state.pr.head_sha.slice(0, 12)}\`'s parent and passes on it — ` +
      `Tier ${score.tier}, confidence ${score.score}/85. The pull request carries the failing test, ` +
      `both exit codes, the diff, and every artifact by hash.\n\n` +
      `Nothing has been merged. That is always yours.`
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

  // Tier 3, which the gate never bends on and which is a deliverable rather than a
  // failure. The info-request is structured because "we could not reproduce it" on
  // its own puts the work back on the reporter with no direction.
  return (
    `We could not reproduce this, so **no fix was attempted**. That is deliberate: a fix for a bug ` +
    `that was never reproduced is a guess with a diff attached.\n\n` +
    `What was tried:\n\n` +
    (state.registeredRepro
      ? `- a reproduction was written and registered: \`${state.registeredRepro.command}\`\n` +
        `- it did **not** fail on the base commit, or it failed for a reason that did not match the ` +
        `reported symptom\n`
      : `- no reproduction could be written from the report as it stands\n`) +
    (state.transcript.length > 0 ? `- ${state.transcript.length} transcript messages are stored\n` : '') +
    `\nWhat would most help, in order:\n\n` +
    `1. The exact steps, including anything you did before the ones that fail.\n` +
    `2. What you saw and what you expected instead — a screenshot or the literal text is ideal.\n` +
    `3. The account or data state involved, if the behaviour depends on it.\n` +
    `4. Where it happened: which environment, which version or commit.\n\n` +
    `Add any of that to this issue and label it again to start a new run.`
  );
}

/** Quote attacker-influenced text so it cannot restructure the document around it. */
const quote = (text: string): string =>
  text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
