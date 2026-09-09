// The host side of M4: one container per participant, sequenced here.
//
// This does not contradict M3.1's "no docker client in the sandbox" — the
// sandbox still has none. Orchestration moves UP, to the host, which already
// has a daemon. What moves with it is the thing that mattered: base and fix stop
// sharing a machine.
//
// Since M10 the containers themselves are started one file over: this module decides
// WHICH phase runs, in what order, from what world, and what its result means; an
// `Executor` (`executor.ts`, Docker in `executor-docker.ts`) decides where. Nothing
// here spawns anything, and `test/executor.test.ts` keeps it that way.
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

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent } from './events.js';
import { fold } from './fold.js';
import { runAgentLoop, type AgentTranscript, type LoopUsage } from './loop.js';
import type { Recipe } from './recipe.js';
import type { Job } from './runner.js';
import { dockerExecutor } from './executor-docker.js';
import { own, type EnvSnapshot, type Executor, type PhaseResult } from './executor.js';
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
  /**
   * What the recipe's own test command did in the sealed world, observed before
   * either agent ran. Absent when the recipe declares no test command.
   *
   * The fix agent already gets `suite` — the base container's real SUITE_RUN — so
   * this looks redundant and is not: `suite` says how the project's tests fared on
   * a commit, and this says whether that command is RUNNABLE where the judging
   * happens at all. A repository whose test command resolves from a registry has
   * no suite result to report and every reason to be told why.
   */
  sealed?: SealedWorld;
};

/** Tail of base's output handed to the fix agent. The failure is at the end. */
const MAX_OBSERVED_CHARS = 8 * 1024;

const execFile = promisify(execFileCb);

export type RunPlan = Omit<
  Job,
  'sourcePath' | 'afterSeq' | 'only' | 'fixRef' | 'repro' | 'agentPrompt' | 'secrets'
> & {
  /**
   * Stored credentials OFFERED to this run's phases (10l, ADR-0017).
   *
   * A different name from `Job.secrets` on purpose, and the two are the two sides of one
   * guard: `plan.stored` is what the run has, `job.secrets` is what a particular sandbox
   * was given, and `mayInject` in `executor.ts` is the only thing that turns one into the
   * other. `secrets` is omitted from the inherited `Job` fields above so the offered map
   * cannot be mistaken for an injected one, or reach a Job through a spread.
   *
   * On the plan rather than on `PhaseSpec` because a plan reaches every `runPhase` call —
   * six of them — and the alternative was six call sites each deciding whether their phase
   * is sealed, which is a fact none of them can see. A seventh added later would have
   * defaulted to leaking.
   *
   * Never logged and never serialised: a plan is passed by reference and no code path
   * stringifies one, which is what makes this safe to carry here rather than fetch per
   * phase.
   */
  stored?: Record<string, string>;
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
   *
   * A FUNCTION when the caller wants to say something about the world this agent
   * will be judged in: the sealed-world probe runs after the plan is built and
   * before the agent starts, so a string here was written before anyone looked.
   */
  reproPrompt?: string | ((sealed?: SealedWorld) => string | Promise<string>);
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
  /**
   * The image every judging phase runs from — and the agent, when `agentImage` is not
   * set. Read by the executor, which decides what an image reference IS: a local Docker
   * tag today, a registry reference on a substrate that pulls.
   */
  image: string;
  /**
   * Where each phase runs (M10, ADR-0021). Docker on this machine unless a caller
   * brings another — the worker brings Vercel's. Everything above this field is the
   * same either way, which is the whole point of it being a field: the order of
   * phases, the gate, the seq counter and the fold are the product; where a phase
   * executes is a substrate.
   */
  executor?: Executor;
  /**
   * Host path to a `claude` executable, mounted over the image's. For tests: the
   * image ships no agent yet, and a hostile fake is how the supervision boundary
   * is exercised without one.
   */
  /**
   * The wall clock each container gets, from the host. `CONTAINER_TIMEOUT_MS` by
   * default; a test that wants to observe the ceiling passes a small one.
   *
   * Distinct from `timeoutMs`, which bounds a COMMAND inside a container that is
   * running, and from `loop.timeoutMs`, which bounds the agent. This one is the
   * only bound that survives a container which never got as far as running.
   */
  containerTimeoutMs?: number;
  /** How many attempts before the run gives up. One, unless a caller asks for more. */
  maxAttempts?: number;
  /**
   * Host path to a `claude` executable, mounted over the image's (see the doc two fields
   * up). A bind mount is a Docker idea: the Docker executor honours this and any other
   * ignores it, which is acceptable only because it exists for the hostile-fake tests.
   */
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
   * args in `executor-docker.ts`. Omitted, nothing boots and every container stays
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
   * there is a recipe to replay" (see the docker args in `executor-docker.ts`) — written
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
  /**
   * A FUNCTION when the caller wants to say something about the world the agent is
   * being judged in — the same reason `agentPrompt` is one. The probe runs after
   * the plan is built and before this agent starts, so a string here is a prompt
   * written before anyone looked.
   */
  | { reproPrompt: string | ((sealed?: SealedWorld) => string | Promise<string>); repro?: never }
);


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
  // Where the phases run (M10). Docker unless the caller brought another executor.
  const executor = plan.executor ?? dockerExecutor();
  // The environment snapshot, when one was built. Declared out here because it is
  // the largest thing a run leaves behind — an image, on Docker — and it has to be
  // removable from the `finally` below rather than from the end of a happy path.
  let snapshot: EnvSnapshot | null = null;
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
    //
    // `try`/`catch` around the `await`, not `.catch()` on the promise: an executor that
    // throws synchronously never returns a promise to attach a handler to.
    if (snapshot) {
      try {
        await executor.dropSnapshot(snapshot);
      } catch {
        // Disk hygiene, never at the cost of the run.
      }
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
  const built =
    plan.recipe?.install === undefined
      ? null
      : await executor.buildSnapshot(plan, source, base, plan.recipe);
  if (built && 'snapshot' in built) snapshot = built.snapshot;
  // The two containers that JUDGE run from the snapshot — `from`, on every
  // `runPhase` below that is not the agent's; everything else is untouched by it.
  // The agent sandbox never runs from a world built out of a recipe replay it is
  // about to perform itself.

  // Before the agent, because the agent is who it is for — and skipped entirely when
  // there is no agent to tell. A caller who supplies the reproduction has already
  // decided what runs, and spending a container on prose nobody will read is the
  // kind of cost that gets a good check deleted later.
  //
  // A run whose environment failed to build never gets here either: `snapshot.failed`
  // ends it inside the attempt loop below, so this only probes a world that exists.
  const sealed =
    (built && 'failed' in built) || !(plan.reproPrompt || plan.agentPrompt)
      ? undefined
      : await probeSealedWorld(executor, plan, source, base, snapshot ?? undefined);

  // Starts at zero because this function owns the whole run: it emits the first
  // event. A caller-supplied starting seq was a public field that could not work
  // — the gate folds this run's events, and `fold()` throws on a stream that does
  // not begin at 1, so any non-zero value threw mid-run and discarded the base
  // container's observations.
  let afterSeq = 0;

  // WHAT THE PHASES WILL RUN IN, said once, before the first attempt (M10, ADR-0021).
  //
  // After 7e the containers that judge stopped running from `plan.image` and started
  // running from something built during this run, and nothing in the log said so — a
  // reader asking what the base phase executed in had to know which milestone shipped
  // when. `steps` is what the replay returned, which is a fact about the build and not
  // about the project: `install` exiting 0 says the command succeeded and nothing about
  // whether it installed the right thing.
  if (built && 'snapshot' in built) {
    events.push(
      own(plan.runId, ++afterSeq, {
        type: 'ENV_BUILT',
        payload: {
          v: 1,
          executor: executor.kind,
          image_ref: plan.image,
          snapshot: built.snapshot.ref,
          steps: built.steps ?? [],
        },
      }),
    );
  }

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
    if (built && 'failed' in built) {
      events.push(
        own(plan.runId, ++afterSeq, {
          type: 'VERIFICATION_ABORTED',
          payload: {
            v: 1,
            phase: 'setup',
            cause: 'environment',
            reason: redact(built.failed).slice(0, MAX_REASON_CHARS),
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
        return await executor.runPhase({
          plan,
          source: agentSource,
          afterSeq: at,
          phase: 'agent',
          overrides: { agentPrompt: prompt, ...shared },
        });
      }
      let transcript: AgentTranscript = {
        lines: [],
        stopped: 'spawn_failed',
        exitCode: -1,
        usage: { turns: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
      const result = await executor.runPhase({
        plan,
        source: agentSource,
        afterSeq: at,
        phase: 'agent',
        overrides: { serveTools: true, ...shared },
        driver: async ({ invoke }) => {
          transcript = await runAgentLoop({ prompt, invoke, ...plan.loop });
        },
      });
      // AFTER whatever the executor itself wrote, not from `at`.
      //
      // Until M10 nothing but the container wrote events for this phase, and in
      // `serveTools` mode the container writes none — so `at` was the whole answer. The
      // Vercel executor writes one: `SANDBOX_SEALED`, which has to precede every
      // `AGENT_MESSAGE` below or the fold's ordering question is answered wrongly for a
      // sandbox that WAS sealed in time. Starting here instead of at `at` is what keeps
      // the two writers from claiming the same seq, and the Runner allocates
      // contiguously from `afterSeq`, so this is the last seq either of them used.
      let seq = at + result.events.length;
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
    // Read out of the plan once. Narrowing `plan.reproPrompt` in place narrows the
    // whole plan union with it, and the string branch then has no member left.
    const authored = plan.reproPrompt;
    if (authored) {
      const prompt = typeof authored === 'function' ? await authored(sealed) : authored;
      steps.push({ phase: 'agent', job: {}, source: agentSource, kind: 'repro', prompt });
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
            ? await plan.agentPrompt({
                repro: plan.repro!,
                ...(sealed === undefined ? {} : { sealed }),
              })
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
          : await executor.runPhase({
              plan,
              source: step.source,
              afterSeq,
              phase: step.phase,
              overrides,
              ...(snapshot ? { from: snapshot } : {}),
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
                  ...(sealed === undefined ? {} : { sealed }),
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
        const fix = await executor.runPhase({
          plan,
          source,
          afterSeq,
          phase: 'fix',
          overrides: {
            only: 'fix',
            fixRef,
            ...(resolvedRepro ? { repro: resolvedRepro } : {}),
          },
          ...(snapshot ? { from: snapshot } : {}),
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
 * The shapes an unset environment variable takes in somebody else's error message.
 *
 * Three, because three cover node, shells and python between them, and a longer list
 * would be a parser for every runtime rather than a hint. Deliberately not exhaustive —
 * what it produces is a sentence on a page, and a miss costs nothing a person would
 * notice.
 *
 * `\b` before each name, so a name is a whole token: `myDATABASE_URL is not set` names
 * a variable this project does not have, and quoting a fragment of an identifier back
 * to somebody as advice is worse than saying nothing.
 */
const UNSET_VARIABLE =
  /\b([A-Z][A-Z0-9_]{2,})\s+is not (?:set|defined)|process\.env\.\b([A-Z][A-Z0-9_]{2,})\s+is undefined|Missing (?:required )?(?:environment )?variable:?\s+\b([A-Z][A-Z0-9_]{2,})/g;

/**
 * The names a failing suite's output complains about, minus the ones already handled.
 *
 * Separate from its one caller so it can be tested without a container: everything
 * around it in `proveRepository` needs Docker, and a heuristic nobody can exercise is
 * a heuristic that quietly stops matching. Capped at eight, because this ends up in a
 * sentence a person reads and a list longer than that is a log.
 */
export function namesLookingUnset(output: string, handled: Iterable<string> = []): string[] {
  const known = new Set(handled);
  const named = [...output.matchAll(UNSET_VARIABLE)]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .filter((name): name is string => name !== undefined && !known.has(name));
  return [...new Set(named)].slice(0, 8);
}

/**
 * What onboarding proved about a repository, and what it could not (8f).
 *
 * Milestone 7: *"Onboarding proves a recipe, not a repository."* 6b's drafting run
 * ends with a human approving text in a box, and until now that was the whole of it
 * — the first time anyone found out whether those commands actually work was in the
 * middle of a real run, twenty minutes after a stranger filed an issue.
 *
 * The state is derived from the observations beneath it and never asserted on its
 * own: `blocked` means the environment did not build, which is a repository nobody
 * can run anything against; `ready_with_caveats` means it built and something the
 * engine needs is missing or already broken; `ready` means neither.
 */
export type RepoProof = {
  state: 'ready' | 'ready_with_caveats' | 'blocked';
  /** The commit it was proved at. A proof is about a tree, not about a repository. */
  commit: string;
  /** Whether the recipe's install/migrate/seed replayed into an image at all. */
  environment: { built: true } | { built: false; failed: string };
  /** What the project's own test command did in a sealed container (8b's probe). */
  suite?: SealedWorld;
  /** What is wrong with THIS repository, each item priced in the words a human needs. */
  caveats: string[];
  /**
   * What this engine does not check for anyone — kept apart from `caveats`, which
   * are about the repository. Collapsing the two would read as "your project is
   * missing something" when the missing thing is ours.
   */
  unproved: string[];
  provedAt: string;
};

/**
 * Prove that this repository runs, and record what could not be proved.
 *
 * Deliberately the same two containers a real run would use — `buildSnapshot`
 * and the sealed suite probe — rather than a cheaper approximation. The entire
 * value here is that the answer is the one a run will get, and an onboarding check
 * that passes where runs fail is worse than no check: it certifies a repository
 * into a false Tier 3 twenty minutes later.
 *
 * Runs at APPROVAL, not at drafting. A draft is a proposal and there is nothing to
 * prove about commands nobody has agreed to; the moment they become the commands
 * this engine will execute verbatim is the moment they are worth executing once,
 * while a human is still looking.
 *
 * What it does not do is named in `caveats` rather than left for someone to notice.
 */
export async function proveRepository(plan: {
  runId: string;
  repoPath: string;
  image: string;
  recipe: Recipe;
  /** Where the two containers run. Docker unless the caller brings another (M10). */
  executor?: Executor;
}): Promise<RepoProof> {
  const provedAt = new Date().toISOString();
  const workspace = await mkdtemp(join(tmpdir(), 'engine-prove-'));
  const store = await mkdtemp(join(tmpdir(), 'engine-prove-blobs-'));
  await writeFile(join(store, '.evidence-store'), '');
  const executor = plan.executor ?? dockerExecutor();
  let snapshot: EnvSnapshot | null = null;

  try {
    const source = join(workspace, 'source');
    // `--mirror`, for the reason `orchestrate` uses one: a plain clone hides every
    // branch but the default under `refs/remotes`, and the container's own clone
    // transfers `refs/heads/*` only.
    await execFile('git', ['clone', '--quiet', '--no-local', '--mirror', '--', plan.repoPath, source]);
    const { stdout } = await execFile('git', ['-C', source, 'rev-parse', 'HEAD']);
    const commit = stdout.trim();

    const proving: RunPlan = {
      runId: plan.runId,
      repoPath: plan.repoPath,
      blobRoot: store,
      image: plan.image,
      baseRef: commit,
      // Never matched against anything here: no reproduction runs, and the probe
      // discards the events that would have carried it.
      symptomPattern: 'x',
      repro: { command: '' },
      recipe: plan.recipe,
    };

    const built =
      plan.recipe.install === undefined
        ? null
        : await executor.buildSnapshot(proving, source, commit, plan.recipe);
    if (built && 'failed' in built) {
      return {
        state: 'blocked',
        commit,
        environment: { built: false, failed: redact(built.failed) },
        caveats: [
          'nothing else could be checked: with no environment there is no container to check it in',
        ],
        unproved: [],
        provedAt,
      };
    }
    if (built) snapshot = built.snapshot;

    const suite = await probeSealedWorld(executor, proving, source, commit, snapshot ?? undefined);
    const caveats: string[] = [];
    if (plan.recipe.install === undefined) {
      caveats.push(
        'this recipe installs nothing, so the containers that judge a fix get a bare checkout — ' +
          'correct for a project with no dependencies, and a false "could not reproduce" for one that has them',
      );
    }
    if (suite === undefined) {
      caveats.push(
        'no test command is set, so no run here will ever carry a regression check: a fix that ' +
          'breaks the rest of this project will look exactly like one that does not',
      );
    } else if ('failed' in suite) {
      caveats.push(
        `the test command \`${suite.command}\` could not be run in the sealed container: ${suite.failed}. ` +
          'A command that needs a network or a running service cannot be the one that judges a fix, ' +
          'and it is also the example the agent copies when it writes a reproduction',
      );
    } else if (suite.exitCode !== 0) {
      caveats.push(
        `the test command \`${suite.command}\` already fails at this commit (exit ${suite.exitCode}), ` +
          'so every regression check on this repository will read "already red" and say nothing about ' +
          'what a fix broke. Nothing here is a claim that the repository is wrong — a red suite at HEAD ' +
          'is a normal state and this is only what it costs',
      );
    }

    // A GUESS, labelled as one (M10). A suite that fails complaining about an unset
    // variable is the commonest way a repository turns out to need configuration nobody
    // wrote down, and saying so at approval — while a human is looking — is worth far
    // more than discovering it inside a stranger's issue. It is a regex over somebody
    // else's error message, so it never gates and never becomes an event: it is a
    // sentence on the onboarding page, and `recipe.required` is the thing that acts.
    //
    // Only on a suite that FAILED. A green run that happens to print the sentence — a
    // test asserting its own error message, which is exactly what a project with good
    // coverage of its configuration does — is not evidence of anything missing, and a
    // caveat on a repository that just proved itself is the kind of noise that teaches
    // people to skip the list. And a name the recipe already sets or already requires is
    // handled; repeating it as a guess would advise a change that is already made.
    if (suite !== undefined && 'output' in suite && suite.exitCode !== 0) {
      const unique = namesLookingUnset(suite.output, [
        ...Object.keys(plan.recipe.env ?? {}),
        ...(plan.recipe.required ?? []),
      ]);
      if (unique.length > 0) {
        caveats.push(
          `the test command's output mentions ${unique.map((name) => `\`${name}\``).join(', ')}, ` +
            'which this recipe neither sets nor requires. That is a guess read off an error ' +
            'message, not a finding — but if the project needs those to run, set them in the ' +
            'recipe now, or list them as required so a run without them stops and says so instead ' +
            'of failing to reproduce and calling that a finding about somebody\'s bug',
        );
      }
    }

    return {
      state: caveats.length === 0 ? 'ready' : 'ready_with_caveats',
      commit,
      environment: { built: true },
      ...(suite === undefined ? {} : { suite }),
      caveats,
      // Named rather than silently absent. Both are milestone 7's own list, and both
      // need an agent session with a network and a browser — a drafting-shaped run,
      // which is a different thing from the two sealed containers this function is.
      unproved: [
        'the single-test invocation: nothing here has executed one, so an agent still works it out per run',
        'a screenshot of the booted app, which would be the UI baseline a visual reproduction is compared against',
      ],
      provedAt,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await rm(store, { recursive: true, force: true }).catch(() => {});
    // The image is the largest thing this leaves on the host, and onboarding runs
    // on somebody else's schedule rather than a run's — so it is removed here for
    // the same reason `orchestrate` removes its own in a `finally`.
    if (snapshot) {
      try {
        await executor.dropSnapshot(snapshot);
      } catch {
        // Never at the cost of the proof.
      }
    }
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
  /** Where the drafting session runs. Docker unless the caller brings another (M10). */
  executor?: Executor;
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
      // `Job`'s shape regardless. `buildSnapshot` sets the same placeholder for
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
    const result = await (plan.executor ?? dockerExecutor()).runPhase({
      plan: draftPlan,
      source: plan.repoPath,
      afterSeq: 0,
      phase: 'agent',
      overrides: {
        only: 'agent',
        baseRef,
        serveTools: true,
      },
      driver: async ({ invoke }) => {
        const prompt = await renderPrompt('recipe', {
          environment: describeDraftingEnvironment({ browser: plan.agentImage !== undefined }),
        });
        transcript = await runAgentLoop({ prompt, invoke, ...plan.loop });
      },
    });

    // This function's own version of the cleanup `orchestrate()` does for every
    // phase it runs — `runPhase` always opens a handover directory for an
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
 * What the project's own test command does in the world that judges — observed
 * there, not believed about it.
 *
 * Two sentences in `describeEnvironment` used to be assertions. 7a deleted one of
 * them ("The project's own test command is `X`. It passes on this commit.") for
 * the honest reason that nothing had ever executed it, and left the other
 * standing: that the judging container has nothing installed. 7e made that one
 * false too — the phases run from a snapshot with the repository's dependencies
 * in it — and nothing noticed, because a prompt is the one thing this suite
 * cannot check (see the scripted-agent limitation in ADR-0015's amendment).
 *
 * So the engine runs it. `test` is a command a human approved for THIS repository
 * and it is the template the agent imitates: milestone 7's third defect was a
 * recipe whose test command resolved from the registry, in a container that has no
 * network, which taught the agent to write a reproduction that needed one. That
 * cost three model runs to diagnose and one sealed container to have prevented.
 */
export type SealedWorld = { command: string } & (
  | { exitCode: number; output: string }
  | { failed: string }
);

/**
 * Run the recipe's test command exactly where a reproduction will be judged.
 *
 * It IS a base phase — same container, same image, same `--network none`, same
 * clone, same restored dependencies, same uid — with the project's test command in
 * the place of a reproduction. Nothing cheaper is honest: milestone 7's first
 * defect was `corepack enable` succeeding as root in the environment build and
 * failing as uid 1000 in the agent sandbox, so an approximation of the phase
 * container is exactly the thing that does not answer this question.
 *
 * Its events are DISCARDED, and that is deliberate rather than wasteful. They
 * describe our environment, not the user's bug, and a `TEST_RUN` here would be a
 * second base-phase observation for the fold to pair against the real one. The
 * ReplayOutcome precedent already covers this: what the engine learns about its own
 * world travels on the reply channel, never on the log (ADR-0006).
 */
async function probeSealedWorld(
  executor: Executor,
  plan: RunPlan,
  source: string,
  base: string,
  from?: EnvSnapshot,
): Promise<SealedWorld | undefined> {
  const command = plan.recipe?.test;
  if (command === undefined) return undefined;
  const result = await executor.runPhase({
    plan,
    source,
    afterSeq: 0,
    phase: 'base',
    overrides: {
      only: 'suite',
      baseRef: base,
      fixRef: base,
      // Never read on this path — the Runner returns before `verify()` — and passed
      // as the base commit rather than left to a default so nothing here names
      // something that does not exist.
      repro: { command: '' },
      suiteCommand: command,
    },
    ...(from ? { from } : {}),
  });
  const observed = result.suiteReport;
  if (observed === undefined) {
    // The container said nothing at all: it could not stand up, or it was stopped.
    // Prose, because an unrun command must never read as a passing one.
    return { command, failed: result.stderr.trim().split('\n').at(-1) || 'the engine could not run it there' };
  }
  return 'failed' in observed
    ? { command, failed: observed.failed }
    : { command, exitCode: observed.exit_code, output: observed.output };
}


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
  const { command, files, pinned } = manifest as {
    command?: unknown;
    files?: unknown;
    pinned?: unknown;
  };
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('the reproduction manifest names no command');
  }
  // `files` may be empty now, and only when `pinned` is not. A reproduction that
  // is a test the REPOSITORY already contains writes nothing into the tree — that
  // is the whole of what makes it strong (8d) — so demanding a file to apply would
  // force the agent to invent one.
  const written = Array.isArray(files) ? files : [];
  const held = Array.isArray(pinned) ? pinned : [];
  if (written.length === 0 && held.length === 0) {
    throw new Error('the reproduction manifest names no files');
  }
  if (written.length + held.length > MAX_REPRO_FILES) {
    throw new Error(
      `the reproduction names ${written.length + held.length} files, past the ${MAX_REPRO_FILES} ceiling`,
    );
  }

  const contents: Record<string, string> = {};
  let total = 0;
  for (const path of written) {
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

  // Pinned paths are NAMES and nothing else: never read out of the agent's commit,
  // never written anywhere. `verify()` reads them from the base checkout and hashes
  // them there, which is what makes a pinned path evidence about the repository
  // rather than about the agent — the same distinction `show()` above exists to
  // keep, one level up. Validated with the same regex so a name that is an option
  // or an escape cannot reach a git argument later.
  const names: string[] = [];
  for (const path of held) {
    if (typeof path !== 'string') {
      throw new Error('the reproduction manifest names a non-string path');
    }
    if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(path) || path.split('/').includes('..')) {
      throw new Error(`the manifest names an unusable path: ${path.slice(0, 120)}`);
    }
    // Both lists naming the same path would apply the agent's copy over the
    // repository's and then call the result pre-existing.
    if (path in contents) {
      throw new Error(`the manifest both writes and pins ${path.slice(0, 120)}`);
    }
    names.push(path);
  }
  return { command, files: contents, ...(names.length === 0 ? {} : { pinned: names }) };
}
