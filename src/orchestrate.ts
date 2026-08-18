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
import { runAgentLoop, type AgentTranscript, type LoopUsage } from './loop.js';
import type { Recipe, ReplayOutcome } from './recipe.js';
import { isWorkerReply, type Job, type WorkerRequest } from './runner.js';
import { get, put } from './blobs.js';
import { redact } from './redact.js';
import type { ReproSpec } from './verify.js';
import { describeDraftingEnvironment, extractRecipeDraft, renderPrompt } from './prompts.js';
import { MAX_REASON_CHARS } from './verify.js';

/**
 * What the fix agent is told, beyond the issue and its own tree.
 *
 * An object rather than a positional `ReproSpec`, because everything worth adding
 * here is a fact the base container observed and the caller cannot know in advance
 * — and each one arrived by being threaded through a signature that had no room
 * for it. The command was the first. It will not be the last.
 */
export type FixContext = {
  repro: ReproSpec;
  /**
   * The tail of what the reproduction actually PRINTED on base, read out of the
   * evidence store.
   *
   * The agent had the command and not its output, so its first act was always to
   * re-run the command to see the failure it was being asked to remove — a turn
   * spent rediscovering something the engine had already observed and hashed. Worse
   * when the re-run disagrees: the sandbox and the phase container are different
   * worlds, so "run it yourself" is not guaranteed to show the same failure the
   * verdict will be taken from. This is that failure, verbatim.
   */
  baseOutput?: string;
  /**
   * How the project's own suite fared on base — the baseline a regression is
   * measured against. Absent when the recipe declares no test command.
   */
  suite?: { command: string; exitCode: number };
};

/** Tail of base's output handed to the fix agent. The failure is at the end. */
const MAX_OBSERVED_CHARS = 8 * 1024;

/** Output ceiling per container. Matches what the sandbox tests already allow. */
const execFile = promisify(execFileCb);

const MAX_STREAM_BYTES = 32 * 1024 * 1024;
/** Tail of a container's diagnostics. The reason is at the end, not the start. */
const MAX_STDERR_CHARS = 8 * 1024;

export type RunPlan = Omit<Job, 'sourcePath' | 'afterSeq' | 'only' | 'fixRef' | 'repro' | 'agentPrompt'> & {
  /**
   * The fix agent's prompt — as a FUNCTION of the reproduction that was registered,
   * because it has to quote a command that did not exist when the run started.
   *
   * A string was accepted before, and `run.ts` therefore passed prose in place of the
   * command: the prompt promised "you have exactly the command above, so there is no
   * guessing about what will be checked" and then handed over the sentence "the command
   * registered in .engine/repro.json of the commit you are on". The first real model run
   * is what showed the cost — the fix agent followed the indirection, read the manifest,
   * read the source, and finished in three turns without editing anything. A prompt that
   * contradicts itself is not "one indirection worse"; it is a fix phase that does not
   * work, and no scripted test could see it because a scripted agent never reads.
   *
   * A plain string is still accepted for the fix-only path, where the CALLER supplied the
   * reproduction and there is no ordering to prove.
   */
  agentPrompt?: string | ((context: FixContext) => string | Promise<string>);
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
  /** How many attempts before the run gives up. One, unless a caller asks for more. */
  maxAttempts?: number;
  agentImageMount?: string;
  /**
   * The image for the AGENT container only — the one with a browser in it (5f).
   *
   * Two images rather than one with a flag, because "a phase container must never gain
   * a browser" then stops being a policy anyone can forget and becomes a fact about
   * `plan.image`: the binary is not in it. ADR-0006's amendment requires the split, and
   * a flag would be the version of it that fails silently.
   */
  agentImage?: string;
  /**
   * Drive the agent from the HOST, with tool calls travelling into the container
   * (ADR-0011). Set, and no agent binary runs in the sandbox at all.
   *
   * Absent, the M3 path stands: `claude -p` inside the container, which is the
   * shape the hostile-fake suite exercises and which cannot reach a model because
   * the container is sealed. Both are honest; only one can do the job.
   *
   * `baseURL` is how this is tested without a credential — a local server that
   * speaks the Messages API scripts the tool calls.
   */
  loop?: {
    /** `anthropic` (default) or `openrouter` — which API drives the agent (ADR-0015). */
    provider?: string;
    apiKey?: string;
    /** A bearer credential, for an Anthropic-compatible gateway. */
    authToken?: string;
    baseURL?: string;
    /** Cheaper model, cheaper effort — the two levers that decide what a run costs. */
    model?: string;
    effort?: string;
    maxTokens?: number;
    timeoutMs?: number;
    maxLines?: number;
    maxIterations?: number;
  };
  /**
   * The environment recipe for this repository, replayed in the agent sandbox
   * before the agent gets the tools (ADR-0013).
   *
   * Its presence is also what gives the agent sandbox a network — see the docker
   * args in `runContainer`. Omitted, nothing boots and every container stays
   * sealed, which is what the adversarial fixtures want and what 5a asserts.
   */
  recipe?: Recipe;
  /**
   * A git repository to copy the accepted agent commits into before the workspace is
   * destroyed.
   *
   * Without this the commit under judgement exists ONLY in the mirror this function
   * clones and then deletes, so the host has nothing to push and `state.handedOver`
   * names an object nobody can resolve. That was not a hypothetical: 5e's end-to-end
   * test reproduced the whole run and then failed on `git push` with `bad object`.
   *
   * A separate field rather than fetching into `repoPath` unconditionally, because
   * this function's invariant is that it works from a clone it owns and writes to
   * nothing it was handed. The caller names where it wants the commits, and takes
   * responsibility for that being a repository it owns too.
   */
  exportTo?: string;
  /**
   * Give the agent sandbox a network with NO recipe to replay (M6b, ADR-0013's
   * drafting run).
   *
   * The rule this widens: "the agent sandbox gets a network when, and only when,
   * there is a recipe to replay" (see the docker args in `runContainer`) — written
   * when the only agent that could exist was one replaying a recipe a human had
   * already approved. A drafting agent is the one PROPOSING that recipe, and
   * `prompts/recipe.md` tells it to install what it proposes, boot what it
   * proposes, and prove both before it writes anything down — which needs a
   * registry and localhost for the identical reason replaying an approved recipe
   * does.
   *
   * This is not a new trust boundary, and it is worth being precise about why: it
   * is the SAME agent sandbox the repro/fix agent already gets with a network, on
   * the terms the README already states — "nothing worth stealing lives there and
   * nothing it produces is trusted" (ADR-0010's v1.5 amendment). What changes is
   * whose commands are running: a recipe a human read, or one this container is in
   * the middle of writing. Nothing it produces reaches a human unreviewed either
   * way — a draft is stored beside `recipes`, never inside it, and only a human
   * approving it at `/repos/<repo>/onboard` (ADR-0013's control) can promote it to
   * something a real run will ever replay.
   */
  draftingEnvironment?: boolean;
} & (
  | { repro: Job['repro']; reproPrompt?: never }
  | { reproPrompt: string; repro?: never }
);

/** What one container reported, and how it exited. */
export type PhaseResult = {
  phase: 'agent' | 'base' | 'fix';
  events: RunEvent[];
  exitCode: number;
  /**
   * What the agent loop spent, when this phase ran one.
   *
   * The loop totalled this and then it was dropped here, which made "what did that run
   * cost" unanswerable from outside `src/loop.ts` — the exact gap the totalling was
   * added to close, reintroduced one layer up. Deliberately NOT an event: inventing an
   * event class to describe our own spending would put a fact about us in a log about
   * the user's bug (ADR-0006), so it rides on the result instead.
   */
  usage?: LoopUsage;
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
  /**
   * What a tool-serving container reported about bundling its commits: null when
   * it worked, prose when it did not, absent when this was not that kind of
   * container.
   *
   * It arrives as a REPORT rather than an event because in that mode the host is
   * the only writer (ADR-0006's amendment), and the host turns it into the
   * VERIFICATION_ABORTED with a seq only the host can allocate.
   */
  handoverReport?: string | null;
  /**
   * What the container observed while replaying the recipe, when it replayed one.
   *
   * Present and `ready` → the host emits `ENV_READY`. Present and not `ready` → the
   * host emits a `setup` abort with `cause: 'environment'` and the run ends
   * `errored`, because our infrastructure being wrong about someone's project is
   * not a finding about their bug (ADR-0007's v1.5 amendment).
   */
  envReport?: ReplayOutcome;
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
  // The environment snapshot, when one was built. Declared out here because it is
  // an IMAGE — the largest thing a run leaves on the host — and it has to be
  // removable from the `finally` below rather than from the end of a happy path.
  let snapshotImage: string | null = null;
  // `finally`, because the throws between here and the end of the run are what
  // leak. This file already carried the invariant as a COMMENT — "every throw
  // between the clone and the cleanup at the end leaves a full clone of the
  // repository in tmpdir() forever" — and then grew six more throw sites inside
  // that window, plus a fail-closed check whose whole job is to fire repeatedly
  // while somebody diagnoses why. A comment is not a `finally`.
  try {
    return await run();
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    // A dependency tree on top of the sandbox image, per run. Left behind that is
    // unbounded host-disk growth exactly as the workspace is, and for the same
    // reason it belongs here rather than beside the handover dirs: the throws are
    // what leak. Never at the cost of the run, though — a removal that fails
    // (something still holding the image, a daemon that went away) must not
    // replace a completed run's events with an exception about disk hygiene. That
    // is the evidence-loss shape this file has been bitten by three times.
    if (snapshotImage) {
      await execFile('docker', ['image', 'rm', '--force', snapshotImage]).catch(() => {});
    }
  }

  async function run(): Promise<RunOutcome> {
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

  // THE ENVIRONMENT, BUILT BEFORE THE AGENT EXISTS.
  //
  // The phase containers install nothing — no recipe, no network, and a clone of a
  // commit whose dependencies are gitignored and therefore not in it — so on any
  // repository with dependencies the reproduction exits 127, the symptom never
  // matches, and the reporter is told we could not reproduce their bug. One
  // container installs, the host commits it, and the phases run from that image.
  //
  // The ORDERING is the security argument, and this `await` above the attempt loop
  // is what enforces it. runner.ts warns that a gitignored directory shared with
  // the phases is all an agent needs to fabricate a verdict — seed state a test
  // reads, and it goes red then green while the "fix" changes nothing, with every
  // anti-gaming check still passing because not one of them is about the
  // environment. The answer is not another scrub. It is that these bytes were
  // installed from the base commit's source before the agent container had been
  // created, so there was nobody to plant them.
  //
  // From `plan.image` and never `plan.agentImage`: a phase container must not gain
  // a browser (ADR-0006's amendment), and an image committed from the agent's
  // sandbox would hand it one. The cost is a second install — the agent replays the
  // recipe in its own container — and that is the accepted trade for the image that
  // judges being the sealed one.
  //
  // Only with an `install` step to replay. Without one there is nothing a phase
  // could be missing, and everything behaves exactly as it did.
  const snapshot =
    plan.recipe?.install === undefined
      ? null
      : await buildEnvSnapshot(plan, source, base, plan.recipe);
  if (snapshot && 'image' in snapshot) snapshotImage = snapshot.image;
  // The two containers that JUDGE run from the snapshot; everything else is
  // untouched by it. `plan.image` stays what the agent falls back to, so the agent
  // sandbox never runs from an image built out of a recipe replay it is about to
  // perform itself.
  const judging: RunPlan = snapshotImage === null ? plan : { ...plan, image: snapshotImage };

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

    // A snapshot that could not be built ENDS the run. It must never degrade
    // quietly to the old behaviour: a phase container with nothing installed is
    // precisely how "we could not reproduce your bug" gets sent about a repository
    // whose dependencies we failed to install, and it would read as a finding.
    // `cause: 'environment'`, the same as a recipe that does not boot — our
    // infrastructure being wrong about someone's project is not a tier about their
    // bug (ADR-0007's v1.5 amendment). After ATTEMPT_STARTED because every event
    // belongs to an attempt, and retrying is pointless: the next attempt would
    // install from the same source with the same recipe.
    if (snapshot && 'failed' in snapshot) {
      events.push(
        own(plan.runId, ++afterSeq, {
          type: 'VERIFICATION_ABORTED',
          payload: {
            v: 1,
            phase: 'setup',
            cause: 'environment',
            reason: redact(snapshot.failed).slice(0, MAX_REASON_CHARS),
          },
        }),
      );
      ended = own(plan.runId, ++afterSeq, { type: 'RUN_ENDED', payload: { v: 1, reason: 'error' } });
      break;
    }

    // The agent, if there is one, in a container torn down before the first phase
    // is ever cloned. This is what ADR-0010's "the agent's world is discarded"
    // becomes when the world is a container: it is not scrubbed, it ceases to
    // exist. Note it runs BEFORE the base container, so the gate cannot prevent
    // spawning it — the gate decides whether a FIX is attempted.
    /**
     * Run one agent container, whichever side the loop is on.
     *
     * With `plan.loop`, the container serves tool calls and writes NO events, and
     * the transcript becomes AGENT_MESSAGE payloads right here — which is
     * ADR-0006's amendment made literal: the sole writer is the host orchestrator,
     * and this is the host orchestrator.
     */
    const agentContainer = async (
      prompt: string,
      at: number,
      extra: Partial<Job> = {},
    ): Promise<PhaseResult> => {
      const shared: Partial<Job> = {
        only: 'agent',
        baseRef: base,
        ...(plan.recipe ? { recipe: plan.recipe } : {}),
        ...extra,
      };
      if (!plan.loop) {
        return await runContainer(plan, agentSource, at, 'agent', { agentPrompt: prompt, ...shared });
      }
      let transcript: AgentTranscript = {
        lines: [],
        stopped: 'spawn_failed',
        exitCode: -1,
        usage: { turns: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
      const result = await runContainer(
        plan,
        agentSource,
        at,
        'agent',
        { serveTools: true, ...shared },
        async ({ invoke }) => {
          transcript = await runAgentLoop({ prompt, invoke, ...plan.loop });
        },
      );
      let seq = at;
      const written: RunEvent[] = [];
      // The environment, first, because it precedes everything the agent said.
      //
      // `ENV_READY` is emitted for an OBSERVED healthcheck and never for the
      // recipe's claim that one would pass — that split is what ADR-0013 turns on,
      // and it is why the payload carries what the Runner saw rather than what the
      // recipe said.
      if (result.envReport?.ready) {
        written.push(
          own(plan.runId, ++seq, {
            type: 'ENV_READY',
            payload: {
              v: 1,
              services: result.envReport.services.map((service) => ({
                name: service.name,
                port: service.port,
                ...(service.healthcheck === undefined ? {} : { healthcheck: service.healthcheck }),
                detail: service.detail,
              })),
              steps: result.envReport.steps.map((step) => ({ step: step.step, exit_code: step.exit_code })),
            },
          }),
        );
      } else if (result.envReport) {
        // Not a tier, and not a reproduction that failed. `cause: 'environment'` is
        // what makes the fold disqualify this attempt, and the caller turns it into
        // `RUN_ENDED { error }` — a boot that never happened produces no tier at
        // all, because tiers describe reproductions and there was never an attempt.
        written.push(
          own(plan.runId, ++seq, {
            type: 'VERIFICATION_ABORTED',
            payload: {
              v: 1,
              phase: 'setup',
              cause: 'environment',
              reason: redact(result.envReport.failed ?? 'the environment did not come up').slice(0, MAX_REASON_CHARS),
            },
          }),
        );
      }
      for (const [n, line] of transcript.lines.entries()) {
        written.push(
          own(plan.runId, ++seq, {
            type: 'AGENT_MESSAGE',
            payload: {
              v: 1,
              n,
              claimed_type: line.claimed_type,
              // Re-serialised on its way into a payload, exactly as the in-sandbox
              // supervisor did: a tool result shaped like a RunEvent lands inside a
              // string field and stays there.
              raw_hash: await put(plan.blobRoot, line.raw),
              bytes: Buffer.byteLength(line.raw),
            },
          }),
        );
      }
      // Only when there WAS supervision. `AGENT_FINISHED` says how the loop ended,
      // and a world that never came up means the loop was never started — emitting
      // `spawn_failed` over an agent nobody asked to run would put a fact about the
      // agent in a log where the fault is entirely ours.
      if (!result.envReport || result.envReport.ready) {
        written.push(
          own(plan.runId, ++seq, {
            type: 'AGENT_FINISHED',
            payload: {
              v: 1,
              messages: transcript.lines.length,
              exit_code: transcript.exitCode,
              stopped: transcript.stopped,
            },
          }),
        );
      }
      // The container reported this rather than writing it, because it is not a
      // writer in this mode. `handoverReport === null` means the bundle was made.
      if (result.handoverReport) {
        written.push(
          own(plan.runId, ++seq, {
            type: 'VERIFICATION_ABORTED',
            payload: {
              v: 1,
              phase: 'setup',
              cause: 'handover',
              reason: redact(result.handoverReport).slice(0, MAX_REASON_CHARS),
            },
          }),
        );
      }
      return { ...result, usage: transcript.usage, events: [...result.events, ...written] };
    };

    const steps: {
      phase: PhaseResult['phase'];
      job: Partial<Job>;
      source: string;
      kind?: 'repro' | 'fix';
      prompt?: string;
    }[] = [];
    // `only: 'agent'` matters: without it the agent container ran the agent AND
    // both phases, so the fix phase started on the very machine the agent had been
    // working in. It stayed invisible because the duplicate registrations made the
    // fold stricter rather than wrong.
    // The repro agent, when there is one, runs before everything: base cannot be
    // judged against a reproduction that does not exist yet.
    if (plan.reproPrompt) {
      steps.push({ phase: 'agent', job: {}, source: agentSource, kind: 'repro', prompt: plan.reproPrompt });
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
      // `baseRef` is resolved by `agentContainer`, and DEAD today: the Runner
      // returns on `only: 'agent'` before `verify()` ever reads it. Passed anyway
      // because a future agent path should get the sha rather than a name the
      // stripped source no longer carries.
      steps.push({
        phase: 'agent',
        job: {},
        source: agentSource,
        kind: 'fix',
        // No observed output to hand over on this path: the caller supplied the
        // reproduction and this agent runs BEFORE the base container, so nothing has
        // watched it fail yet.
        prompt:
          typeof plan.agentPrompt === 'function'
            ? await plan.agentPrompt({ repro: plan.repro! })
            : plan.agentPrompt,
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
              reason: redact(stale || 'the agent handed nothing over').slice(0, MAX_REASON_CHARS),
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
              reason: redact(String((error as Error).message)).slice(0, MAX_REASON_CHARS),
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
      const overrides: Partial<Job> = {
        ...step.job,
        ...(resolvedRepro ? { repro: resolvedRepro } : {}),
        // The sham-fix control, on exactly when the AGENT wrote the reproduction.
        // A caller-supplied repro has no oracle to be: whoever wrote it did not
        // see the tree it would judge.
        ...(plan.reproPrompt ? { controlRun: true } : {}),
      };
      const result =
        step.phase === 'agent'
          ? await agentContainer(step.prompt!, afterSeq, overrides)
          : await runContainer(judging, step.source, afterSeq, step.phase, overrides);
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

      // The environment never came up. `error`, and NOT `not_reproduced` — the whole
      // point of ADR-0007's v1.5 amendment. Tier 3 means "we tried to reproduce the
      // bug and could not", which is a deliverable with value; "our recipe no longer
      // boots your app" is our infrastructure being wrong about the user's project,
      // and presenting it as a finding about their bug is the confidence score
      // becoming a disclaimer.
      if (result.envReport && !result.envReport.ready) {
        ended = own(plan.runId, ++afterSeq, { type: 'RUN_ENDED', payload: { v: 1, reason: 'error' } });
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
          // Rendered HERE, after registration, which is the whole reason it is a
          // function: `resolvedRepro` is the reproduction the base container read out of
          // the agent's commit, so the fix agent is told the command that will actually
          // judge it rather than where to go looking for it.
          //
          // And with the base container's own observations, which only exist by now:
          // what the reproduction printed, and how the project's suite fared. Read
          // out of the blob store rather than re-derived, so the agent is shown the
          // exact bytes the verdict was taken from.
          const fixPrompt =
            typeof plan.agentPrompt === 'function'
              ? await plan.agentPrompt({
                  repro: resolvedRepro!,
                  ...(await observedOnBase(plan.blobRoot, events, n)),
                })
              : plan.agentPrompt;
          const author = await agentContainer(fixPrompt, afterSeq, {
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
        const fix = await runContainer(judging, source, afterSeq, 'fix', {
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

  // The accepted commits, out of the workspace before it ceases to exist.
  //
  // `refs/heads/engine-agent-work-*` is where `applyHandover` puts each one. Fetched
  // under a namespace of its own so nothing the caller already had is overwritten —
  // the point is to make the objects resolvable, not to move anyone's branches.
  if (plan.exportTo) {
    await execFile('git', [
      '-C', plan.exportTo, 'fetch', '--quiet', '--no-tags', source,
      '+refs/heads/engine-agent-work-*:refs/engine/handover/*',
    ]).catch(() => {
      // Not fatal, and not silent either: the events are the record and a run whose
      // commits could not be exported still produced every fact it observed. The
      // caller discovers it when the push fails, with git's own words.
    });
  }

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
 * What one drafting session needs. Not a `RunPlan`: there is no reproduction, no
 * fix, no attempt loop, no gate — a draft is one agent turn, and the deliverable
 * is text in its transcript, not a judged commit.
 */
export type DraftPlan = {
  runId: string;
  /** Host path to the repository, mounted read-only. Never written to. */
  repoPath: string;
  image: string;
  /** The image with a browser in it, if the agent should have one while drafting. */
  agentImage?: string;
  loop: NonNullable<RunPlan['loop']>;
};

export type DraftOutcome =
  | { ok: true; draft: unknown; transcriptText: string; usage: LoopUsage }
  | { ok: false; reason: string; transcriptText: string; usage: LoopUsage };

/**
 * Run one drafting session and return what the agent wrote, unvalidated.
 *
 * "Unvalidated" is deliberate: this function's job is to run the agent and hand
 * back its words, not to decide whether they are a recipe a human should see.
 * `parseRecipe` — which this function does not call — is what checks shape, and
 * it runs at the point a human is about to be shown the result, which is also
 * where a malformed draft has to be explained rather than silently discarded.
 *
 * No `RunEvent` is emitted and nothing is appended to the log. A draft is
 * configuration on its way to existing, like `recipes` and `installations`
 * already are (M6a, ADR-0013) — current, mutable, and not a fact about a run,
 * because until a human approves it nothing has run against it at all.
 */
export async function draftRecipe(plan: DraftPlan): Promise<DraftOutcome> {
  const empty: LoopUsage = {
    turns: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

  // A throwaway store, created and destroyed here rather than borrowed from a real
  // run's durable one. Nothing about a draft is evidence — the deliverable is text
  // in the transcript, never a blob anyone will fetch by hash — so there is nothing
  // this store needs to outlive the call.
  const store = await mkdtemp(join(tmpdir(), 'engine-draft-blobs-'));
  await writeFile(join(store, '.evidence-store'), '');

  try {
    const { stdout } = await execFile('git', ['-C', plan.repoPath, 'rev-parse', 'HEAD']);
    const baseRef = stdout.trim();

    const draftPlan: RunPlan = {
      runId: plan.runId,
      repoPath: plan.repoPath,
      blobRoot: store,
      image: plan.image,
      agentImage: plan.agentImage,
      baseRef,
      // Dead on the `only: 'agent'` path — `verify()` never runs — and required by
      // `Job`'s shape regardless. `buildEnvSnapshot` sets the same placeholder for
      // the same reason.
      symptomPattern: 'x',
      repro: { command: '' },
      loop: plan.loop,
      draftingEnvironment: true,
    };

    let transcript: AgentTranscript = {
      lines: [],
      stopped: 'spawn_failed',
      exitCode: -1,
      usage: empty,
    };

    // No ancestry stripping, unlike the repro/fix agent's `agentSource`. That
    // machinery exists to stop an agent claiming authorship of content it cannot
    // prove it wrote, because that commit is what gets JUDGED (ADR-0008). A
    // drafting agent authors no judged commit — its only deliverable is the text
    // above, and its whole world, committed or not, is discarded the moment this
    // container exits (ADR-0010). There is nothing here for stripped ancestry to
    // protect, so `plan.repoPath` is mounted as it is.
    const result = await runContainer(
      draftPlan,
      plan.repoPath,
      0,
      'agent',
      {
        only: 'agent',
        baseRef,
        serveTools: true,
      },
      async ({ invoke }) => {
        const prompt = await renderPrompt('recipe', {
          environment: describeDraftingEnvironment({ browser: plan.agentImage !== undefined }),
        });
        transcript = await runAgentLoop({ prompt, invoke, ...plan.loop });
      },
    );

    // This function's own version of the cleanup `orchestrate()` does for every
    // phase it runs — `runContainer` always opens a handover directory for an
    // `agent` phase, and nothing past this point will ever read it, so nothing
    // past this point will clean it up if this does not.
    if (result.handover) await rm(result.handover, { recursive: true, force: true }).catch(() => {});

    // Two different texts, on purpose. `assistantText` is what the agent SAID, and it
    // is the only thing `extractRecipeDraft` may ever read — a tool result can contain
    // a fenced block that is not the agent's proposal at all (a file it `read`, a
    // README quoting an example), and the LAST-fenced-block rule that protects against
    // the agent's own rejected drafts offers no protection against someone else's json
    // block arriving from a tool. `debugText` is everything, in order, and it exists
    // because a caller trying to understand why a session failed needs to see what the
    // agent RAN, not only what it wrote at the end.
    const assistantText = transcript.lines
      .filter((line) => line.claimed_type === 'assistant')
      .map((line) => {
        try {
          return String((JSON.parse(line.raw) as { text?: unknown }).text ?? '');
        } catch {
          return '';
        }
      })
      .join('\n\n');

    const debugText = transcript.lines
      .map((line) => {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(line.raw) as Record<string, unknown>;
        } catch {
          return `[${line.claimed_type}] ${line.raw}`;
        }
        if (line.claimed_type === 'assistant') return String(payload.text ?? '');
        if (line.claimed_type === 'tool_use') return `[tool_use] ${String(payload.name)}(${JSON.stringify(payload.input)})`;
        if (line.claimed_type === 'tool_result') return `[tool_result] ${String(payload.name)} -> ${String(payload.output)}`;
        if (line.claimed_type === 'thinking') return `[thinking] ${String(payload.thinking)}`;
        if (line.claimed_type === 'loop_error') return `[loop_error] ${String(payload.message)}`;
        return '';
      })
      .filter((line) => line !== '')
      .join('\n');

    if (transcript.stopped === 'spawn_failed' || transcript.lines.length === 0) {
      return { ok: false, reason: 'the drafting agent never ran', transcriptText: debugText, usage: transcript.usage };
    }

    try {
      return { ok: true, draft: extractRecipeDraft(assistantText), transcriptText: debugText, usage: transcript.usage };
    } catch (error) {
      return {
        ok: false,
        reason: String((error as Error).message ?? error),
        transcriptText: debugText,
        usage: transcript.usage,
      };
    }
  } finally {
    await rm(store, { recursive: true, force: true }).catch(() => {});
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

/**
 * What the base container observed, for the fix agent's prompt.
 *
 * Read off the fold rather than by scanning for event types, so "which attempt" has
 * one definition (ADR-0009) — and read out of the blob store rather than kept in
 * memory, because the bytes the verdict was taken from are the ones the agent should
 * see, and those are the ones with a hash.
 *
 * Never throws. A prompt is better with this and must not depend on it: a missing
 * blob is a degraded prompt, not a lost run.
 */
async function observedOnBase(
  blobRoot: string,
  events: RunEvent[],
  attempt: number,
): Promise<Pick<FixContext, 'baseOutput' | 'suite'>> {
  try {
    const state = fold(events);
    // The FIRST base run of the attempt — `repeat: 0`, the one the flake repeats
    // repeat. They are all red or the gate would not be open, so any would do; the
    // first is the one a reader would go looking for.
    const base = state.testRuns.find((run) => run.phase === 'base' && run.attempt === attempt);
    const suite = state.suiteRuns.find((run) => run.phase === 'base' && run.attempt === attempt);
    const output = base ? (await get(blobRoot, base.stdout_hash)).toString('utf8') : undefined;
    return {
      ...(output === undefined
        ? {}
        : { baseOutput: output.length > MAX_OBSERVED_CHARS ? output.slice(-MAX_OBSERVED_CHARS) : output }),
      ...(suite === undefined ? {} : { suite: { command: suite.command, exitCode: suite.exit_code } }),
    };
  } catch {
    return {};
  }
}

/**
 * Build the image the phases judge from: the sealed phase image, plus this
 * repository's dependencies, installed once.
 *
 * Not `--rm`, which is the whole reason this does not go through `runContainer`:
 * the container has to survive its own exit long enough to be committed, and it
 * has to carry a `--name` for `docker commit` to have something to name. It gets a
 * NETWORK, on the same terms the agent sandbox does (ADR-0013): install needs a
 * package registry. The phases it feeds keep `--network none` — that is the whole
 * point of doing it here. They inherit the result of a network they never had.
 *
 * Returns the failure rather than throwing it. A repository whose install does not
 * complete is an operational fault the caller records as `cause: 'environment'` and
 * ends the run on; an exception here would discard the run instead of reporting why
 * it could not start.
 */
async function buildEnvSnapshot(
  plan: RunPlan,
  source: string,
  base: string,
  recipe: Recipe,
): Promise<{ image: string } | { failed: string }> {
  // Sanitised the same way the handover ref is: a run id reaches this as a docker
  // name and a tag, and both have a character set.
  const id = plan.runId.replace(/[^A-Za-z0-9_-]/g, '') || 'run';
  const container = `engine-env-${id}`;
  const image = `engine-env:${id}`;
  // A container left by an earlier run with this id would take the name and this
  // build would fail on it — and committing SOMEBODY ELSE'S container would be
  // worse: an environment nobody in this run built, judged as though we had.
  await execFile('docker', ['rm', '--force', container]).catch(() => {});

  const job: Job = {
    runId: plan.runId,
    afterSeq: 0,
    sourcePath: '/src',
    baseRef: base,
    // Never read on this path — the Runner returns before `verify()` — and passed
    // as base rather than left to a default so nothing here names a commit that
    // does not exist yet.
    fixRef: base,
    repro: { command: '' },
    symptomPattern: plan.symptomPattern,
    only: 'env',
    recipe,
  };

  const child = spawn(
    'docker',
    ['run', '--name', container, '-i', '-v', `${source}:/src:ro`, plan.image],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  child.stdin.end(`${JSON.stringify(job)}\n`);

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    // Bounded like the event channel is. This container speaks one line, so
    // anything approaching the ceiling is a container that is not the one we asked
    // for, and reading it into host memory unbounded is how that becomes our
    // problem.
    if (stdout.length < MAX_STREAM_BYTES) stdout += chunk;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
  });
  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });

  let env: ReplayOutcome | undefined;
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isWorkerReply(parsed) && 'env' in parsed) env = parsed.env;
    } catch {
      // Not a reply. This container writes no events, so there is nothing else on
      // the channel that a line could be.
    }
  }

  // Said in the recipe's own words where there are any. `replayRecipe` already
  // names the step that failed and redacts the command, and a paraphrase of that
  // would be a diagnosis nobody can act on — the mistake this codebase has made
  // twice with git's stderr.
  const failed =
    exitCode !== 0
      ? `the environment build exited ${exitCode}: ${stderr.trim().split('\n').at(-1) ?? ''}`
      : env === undefined
        ? 'the environment build reported nothing about the recipe it replayed'
        : env.ready
          ? null
          : (env.failed ?? 'the environment did not build');

  try {
    if (failed !== null) return { failed };
    await execFile('docker', ['commit', container, image]);
    return { image };
  } catch (error) {
    return { failed: `could not commit the environment: ${String(error)}` };
  } finally {
    // Whatever happened. The image is what the run needs; the container it was
    // committed from is a copy of the same bytes waiting to be forgotten.
    await execFile('docker', ['rm', '--force', container]).catch(() => {});
  }
}

/**
 * Drives a tool-serving container from out here.
 *
 * The whole of ADR-0011 in one function type: something on the host is handed a
 * way to execute a tool inside the container, and what it does with that — talk to
 * the model API, replay a script — is not this file's business. The container
 * never learns which.
 */
export type ContainerDriver = (io: {
  invoke: (tool: string, input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
}) => Promise<void>;

async function runContainer(
  plan: RunPlan,
  source: string,
  afterSeq: number,
  phase: PhaseResult['phase'],
  overrides: Partial<Job>,
  /** Present only for a `serveTools` container: what to run while it serves. */
  driver?: ContainerDriver,
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
    // Read off the recipe here rather than asked of the caller, so there is no way to
    // configure a run whose suite command disagrees with the one its environment was
    // built from. The agent container ignores it — `only: 'agent'` returns before
    // `verify()` — so this reaches only the two containers that judge.
    ...(plan.recipe?.test === undefined ? {} : { suiteCommand: plan.recipe.test }),
    ...(plan.baseRuns === undefined ? {} : { baseRuns: plan.baseRuns }),
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
    // Dependency install is what this used to foreclose, and for four milestones a
    // reproduction needing a package the base commit lacked was simply unrunnable.
    // It is not the seal that changed: the dependencies arrive in the IMAGE now,
    // installed by a build container before the agent existed, so the phases still
    // reach nothing and no longer need to (see `buildEnvSnapshot`).
    // NO NETWORK, for every container including the agent's.
    //
    // The phases need none. The agent needs the model API — and the transport for
    // that is NOT built: `--add-host <name>:host-gateway` requires a network, and
    // `--network none` removes every interface, so the two cannot coexist. An
    // earlier version of this line tried to and silently dropped the seal, which
    // would have handed an untrusted agent the open bridge; `HTTPS_PROXY` is an
    // environment variable and an agent that ignores it is just on the internet.
    //
    // Sealed until the transport exists. An agent that cannot reach the model API
    // cannot do its job, and a caller who needs one will notice immediately —
    // which is the failure this project wants, rather than a boundary that reads
    // as enforced and is not.
    // The ASYMMETRY ADR-0013 turns on, and the only place it is expressed.
    //
    // The phase containers get nothing, always: a reproduction that can reach the
    // network is a reproduction that can be TOLD what to answer, and the code under
    // judgement must not be able to exfiltrate the repository it was handed.
    //
    // The AGENT sandbox gets a network when — and only when — there is a recipe to
    // replay, because install needs a package registry and booted services need
    // localhost. It is the default bridge rather than a registry-only allowlist:
    // ADR-0011 established that this project cannot express "sealed plus one route"
    // (`--network none` removes every interface; the transport does not exist), and
    // ADR-0010's v1.5 amendment says the agent sandbox "is not contained, and it no
    // longer needs to be" — nothing worth stealing lives there and nothing it
    // produces is trusted. What makes that affordable is what LEFT it: no model
    // credential, no GitHub token, no event channel.
    // `|| plan.draftingEnvironment` is the one addition M6b makes to this line, and
    // the comment above the field it reads explains why it belongs beside the
    // recipe check rather than as a separate rule: both are "this agent needs to
    // install and boot something", and a recipe existing is just the other way
    // that need can be true.
    ...(phase === 'agent' && (plan.recipe || plan.draftingEnvironment) ? [] : ['--network', 'none']),
    '-v', `${source}:/src:ro`,
    '-v', `${store}:/blobs`,
    ...(handover ? ['-v', `${handover}:/out`] : []),
    ...(plan.agentImageMount ? ['-v', `${plan.agentImageMount}:/usr/local/bin/claude:ro`] : []),
    // The agent's image when there is one, and `plan.image` for everything that
    // judges. This one line is the whole of "the browser runs in the agent sandbox
    // only".
    phase === 'agent' ? (plan.agentImage ?? plan.image) : plan.image,
  ];

  // `spawn`, not `execFile`. execFile has no `input` option — that belongs to
  // execFileSync — so the Job never reached the container's stdin, `readStdin()`
  // waited for an EOF that never came, and the container hung until the test
  // timed out. A cast had made the type checker stop saying so.
  //
  // A non-zero exit is an outcome here, not a crash: the Runner's exit codes say
  // whether there is a stream worth reading, and a partial stream is evidence.
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  // The Job on its own LINE, and stdin left open when something out here is going
  // to keep writing to it. Without the newline the container's line reader waits
  // for EOF, which is precisely the deadlock the tool protocol would otherwise
  // introduce: the host waiting for a result, the container waiting for the end of
  // the job it already has.
  if (driver) child.stdin.write(`${JSON.stringify(job)}\n`);
  else child.stdin.end(JSON.stringify(job));

  // What is on the channel, split as it arrives.
  //
  // Incremental rather than parsed at the end, because a tool-serving container
  // interleaves REPLIES with its events and the driver needs each reply the moment
  // it lands. A non-driving container behaves exactly as before: every line is an
  // event and nothing is looked at until the container exits.
  const eventLines: string[] = [];
  const pending = new Map<string, (result: { ok: boolean; output: string }) => void>();
  let ready = () => {};
  const readied = new Promise<void>((resolve) => (ready = resolve));
  let handoverReport: string | null | undefined;
  let envReport: ReplayOutcome | undefined;
  let stdout = '';
  // Counted separately, because `stdout` is now DRAINED per line. Measuring the
  // ceiling against it would measure the current partial line, and the guard would
  // silently never fire — a stream cut mid-line reaching the fold is precisely what
  // it exists to refuse.
  let totalBytes = 0;
  let truncated = false;
  const take = (line: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Not JSON at all. Kept as an event line so `parse` fails loudly rather
      // than silently dropping something that was supposed to be a fact.
      eventLines.push(line);
      return;
    }
    if (!isWorkerReply(parsed)) {
      eventLines.push(line);
      return;
    }
    if ('ready' in parsed) ready();
    else if ('env' in parsed) envReport = parsed.env;
    else if ('finished' in parsed) handoverReport = parsed.finished.handover;
    else {
      const settle = pending.get(parsed.result.id);
      // A reply for a call nobody is waiting on is dropped rather than thrown:
      // the only writer on this pipe is our own Runner, and a duplicate would be
      // an engine bug that must not cost the run its transcript.
      if (settle) {
        pending.delete(parsed.result.id);
        settle({ ok: parsed.result.ok, output: parsed.result.output });
      }
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (totalBytes + chunk.length > MAX_STREAM_BYTES) {
      truncated = true;
      return;
    }
    totalBytes += chunk.length;
    stdout += chunk;
    let newline = stdout.indexOf('\n');
    while (newline !== -1) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line !== '') take(line);
      newline = stdout.indexOf('\n');
    }
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

  const closed = new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });

  if (driver) {
    let calls = 0;
    const invoke = async (tool: string, input: Record<string, unknown>) => {
      const id = `h${++calls}`;
      return await new Promise<{ ok: boolean; output: string }>((resolve, reject) => {
        pending.set(id, resolve);
        // Races the container's own exit. A container that dies mid-loop would
        // otherwise leave the driver awaiting a reply forever, and a hung host
        // process is the one failure mode with no diagnosis at all.
        closed.then(() => {
          if (pending.delete(id)) reject(new Error('the container exited before answering'));
        });
        child.stdin.write(`${JSON.stringify({ call: { id, tool, input } } satisfies WorkerRequest)}\n`);
      });
    };
    // Wait for the world. `Promise.race` against the exit, because a container
    // that fails to stand up never sends `ready` and the driver must not block on
    // a message that is not coming.
    await Promise.race([readied, closed]);
    // A world that never came up gets no loop. Spending a model on a container
    // whose services are down produces a transcript full of connection refusals and
    // a reproduction of our own outage; the host records the operational fault
    // instead.
    try {
      if (!envReport || envReport.ready) await driver({ invoke });
    } finally {
      // Always, however the driver ended. Without this the container serves
      // forever and the run hangs on a loop that has already finished.
      child.stdin.write(`${JSON.stringify({ done: true } satisfies WorkerRequest)}\n`);
      child.stdin.end();
    }
  }

  const exitCode = await closed;

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
  // The tail, if the container's last line had no newline. Then the events, which
  // is every line that was not a reply.
  if (stdout.trim() !== '') take(stdout.trim());
  const events = parse(eventLines);
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
          reason: redact(collection).slice(0, MAX_REASON_CHARS),
        },
      }),
    );
  }
  return {
    phase,
    events,
    exitCode,
    stderr: stderr.trim(),
    ...(handover ? { handover } : {}),
    ...(handoverReport === undefined ? {} : { handoverReport }),
    ...(envReport === undefined ? {} : { envReport }),
  };
}

const parse = (lines: string[]): RunEvent[] => lines.map((line) => JSON.parse(line) as RunEvent);

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
/**
 * Enough for a reproduction; far short of shipping a payload through the manifest.
 *
 * Exported because the repro PROMPT quotes both numbers, and a prompt that promises
 * a limit the engine does not enforce is worse than no prompt: it produces a
 * confident agent and a refused run. `test/prompts.test.ts` reads them from here.
 */
export const MAX_REPRO_FILES = 32;
export const MAX_REPRO_BYTES = 256 * 1024;

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
