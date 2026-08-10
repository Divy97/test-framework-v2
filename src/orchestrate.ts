// The host side of M4: one container per participant, sequenced here.
//
// This does not contradict M3.1's "no docker client in the sandbox" — the
// sandbox still has none. Orchestration moves UP, to the host, which already
// has a daemon. What moves with it is the thing that mattered: base and fix stop
// sharing a machine.
//
// Six review rounds established the shape of the problem. Every fix that scrubbed
// a shared channel was correct and was followed by another way in, because
// per-participant directories and a best-effort process sweep are approximations
// of isolation. A container is not an approximation: there is no tree to inherit,
// no TMPDIR to seed, no HOME to plant in, no process to outlive a boundary, and
// no window on the evidence store between phases.
//
// Only two things cross between containers, both explicitly: the commits (via
// the read-only source mount) and the seq counter.
//
// The evidence store is the exception that had to be built, not assumed. Mounted
// straight through, it defeated the whole point: the base container flushes
// before it exits, the fix container mounts the same directory, `guardEvidence`
// treats those blobs as pre-existing and never evicts them, and a bind mount
// does not honour container permissions — so a repro could read them and be red
// once, green after. That is strictly WORSE than the whole-run path, where blobs
// sit in root-owned staging until the last repro has finished. So each container
// gets its own empty store and the host collects from it afterwards. Blobs are
// content-addressed, so collecting is a copy that cannot collide meaningfully.

import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, lstat, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent } from './events.js';
import { fold } from './fold.js';
import type { Job } from './runner.js';
import type { ReproSpec } from './verify.js';
import { startEgressProxy } from './egress.js';
import { MAX_REASON_CHARS } from './verify.js';

/** Output ceiling per container. Matches what the sandbox tests already allow. */
const execFile = promisify(execFileCb);

const MAX_STREAM_BYTES = 32 * 1024 * 1024;
/** Tail of a container's diagnostics. The reason is at the end, not the start. */
const MAX_STDERR_CHARS = 8 * 1024;

export type RunPlan = Omit<Job, 'sourcePath' | 'afterSeq' | 'only' | 'fixRef' | 'repro'> & {
  /**
   * The reproduction, when the caller supplies it. Omitted when `reproPrompt` is
   * set: the agent authors it, and a spec chosen in advance would be anchoring a
   * test nobody had written yet.
   *
   * Exactly one of the two — see `RunPlan` below. Making both optional turned a
   * compile error into a run that reached a container and aborted there, which is
   * a worse way to learn the plan was incomplete.
   */
  repro?: Job['repro'];
  /**
   * Ask an agent to WRITE the reproduction first, in a container of its own.
   *
   * Its tree does not survive (ADR-0010), so the repro arrives as a commit and
   * the engine reads the bytes out of it — see `readReproFromCommit`. This is
   * also what makes ADR-0008's ordering invariant real rather than intended: the
   * repro is registered by the base container, and the FIX agent does not start
   * until after that, so `REPRO_REGISTERED` provably precedes the fix agent's
   * first message by seq. Nobody has to trust that it did.
   */
  reproPrompt?: string;
  /**
   * The commit the fix is judged at. Omitted when an agent is writing it: the
   * orchestrator then uses whatever the agent committed, which is the only
   * honest answer — a fix ref chosen in advance would be judging a commit
   * nobody had made yet.
   */
  fixRef?: string;
  /** Host path to the repository. Mounted read-only into every container. */
  repoPath: string;
  /** Host directory holding the evidence. Must pre-exist with its sentinel. */
  blobRoot: string;
  image: string;
  /**
   * Host path to a `claude` executable, mounted over the image's. For tests: the
   * image ships no agent yet, and a hostile fake is how the supervision boundary
   * is exercised without one.
   */
  /**
   * The one host the agent may reach. Omitted, it reaches nothing at all.
   *
   * Sealed by default on purpose: an engine that silently grants the open
   * internet when a field is missing has made the safe case the one you have to
   * remember. A caller who needs the model API names it.
   */
  egress?: readonly string[];
  /** How many attempts before the run gives up. One, unless a caller asks for more. */
  maxAttempts?: number;
  agentImageMount?: string;
} & (
  | { repro: Job['repro']; reproPrompt?: never }
  | { reproPrompt: string; repro?: never }
);

/** What one container reported, and how it exited. */
export type PhaseResult = {
  phase: 'agent' | 'base' | 'fix';
  events: RunEvent[];
  exitCode: number;
  /** Host directory the agent container left its commits in, when it had one. */
  handover?: string;
  /**
   * What the container said on stderr, bounded.
   *
   * `EXIT.silent` is documented as "ignore the channel and read stderr", and
   * discarding it made that exit code unreadable: a store missing its sentinel
   * looked exactly like a missing image, an OOM kill, or a spawn failure. For a
   * project whose subject is evidence, an operational failure with no diagnosis
   * is the wrong thing to ship.
   */
  stderr: string;
};

export type RunOutcome = {
  events: RunEvent[];
  phases: PhaseResult[];
  /** True when every container completed its phases; see EXIT in runner.ts. */
  complete: boolean;
  /**
   * The agent handed over nothing usable and no phase ran. Separate from
   * `complete` because a run the GATE stopped is a deliverable (ADR-0007) and a
   * run the agent forfeited is a finding about the agent — collapsing them lost
   * the distinction the log exists to keep.
   */
  refused: boolean;
};

/**
 * The orchestrator's own events. It is a trusted writer — ADR-0006's constraint
 * is that the AGENT cannot write facts, and ADR-0009 makes the orchestrator the
 * one producer allowed to state why a run stopped.
 */
const own = (runId: string, seq: number, event: Omit<RunEvent, 'run_id' | 'seq' | 'ts'>): RunEvent =>
  ({ ...event, run_id: runId, seq, ts: new Date().toISOString() }) as RunEvent;

/**
 * Run one attempt as a sequence of containers.
 *
 * Stops at the first container that could not observe its phase. A fix phase run
 * after a base phase that failed to complete would be comparing against nothing,
 * and the partial stream already says where it stopped.
 */
export async function orchestrate(plan: RunPlan): Promise<RunOutcome> {
  // The sentinel check moved layers with the store and had to move with it.
  // Each container now gets a store this function creates, so the Runner's own
  // check passes by construction and says nothing about durability — the
  // question "will the evidence outlive this run" is now the HOST's, and this is
  // where it has to be asked. Without it a typo'd path yields a complete,
  // plausible event stream whose artifacts were collected into nowhere.
  await stat(join(plan.blobRoot, '.evidence-store')).catch(() => {
    throw new Error(
      `${plan.blobRoot} is not an evidence store (create it and leave a .evidence-store file); ` +
        'the artifacts these containers produce would be collected into nothing',
    );
  });

  const phases: PhaseResult[] = [];
  const events: RunEvent[] = [];
  // The agent's commits have to reach the phases, and the user's repository is
  // never written to — so the orchestrator works from a clone it owns. This is
  // the only place a commit crosses between containers, and it crosses as a
  // bundle: objects and refs, no working tree, nothing else.
  const workspace = await mkdtemp(join(tmpdir(), 'engine-workspace-'));
  // `finally`, because the throws between here and the end of the run are what
  // leak. This file already carried the invariant as a COMMENT — "every throw
  // between the clone and the cleanup at the end leaves a full clone of the
  // repository in tmpdir() forever" — and then grew six more throw sites inside
  // that window, plus a fail-closed check whose whole job is to fire repeatedly
  // while somebody diagnoses why. A comment is not a `finally`.
  // One proxy per run, in this process. Its allowlist and the record of what the
  // agent tried live where the run's other evidence does.
  const proxy = plan.egress?.length ? await startEgressProxy(plan.egress) : null;
  try {
    return await run();
  } finally {
    await proxy?.close();
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }

  async function run(): Promise<RunOutcome> {
  // Where the agent's one channel lives, if it has one. `host.docker.internal`
  // is not used: `--add-host <name>:host-gateway` makes the ALLOWLISTED name
  // resolve to the host, so the agent's client asks for the host it means and
  // the proxy checks the name it was given.
  const channel = proxy ? { host: 'egress.invalid', port: proxy.port } : undefined;
  const source = join(workspace, 'source');
  // `--mirror`, not a plain clone. A plain clone puts the source's other
  // branches under `refs/remotes/origin/*`, and the container's own clone
  // transfers only `refs/heads/*` — so interposing a workspace silently dropped
  // every non-default branch, and any baseRef or fixRef off `main` stopped
  // resolving. A mirror keeps them all as local refs.
  await execFile('git', ['clone', '--quiet', '--no-local', '--mirror', '--', plan.repoPath, source]);

  // Everything the repository already had — both the commits and the CONTENT
  // those commits pointed at.
  //
  // The commit set alone was the previous round's check, and it was the same
  // mistake in new clothes: it tested whether the agent had created a new sha,
  // not whether it had written anything. `git commit --allow-empty` on top of a
  // fix the repository already carried produces a fresh sha over a byte-identical
  // tree, and the run then credited the agent with work it inherited — the
  // pre-existing fix became an ancestor, so even the diff named the right files.
  // `--amend`, `cherry-pick` and `merge` all did the same.
  //
  // Two checks survive, and only two: the commit must be one the repository did
  // not already have, and its tree must differ from base's.
  //
  // A third — refusing any tree that existed off base's ancestry — was how this
  // tried to catch INHERITED work, and it is now a pure false positive. The agent
  // clones a source holding base's ancestry and nothing else, so it cannot copy
  // content it cannot reach; a tree of its own that happens to match one on some
  // other branch is therefore independent authorship of the same fix, which is
  // the ordinary outcome when a repository already carries the fix on a branch —
  // exactly the shape this project benchmarks. Review measured it refusing a
  // genuine fix and writing an accusation of inheritance into an immutable log.
  //
  // Removing the capability made the recognition rule wrong, not redundant. It
  // never covered the case its own comment claimed either: `--not <baseRef>`
  // excludes base's ancestry by construction.
  //
  // `--no-replace-objects` because `--mirror` copies `refs/replace/*` and the
  // phase containers' plain clone does not: without it these sets are computed
  // over a different history than base and fix actually see.
  const git = ['-C', source, '--no-replace-objects'];
  const { stdout: existing } = await execFile('git', [...git, 'rev-list', '--all']);
  const before = new Set(existing.split('\n').filter(Boolean));
  const { stdout: baseShaOut } = await execFile('git', [...git, 'rev-parse', `${plan.baseRef}^{commit}`]);
  const base = baseShaOut.trim();
  const { stdout: baseTreeOut } = await execFile('git', [...git, 'rev-parse', `${plan.baseRef}^{tree}`]);
  const baseTree = baseTreeOut.trim();
  // The base commit must be IN the history this check was computed over.
  //
  // The first fail-closed guard here was `existing.trim() && before.size === 0`,
  // a tautology: `filter(Boolean)` leaves the set empty only when every line was
  // empty, which makes `trim()` falsy too. It could never fire. A safety net that
  // cannot fail is worse than none, because it is read as one.
  //
  // What it was meant to catch: the set was once parsed with `/^[0-9a-f]{40}$/`,
  // the only hard-coded object-ID length in the engine, so on a SHA-256
  // repository not one token matched, `before` came out EMPTY, and every handover
  // passed with no error and no abort. This guard is the record of that, and it
  // is kept written down because deleting it is not free — the very commit that
  // removed this paragraph broke SHA-256 repositories again, one construction
  // over, within a day.
  if (!before.has(base)) {
    throw new Error(
      'the base commit is not in the history this check reads; refusing to run an unenforceable check',
    );
  }

  // The agent's source: base's ancestry, and NOTHING else.
  //
  // The authorship check can only ever see content, so it catches byte-identical
  // inheritance and stops there — check out a fix the repository already carries,
  // add one unrelated file, commit, and the result is genuinely new content built
  // on work the agent did not do. No content-based check can separate that from a
  // real fix, because the fix IS in the tree and the agent DID author the commit
  // on top of it.
  //
  // So remove the thing being inherited rather than trying to recognise it. The
  // agent clones this, and a fix commit that is not in its object store cannot be
  // checked out, cherry-picked, merged or reset to. The hole is closed by
  // construction rather than by recognition — which is why the recognition rule
  // that used to stand beside it is gone rather than kept as a second line.
  //
  const agentSource = join(workspace, 'agent-source');
  await buildAgentSource(source, base, agentSource);

  // Starts at zero because this function owns the whole run: it emits the first
  // event. A caller-supplied starting seq was a public field that could not work
  // — the gate folds this run's events, and `fold()` throws on a stream that does
  // not begin at 1, so any non-zero value threw mid-run and discarded the base
  // container's observations.
  let afterSeq = 0;

  // The agent, if there is one, in a container that is torn down before the
  // first phase is ever cloned. This is what ADR-0010's "the agent's world is
  // discarded" becomes when the world is a container: it is not scrubbed, it
  // ceases to exist.
  // An attempt has to be declared before anything can be credited to it: the
  // fold refuses to pair runs at attempt 0, because runs from unrelated attempts
  // could otherwise be matched up. Nothing emitted this before, which is why the
  // tests had to prepend it by hand.
  // BOUNDED ATTEMPTS. Retrying is only meaningful now that a later attempt can
  // propose a different REPRODUCTION — before 3b.2b every attempt would have run
  // the same caller-supplied spec against the same commits and got the same
  // answer, so the loop would have been a way to spend money.
  //
  // Per-attempt state is declared inside the loop on purpose. Carrying `fixRef`
  // or `resolvedRepro` across an attempt boundary would judge attempt 2 against
  // attempt 1's commit or anchor it to attempt 1's reproduction, which is the
  // cross-attempt confusion the fold spent two PRs learning to refuse.
  let ended: RunEvent | null = null;
  let refused = false;
  // Validated, because every unusual value fails in a way that reads as success.
  // `0` returned `complete: true` on an EMPTY log that `fold()` then refuses —
  // no attempt declared, no container run, and an outcome claiming it went fine.
  // `2.5` never satisfies `n === maxAttempts` while still satisfying
  // `n < maxAttempts`, so the ending is allocated, discarded and rolled back on
  // the last iteration and the run stays permanently unended. `Infinity` loops.
  const maxAttempts = plan.maxAttempts ?? 1;
  // An upper bound too: `Number.isInteger(1e21)` is true, so the value the
  // comment above calls out as looping forever was reachable through a different
  // number. Ten is far past any useful retry and well short of hanging.
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error(`maxAttempts must be a whole number from 1 to 10, not ${String(plan.maxAttempts)}`);
  }
  for (let n = 1; n <= maxAttempts; n += 1) {
    ended = null;
    refused = false;
    let fixRef = plan.fixRef;
    let resolvedRepro = plan.repro;
    // An attempt has to be declared before anything can be credited to it: the
    // fold refuses to pair runs at attempt 0, because runs from unrelated
    // attempts could otherwise be matched up.
    events.push(own(plan.runId, ++afterSeq, { type: 'ATTEMPT_STARTED', payload: { v: 1, n } }));

    // The agent, if there is one, in a container torn down before the first phase
    // is ever cloned. This is what ADR-0010's "the agent's world is discarded"
    // becomes when the world is a container: it is not scrubbed, it ceases to
    // exist. Note it runs BEFORE the base container, so the gate cannot prevent
    // spawning it — the gate decides whether a FIX is attempted.
    const steps: { phase: PhaseResult['phase']; job: Partial<Job>; source: string; kind?: 'repro' | 'fix' }[] = [];
    // `only: 'agent'` matters: without it the agent container ran the agent AND
    // both phases, so the fix phase started on the very machine the agent had been
    // working in. It stayed invisible because the duplicate registrations made the
    // fold stricter rather than wrong.
    // The repro agent, when there is one, runs before everything: base cannot be
    // judged against a reproduction that does not exist yet.
    if (plan.reproPrompt) {
      steps.push({
        phase: 'agent',
        job: { agentPrompt: plan.reproPrompt, only: 'agent', baseRef: base },
        source: agentSource,
        kind: 'repro',
      });
    }
    // The FIX agent. With a repro agent present it is DEFERRED to after the base
    // container has registered the reproduction, so ADR-0008's ordering invariant
    // becomes a fact about the log rather than an intention: `REPRO_REGISTERED`
    // provably precedes this agent's first message by seq, so it cannot have
    // written the fix against a reproduction it had already watched fail. It also
    // means the gate now stops the agent being spawned at all on a bug that was
    // never shown — which the earlier ordering explicitly could not do.
    //
    // Without a repro agent it stays ahead of base, where every M3.1 and 3b.1 test
    // exercises it. The caller supplied the repro there, so there is no ordering
    // between authoring and registration to prove.
    if (plan.agentPrompt && !plan.reproPrompt) {
      // `baseRef` resolved: the stripped source has one branch and none of the
      // names the plan may have used.
      steps.push({
        phase: 'agent',
        // `baseRef` resolved, and DEAD today: the Runner returns on `only: 'agent'`
        // before `verify()` ever reads it. Kept because a future agent path should
        // get the sha rather than a name the stripped source no longer carries.
        // `fixRef` on this same job is dead for the identical reason and is NOT
        // resolved — said here rather than left as a silent asymmetry two lines
        // apart.
        job: { agentPrompt: plan.agentPrompt, only: 'agent', baseRef: base },
        source: agentSource,
        kind: 'fix',
      });
    }
    steps.push({ phase: 'base', job: { only: 'base' }, source });


    /**
     * How a container's exit ends the run.
     *
     * `EXIT.partial` (2) means observation stopped and the stream IS on the
     * channel — a finding about this run. Collapsing it into `error` handed the
     * agent the status ADR-0009 exists to deny it: a reproduction of `sleep 600`,
     * or one naming a path the fix commit tracks, aborts a phase container and the
     * run then reported `errored` rather than `unresolved`. A status the agent can
     * choose is not a status, and `errored` is the single thing the fold takes on
     * trust. Only 1 (an engine bug) and 3 (nothing on the channel at all) are ours.
     */
    const endedBy = (exitCode: number): RunEvent =>
      own(plan.runId, ++afterSeq, {
        type: 'RUN_ENDED',
        payload: { v: 1, reason: exitCode === 2 ? 'attempts_exhausted' : 'error' },
      });

    /**
     * Take the commit an agent handed over, or refuse the run and say why.
     *
     * One rule for both agents. The repro agent's commit is under exactly the same
     * suspicion as the fix agent's: an agent that hands back a commit the
     * repository already had has authored no reproduction either.
     */
    const accept = async (result: PhaseResult, kind: 'repro' | 'fix'): Promise<string | null> => {
      const handover = await applyHandover(source, plan.runId, result.handover);
      const stale =
        handover.commit === null
          ? handover.why
          : before.has(handover.commit)
            ? `the agent handed over ${handover.commit}, a commit the repository already had`
            : handover.tree === baseTree
              ? `the agent handed over ${handover.commit}, which changes nothing against the base`
              : null;
      if (handover.commit === null || stale) {
        events.push(
          own(plan.runId, ++afterSeq, {
            type: 'VERIFICATION_ABORTED',
            payload: {
              v: 1,
              phase: 'setup',
              cause: 'handover',
              reason: (stale || 'the agent handed nothing over').slice(0, MAX_REASON_CHARS),
            },
          }),
        );
        ended = own(plan.runId, ++afterSeq, {
          type: 'RUN_ENDED',
          payload: { v: 1, reason: 'attempts_exhausted' },
        });
        refused = true;
        return null;
      }
      events.push(
        own(plan.runId, ++afterSeq, {
          type: 'AGENT_HANDED_OVER',
          payload: { v: 1, commit: handover.commit, kind },
        }),
      );
      return handover.commit;
    };

    /** Read the reproduction out of the commit the repro agent authored. */
    const registerRepro = async (head: string): Promise<boolean> => {
      try {
        resolvedRepro = await readReproFromCommit(source, head);
        return true;
      } catch (error) {
        events.push(
          own(plan.runId, ++afterSeq, {
            type: 'VERIFICATION_ABORTED',
            payload: {
              v: 1,
              phase: 'setup',
              cause: 'handover',
              reason: String((error as Error).message).slice(0, MAX_REASON_CHARS),
            },
          }),
        );
        ended = own(plan.runId, ++afterSeq, {
          type: 'RUN_ENDED',
          payload: { v: 1, reason: 'attempts_exhausted' },
        });
        refused = true;
        return false;
      }
    };
    for (const step of steps) {
      const result = await runContainer(plan, step.source, afterSeq, step.phase, {
        ...step.job,
        ...(resolvedRepro ? { repro: resolvedRepro } : {}),
        // The sham-fix control, on exactly when the AGENT wrote the reproduction.
        // A caller-supplied repro has no oracle to be: whoever wrote it did not
        // see the tree it would judge.
        ...(plan.reproPrompt ? { controlRun: true } : {}),
      });
      // Record what the container reported BEFORE judging any of it. Checking
      // first and breaking discarded the transcript and the container's own
      // stream — the same mistake the abort path made: a run that could not be
      // trusted is still a run that observed things.
      phases.push(result);
      events.push(...result.events);
      afterSeq = result.events.at(-1)?.seq ?? afterSeq;

      if (result.exitCode !== 0) {
        ended = endedBy(result.exitCode);
        break;
      }

      if (step.phase === 'agent') {
        const head = await accept(result, step.kind === 'repro' ? 'repro' : 'fix');
        if (head === null) break;
        // The repro agent's commit is the TEST, not the repair — so it is read, not
        // set as `fixRef`.
        if (step.kind === 'repro') {
          if (!(await registerRepro(head))) break;
        } else {
          fixRef = head;
        }
      }
    }

    // THE GATE (ADR-0007). No reproduction, no fix — and the decision is read off
    // the fold rather than worked out here, because a second definition of "did it
    // reproduce" living in a producer is exactly what ADR-0009 forbids. A Tier 3
    // outcome is a real deliverable, not a failure.
    if (!ended) {
      // THIS attempt's reproduction, not the run's. Reading the run-level flag let
    // attempt 2 spend a fix agent and a fix container on a bug it had just failed
    // to show, off attempt 1's evidence — ADR-0007 says the gate never bends. The
    // decision is still read off the fold rather than worked out here (ADR-0009);
    // what changed is which question the fold is asked.
    if (fold(events).shownAttempts.includes(n)) {
        // The fix agent, deferred to here so the log can PROVE it never saw the
        // reproduction before that reproduction was registered.
        if (plan.reproPrompt && plan.agentPrompt) {
          const author = await runContainer(plan, agentSource, afterSeq, 'agent', {
            agentPrompt: plan.agentPrompt,
            only: 'agent',
            baseRef: base,
            ...(resolvedRepro ? { repro: resolvedRepro } : {}),
          });
          phases.push(author);
          events.push(...author.events);
          afterSeq = author.events.at(-1)?.seq ?? afterSeq;
          if (author.exitCode !== 0) {
            ended = endedBy(author.exitCode);
          } else {
            const head = await accept(author, 'fix');
            if (head !== null) fixRef = head;
          }
        }
        // Nested inside `shownOnBase`, NOT a second top-level branch. Flattening it
        // put the `not_reproduced` else on the wrong condition, so a fix agent that
        // was refused had its `attempts_exhausted` overwritten with
        // `not_reproduced` — a run claiming the bug never reproduced when the base
        // container had just shown that it did.
        if (ended) {
          // A refused or failed fix agent has already said why.
        } else {
        // `resolvedRepro`, not `plan.repro`. The fix container was the one call
        // site that did not carry it, so with an agent-authored reproduction it
        // ran anchored to nothing and aborted AFTER a perfectly good base phase —
        // the ordering was right and the spec never reached the container judging
        // the fix.
        const fix = await runContainer(plan, source, afterSeq, 'fix', {
          only: 'fix',
          fixRef,
          ...(resolvedRepro ? { repro: resolvedRepro } : {}),
        });
        phases.push(fix);
        events.push(...fix.events);
        afterSeq = fix.events.at(-1)?.seq ?? afterSeq;
        // Only a failed fix container ends the run here. A SUCCESSFUL one is not
        // an ending: nothing is exhausted (there is one attempt and no cap), and
        // the fold maps every non-`error` reason without a PR to `unresolved` —
        // ADR-0007's not-reproduced deliverable. Emitting one rendered every
        // credited red-then-green run as UNRESOLVED, indistinguishable on a
        // dashboard from "we could not reproduce it".
        //
        // So the run stays `attempting` until the PR step exists to end it. An
        // unended run is incomplete; a run ended with the wrong reason is a lie in
        // an immutable log.
        if (fix.exitCode !== 0) {
          ended = endedBy(fix.exitCode);
        }
        }
      } else {
        // The bug was never shown, so no fix was attempted and none should be. The
        // reason records the CAUSE of stopping, never the verdict — the fold keeps
        // deriving that from the runs (ADR-0009).
        ended = own(plan.runId, ++afterSeq, {
          type: 'RUN_ENDED',
          payload: { v: 1, reason: 'not_reproduced' },
        });
      }
    }

    // Read off the fold, never re-derived here: a second definition of "did it
    // reproduce" living in a producer is what ADR-0009 forbids, and this
    // projection has been bitten by that already.
    if (fold(events).reproduced) break;
    // Out of attempts. `attempts_exhausted` is the honest cause — the run stopped
    // because it ran out of tries, not because anything errored — unless an
    // attempt already recorded a harder reason for stopping.
    if (n === maxAttempts && !ended) {
      ended = own(plan.runId, ++afterSeq, {
        type: 'RUN_ENDED',
        payload: { v: 1, reason: 'attempts_exhausted' },
      });
    }
    // A run that ERRORED stops; one that merely failed to reproduce or was
    // refused tries again, which is the whole point of bounding attempts rather
    // than allowing one.
    if (ended?.type === 'RUN_ENDED' && ended.payload.reason === 'error') break;
    if (n < maxAttempts) {
      // Discarding the event means giving back its seq. `++afterSeq` allocated
      // one for a RUN_ENDED that is now not being emitted, and the next attempt
      // then started one past the last event in the log — a gap, which `fold()`
      // refuses outright. `events` is what was actually emitted, so the counter
      // follows it rather than the other way round.
      ended = null;
      afterSeq = events.at(-1)?.seq ?? afterSeq;
    }
  }
  if (ended) events.push(ended);

  // The workspace is a full clone and each handover holds whatever the agent
  // chose to leave in `/out`. Left behind, that is unbounded host-disk growth
  // per run — and the handover dirs are agent-writable, which is not something
  // to accumulate.
  //
  // Never at the cost of the evidence, though: `force` suppresses ENOENT and
  // nothing else, and `/out` is chowned to the repro user on a bind mount — so on
  // Linux an orchestrator running as neither root nor uid 1000 cannot unlink the
  // bundle, and a throw here would discard every event from every container for
  // the sake of disk hygiene.
  for (const phase of phases) {
    if (phase.handover) await rm(phase.handover, { recursive: true, force: true }).catch(() => {});
  }

  // `refused`, not `ended`. A refusal breaks out with the agent container at exit
  // 0 and no phase run at all, and `every` over that one entry is vacuously true
  // — so `complete` reported success for a run that never reached a phase. But
  // gating on `ended` overshot: `not_reproduced` sets it too, and ADR-0007 calls
  // that a DELIVERABLE, not a failure. A clean Tier 3 run would have reported
  // itself incomplete, collapsing "the gate honestly held" with "a container
  // died".
  return { events, phases, refused, complete: !refused && phases.every((p) => p.exitCode === 0) };
  }
}

/**
 * Fetch the agent's bundle into the workspace and report the commit it left.
 *
 * Onto a BRANCH of its own. `refs/agent/*` was the instinct — keep the agent
 * away from anything existing — but `git clone` fetches only `refs/heads/*` and
 * tags, so the phase containers cloned a workspace whose agent ref they could
 * not see, checked out the repository's own commit instead, and verified that.
 * A run reporting on a commit other than the one under judgement is the failure
 * this project exists to prevent, and it was silent.
 *
 * A distinct branch name still keeps it off `main`: the point was never the ref
 * namespace, it was not overwriting a ref the repository already had. It is
 * per-run because a two-level name IS a namespace and namespaces collide: any
 * repository with a branch called `engine` D/F-conflicts with `engine/agent-work`
 * and every agent run against it failed with no diagnosis at all.
 *
 * Returns why it failed rather than just that it did. Three unrelated causes —
 * corrupt bundle, failed fetch, nothing handed over — used to arrive as one
 * indistinguishable null, which is the "drops git's own words" mistake this file
 * complains about elsewhere.
 */
type Handover = { commit: string; tree: string } | { commit: null; why: string };

async function applyHandover(source: string, runId: string, dir: string | undefined): Promise<Handover> {
  if (!dir) return { commit: null, why: 'the agent container handed nothing over' };
  const bundle = join(dir, 'agent.bundle');
  // lstat: the agent owns `/out` and can leave a symlink where the bundle should
  // be. Following one would fetch from wherever it points.
  const kind = await lstat(bundle).catch(() => null);
  if (!kind?.isFile()) return { commit: null, why: 'no bundle was left at the handover path' };

  const ref = `refs/heads/engine-agent-work-${runId.replace(/[^A-Za-z0-9_-]/g, '')}`;
  try {
    await execFile('git', ['-C', source, 'fetch', '--quiet', bundle, `+HEAD:${ref}`]);
    const { stdout } = await execFile('git', ['-C', source, 'rev-parse', ref]);
    const { stdout: tree } = await execFile('git', ['-C', source, 'rev-parse', `${ref}^{tree}`]);
    return { commit: stdout.trim(), tree: tree.trim() };
  } catch (error) {
    // A corrupt or hostile bundle is a handover that did not happen, not a
    // reason to lose the run. Letting this throw discarded the attempt, the
    // transcript and the agent container's whole stream.
    const detail = (error as { stderr?: string }).stderr ?? '';
    return { commit: null, why: detail.trim().split('\n')[0] || String(error) };
  }
}

async function runContainer(
  plan: RunPlan,
  source: string,
  afterSeq: number,
  phase: PhaseResult['phase'],
  overrides: Partial<Job>,
  egress?: { host: string; port: number },
): Promise<PhaseResult> {
  // The agent container gets no repro to run; the phase containers get no agent.
  // Passing both would put an agent beside the phase it is meant to be isolated
  // from, which is the entire point of doing this.
  const job: Job = {
    runId: plan.runId,
    afterSeq,
    sourcePath: '/src',
    baseRef: plan.baseRef,
    // Resolved rather than planned: with an agent, this is the commit it made.
    fixRef: overrides.fixRef ?? plan.fixRef ?? plan.baseRef,
    // Resolved by the caller: with a repro agent it is the spec read out of that
    // agent's commit, and there is nothing to run before it exists. The empty
    // fallback reaches ONLY the agent container, which returns before `verify()`
    // (runner.ts, `only: 'agent'`) and so never runs a reproduction — the plan
    // type now makes `repro` or `reproPrompt` mandatory, so a phase container
    // cannot arrive here without one.
    repro: overrides.repro ?? plan.repro ?? { command: '' },
    symptomPattern: plan.symptomPattern,
    ...(plan.flakeRuns === undefined ? {} : { flakeRuns: plan.flakeRuns }),
    ...(plan.timeoutMs === undefined ? {} : { timeoutMs: plan.timeoutMs }),
    ...(plan.agentTimeoutMs === undefined ? {} : { agentTimeoutMs: plan.agentTimeoutMs }),
    ...overrides,
  };

  // A store of this container's own, empty, with the sentinel the Runner insists
  // on. Nothing another participant wrote is visible from inside it.
  const store = await mkdtemp(join(tmpdir(), 'engine-phase-store-'));
  await writeFile(join(store, '.evidence-store'), '');
  // Only the agent gets somewhere to put commits. A phase container with an
  // output mount could write one, and a phase is supposed to observe, not author.
  const handover = phase === 'agent' ? await mkdtemp(join(tmpdir(), 'engine-handover-')) : undefined;

  const args = [
    'run', '--rm', '-i',
    // NO NETWORK for the phases. The agent needs the model API; the containers
    // that judge a commit need nothing at all, and a reproduction that can reach
    // the network is a reproduction that can be TOLD what to answer — the same
    // identity-oracle channel ADR-0008's amendment is about, over a wire instead
    // of over the tree. It also means the code under judgement cannot exfiltrate
    // the repository it was handed.
    //
    // Dependency install is the thing this forecloses, and M3 already refuses it:
    // a reproduction needing a package the base commit lacks is unrunnable today.
    // When a `setupCommand` arrives it will need its own network decision rather
    // than inheriting this one.
    // The phases get nothing. The agent gets one channel, or nothing — never the
    // open internet by default. `--add-host` points the allowlisted name at the
    // host loopback the proxy is bound to, and `HTTPS_PROXY` sends the client
    // through it; with no `egress` configured the agent is as sealed as a phase.
    //
    // `host-gateway` rather than a container-to-container network: the proxy runs
    // in THIS process, where its allowlist and its record live, so there is no
    // second image to keep honest and no sidecar that could be replaced.
    ...(phase !== 'agent' || egress === undefined
      ? ['--network', 'none']
      : [
          '--add-host',
          `${egress.host}:host-gateway`,
          '-e',
          `HTTPS_PROXY=http://${egress.host}:${egress.port}`,
          // `HTTP_PROXY` too, so a plain-HTTP client is pointed at the proxy
          // rather than at the open network — where it is answered 405, because
          // this proxy speaks CONNECT and an absolute-URI GET is the other
          // protocol. That is a refusal either way, but it is worth being plain:
          // the allowlist is enforced for https, and plain http to the ALLOWED
          // host does not work at all. The model API is https.
          '-e',
          `HTTP_PROXY=http://${egress.host}:${egress.port}`,
        ]),
    '-v', `${source}:/src:ro`,
    '-v', `${store}:/blobs`,
    ...(handover ? ['-v', `${handover}:/out`] : []),
    ...(plan.agentImageMount ? ['-v', `${plan.agentImageMount}:/usr/local/bin/claude:ro`] : []),
    plan.image,
  ];

  // `spawn`, not `execFile`. execFile has no `input` option — that belongs to
  // execFileSync — so the Job never reached the container's stdin, `readStdin()`
  // waited for an EOF that never came, and the container hung until the test
  // timed out. A cast had made the type checker stop saying so.
  //
  // A non-zero exit is an outcome here, not a crash: the Runner's exit codes say
  // whether there is a stream worth reading, and a partial stream is evidence.
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(JSON.stringify(job));

  let stdout = '';
  let truncated = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (stdout.length + chunk.length > MAX_STREAM_BYTES) {
      truncated = true;
      return;
    }
    stdout += chunk;
  });
  // Kept, not just drained. Draining is still required — a container that says
  // a lot on stderr blocks writing to it and never reaches its own exit, the
  // same deadlock the agent supervisor has — but the last few KB are what makes
  // a non-zero exit diagnosable.
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });

  // Collect the artifacts into the real store, from the host, once the container
  // is gone. Whatever a participant planted in its own store comes along, but it
  // was only ever visible to itself — and the sentinel is skipped so a store that
  // never held one does not acquire it here.
  //
  // Never by throwing, though. Both of these run MID-RUN, so a rejection here
  // propagated out of `orchestrate()` and destroyed every phase captured so far —
  // the same evidence-loss shape fixed twice already elsewhere in this file, left
  // standing at the two sites that were not the one being looked at. A collection
  // failure is reported instead: the events are the record, and a stream whose
  // blobs went missing is still worth vastly more than no stream.
  let collection = '';
  try {
    for (const entry of await readdir(store)) {
      if (entry === '.evidence-store') continue;
      await cp(join(store, entry), join(plan.blobRoot, entry), { recursive: true, force: true });
    }
  } catch (error) {
    collection = `could not collect this container's artifacts: ${String(error)}`;
  }
  await rm(store, { recursive: true, force: true }).catch(() => {});

  if (truncated) {
    // Refusing beats guessing: a stream cut mid-line is not a stream, and the
    // fold would reject it anyway on the seq that never arrived.
    throw new Error(`the ${phase} container produced more than ${MAX_STREAM_BYTES} bytes of events`);
  }
  const events = parse(stdout);
  // As an EVENT, not on `PhaseResult.stderr`. This PR condemned that field by
  // name three files over — the orchestrator keeps it and never persists it, so
  // nothing folds it and no projection reads it. A half-copied store otherwise
  // folds to `reproduced: true`, scores 85, and cites `stdout_hash` refs that
  // were never written to the real store, with nothing anywhere saying the
  // evidence is missing. `cleanup`, because every phase had already been
  // observed when this failed: it is a tidy-up failure, not a failure to look.
  if (collection) {
    events.push(
      own(plan.runId, (events.at(-1)?.seq ?? afterSeq) + 1, {
        type: 'VERIFICATION_ABORTED',
        payload: {
          v: 1,
          phase: 'cleanup',
          // Not `verify()`'s. Without saying so, the fold reads this as proof the
          // fix series completed — see the witness rule in fold.ts.
          cause: 'collection',
          reason: collection.slice(0, MAX_REASON_CHARS),
        },
      }),
    );
  }
  return { phase, events, exitCode, stderr: stderr.trim(), ...(handover ? { handover } : {}) };
}

const parse = (stdout: string): RunEvent[] =>
  stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);

/**
 * The agent's source: base's ancestry, and nothing else.
 *
 * Exported because both regressions this has had were invisible to the container
 * suite and provable in milliseconds here — a SHA-256 repository, and a global
 * `push.followTags`. Verifying a repository build by running a container is
 * verifying it in the one place it is slowest and least legible.
 */
export async function buildAgentSource(source: string, base: string, agentSource: string): Promise<void> {
  // The source's own hash algorithm, not this git's default. `init` always makes
  // a SHA-1 repository, and pushing a SHA-256 repository into one fails outright
  // — a repo class that worked before this construction replaced the previous
  // one. The comment deleted from the check above was the record of the LAST
  // time SHA-256 silently broke this, which is precisely why it should not have
  // been deleted.
  const { stdout: format } = await execFile('git', ['-C', source, 'rev-parse', '--show-object-format']);
  await execFile('git', ['init', '--quiet', '--bare', `--object-format=${format.trim()}`, agentSource]);
  // PUSH by sha, rather than clone-then-strip-then-prune. The objects off base's
  // ancestry are never written at all, so no gc, cruft pack, prune grace, reflog
  // or git-version question can resurrect them — the earlier construction leaned
  // on `reflog expire` whose failure was swallowed, and with
  // `core.logAllRefUpdates` inherited from a global config the fix survived the
  // prune with `git fsck --unreachable` reporting nothing at all.
  //
  // It does not apply replace refs either — `push` by sha sends the real object,
  // so the enclosing `--no-replace-objects` that the other traversals carry is not
  // needed here. Said rather than left for the next reader to re-derive.
  //
  // It also does not care WHICH ref holds base. `clone --bare` fetches only
  // `refs/heads/*` and tags, so a base reachable solely from `refs/remotes/*` —
  // any repository that is itself a clone — left the object out and the strip
  // died on a bare exception where the run used to produce an evented abort.
  //
  // The flags are not decoration. `push` reads the user's ambient config and the
  // `clone` it replaced did not, so three ordinary global settings each reach a
  // construction that is supposed to depend on nothing: `push.followTags` brings
  // annotated tag objects the postcondition below then reports as a violation,
  // `push.gpgSign` fails the push outright, and a global `core.hooksPath` with a
  // `pre-push` hook refuses it. A repository build must not vary with whoever's
  // machine the host happens to be.
  await execFile('git', [
    '-C', source, 'push', '--quiet', '--no-follow-tags', '--no-verify', '--no-signed',
    agentSource, `${base}:refs/heads/main`,
  ]);
  await execFile('git', ['-C', agentSource, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

  // The postcondition the comment above used to merely promise.
  //
  // "Verified by the object store, not by the ref listing" has to be something
  // the code does, not something the prose asserts — a ref listing is exactly
  // what every earlier round of this check kept believing. Cheap: one batch read
  // over a repository that holds base's ancestry and nothing else.
  const objects = await execFile('git', [
    '-C', agentSource, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)',
  ]);
  const reachable = await execFile('git', ['-C', agentSource, 'rev-list', '--objects', 'refs/heads/main']);
  const want = new Set(reachable.stdout.split('\n').filter(Boolean).map((line) => line.split(' ')[0]!));
  const extra = objects.stdout.split('\n').filter(Boolean).filter((o) => !want.has(o));
  if (extra.length > 0) {
    throw new Error(
      `the agent's source holds ${extra.length} objects off the base's ancestry; refusing to run`,
    );
  }
  // And the ref set, which the object check does not cover: `push.followTags` is
  // exactly a ref-set surprise, and it is how the object check first fired.
  const { stdout: built } = await execFile('git', ['-C', agentSource, 'for-each-ref', '--format=%(refname)']);
  const refs = built.split('\n').filter(Boolean);
  if (refs.length !== 1 || refs[0] !== 'refs/heads/main') {
    throw new Error(`the agent's source carries refs beyond base: ${refs.join(', ')}; refusing to run`);
  }
}

/** Where the agent leaves its reproduction. Fixed: a configurable path is a path the agent chooses. */
export const REPRO_MANIFEST = '.engine/repro.json';
/** Enough for a reproduction; far short of shipping a payload through the manifest. */
const MAX_REPRO_FILES = 32;
const MAX_REPRO_BYTES = 256 * 1024;

/**
 * The reproduction the agent authored, read out of its commit.
 *
 * The agent's tree does not survive its container (ADR-0010), so the repro has to
 * arrive as a commit exactly as the fix does. What arrives is a manifest NAMING
 * paths and a command — never hashes, never bytes-as-testimony. The engine reads
 * the bytes itself out of the commit and hands them to `verify()` as `applied`
 * files, which it writes over both checkouts.
 *
 * That is ADR-0008's anchoring reached from a commit instead of from a Job: the
 * same bytes run in both phases because the engine put them there, not because
 * the agent promised it would. A manifest hash would be testimony wearing an
 * evidence event's shape (ADR-0006), so this format has nowhere to put one.
 */
export async function readReproFromCommit(source: string, commit: string): Promise<ReproSpec> {
  const show = async (path: string): Promise<string> => {
    // `git show <rev>:<path>` accepts no `--`, so the path is validated before it
    // can become an argument at all: a leading `-` is an option, and an absolute
    // or parent-relative path reads outside the tree under judgement. `verify()`
    // guards the WRITE side; this guards the read.
    if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(path) || path.split('/').includes('..')) {
      throw new Error(`the manifest names an unusable path: ${path.slice(0, 120)}`);
    }
    // A blob, and a regular one. `git show <rev>:<dir>` exits 0 with git's tree
    // listing as prose, and `<rev>:<symlink>` returns the link's TARGET STRING as
    // content — neither reads a host file, but both make the reproduction's bytes
    // something other than the file the manifest named, and the diagnosis then
    // surfaces two layers away as a mystery write.
    const { stdout: mode } = await execFile('git', [
      '-C', source, 'ls-tree', '--format=%(objectmode)', commit, '--', path,
    ]);
    if (!['100644', '100755'].includes(mode.trim())) {
      throw new Error(`the manifest names something that is not a regular file: ${path.slice(0, 120)}`);
    }
    const { stdout } = await execFile('git', ['-C', source, 'show', `${commit}:${path}`], {
      maxBuffer: MAX_REPRO_BYTES,
    });
    return stdout;
  };

  let raw: string;
  try {
    raw = await show(REPRO_MANIFEST);
  } catch {
    throw new Error(`the agent committed no reproduction at ${REPRO_MANIFEST}`);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error('the reproduction manifest is not JSON');
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('the reproduction manifest is not an object');
  }
  const { command, files } = manifest as { command?: unknown; files?: unknown };
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('the reproduction manifest names no command');
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('the reproduction manifest names no files');
  }
  if (files.length > MAX_REPRO_FILES) {
    throw new Error(
      `the reproduction names ${files.length} files, past the ${MAX_REPRO_FILES} ceiling`,
    );
  }

  const contents: Record<string, string> = {};
  let total = 0;
  for (const path of files) {
    if (typeof path !== 'string') {
      throw new Error('the reproduction manifest names a non-string path');
    }
    const body = await show(path);
    total += Buffer.byteLength(body);
    if (total > MAX_REPRO_BYTES) {
      throw new Error(`the reproduction came to more than ${MAX_REPRO_BYTES} bytes`);
    }
    contents[path] = body;
  }
  return { command, files: contents };
}
