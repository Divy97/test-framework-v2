// One run, end to end: an issue in, a pull request out.
//
// This is the file the milestone's "what done looks like" describes — "a person
// opens a GitHub issue and receives a pull request whose description proves the bug
// existed before the change and does not exist after it, with no step in between
// where the engine trusted anything the agent said."
//
// It is deliberately a sequence and not a swarm. The ORDER is the product: the repro
// agent runs before the base phase so `REPRO_REGISTERED` provably precedes the fix
// agent by `seq` (ADR-0008), the gate reads the fold before a fix is attempted
// (ADR-0007, ADR-0009), and the PR is opened only after the fix phase passed.
//
// Three things it holds that nothing below it may:
//
//   1. **The installation token.** Minted here, used for the clone and the push and
//      the API, and never passed into a container (ADR-0012). Minted TWICE on
//      purpose — see the comment at the push.
//   2. **The pen.** Every event is appended by this function or by `orchestrate()`,
//      which is the same trust boundary (ADR-0006's amendment).
//   3. **The obligation to answer.** A run that ends silently is worse than no run,
//      so the issue comment is in a `finally`.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { get, put } from './blobs.js';
import type { RunEvent } from './events.js';
import { fold, type RunState } from './fold.js';
import type { LoopUsage } from './loop.js';
import {
  cloneRepository,
  repoUrl,
  commentOnIssue,
  installationToken,
  openPullRequest,
  pushBranch,
  type GitHubApp,
  type IssueIntake,
} from './github.js';
import { orchestrate, type RunPlan, type SealedWorld } from './orchestrate.js';
import { describeEnvironment, renderPrompt } from './prompts.js';
import { redact } from './redact.js';
import { missingRequired, type Recipe } from './recipe.js';
import { issueComment, pullRequestBody, pullRequestTitle, triageComment } from './report.js';
import { triage } from './triage.js';

const execFileAsync = promisify(execFile);

/** What a Tier 3 comment may quote of the agent, bounded. Longer is a wall, not an ask. */
const MAX_LAST_WORD_CHARS = 1_200;

/**
 * The last thing the agent said, for the comment to quote.
 *
 * Read here rather than in `report.ts` because the text lives in the blob store and
 * the report builder is deliberately a pure function of the fold: it renders what it
 * is handed and reaches for nothing. The transcript in `RunState` carries hashes,
 * which is the right thing for it to carry — a fold that dereferenced blobs would be
 * a fold with IO in it.
 *
 * Only when the agent FINISHED. Every other `stopped` value means it was cut off
 * mid-thought, and quoting a sentence a ceiling interrupted as though it were an
 * answer is the same class of mistake as milestone 7's "the agent handed over a
 * commit the repository already had" — a confident diagnosis of a model that had
 * been stopped by us.
 */
async function lastWord(blobRoot: string, state: RunState): Promise<{ lastWord?: string }> {
  if (state.agent?.stopped !== 'exit') return {};
  const said = state.transcript.filter((line) => line.claimed_type === 'assistant').at(-1);
  if (!said) return {};
  try {
    const raw = (await get(blobRoot, said.raw_hash)).toString('utf8');
    const text: unknown = (JSON.parse(raw) as { text?: unknown }).text;
    if (typeof text !== 'string') return {};
    const trimmed = redact(text).trim();
    // A sign-off is not an info request. Below this it says nothing the four-item
    // checklist does not say better, and the checklist is what the fallback is for.
    if (trimmed.length < 40) return {};
    return { lastWord: trimmed.slice(0, MAX_LAST_WORD_CHARS) };
  } catch {
    // A blob that will not resolve or parse is not worth a run's last word. The
    // generic ask is still a real deliverable.
    return {};
  }
}

export type RunRequest = {
  /**
   * An ISSUE intake specifically. `intake()` also maps installation deliveries now
   * (M6a), and those carry no issue to comment on and no reported text — this function
   * would have to invent both to accept one.
   */
  intake: IssueIntake;
  app: GitHubApp;
  /** Null for a repository with no recipe yet. Nothing boots, and the agent is told so. */
  recipe: Recipe | null;
  image: string;
  /** The image with a browser in it, for the agent container only (5f). */
  agentImage?: string;
  blobRoot: string;
  /**
   * Where the events go. Injected because the store is a `Db` and the shape of
   * a run has nothing to do with Postgres — and because a test needs to read them
   * without one.
   */
  append: (event: RunEvent) => Promise<void>;
  /** The symptom the base phase's output must match. Defaults to the issue's own words. */
  symptomPattern?: string;
  /** Override for tests: the git remote to clone and push. Defaults to GitHub. */
  remote?: (token: string) => string;
  loop?: RunPlan['loop'];
  /**
   * The id this run is already known by, when something else minted it.
   *
   * Set by the runner daemon: the plane hands out the id with the job, and every event
   * this run emits has to carry it or the plane will refuse them all — it authorizes an
   * append by asking which runner that run was dispatched to.
   */
  runId?: string;
  /**
   * The model that triage asks (8e), when the default is not wanted. Its credential
   * is the run's; only the model differs, because reading an issue and answering in
   * one sentence is not the job the run's model was chosen for.
   */
  triageModel?: string;
  flakeRuns?: number;
  /**
   * Names this repository has a stored secret for (M10).
   *
   * Only the NAMES: a value never reaches this function, and the check below only asks
   * whether a required name is supplied at all. Values are resolved later, at the moment
   * of injection, into a sandbox that has no route out (ADR-0017).
   */
  secretNames?: readonly string[];
};

export type RunResult = {
  runId: string;
  state: RunState;
  prUrl?: string;
  /** What each agent phase spent, so a run's cost is readable without parsing blobs. */
  usage?: { phase: string; usage: LoopUsage }[];
  /**
   * What each container said on stderr, and how it exited.
   *
   * `PhaseResult.stderr` already existed and its own note says why discarding it is
   * wrong — "an operational failure with no diagnosis is the wrong thing to ship" — and
   * then it was discarded here anyway. The first real webhook-driven run ended
   * `spawn_failed` with `messages: 0`, and nothing anywhere could say why: no `ENV_READY`,
   * no environment abort, just a container that never reached ready. This is that gap.
   *
   * Not an event: a container's stderr is our infrastructure talking about itself.
   */
  diagnostics?: { phase: string; exitCode: number; stderr: string }[];
};

/**
 * Run one issue to a verdict, and answer on the issue either way.
 *
 * Returns rather than throws for every outcome the design has a name for. It throws
 * only when it could not even start — no token, no clone — because at that point
 * there is no run to report on and nothing to comment about.
 */
export async function runFromIssue(request: RunRequest): Promise<RunResult> {
  const { intake, app } = request;
  // The caller's id when it has one, and that is the hosted path (9d): the control
  // plane mints the run id at dispatch, before any runner sees the work, because
  // "appending to this run" is only an authorizable claim if somebody other than the
  // writer decided the run exists (ADR-0019). Locally there is no such somebody and
  // this stays what it always was.
  const runId = request.runId ?? crypto.randomUUID();
  const events: RunEvent[] = [];
  const emit = async (event: RunEvent) => {
    events.push(event);
    await request.append(event);
  };

  // Minted before anything else, because a clone we cannot do makes the rest moot.
  const token = await installationToken(app, intake.installationId);
  // The URL carries NO credential — the token goes in an `http.extraHeader` that git
  // does not persist. See `repoUrl`.
  const remote = request.remote ? request.remote(token) : repoUrl(intake.repo);

  const workspace = await mkdtemp(join(tmpdir(), 'engine-run-'));
  try {
    const source = join(workspace, 'source');
    await cloneRepository(remote, source, token);
    // The default branch's tip, resolved to a sha. A branch name can move between now
    // and the phases, and a run that reported on "main" rather than on a commit would
    // be a run whose evidence nobody can re-check.
    const { stdout } = await execFileAsync('git', ['-C', source, 'rev-parse', 'HEAD']);
    const baseRef = stdout.trim();

    await emit({
      run_id: runId,
      seq: 1,
      ts: new Date().toISOString(),
      type: 'RUN_REQUESTED',
      payload: intake.event,
    });

    // A FUNCTION of what the engine observed in the judging container, because the
    // paragraph about that container is the one an agent acts on and it was written
    // before anyone had looked. `orchestrate` runs the probe after the plan is built,
    // so the string cannot exist yet — only a way to make it can.
    const environmentWith = (sealed?: SealedWorld) =>
      describeEnvironment({
        ...(request.recipe ? { services: request.recipe.services } : {}),
        ...(request.recipe?.env ? { env: request.recipe.env } : {}),
        ...(request.recipe?.test ? { testCommand: request.recipe.test } : {}),
        ...(sealed ? { sealed } : {}),
        browser: request.agentImage !== undefined,
        // A recipe is what gives the agent sandbox a network and what the phases'
        // snapshot is taken of, so it is the condition the asymmetry paragraph turns on.
        booted: request.recipe !== null,
      });
    const issue = intake.event.raw_text;

    /**
     * Say what happened on the issue, whatever happened.
     *
     * Best effort and never at the cost of the run: a comment that cannot be posted must
     * not discard a pull request that exists, and there is no event class for "we could
     * not reach GitHub" — inventing one to describe our own outage would put a fact about
     * us in a log about the user's bug.
     */
    const sayWhatHappened = async (final: RunState) => {
      try {
        const fresh = await installationToken(app, intake.installationId);
        await commentOnIssue(
          app,
          fresh,
          intake.repo,
          intake.issueNumber,
          issueComment(final, {
            issue,
            threadRef: intake.event.thread_ref,
            ...(await lastWord(request.blobRoot, final)),
          }),
        );
      } catch {
        // Deliberately unrecorded; see above.
      }
    };

    // BLOCKED, before a sandbox exists (M10). A recipe can name variables this repository
    // cannot run without. Starting anyway boots a half-configured project, fails to
    // reproduce, and reports that failure as a finding about somebody's bug — the one
    // presentation ADR-0007's amendment forbids. Ending here is not the gate bending: no
    // reproduction was shown, so no fix is attempted and no pull request is opened. What
    // is different from a Tier 3 is that nothing was TESTED, and the comment says so and
    // asks only for the names.
    //
    // Before triage, too: a cheap model's question about a report is worth asking while
    // the reporter is still at their keyboard, and worth not asking at all about a run
    // that is not going to happen.
    const missing = request.recipe ? missingRequired(request.recipe, request.secretNames ?? []) : [];
    if (missing.length > 0) {
      let seq = 1;
      const at = () => ({ run_id: runId, seq: ++seq, ts: new Date().toISOString() });
      // Every event belongs to an attempt — including the one that says an attempt never
      // began, which the fold would otherwise refuse to place.
      await emit({ ...at(), type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } });
      await emit({
        ...at(),
        type: 'VERIFICATION_ABORTED',
        payload: {
          v: 1,
          phase: 'setup',
          cause: 'missing_env',
          reason: `required and unset: ${missing.join(', ')}`,
          missing,
        },
      });
      await emit({ ...at(), type: 'RUN_ENDED', payload: { v: 1, reason: 'blocked' } });
      const blocked = fold(events);
      await sayWhatHappened(blocked);
      return { runId, state: blocked };
    }

    // TRIAGE, before a container starts (8e). The reporter is at the keyboard now and
    // nowhere near it in twenty minutes, so this is the only moment a question is
    // cheap.
    //
    // It never gates. Whatever comes back, the run proceeds — the question and the
    // run are not alternatives, and a cheap model's opinion of somebody's bug report
    // is the last thing that should be able to stop one (7c's precedent).
    //
    // Awaited rather than fired, because it is one bounded call before the first
    // container and ordering it ahead of the sandbox is the entire point. `askOnce`
    // carries its own 30s ceiling for exactly this reason: an unbounded wait in front
    // of a run is what 8a removed from the layer below.
    //
    // Wrapped, because everything in it is optional to the run and none of it is
    // allowed to cost one — a model that is down, a repository that will not list, a
    // GitHub that will not take the comment.
    try {
      const { stdout: listing } = await execFileAsync('git', [
        '-C', source, 'ls-tree', '-r', '--name-only', baseRef,
      ]);
      const question = await triage({
        issue,
        tree: listing.split('\n').filter((path) => path !== ''),
        // The run's credential, and deliberately NOT the run's model: this reads an
        // issue and answers in one sentence, and `askOnce` defaults to the cheap one.
        ...(request.loop?.provider === undefined ? {} : { provider: request.loop.provider }),
        ...(request.loop?.apiKey === undefined ? {} : { apiKey: request.loop.apiKey }),
        ...(request.loop?.authToken === undefined ? {} : { authToken: request.loop.authToken }),
        ...(request.loop?.baseURL === undefined ? {} : { baseURL: request.loop.baseURL }),
        ...(request.triageModel === undefined ? {} : { model: request.triageModel }),
      });
      if (question !== null) {
        await commentOnIssue(app, token, intake.repo, intake.issueNumber, triageComment(question));
      }
    } catch {
      // Recorded nowhere, for the reason the final comment's failure is: there is no
      // event class for "we could not ask", and inventing one to describe our own
      // outage would put a fact about us in a log about the user's bug.
    }

    // The fix prompt cannot be rendered yet: it names the registered command, and
    // nothing has registered one. `orchestrate` defers the fix agent until after the
    // base container has, which is the same ordering ADR-0008 asks for — so the
    // placeholder is filled from the fold at that point rather than guessed now.
    //
    // Passed as a FUNCTION for that reason. A string here would be a fix prompt that
    // quotes a command nobody has written.
    // Computed ONCE, because the agent is told this string and the engine checks for it.
    // Deriving it twice is how the prompt and the check drift apart, and the first real
    // model run is what proved that gap exists: the agent was asked to "mention the
    // symptom the report describes", paraphrased it as it reasonably would, and the
    // literal check refused a reproduction that was genuinely correct. The engine was
    // right and the prompt was unsatisfiable except by luck.
    const symptomPattern = request.symptomPattern ?? symptomFrom(issue);

    const outcome = await orchestrate({
      runId,
      // `afterSeq` is not a field: `orchestrate` owns its own numbering from 1, and
      // RUN_REQUESTED above is seq 1 — so the plan continues from there.
      repoPath: source,
      blobRoot: request.blobRoot,
      image: request.image,
      baseRef,
      reproPrompt: (sealed) =>
        renderPrompt('repro', { issue, environment: environmentWith(sealed), symptom: symptomPattern }),
      // A function, so it is rendered AFTER the reproduction is registered and can name
      // the command that will actually judge the fix. It used to be rendered here with
      // prose in place of both variables, which made the prompt contradict itself — it
      // promises "you have exactly the command above" and then quoted a sentence telling
      // the agent where to look instead. The first real model run is what exposed it.
      agentPrompt: (context) =>
        renderPrompt('fix', {
          issue,
          environment: environmentWith(context.sealed),
          command: context.repro.command,
          // What the base container watched the reproduction print. Every placeholder
          // must be filled — `renderPrompt` refuses a template with one left — so the
          // absence has to read as a fact rather than as an empty fence.
          observed:
            context.baseOutput?.trim() ||
            '(the engine has not run it yet on this path, so there is no captured output)',
          suite: describeSuite(request.recipe?.test, context.suite),
          // The reproduction's own paths, which rule 3 tells the agent not to touch. An
          // empty manifest is possible and must read as a fact, not as a blank section.
          files:
            Object.keys(context.repro.files ?? {})
              .map((path) => `- \`${path}\``)
              .join('\n') || '(the manifest listed none)',
        }),
      symptomPattern,
      // So the commit under judgement outlives `orchestrate`'s own workspace and this
      // clone can push it. Without it `state.handedOver` names an object only a
      // deleted directory ever had.
      exportTo: source,
      ...(request.recipe ? { recipe: request.recipe } : {}),
      ...(request.agentImage ? { agentImage: request.agentImage } : {}),
      ...(request.loop ? { loop: request.loop } : {}),
      ...(request.flakeRuns === undefined ? {} : { flakeRuns: request.flakeRuns }),
    });

    // `orchestrate` starts its own numbering at 1, and RUN_REQUESTED already took it.
    // Renumbered rather than re-plumbed: the plan type has no `afterSeq`, and a gap or
    // a collision is something `fold()` refuses outright.
    let seq = 1;
    for (const event of outcome.events) {
      if (event.type === 'RUN_REQUESTED') continue;
      await emit({ ...event, seq: ++seq });
    }

    let state = fold(events);
    let prUrl: string | undefined;

    // THE GATE, read off the fold and not re-derived (ADR-0009). A PR is opened only
    // for a run the fold credits — red on base for the reported reason, green on the
    // fix every time, the series vouched for.
    if (state.reproduced && state.handedOver) {
      // Minted AGAIN. A run can outlive an hour, and ADR-0012 is explicit that this is
      // why the mint is a function rather than a value captured at the start. The
      // token from the clone may be dead by now.
      const fresh = await installationToken(app, intake.installationId);
      const pushRemote = request.remote ? request.remote(fresh) : repoUrl(intake.repo);
      const branch = `engine/run-${runId.slice(0, 8)}`;
      // Pushed from the orchestrator's own clone of the source, which is where the
      // agent's commit was fetched to. The sandbox never had a remote at all.
      await pushBranch(source, pushRemote, branch, state.handedOver, fresh);

      const context = { issue, threadRef: intake.event.thread_ref };
      const pr = await openPullRequest(app, fresh, intake.repo, {
        title: pullRequestTitle(state, context),
        body: pullRequestBody(state, context),
        head: branch,
        base: defaultBranchOf(source),
      });
      prUrl = pr.html_url;

      await emit({
        run_id: runId,
        seq: ++seq,
        ts: new Date().toISOString(),
        type: 'PR_OPENED',
        payload: {
          v: 1,
          repo: intake.repo,
          pr_number: pr.number,
          head_sha: pr.head_sha,
          diff_hash: state.fixDiff?.diff_hash ?? (await put(request.blobRoot, '')),
        },
      });
      await emit({
        run_id: runId,
        seq: ++seq,
        ts: new Date().toISOString(),
        type: 'RUN_ENDED',
        payload: { v: 1, reason: 'pr_opened' },
      });
      state = fold(events);
    }

    // An issue comment on EVERY terminal outcome, including Tier 3 and errored. A run
    // that ends silently is worse than no run: the person who opened the issue is
    // left waiting on something that already finished.
    //
    // Best effort, and last. A failed comment must not discard a pull request that
    // exists — the PR is the deliverable.
    await sayWhatHappened(state);

    // What the agent phases spent. Carried out rather than logged, for the reason above:
    // our bill is not a fact about the user's bug.
    const usage = outcome.phases
      .filter((phase) => phase.usage !== undefined)
      .map((phase) => ({ phase: phase.phase, usage: phase.usage! }));

    // Every phase, not only the ones that exited non-zero. A container that exits 0
    // having done nothing is the failure that has no other symptom.
    const diagnostics = outcome.phases.map((phase) => ({
      phase: phase.phase,
      exitCode: phase.exitCode,
      stderr: phase.stderr,
    }));

    return {
      runId,
      state,
      ...(prUrl === undefined ? {} : { prUrl }),
      ...(usage.length === 0 ? {} : { usage }),
      ...(diagnostics.length === 0 ? {} : { diagnostics }),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The suite baseline, in the fix prompt's own words.
 *
 * Three genuinely different situations, and the agent has to be able to tell them
 * apart: there is no suite, there is one and it was green on base, or there is one
 * that was ALREADY red. Only the middle case makes "do not break it" a meaningful
 * instruction — telling an agent not to break something already broken is how a
 * pre-existing failure becomes the agent's problem, and then ours.
 */
function describeSuite(command: string | undefined, observed?: { command: string; exitCode: number }): string {
  if (!command) return 'This repository has no test command in its recipe, so no suite is run against your commit.';
  if (!observed) {
    return (
      `The project's own suite is \`${command}\`. It is run on your commit and the result is ` +
      `published, but nothing has run it on the base commit, so there is no baseline to compare against.`
    );
  }
  return observed.exitCode === 0
    ? `The project's own suite — \`${command}\` — **passed** on the base commit. It is run again on ` +
        `yours and the two are compared, so a fix that turns it red is reported as a regression.`
    : `The project's own suite — \`${command}\` — was **already failing** on the base commit ` +
        `(exit ${observed.exitCode}), before anything you do. You are not being asked to repair that, ` +
        `and it will not be attributed to your fix. Do not let it distract you from the reproduction.`;
}

/**
 * The symptom pattern, from the issue's own words.
 *
 * Crude on purpose: the longest quoted string, or the longest word over five
 * characters. The base phase's output has to MATCH the reported symptom, and a
 * pattern derived from the report is the only thing available before an agent has
 * read anything. A caller who knows better passes `symptomPattern`.
 *
 * Escaped, because an issue is attacker-influenced text and an unescaped `(` from a
 * bug report would be a regex someone else wrote.
 */
/** Longest line a symptom may be. Beyond this it is cut at a word boundary. */
const MAX_SYMPTOM_CHARS = 100;
/** Below this a line says too little to anchor anything — "Bug", "Broken", "help". */
const MIN_SYMPTOM_CHARS = 12;

export function symptomFrom(issue: string): string {
  // A human quoting the symptom is the strongest signal there is, and it stays first.
  const quoted = [...issue.matchAll(/"([^"]{2,60})"|`([^`]{2,60})`/g)]
    .map((match) => match[1] ?? match[2] ?? '')
    .sort((a, b) => b.length - a.length)[0];

  // Then the first line that says something — which for a GitHub issue is its TITLE,
  // because `intake` builds this text as `title\n\nbody`.
  //
  // This used to be "the longest word over five characters", and the first real
  // webhook-driven run showed what that costs. For
  //
  //   The shipped filter returns everything
  //   /api/orders?status=shipped returns every order, including pending ones.
  //
  // it derived `"everything"`. The agent then wrote a genuinely good reproduction —
  // `Expected 2 shipped orders, got 4` — and the engine refused it, because the output
  // had to contain the literal string `everything` and no sane assertion message does.
  // The run ended `not_reproduced` on a correct reproduction of a real bug.
  //
  // A single common word is also a WEAK anchor, which is the deeper problem: ADR-0008
  // wants the output to prove this bug failed rather than some other thing, and
  // `everything` would match almost any prose. A title is specific, meaningful, and
  // short enough for an agent to print verbatim.
  const line = issue
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length >= MIN_SYMPTOM_CHARS);
  const capped =
    line && line.length > MAX_SYMPTOM_CHARS
      ? line.slice(0, line.lastIndexOf(' ', MAX_SYMPTOM_CHARS) + 1 || MAX_SYMPTOM_CHARS).trim()
      : line;

  // And only then the old rule, for a report that is one long word or nothing at all.
  const word = issue
    .split(/[^\w.-]+/)
    .filter((token) => token.length > 5)
    .sort((a, b) => b.length - a.length)[0];

  const chosen = quoted || capped || word || '';
  // Escaped, because an issue is attacker-influenced text and `new RegExp` on an
  // unescaped `(` from a bug report throws inside the container.
  return chosen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The branch a pull request opens against.
 *
 * `symbolic-ref` on the clone's own HEAD, which is what the remote said its default
 * branch was — rather than assuming `main`. A repository whose default is `master`,
 * or `trunk`, would otherwise get a PR against a branch that does not exist.
 */
function defaultBranchOf(source: string): string {
  try {
    return execFileSync('git', ['-C', source, 'rev-parse', '--abbrev-ref', 'origin/HEAD'], {
      encoding: 'utf8',
    })
      .trim()
      .replace(/^origin\//, '');
  } catch {
    // A clone with no `origin/HEAD` — which a bare local remote in a test may not
    // have. `main` is the guess, and it is a guess rather than a claim.
    return 'main';
  }
}
