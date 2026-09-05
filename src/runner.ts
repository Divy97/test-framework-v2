// The Runner: PID 1 inside the sandbox (ADR-0006). It clones the repo, executes
// the verification engine, and pushes the resulting events out through one
// channel — stdout, one JSON object per line.
//
// It does not interpret anything. Whatever `verify()` observed goes out verbatim,
// and the fold decides what it means.
//
// No agent yet: M3.1 proves containment and the event path with nothing
// non-deterministic in the loop.

import { closeSync, openSync, writeSync } from 'node:fs';
import { appendFile, chmod, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { basename, dirname } from 'node:path';
import { promisify } from 'node:util';
import type { RunEvent } from './events.js';
import { superviseAgent } from './agent.js';
import { resolveInside as confine } from './paths.js';
import { replayRecipe, type Recipe, type ReplayOutcome } from './recipe.js';
import { ToolHost } from './tools.js';
import {
  MAX_OUTPUT_BYTES,
  MAX_REASON_CHARS,
  ObservationFailed,
  run as observeCommand,
  verify,
  type Env,
  type ReproSpec,
} from './verify.js';

const execFileAsync = promisify(execFile);

/** What the host asks the sandbox to verify. Read as JSON on stdin. */
export type Job = {
  runId: string;
  afterSeq: number;
  /** Path to the source repo, mounted read-only. Cloned rather than used in place. */
  sourcePath: string;
  baseRef: string;
  fixRef: string;
  repro: ReproSpec;
  /** Serialised as a string: JSON has no regex, and the source must survive the wire. */
  symptomPattern: string;
  /**
   * Ask the agent this before verifying. Omitted, no agent runs at all — which is
   * the M3.1 shape, kept working so the engine stays testable without one.
   *
   * A prompt, never a command: the Runner chooses the binary and its flags. A
   * caller-supplied command line would be arbitrary execution wearing a
   * configuration field's clothes.
   */
  agentPrompt?: string;
  agentTimeoutMs?: number;
  /**
   * Serve tool calls from the host instead of running an agent in here at all
   * (ADR-0011). Implies `only: 'agent'`.
   *
   * The loop is outside; this container executes what it is told and returns
   * results. Two consequences, both deliberate:
   *
   *   - **No agent binary.** Nothing in here talks to the model API, which is why
   *     the container needs no egress and why `--network none` stops being a
   *     stopgap and becomes correct.
   *   - **No events.** ADR-0006's amendment moves the pen to the host
   *     orchestrator, and this is where that stops being a claim: in this mode the
   *     container writes tool results and a closing report on the channel and not
   *     one event, so there is nothing to trust about it. `agentPrompt`'s path
   *     still emits its own transcript, because there the Runner is the only thing
   *     that watched the process.
   */
  serveTools?: boolean;
  /**
   * Stand the environment up before the agent gets the tools (ADR-0013).
   *
   * Replayed, never derived: the recipe was drafted once and approved by a human,
   * and it is stored on our side keyed by repository. Omitted, nothing is booted —
   * which is the M2/M3 shape and what every adversarial fixture wants, since a tiny
   * generated git repo has nothing to boot.
   */
  recipe?: Recipe;
  /**
   * Observe one phase and stop. Omitted, this container runs the whole run, as
   * M3 did.
   *
   * With it, the host runs a container per phase and nothing is shared between
   * them — no tree, no TMPDIR, no HOME, no surviving process, no `/blobs` window
   * between phases. Every channel ADR-0010 enumerates comes from base and fix
   * sharing a machine; this removes the sharing rather than scrubbing it, which
   * is the only move here that has not needed a follow-up fix.
   *
   * `env` is not a phase at all: it observes nothing, judges nothing and emits no
   * event. It installs this repository's dependencies so the host can commit the
   * result into the image the phases then run from — see `buildEnvironment`.
   *
   * `suite` is not a phase either, and deliberately not a reproduction: it runs
   * `suiteCommand` in a phase's world — same clone, same restored dependencies,
   * same uid, same seal — and reports what happened on the reply channel. It
   * emits no event, because what the engine learns about ITS OWN world is not a
   * fact about the user's bug (ADR-0006), and it is not routed through `verify()`
   * because a reproduction anchored to nothing is refused there, correctly: the
   * anchor rule exists to stop a fix commit owning its own reproduction, and
   * there is no fix commit here to own anything.
   */
  only?: 'base' | 'fix' | 'agent' | 'env' | 'suite';
  flakeRuns?: number;
  baseRuns?: number;
  /**
   * The project's own test command, run on both commits so a regression is visible.
   *
   * Passed as a bare string rather than inferred from `recipe`, because the phase
   * containers deliberately carry no recipe: they replay nothing, and handing them a
   * whole boot procedure to extract one field from would give them a capability they
   * must not have. The orchestrator reads it off the recipe and passes the command.
   */
  suiteCommand?: string;
  timeoutMs?: number;
  /** Run the sham-fix control. Set when the AGENT wrote the reproduction. */
  controlRun?: boolean;
};

const WORK = '/work';
/**
 * Where the evidence lands. A Runner constant, never a Job field: a
 * caller-supplied path could aim the blob writes at the repo or the read-only
 * source mount.
 */
const BLOBS = '/blobs';
/** Matches the `repro` user created in the Dockerfile. */
export const REPRO_UID = 1000;
const REPRO_GID = 1000;

/**
 * Where the environment build leaves what it built, and the list of what it wrote.
 *
 * Outside `/work` on purpose: `/work` is per-participant scratch that the agent
 * teardown deletes wholesale, and this has to survive into a DIFFERENT container —
 * it is committed into an image, and the phases read it out of that image at clone
 * time. Nothing under here is ever handed to the repro user.
 */
const ENV = '/opt/env';
const ENV_REPO = `${ENV}/repo`;
const ENV_IGNORED = `${ENV}/ignored.txt`;

/**
 * What the exit status tells a caller, and specifically whether there is
 * anything on the channel worth reading.
 *
 * `partial` and `silent` were one code until a stream could survive an abort.
 * They demand opposite things — fold the channel, or ignore it and read stderr —
 * so collapsing them would leave a caller unable to tell evidence from nothing.
 */
export const EXIT = {
  /** Every phase observed; the stream is complete. */
  complete: 0,
  /** An engine or Runner bug. Nothing on the channel. */
  bug: 1,
  /** Observation stopped, and a partial stream IS on the channel. Fold it. */
  partial: 2,
  /** Observation stopped with nothing on the channel — including a failed flush. */
  silent: 3,
} as const;

/**
 * Proof the store outlives the container — which `st_dev` alone cannot give.
 *
 * A different device only means "a different filesystem": an anonymous volume
 * (`-v /blobs`) passes that test and is then deleted by `--rm`, admitting the
 * exact silent-loss case the check exists to stop. So the caller must have
 * created the directory on the host and left a sentinel in it.
 */
const SENTINEL = '.evidence-store';

/**
 * Every directory in the sandbox IMAGE a participant can write.
 *
 * Not every place one can leave state for another — that was an overclaim. The
 * run adds mounts the image does not have, and two of them are channels this
 * list cannot cover: `/blobs`, which a bind mount leaves writable regardless of
 * container permissions and which outlives the run, and the agent's own world.
 * Those are handled where they are created; this list is about the image.
 *
 * This list was three guesses long and kept being wrong — `/home/node` is not
 * world-writable, it is uid-1000-owned because the image ships it that way, and
 * `/dev/mqueue` was simply never thought of. What was missing was not a longer
 * list but a way to know when the list is complete.
 *
 * `test/sandbox.test.ts` enumerates the image as the repro user and asserts the
 * result is exactly this array, so the guessing is over: change the base image
 * and add a writable path, and the suite says so instead of the next review
 * round finding it. The entry that matters is whichever one is not here yet.
 */
export const SHARED_WRITABLE = ['/tmp', '/var/tmp', '/dev/shm', '/dev/mqueue', '/home/node'];

/**
 * Which way the evidence is going to outlive the machine that produced it (M10).
 *
 * `mounted` is Docker's: `/blobs` is a bind mount, so the bytes are already on a host
 * that outlives the container, and a store on the same device as `/` is the silent-loss
 * case the check exists to refuse.
 *
 * `collected` is a microVM's: there is no host to mount from, the store is on this
 * machine's own filesystem, and the worker copies it out before destroying the machine
 * (ADR-0021). The device check cannot apply — everything is the same device — so what is
 * left is the sentinel, which still proves the caller MEANT this directory to be a store
 * rather than a path typo the run would write into and lose.
 */
export type StoreMode = 'mounted' | 'collected';

async function storeWillOutliveThis(path: string, mode: StoreMode): Promise<boolean> {
  try {
    // `lstat`, and the sentinel has to be a FILE. Under `collected` the sentinel is the
    // only gate left — the device check cannot apply — so the shapes `guardEvidence`
    // already anticipates (a symlink where the store should be, a directory wearing the
    // sentinel's name) matter more here than they did, not less.
    const here = await lstat(path);
    if (!here.isDirectory()) return false;
    if (mode === 'mounted') {
      const root = await stat('/');
      if (here.dev === root.dev) return false;
    }
    if (!(await lstat(`${path}/${SENTINEL}`)).isFile()) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Leave nothing of the agent running, and nothing of its debris lying around,
 * before the phases begin.
 *
 * A process the agent backgrounds outlives it. Running as the repro user it can
 * write the phases' own private TMPDIR and HOME, so separating those directories
 * does nothing at all against it — it stages the red-then-green flip from
 * inside. Killing the agent's process group is not enough either: a grandchild
 * that calls `setsid` leaves the group.
 *
 * Being PID 1 is what makes this closable. The Runner owns the container's PID
 * namespace, so every other process in /proc is something this run started, and
 * nothing legitimate is running between the agent finishing and the base phase.
 *
 * The shared tmpfs directories go with them. `TMPDIR` only redirects a test that
 * honours it; one that writes `/tmp` literally shares the path regardless, and
 * `/var/tmp` and `/dev/shm` are world-writable too. Enumerating them here is
 * exactly the enumeration ADR-0010 said nobody finishes — which is why the reap
 * above is the load-bearing half and this is the belt to its braces.
 *
 * Gated hard on being PID 1: outside a container this would kill the developer's
 * session and erase their /tmp.
 */
/**
 * Stop everything, then kill it. Not the other way round, and not one pass.
 *
 * Reading `/proc` and killing what was in it is a SNAPSHOT, not a fence: a
 * process that forks a successor and exits is never in the list about to be
 * swept, so a self-respawning chain walks straight through. Review demonstrated
 * it winning three runs in five — carrying its state in `argv` and its code in
 * the environment, so the directory scrub had nothing to delete either.
 *
 * SIGSTOP cannot be caught, blocked or ignored, and a stopped process cannot
 * fork. So stopping the population first makes it monotonically shrinking, and
 * the loop converges instead of racing: repeat until a pass finds nothing new,
 * and only then kill. The residual is a child forked in the window between two
 * signals, which the next pass stops.
 */
async function reap(only?: (pid: number) => Promise<boolean> | boolean): Promise<void> {
  const alive = async () => {
    const pids = (await readdir('/proc'))
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 1);
    if (!only) return new Set(pids);
    // Filtered when this process is not PID 1 (M10): a microVM is shared with the
    // substrate's own agent, and sweeping everything would stop the thing holding the
    // channel open.
    const mine = new Set<number>();
    for (const pid of pids) if (await only(pid)) mine.add(pid);
    return mine;
  };

  const signal = (pids: Set<number>, sig: NodeJS.Signals) => {
    for (const pid of pids) {
      try {
        process.kill(pid, sig);
      } catch {
        // Already gone. Nothing to do.
      }
    }
  };

  let stopped = new Set<number>();
  // Bounded so a pathological forker cannot wedge the run; the exit is that a
  // pass adds nobody, which is the normal case on the first or second try.
  for (let pass = 0; pass < 16; pass++) {
    const now = await alive();
    signal(now, 'SIGSTOP');
    const fresh = [...now].filter((pid) => !stopped.has(pid));
    stopped = new Set([...stopped, ...now]);
    if (fresh.length === 0) break;
  }
  signal(await alive(), 'SIGKILL');
}

async function clearTheField(extra: string[] = [], evidence?: EvidenceStore): Promise<void> {
  if (process.pid !== 1) return;
  await reap();
  await scrub(extra, evidence);
}

/**
 * Every process owned by `uid`, for a machine we own but are not PID 1 of (M10).
 *
 * The PID-1 sweep above cannot run in a microVM: `/proc` there holds the substrate's own
 * agent, and SIGSTOPping it stops the channel this run reports on. The uid is the same
 * boundary one layer in — the repro and everything the agent started run as it, and the
 * Runner does not.
 *
 * Self and ancestors are excluded by pid rather than by uid, because a substrate may well
 * run OUR entrypoint as the same uid the repro drops to: on Vercel's managed images the
 * default user is 1000. Killing the Runner mid-teardown would end the run with the
 * evidence unflushed, which is the one outcome worse than a survivor.
 */
async function reapOwnedBy(uid: number): Promise<void> {
  const ancestors = new Set<number>([process.pid]);
  for (let pid = process.ppid; pid > 1; ) {
    ancestors.add(pid);
    const parent = await ownerAndParent(pid);
    if (!parent) break;
    pid = parent.ppid;
  }
  await reap(async (pid) => {
    if (ancestors.has(pid)) return false;
    const who = await ownerAndParent(pid);
    return who?.uid === uid;
  });
}

/** A process's real uid and parent, read out of `/proc`. Absent when it is already gone. */
async function ownerAndParent(pid: number): Promise<{ uid: number; ppid: number } | null> {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    // `Uid:` is real, effective, saved, filesystem — the first is the one that says who
    // started it, which is what the teardown is about.
    const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
    const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]);
    return Number.isInteger(uid) && Number.isInteger(ppid) ? { uid, ppid } : null;
  } catch {
    return null;
  }
}

/** The same teardown, on a machine this process is not PID 1 of (M10). */
async function clearTheFieldOwnedBy(
  uid: number,
  extra: string[] = [],
  evidence?: EvidenceStore,
): Promise<void> {
  await reapOwnedBy(uid);
  await scrub(extra, evidence);
}

/** Empty every directory a participant can write, and evict what it left in the store. */
async function scrub(extra: string[] = [], evidence?: EvidenceStore): Promise<void> {
  for (const dir of [...SHARED_WRITABLE, ...extra]) {
    // Defensive, and currently against an unreachable case: every parent of
    // every path in the list is root-owned 0755, so a participant cannot swap
    // one for a symlink. Kept because a root-privileged recursive delete that
    // follows links is how the host evidence store gets emptied, and the cost of
    // being wrong about "unreachable" here is every earlier run's artifacts.
    const kind = await lstat(dir).catch(() => null);
    if (!kind) continue;
    if (!kind.isDirectory()) {
      throw new ObservationFailed(
        `${dir} is not a directory; the phases' scratch space was replaced and cannot be scrubbed`,
      );
    }
    for (const entry of await readdir(dir)) {
      // A failure here is a failure to isolate, which is a failure to observe.
      // Swallowed, the fix phase silently inherits base-phase state and the run
      // is credited anyway.
      await rm(`${dir}/${entry}`, { recursive: true, force: true });
    }
  }
  await evidence?.evict();
}

/**
 * The evidence store is a writable directory shared by every participant, so it
 * is a channel like any other — and the worst-placed one, because a bind mount
 * does not honour container permissions and it OUTLIVES the run. State left
 * there reaches the next phase, the host, and every later run against the same
 * store.
 *
 * It cannot simply be emptied: that is where the evidence lives. But the Runner
 * writes nothing here until the final flush — every blob goes to root-owned
 * staging first — so anything that appears mid-run was put there by a
 * participant. Snapshot what was already present, and evict the rest.
 */
type EvidenceStore = { evict: () => Promise<void> };

async function guardEvidence(root: string): Promise<EvidenceStore> {
  // Recursive, because blobs live at `<ab>/<cd>/<rest>`. A depth-1 snapshot
  // protects a pre-existing NAME wholesale, so any store that has ever held an
  // artifact hands the participant a fanout directory that is never evicted —
  // and a fresh store is no better, since the sentinel can be turned into a
  // directory during the base phase and back into a file during the fix.
  const original = new Set(await listing(root));
  return {
    evict: async () => {
      // Deepest first, so removing a directory never invalidates a path still
      // to be examined.
      for (const path of (await listing(root)).sort().reverse()) {
        if (original.has(path)) continue;
        await rm(`${root}/${path}`, { recursive: true, force: true });
      }
    },
  };
}

/** Every path under `root`, relative, directories included. */
async function listing(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(`${root}/${prefix}`, { withFileTypes: true }).catch(() => []);
  const paths: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    paths.push(path);
    // `isDirectory()` on a Dirent is an lstat, so a symlink is never descended.
    if (entry.isDirectory()) paths.push(...(await listing(root, path)));
  }
  return paths;
}

/** Where an agent container leaves its commits. Mounted only for the agent step. */
const HANDOVER = '/out';
/**
 * Ceiling on the bundle. The agent chooses what it commits, so this is the one
 * place its output reaches host disk unbounded — a single enormous blob in a
 * commit would otherwise be copied out without anything looking at the size.
 */
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

/**
 * The one thing an agent is allowed to carry out of its container: commits.
 *
 * Its tree is discarded by design (ADR-0010) — not scrubbed, destroyed with the
 * container — so a reproduction or a fix it writes reaches the phases as a git
 * bundle or it does not reach them at all. A bundle is exactly the right shape:
 * it carries objects and refs and nothing else. No working tree, no untracked
 * files, no TMPDIR, no processes.
 *
 * Silently skipped when `/out` is not mounted, because a run that only wants the
 * transcript should not fail for want of somewhere to put code.
 */
async function handOverCommits(world: { tree: string; gitDir: string }): Promise<string | null> {
  const mounted = await stat(HANDOVER).then((s) => s.isDirectory()).catch(() => false);
  if (!mounted) return null;

  // The bundle is written by uid 1000 now, so the mount has to be reachable by
  // it. The host owns the directory and reads it afterwards; only this one file
  // is ever created here.
  await execFileAsync('chown', [`${REPRO_UID}:${REPRO_GID}`, HANDOVER]).catch(() => {});
  const bundle = `${HANDOVER}/agent.bundle`;
  // `/out` is agent-writable while the agent runs, and `git bundle create` takes
  // a lock at exactly `<bundle>.lock`. One line — `: > /out/agent.bundle.lock` —
  // made every subsequent bundle fail. Clearing both is safe here and only here:
  // the reap has already run, so nothing the agent started is still alive to
  // recreate them.
  await rm(`${bundle}.lock`, { recursive: true, force: true }).catch(() => {});
  await rm(bundle, { recursive: true, force: true }).catch(() => {});
  try {
    // `cwd` as well as GIT_DIR: `git bundle` refuses with "Need a repository"
    // when it is run from outside one, whatever the environment says. The tree
    // is uid-1000-owned and this runs as root, which is why it was already
    // marked `safe.directory`.
    // `HEAD`, not `--all`. `--all` carries refs/heads/*, and the agent's work
    // sits at HEAD — which on a fresh clone may be detached, so its commit was
    // in no branch at all and the bundle crossed carrying only what the clone
    // started with. The run then verified the repository's own fix commit and
    // called it the agent's.
    await execFileAsync('git', ['bundle', 'create', bundle, 'HEAD'], {
      cwd: world.tree,
      env: { ...process.env, GIT_DIR: world.gitDir, GIT_WORK_TREE: world.tree },
      // As the author, not as root. The author owns this git dir, so its config
      // is attacker-controlled — and `diff.external` and `core.fsmonitor` turn
      // an ordinary git command into arbitrary execution. Dropping privileges
      // makes that the author's own uid rather than root's.
      uid: REPRO_UID,
      gid: REPRO_GID,
    });
  } catch (error) {
    // git's own words, not a paraphrase. A wrapper that drops them turns a
    // one-line diagnosis into a debugging session — the mistake this codebase
    // has already made twice.
    // `||`, not `??`. `''.split('\n')[0]` is `''` — not nullish — so `??` never
    // fired and an error with no stderr produced a message ending in a colon.
    // The comment above this one calls that the mistake made twice already.
    const detail = (error as { stderr?: string }).stderr ?? '';
    // Reported, not thrown. Throwing here unwound above `flush()` and above the
    // loop that emits the transcript, so a failure to hand code over discarded
    // the transcript, `AGENT_FINISHED` — which ADR-0006 calls evidence, the
    // Runner having watched the process — and every staged blob, and ended the
    // run `errored`. The agent could trigger it at will, and ADR-0009 is explicit
    // that a status the agent can choose is not a status.
    //
    // A handover that did not happen is a fact ABOUT the agent. The orchestrator
    // finds no bundle, refuses, and records why; everything observed up to that
    // point survives, because a run that cannot be trusted is still a run that
    // observed things.
    return `could not bundle the agent commits: ${detail.trim().split('\n')[0] || String(error)}`;
  }

  const { size } = await stat(bundle);
  if (size > MAX_BUNDLE_BYTES) {
    await rm(bundle, { force: true });
    return `the agent's commits came to ${size} bytes, past the ${MAX_BUNDLE_BYTES} ceiling`;
  }
  // The host reads it; the agent user must not be able to rewrite it afterwards.
  await chmod(bundle, 0o444);
  return null;
}

/**
 * Install this repository's dependencies once, in a container the host commits
 * into the image the phases run from.
 *
 * Until this existed the engine could only certify repositories that needed no
 * dependencies. The phase containers replay nothing, hold no recipe and run
 * `--network none`; a dependency is a gitignored path, so it is not in the commit
 * they clone either. `npm test` there is exit 127, the output carries no symptom,
 * the fold refuses it and the reporter is told **we could not reproduce your
 * bug** — every step correct and the conclusion false, on every React or Next.js
 * repository this is aimed at.
 *
 * `install`, `migrate` and `seed` only, with `services: []`. A booted service is a
 * PROCESS and a process does not survive `docker commit`; replaying one here would
 * spend a healthcheck proving something that dies with this container. What crosses
 * into the phases is a filesystem, so only the half of the recipe that builds one
 * runs.
 *
 * Reports rather than throws, for the same reason `replayRecipe` does: a recipe
 * that does not build is an operational fault the host records as one. The host
 * ends the run `errored` on it and never silently falls back to a phase image with
 * nothing installed.
 */
async function buildEnvironment(job: Job, emit: (line: string) => void): Promise<number> {
  if (!job.recipe) {
    throw new ObservationFailed('an environment build arrived with no recipe; there is nothing to install');
  }
  await mkdir(ENV, { recursive: true });
  try {
    // `--` so a sourcePath cannot be read as an option, exactly as `world()` does:
    // `--upload-pack=…` and `ext::sh -c …` are both command execution.
    await execFileAsync('git', ['clone', '--quiet', '--no-local', '--', job.sourcePath, ENV_REPO]);
    // At BASE, not at whatever the source's HEAD happens to name. The dependency
    // tree has to be the one the base commit's manifest asks for, or every phase
    // judges a commit against another commit's `node_modules`.
    //
    // Which is also the limit of this: a fix that ADDS a dependency is judged
    // against base's tree and will not resolve it. The phases install nothing and
    // this does not change that — it moves the install to a container that runs
    // before them, and there is only one, from one commit.
    await execFileAsync('git', ['-C', ENV_REPO, 'checkout', '--quiet', '--detach', job.baseRef]);
  } catch (error) {
    throw new ObservationFailed(`could not clone ${job.sourcePath} to build the environment`, { cause: error });
  }

  // As root, and not as the repro user. Nothing untrusted runs in this container —
  // it exists before the agent does — and the phases receive these bytes through
  // `chown -R` on their own clone, so ownership here decides nothing downstream.
  // The recipe's configuration FIRST, so `TMPDIR` and `HOME` win on a collision — the
  // engine sets those for its own reasons and `parseRecipe` refuses a recipe that tries
  // to (M10). A project whose `install` reads `NPM_CONFIG_REGISTRY` or whose `migrate`
  // reads `DATABASE_URL` gets them here, in the one container that has a network.
  const host = new ToolHost({
    root: ENV_REPO,
    gitDir: `${ENV_REPO}/.git`,
    env: { ...job.recipe.env, TMPDIR: '/tmp', HOME: '/root' },
  });
  let env: ReplayOutcome;
  try {
    env = await replayRecipe(host, { ...job.recipe, services: [] });
  } finally {
    await host.close();
  }

  // Only over a world worth keeping. A failed install leaves a half-written
  // dependency tree, and a manifest over that would hardlink it into every phase
  // and present it as the environment.
  if (env.ready) await recordIgnored();
  // On the channel as a REPORT, exactly as the agent container's replay is: this
  // container writes no events, and the host is the only thing that can allocate a
  // seq (ADR-0006's amendment).
  emit(`${JSON.stringify({ env } satisfies WorkerReply)}\n`);
  return EXIT.complete;
}

/**
 * What the install actually wrote, as git sees it.
 *
 * The IGNORED set rather than a hard-coded `node_modules`: dependencies live
 * wherever an ecosystem puts them — `vendor/`, `.venv`, `target/`, `.next/` — and
 * the one authority on which paths those are is the `.gitignore` the repository
 * ships. It is also exactly the set the phase clone cannot obtain for itself,
 * since ignored paths are not in the commit.
 *
 * `core.quotePath=false`, or a non-ASCII path arrives as git's octal escape and
 * the restore looks for a file whose name is the escape.
 */
async function recordIgnored(): Promise<void> {
  const { stdout } = await execFileAsync('git', [
    '-C', ENV_REPO, '-c', 'core.quotePath=false', 'status', '--ignored', '--porcelain',
  ]);
  const ignored = stdout.split('\n').filter((line) => line.startsWith('!! ')).map((line) => line.slice(3));
  await writeFile(ENV_IGNORED, ignored.map((path) => `${path}\n`).join(''));
}

/**
 * Put the built environment into a fresh clone, before anything runs in it.
 *
 * A no-op in every container that runs from the plain sandbox image — the manifest
 * exists only in the committed snapshot, which only the judging containers run
 * from. That is what keeps the agent's world free of it: the agent replays the
 * recipe itself.
 *
 * `cp -al`. One filesystem, so a dependency tree costs directory entries rather
 * than a copy of `node_modules` per phase.
 *
 * Per CLONE, and deliberately not after the phase-boundary scrub. `git clean -xdff`
 * between base and fix exists to stop base leaving state the fix run reads, and
 * restoring after it would hand back the very thing it removed. A container per
 * phase is what makes both true at once: each phase gets the environment from the
 * image, and nothing at all from the other phase.
 *
 * A path that will not restore is skipped. These bytes are a convenience the
 * reproduction may not even need, and losing a run over one unlinkable directory
 * would trade a verdict for tidiness.
 */
async function restoreEnvironment(tree: string): Promise<void> {
  const manifest = await readFile(ENV_IGNORED, 'utf8').catch(() => null);
  if (manifest === null) return;
  for (const line of manifest.split('\n')) {
    if (line.trim() === '') continue;
    try {
      // Confined like any other path the engine did not construct. It came out of
      // git rather than out of an agent, but the check costs nothing and `.git` is
      // among the things it refuses — a restore into the phases' own git state
      // would be a hook the Runner then executes.
      const { rel, target } = await confine(tree, line, { subject: 'ignored path' });
      await mkdir(dirname(target), { recursive: true });
      await execFileAsync('cp', ['-al', `${ENV_REPO}/${rel}`, target]);
    } catch {
      // Skipped, and the phase runs without it. See above.
    }
  }
}

/**
 * Execute the host's tool calls until it says it is finished.
 *
 * One at a time, in arrival order. The model's loop is sequential by construction
 * — it waits for each result before deciding the next call — so concurrency here
 * would buy nothing and would make two `shell_write`s into one session a race.
 *
 * A tool that throws is answered, never rethrown: `ToolHost.run` already turns
 * every failure into a result, and a serving loop that dies on a bad call hands
 * the agent a way to end its own run.
 */
async function serveToolCalls(
  host: ToolHost,
  requests: AsyncIterable<string>,
  emit: (line: string) => void,
): Promise<void> {
  for await (const line of requests) {
    let request: WorkerRequest;
    try {
      request = JSON.parse(line) as WorkerRequest;
    } catch {
      continue; // Not ours. The host is the only writer on this pipe; ignore noise.
    }
    if ('done' in request) return;
    if (!('call' in request)) continue;
    const result = await host.run(request.call);
    emit(`${JSON.stringify({ result } satisfies WorkerReply)}\n`);
  }
}

/**
 * The stdio protocol, when the host drives the tools from outside (ADR-0011).
 *
 * The worker "dials out" and nothing dials in: with `--network none` there is no
 * interface to listen on, and the pipe the host already holds to this container's
 * stdin and stdout is the only channel. That is not a workaround for the seal —
 * it is why the seal costs nothing.
 *
 * Deliberately three message shapes and no framing beyond one JSON object per
 * line, matching the event channel. A protocol with a length prefix would be a
 * second parser to get wrong.
 */
export type WorkerRequest =
  | { call: { id: string; tool: string; input: Record<string, unknown> } }
  | { done: true };

export type WorkerReply =
  /**
   * What the Runner observed while replaying the recipe. Sent before `ready`, so the
   * host can emit `ENV_READY` — or refuse to spend a loop on a world that never came
   * up — before any transcript event exists.
   *
   * A REPORT rather than an event for the same reason the handover is: in this mode
   * the container is not a writer, and the host is the only thing that can allocate
   * a seq.
   */
  | { env: ReplayOutcome }
  /** The world is as built as it is going to get, and the tools will answer. */
  | { ready: true }
  | { result: { id: string; ok: boolean; output: string } }
  /**
   * Setup, and then teardown, as the Runner observed them — never as events.
   * `handover` is null when the commits were bundled, and prose when they were
   * not; the HOST turns that into a VERIFICATION_ABORTED, because in this mode the
   * host is the only writer there is.
   */
  | { finished: { handover: string | null } }
  /**
   * What the project's own test command did in a phase's world (8b). A report,
   * never an event, for the same reason `env` is one.
   */
  | { suite: SuiteProbe };

/**
 * The probe's answer. `failed` when the command could not be OBSERVED at all —
 * it never started, it overflowed, it exceeded the ceiling — which must never be
 * collapsed into an exit code, because "we could not watch it" and "it exited 1"
 * are the two things this project works hardest to keep apart.
 */
export type SuiteProbe = { exit_code: number; output: string } | { failed: string };

export const isWorkerReply = (line: unknown): line is WorkerReply =>
  typeof line === 'object' &&
  line !== null &&
  ('ready' in line || 'result' in line || 'finished' in line || 'env' in line || 'suite' in line);

/** One JSON object per line, and a trailing fragment at EOF is a whole line. */
async function* readLines(stream: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk.toString();
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() !== '') yield line;
      newline = buffer.indexOf('\n');
    }
  }
  // The Job has historically arrived with no trailing newline — `stdin.end(json)`
  // — and still may. At EOF the remainder is a complete line by definition.
  if (buffer.trim() !== '') yield buffer;
}

/** The tail the host is handed. The failure is at the end, and a suite can be enormous. */
const PROBE_OUTPUT_CHARS = 8 * 1024;

/**
 * Run the project's own test command in a phase's world and say what happened.
 *
 * The executor is `verify`'s own — imported rather than reimplemented, because the
 * probe's whole value is that it is not an approximation. Milestone 7's first
 * defect was a recipe step that succeeded as root in the environment build and
 * failed as uid 1000 in the agent sandbox: a probe that ran anywhere but here, as
 * anyone but this uid, would answer a different question and read as though it had
 * answered this one.
 *
 * Never throws. A command that could not be observed is reported as prose — the
 * caller turns it into "do not imitate this", which is the true thing to say, and
 * an exception here would end a run over a question that was only ever advisory.
 */
async function probeSuite(
  job: Job,
  world: { tree: string; gitDir: string; env: Env },
  runAs: { uid: number; gid: number },
): Promise<SuiteProbe> {
  const command = job.suiteCommand;
  if (command === undefined) return { failed: 'no test command was given to run' };
  try {
    // AT THE BASE COMMIT. `world()` leaves the clone on the mirror's default HEAD,
    // which on any repository under judgement is the commit the fix is on — so
    // without this the probe would answer for the wrong tree, and answer
    // confidently. GIT_DIR is passed for the same reason `verify` passes it: git's
    // state is outside the worktree here.
    await execFileAsync('git', ['checkout', '--quiet', '--force', job.baseRef], {
      env: { ...process.env, GIT_DIR: world.gitDir, GIT_WORK_TREE: world.tree },
    });
    const observed = await observeCommand(
      command,
      world.tree,
      job.timeoutMs ?? 120_000,
      MAX_OUTPUT_BYTES,
      runAs,
      world.env,
    );
    return {
      exit_code: observed.exitCode,
      output: observed.output.slice(-PROBE_OUTPUT_CHARS),
    };
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * How this Runner is placed on the machine it is running on (M10).
 *
 * Absent, it is Docker's: PID 1 in a container of our own, with a bind-mounted store.
 * Present, it is a microVM's — see `src/runner-vm.ts`, which is the only caller that
 * sets either field.
 */
export type RunJobOptions =
  /** Docker's: PID 1 in a container of our own, with a bind-mounted store. */
  | { store?: 'mounted'; field?: never }
  /**
   * A microVM's. `field` is REQUIRED here, and the union is how: with a store this
   * process does not own outright and no uid to reap, `clearTheField` returns early
   * (not PID 1) and nothing else runs — so the agent's backgrounded processes would
   * survive into the base phase and the run would report success anyway. That is
   * ADR-0010's red-then-green flip, arrived at by an omission the type now refuses.
   */
  | { store: 'collected'; field: { uid: number } };

export async function runJob(
  job: Job,
  workDir = WORK,
  blobRoot = BLOBS,
  emit: (line: string) => void = (line) => process.stdout.write(line),
  /** Tool calls from the host, when the loop is out there. Required by `serveTools`. */
  requests?: AsyncIterable<string>,
  options: RunJobOptions = {},
): Promise<number> {
  // Git's own state lives outside every worktree. Inside one, the repro owns
  // .git and plants a post-checkout hook that `git clean` never descends into,
  // which the Runner then executes as root — so uid 1000 was never the boundary
  // it looked like. GIT_DIR is passed explicitly so git never consults the
  // `.git` file left in the worktree either.

  // The environment build, before anything else and before the store check below.
  // It produces no facts — no phase, no reproduction, no event — so demanding
  // somewhere durable to put them would be demanding a mount for a stream that
  // does not exist. What it produces is a filesystem the host commits into an
  // image.
  if (job.only === 'env') return await buildEnvironment(job, emit);

  // Refuse rather than silently write into the container layer. Without the
  // mount the run still produces a complete, plausible event stream whose
  // artifacts die with --rm — the exact failure this is here to prevent, only
  // invisible.
  const store = options.store ?? 'mounted';
  if (!(await storeWillOutliveThis(blobRoot, store))) {
    throw new ObservationFailed(
      store === 'mounted'
        ? `${blobRoot} is not a host store (mount it and leave a ${SENTINEL} file); ` +
          'the evidence would not survive the container'
        : `${blobRoot} is not an evidence store (create it and leave a ${SENTINEL} file); ` +
          'there would be nothing here for the worker to collect',
    );
  }

  // Blobs are written here first, in the container layer, root-owned 0700.
  // /blobs is a bind mount, and a bind mount does not honour those permissions —
  // Docker Desktop ignores them outright, and on Linux the host uid is commonly
  // 1000, the very uid the repro runs as. Left there during the run, the repro
  // could delete artifacts the base phase had already banked and the stream
  // would still come out clean and complete.
  // Before anything else runs: what was already in the store is evidence from
  // earlier runs, and everything that appears from here is a participant's doing.
  const evidence = await guardEvidence(blobRoot);

  /**
   * Move the run's artifacts into the mounted store, once, after the last repro
   * has run. Extracted because an agent-only container has to do it too and has
   * no phases to reach the old inline copy.
   */
  const flush = async () => {
    // The boundary evicts protect the fix phase from the base phase, but the
    // LAST phase has no boundary after it — without this its plants ride out to
    // the host store and wait there for the next run against it.
    await evidence.evict();
    const owner = await stat(blobRoot);
    try {
      // No shell: `cp` takes its arguments directly, so nothing here can be read
      // as syntax. Ownership follows the host directory, or a non-root host user
      // cannot clean up what root wrote.
      await execFileAsync('cp', ['-a', `${staging}/.`, blobRoot]);
      await execFileAsync('chown', ['-R', `${owner.uid}:${owner.gid}`, blobRoot]);
      // The repro can delete the sentinel mid-run, which would brick this store
      // for the next run against it. Restore it rather than leave a footgun.
      await writeFile(`${blobRoot}/${SENTINEL}`, '');
    } catch (error) {
      // Failing to persist the evidence is a failure to OBSERVE, not a broken
      // Runner. Fail-closed: this runs before any event is emitted, so a flush
      // failure kills the whole stream.
      throw new ObservationFailed(`could not persist the evidence to ${blobRoot}`, { cause: error });
    }
  };

  const staging = `${workDir}/staging`;
  await mkdir(staging, { recursive: true });
  await chmod(staging, 0o700);

  // Clone rather than work in the mounted directory. The mount is the host's
  // tree; verifying in place would put host state inside the evidence and let
  // the run write back out through it.
  // `--` so a sourcePath cannot be read as an option: `--upload-pack=…` and
  // `ext::sh -c …` are both command execution.
  // Standing the sandbox up is not the Runner working correctly or incorrectly —
  // it is the difference between being able to look and not. An unreachable
  // sourcePath or a chown that fails is exactly as much a failure to observe as a
  // repro that times out, and reporting it as a Runner bug sends whoever reads
  // the exit code to the wrong place entirely.
  const setUp = async (what: string, run: Promise<unknown>) => {
    try {
      await run;
    } catch (error) {
      throw new ObservationFailed(`could not ${what}`, { cause: error });
    }
  };

  // The repro runs as this user, not as the Runner. Root in the Runner's own
  // namespace can reach the event channel through /proc/1/fd/N whatever the
  // Runner does with its own descriptors.
  const runAs = { uid: REPRO_UID, gid: REPRO_GID };

  /**
   * A private world for one participant: its own tree, its own TMPDIR, its own
   * HOME — and, for an author, its own git dir.
   *
   * The phases must NOT own their git dir: a repro that owns it plants
   * `hooks/post-checkout` and the Runner executes it as root on the next
   * checkout, which is the hole `--separate-git-dir` was introduced to close.
   * But an AUTHOR has to write objects to commit at all, and withholding the
   * git dir left the agent unable to commit — silently, since a failed commit
   * just means the bundle carries what the clone started with, and the run then
   * verified the repository's own commit believing it was the agent's.
   *
   * Safe for the author because nothing root-privileged ever runs git against
   * that world afterwards: the only command is `git bundle`, and it runs as the
   * author's own uid precisely so a `.git/config` carrying `diff.external` or
   * `core.fsmonitor` executes as uid 1000 rather than as root.
   */
  const world = async (name: string, authors = false) => {
    const root = `${workDir}/${name}`;
    const tree = `${root}/repo`;
    const tmp = `${root}/tmp`;
    const home = `${root}/home`;
    await mkdir(tmp, { recursive: true });
    await mkdir(home, { recursive: true });
    await setUp(
      `clone ${job.sourcePath} for ${name}`,
      // `--` so a sourcePath cannot be read as an option: `--upload-pack=…` and
      // `ext::sh -c …` are both command execution.
      execFileAsync('git', [
        'clone', '--quiet', '--no-local', `--separate-git-dir=${root}/gitdir`, '--',
        job.sourcePath, tree,
      ]),
    );
    // The environment, hardlinked in from the snapshot image if this container is
    // running from one — BEFORE the chown, so the dependency tree is handed to the
    // repro user with the rest of the tree. Restored after it, `node_modules` would
    // be root-owned inside a tree the repro's own commands have to be able to write.
    await restoreEnvironment(tree);
    // The worktree, the temp dir and the home dir. NOT the root, and above all
    // not the gitdir under it — an earlier version of this chowned `${root}`
    // wholesale, which handed the repro `gitdir/hooks/post-checkout` and had the
    // Runner execute it as root on the next checkout. That is the exact hole
    // `--separate-git-dir` was introduced to close, reopened by a refactor that
    // looked like tidying.
    for (const path of authors ? [tree, tmp, home, `${root}/gitdir`] : [tree, tmp, home]) {
      await setUp(
        `hand ${name}'s ${basename(path)} to the repro user`,
        execFileAsync('chown', ['-R', `${REPRO_UID}:${REPRO_GID}`, path]),
      );
    }
    // The Runner stays root, so git now sees a tree owned by someone else and
    // refuses it as "dubious ownership". Scoped to this path, inside a container
    // built for exactly one run.
    await setUp(
      `mark ${name} safe for git`,
      execFileAsync('git', ['config', '--global', '--add', 'safe.directory', tree]),
    );
    // Same order, same reason: the recipe's configuration, then the two names the engine
    // owns. This env reaches the agent's shells, the recipe replay in the agent sandbox,
    // and — through `runEnv` — every command a phase container judges, which is the point:
    // a project that needs `PORT` to boot needs it to be reproduced, too.
    return { tree, gitDir: `${root}/gitdir`, env: { ...job.recipe?.env, TMPDIR: tmp, HOME: home } };
  };

  // The agent goes first and gets its own seq range, so the log reads in the
  // order things happened: it says its piece, and only then does the engine
  // start observing. Its events are testimony and are emitted alongside the
  // evidence, never mixed into it (ADR-0006).
  //
  // It runs as the repro user for the same reason the repro does — root in this
  // PID namespace could open the event channel through /proc/1/fd/N.
  //
  // And it gets its OWN world. Anchoring the reproduction fixes what runs; it
  // says nothing about the world it runs in. Sharing a filesystem with the
  // phases, the agent needs no forged event to fabricate a verdict: it seeds
  // state a test reads — a gitignored directory the phase scrub deliberately
  // spares, $HOME, or a temp dir — and the test goes red then green while the
  // "fix" changes nothing. Every anti-gaming check still passes, because not one
  // of them is about the environment. So the trees are separate clones, the
  // verification tree is made only after the agent is finished, and neither
  // TMPDIR nor HOME is shared. Separation is not the whole answer, though —
  // `clearTheField` below is, because a process that outlives the agent runs as
  // the same uid and can write the phases' private directories anyway.
  const agentWorld = job.agentPrompt || job.serveTools ? await world('agent', true) : null;
  // Set when the host drove the tools from outside, so the teardown below reports
  // the handover on the channel instead of writing an event: in that mode this
  // container is not a writer (ADR-0006's amendment) and must not look like one.
  // The registered reproduction, placed in the FIX agent's tree.
  //
  // `prompts/fix.md` already told the agent "run the registered command yourself — you
  // have exactly the command above" and "the engine writes its own copy of them over your
  // commit". Neither was true: the fix agent's world is a clone of base and nothing put
  // the reproduction in it. The first real run that got this far did the only rational
  // thing — read the file, found it absent, WROTE ITS OWN COPY so it could run the
  // command, and committed it. `verify` then refused the whole run, correctly: a repro
  // path tracked in the fix commit means the agent may have rewritten the test it is
  // judged by.
  //
  // So the engine supplies the bytes it registered, and the paths go into
  // `info/exclude` so `git add -A` cannot stage them. That is deliberately not a filter
  // inside one tool: the agent commits through the shell too (the repro agent did), and
  // an exclusion that is a property of the CLONE holds for every git invocation in it
  // rather than only the one we remembered to guard.
  //
  // `verify`'s refusal stays exactly as it is. This removes the reason an honest agent
  // trips it; it does not soften what happens when one does.
  if (agentWorld && job.repro?.files && Object.keys(job.repro.files).length > 0) {
    for (const [input, content] of Object.entries(job.repro.files)) {
      // The manifest is the agent's own text, so containment first — a path from a
      // reproduction is exactly as untrusted as a path from a tool call.
      const { target, rel } = await confine(agentWorld.tree, input, { subject: 'repro path' });
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      await appendFile(`${agentWorld.gitDir}/info/exclude`, `/${rel}\n`).catch(async () => {
        await mkdir(`${agentWorld.gitDir}/info`, { recursive: true });
        await appendFile(`${agentWorld.gitDir}/info/exclude`, `/${rel}\n`);
      });
    }
  }

  let served: ToolHost | null = null;
  const transcript: RunEvent[] = [];
  if (agentWorld && job.serveTools) {
    if (!requests) {
      throw new ObservationFailed('serveTools was set with no request stream; nothing would drive the tools');
    }
    served = new ToolHost({
      root: agentWorld.tree,
      gitDir: agentWorld.gitDir,
      runAs,
      env: agentWorld.env,
      // STAGING, not `/blobs`. A screenshot is banked the moment it is taken, and it
      // must not be visible to another participant or to the host until the final
      // flush — the same rule every other artifact follows (ADR-0010).
      blobRoot: staging,
    });
    // The recipe, replayed, before the agent can touch anything. A service lives in
    // a NAMED SESSION this ToolHost started and holds a handle to (ADR-0014), so it
    // is still up when the agent arrives and it is torn down by `close()` rather
    // than discovered in /proc.
    //
    // Reported whatever happened. A recipe that does not boot is an operational
    // fault for the host to record as one — not an exception that unwinds a run and
    // certainly not a finding about the user's bug.
    if (job.recipe) {
      const env = await replayRecipe(served, job.recipe);
      emit(`${JSON.stringify({ env } satisfies WorkerReply)}\n`);
    }
    // Announced only once the world exists. The host blocks on this rather than
    // guessing: a tool call that arrives before the clone lands would be refused
    // for a path that is about to exist, and the model would plan around a lie.
    emit(`${JSON.stringify({ ready: true } satisfies WorkerReply)}\n`);
    await serveToolCalls(served, requests, emit);
  } else if (agentWorld) {
    transcript.push(
      ...(await superviseAgent({
        runId: job.runId,
        afterSeq: job.afterSeq,
        prompt: job.agentPrompt!,
        cwd: agentWorld.tree,
        blobRoot: staging,
        runAs,
        env: agentWorld.env,
        ...(job.agentTimeoutMs === undefined ? {} : { timeoutMs: job.agentTimeoutMs }),
      })),
    );
  }

  // Nothing the agent started may still be running when the phases begin, and
  // nothing it left in a shared directory may still be there.
  if (agentWorld) {
    // Sessions first, and by handle. ADR-0014's part one: a service the recipe
    // declared lives in a session this process started and holds, so teardown
    // closes what it owns instead of discovering it in `/proc`. The reap below
    // stays — demoted to belt-and-braces, and still the only thing that reaches a
    // process no session ever knew about.
    await served?.close();
    // Reap FIRST, then extract, then destroy. Bundling before the reap left the
    // agent's surviving processes alive and owning the finished bundle: one
    // could wait for it, chmod it back and overwrite it with a bundle of a
    // different commit, and that commit is what got verified. `chmod 0444`
    // cannot stop a file's own owner, and a bind mount does not carry the mode
    // to the host anyway.
    // The caller says which machine this is, and only one teardown runs. Calling both
    // would mean a substrate that happened to start us as PID 1 got the unfiltered
    // `/proc` sweep — which would SIGSTOP its own agent, the one thing `reapOwnedBy`
    // exists to avoid.
    if (options.field) await clearTheFieldOwnedBy(options.field.uid, [], evidence);
    else await clearTheField([], evidence);
    // Recorded as an event, not written to a stream nothing folds. The size
    // ceiling and a failed bundle used to reach only `process.stderr`, which the
    // orchestrator keeps on `PhaseResult.stderr` and never persists — so the
    // IMMUTABLE LOG stated `no bundle was left at the handover path`, a false
    // cause, while the true one lived somewhere no projection reads. The Runner
    // is the sole event writer and is standing right here.
    const failed = await handOverCommits(agentWorld);
    if (served) {
      // On the channel, as a report. The host is the sole writer in this mode, so
      // an event here would be exactly the second producer ADR-0009 warns about —
      // and the host cannot know the seq this container would have used anyway.
      emit(`${JSON.stringify({ finished: { handover: failed } } satisfies WorkerReply)}\n`);
    } else if (failed) {
      transcript.push({
        run_id: job.runId,
        seq: (transcript.at(-1)?.seq ?? job.afterSeq) + 1,
        ts: new Date().toISOString(),
        type: 'VERIFICATION_ABORTED',
        payload: {
          v: 1,
          phase: 'setup',
          cause: 'handover',
          reason: failed.slice(0, MAX_REASON_CHARS),
        },
      });
    }
    // The agent's world is discarded outright, not scrubbed. ADR-0010 already
    // says its tree does not survive — but the tree, TMPDIR and HOME are all
    // uid-1000-owned, so leaving them standing lets the BASE phase write there
    // and the fix phase read it back. Nothing downstream wants any of it.
    await rm(`${workDir}/agent`, { recursive: true, force: true });
  }

  // Cloned now, not earlier: a tree that existed while the agent ran is a tree
  // the agent could have written to.
  const phases = await world('verify');

  // An agent-only container observes nothing. Without this it ran the agent AND
  // both phases, so the fix phase started on the very machine the agent had just
  // been working in — the exact opposite of what per-participant containers are
  // for, and invisible because the fold's extra registrations made the verdict
  // stricter rather than wrong.
  if (job.only === 'agent') {
    await flush();
    for (const event of transcript) emit(`${JSON.stringify(event)}\n`);
    return EXIT.complete;
  }

  // The sealed-world probe (8b). It runs in the world `world('verify')` just built
  // — the phases' clone, their restored dependencies, their uid, their seal — which
  // is the entire content of its claim: not "this command works somewhere", but
  // "this command works where your reproduction will be judged".
  //
  // It ends the container. Nothing is folded, nothing is emitted, and the only
  // thing that leaves is one reply line.
  if (job.only === 'suite') {
    emit(`${JSON.stringify({ suite: await probeSuite(job, phases, runAs) } satisfies WorkerReply)}\n`);
    await flush();
    return EXIT.complete;
  }

  let events: RunEvent[];
  // A run that could not be observed to the end is still a run that observed
  // things. Losing the base phase because the fix phase died would leave no
  // record at all of the one part that worked — so the partial stream goes out,
  // closed by the VERIFICATION_ABORTED that says where it stopped.
  let exitCode: number = EXIT.complete;
  try {
    events = await verify({
      runId: job.runId,
      // Continue the log rather than restart it: the engine's first event must
      // not collide with the last thing the agent said.
      afterSeq: transcript.at(-1)?.seq ?? job.afterSeq,
      repoPath: phases.tree,
      baseRef: job.baseRef,
      fixRef: job.fixRef,
      repro: job.repro,
      symptomPattern: new RegExp(job.symptomPattern),
      blobRoot: staging,
      gitEnv: { GIT_DIR: phases.gitDir, GIT_WORK_TREE: phases.tree },
      runAs,
      runEnv: phases.env,
      // Base and fix share one world by design — they must, to switch commits in
      // one tree — so the boundary between them needs everything the agent
      // boundary got, not a subset of it. A repro that merely behaves
      // differently the second time is otherwise red once and green afterwards,
      // and nothing about the fix has to change; and a process the BASE phase
      // backgrounds is the same attack again, which no amount of directory
      // scrubbing reaches.
      onPhaseBoundary: async () => {
        const extra = [phases.env.TMPDIR, phases.env.HOME];
        if (options.field) await clearTheFieldOwnedBy(options.field.uid, extra, evidence);
        else await clearTheField(extra, evidence);
      },
      ...(job.only === undefined ? {} : { only: job.only }),
      ...(job.flakeRuns === undefined ? {} : { flakeRuns: job.flakeRuns }),
      ...(job.baseRuns === undefined ? {} : { baseRuns: job.baseRuns }),
      ...(job.suiteCommand === undefined ? {} : { suiteCommand: job.suiteCommand }),
      ...(job.controlRun === undefined ? {} : { controlRun: job.controlRun }),
      ...(job.timeoutMs === undefined ? {} : { timeoutMs: job.timeoutMs }),
    });
  } catch (error) {
    // `verify()` always attaches at least its own VERIFICATION_ABORTED, so today
    // the length check cannot fire. It is kept because the whole partial/silent
    // split rests on setup failures being thrown ABOVE this try: move one inside
    // and the run would emit an empty stream with exit 2, telling a caller to
    // fold nothing — and `fold()` throws on an empty stream.
    if (!(error instanceof ObservationFailed) || error.observed.length === 0) throw error;
    events = error.observed;
    exitCode = EXIT.partial;
  }

  await flush();

  // One event per line: the channel is append-only in shape as well as intent,
  // and a consumer can fold it as it arrives without waiting for the run to end.
  // JSON.stringify is what makes the agent unable to forge a sibling event: a
  // message shaped like a RunEvent was already put inside a string field, and
  // this escapes it rather than letting it out onto its own line.
  for (const event of [...transcript, ...events]) emit(`${JSON.stringify(event)}\n`);
  return exitCode;
}

// Only run when executed directly, so the tests can import runJob.
if (process.argv[1]?.endsWith('runner.ts') || process.argv[1]?.endsWith('runner.js')) {
  // The repro runs as root in this PID namespace, so `/proc/1/fd/1` is reachable
  // — and that file *is* the event channel. An agent could write straight onto
  // it: forged events, and a write without a trailing newline concatenates onto
  // the next real one and destroys REPRO_REGISTERED, the anchor everything else
  // rests on. So take a private handle on the real stdout and leave fd 1 as a
  // dead end. The agent must never be able to append (ADR-0006).
  const channel = openSync('/proc/self/fd/1', 'w');
  closeSync(1);
  openSync('/dev/null', 'w'); // reuses fd 1, so /proc/1/fd/1 now goes nowhere

  try {
    // Line by line now, not drained to EOF. The Job is the FIRST line and the
    // stream stays open, because with the loop outside the container the host
    // keeps writing tool calls down the same pipe — and a `readStdin()` that
    // waits for EOF would deadlock against a host waiting for a result.
    //
    // A Job written with no trailing newline still arrives whole: `readLines`
    // yields the remainder at EOF, which is what every existing caller does.
    const stdin = readLines(process.stdin);
    const first = await stdin.next();
    if (first.done) throw new ObservationFailed('no job arrived on stdin');
    const job = JSON.parse(first.value) as Job;
    // Set the code, never call process.exit: stdout on a pipe is asynchronous,
    // and exiting discards whatever is still queued. A large FIX_DIFF_OBSERVED
    // was being cut mid-JSON while the run reported success — silent evidence
    // loss presented as a clean record, which is the worst failure this project
    // has.
    process.exitCode = await runJob(job, WORK, BLOBS, (line) => writeSync(channel, line), stdin);
  } catch (error) {
    // A failure to observe is not a verification result. It leaves on stderr so
    // it can never be mistaken for an event on the channel.
    const failed = error instanceof ObservationFailed;
    process.stderr.write(`${failed ? 'ObservationFailed' : 'RunnerError'}: ${String(error)}\n`);
    // Nothing reached the channel on this path — a flush that failed takes the
    // whole stream with it, deliberately, since refs nothing can resolve are
    // worse than no refs. `silent`, not `partial`: there is nothing to fold.
    process.exitCode = failed ? EXIT.silent : EXIT.bug;
  }
}
