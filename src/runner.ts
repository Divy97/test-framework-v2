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
import { chmod, lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import type { RunEvent } from './events.js';
import { superviseAgent } from './agent.js';
import { ObservationFailed, verify, type ReproSpec } from './verify.js';

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
   * Observe one phase and stop. Omitted, this container runs the whole run, as
   * M3 did.
   *
   * With it, the host runs a container per phase and nothing is shared between
   * them — no tree, no TMPDIR, no HOME, no surviving process, no `/blobs` window
   * between phases. Every channel ADR-0010 enumerates comes from base and fix
   * sharing a machine; this removes the sharing rather than scrubbing it, which
   * is the only move here that has not needed a follow-up fix.
   */
  only?: 'base' | 'fix';
  flakeRuns?: number;
  timeoutMs?: number;
};

const WORK = '/work';
/**
 * Where the evidence lands. A Runner constant, never a Job field: a
 * caller-supplied path could aim the blob writes at the repo or the read-only
 * source mount.
 */
const BLOBS = '/blobs';
/** Matches the `repro` user created in the Dockerfile. */
const REPRO_UID = 1000;
const REPRO_GID = 1000;

/**
 * What the exit status tells a caller, and specifically whether there is
 * anything on the channel worth reading.
 *
 * `partial` and `silent` were one code until a stream could survive an abort.
 * They demand opposite things — fold the channel, or ignore it and read stderr —
 * so collapsing them would leave a caller unable to tell evidence from nothing.
 */
const EXIT = {
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

async function hostStoreIsMounted(path: string): Promise<boolean> {
  try {
    const [here, root] = await Promise.all([stat(path), stat('/')]);
    if (here.dev === root.dev) return false;
    await stat(`${path}/${SENTINEL}`);
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
async function reap(): Promise<void> {
  const alive = async () => {
    const pids = (await readdir('/proc'))
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 1);
    return new Set(pids);
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

export async function runJob(
  job: Job,
  workDir = WORK,
  blobRoot = BLOBS,
  emit: (line: string) => void = (line) => process.stdout.write(line),
): Promise<number> {
  // Git's own state lives outside every worktree. Inside one, the repro owns
  // .git and plants a post-checkout hook that `git clean` never descends into,
  // which the Runner then executes as root — so uid 1000 was never the boundary
  // it looked like. GIT_DIR is passed explicitly so git never consults the
  // `.git` file left in the worktree either.

  // Refuse rather than silently write into the container layer. Without the
  // mount the run still produces a complete, plausible event stream whose
  // artifacts die with --rm — the exact failure this is here to prevent, only
  // invisible.
  if (!(await hostStoreIsMounted(blobRoot))) {
    throw new ObservationFailed(
      `${blobRoot} is not a host store (mount it and leave a ${SENTINEL} file); ` +
        'the evidence would not survive the container',
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

  /** A private world for one participant: its own tree, its own TMPDIR, its own HOME. */
  const world = async (name: string) => {
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
    // The worktree, the temp dir and the home dir. NOT the root, and above all
    // not the gitdir under it — an earlier version of this chowned `${root}`
    // wholesale, which handed the repro `gitdir/hooks/post-checkout` and had the
    // Runner execute it as root on the next checkout. That is the exact hole
    // `--separate-git-dir` was introduced to close, reopened by a refactor that
    // looked like tidying.
    for (const path of [tree, tmp, home]) {
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
    return { tree, gitDir: `${root}/gitdir`, env: { TMPDIR: tmp, HOME: home } };
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
  const agentWorld = job.agentPrompt ? await world('agent') : null;
  const transcript = agentWorld
    ? await superviseAgent({
        runId: job.runId,
        afterSeq: job.afterSeq,
        prompt: job.agentPrompt!,
        cwd: agentWorld.tree,
        blobRoot: staging,
        runAs,
        env: agentWorld.env,
        ...(job.agentTimeoutMs === undefined ? {} : { timeoutMs: job.agentTimeoutMs }),
      })
    : [];

  // Nothing the agent started may still be running when the phases begin, and
  // nothing it left in a shared directory may still be there.
  if (agentWorld) {
    await clearTheField([], evidence);
    // The agent's world is discarded outright, not scrubbed. ADR-0010 already
    // says its tree does not survive — but the tree, TMPDIR and HOME are all
    // uid-1000-owned, so leaving them standing lets the BASE phase write there
    // and the fix phase read it back. Nothing downstream wants any of it.
    await rm(`${workDir}/agent`, { recursive: true, force: true });
  }

  // Cloned now, not earlier: a tree that existed while the agent ran is a tree
  // the agent could have written to.
  const phases = await world('verify');

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
      onPhaseBoundary: () => clearTheField([phases.env.TMPDIR, phases.env.HOME], evidence),
      ...(job.only === undefined ? {} : { only: job.only }),
      ...(job.flakeRuns === undefined ? {} : { flakeRuns: job.flakeRuns }),
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

  // The repro has run for the last time, so the evidence can cross into the
  // shared mount now. Ownership follows the host directory, or a non-root host
  // user cannot clean up what root wrote.
  // Once more before the evidence crosses. The boundary evicts protect the fix
  // phase from the base phase, but the LAST phase to run has no boundary after
  // it — without this its plants ride out to the host store and wait there for
  // the next run against it.
  await evidence.evict();

  const owner = await stat(blobRoot);
  try {
    // No shell: `cp` takes its arguments directly, so nothing here can be read as
    // syntax. Both paths are Runner constants today, which is precisely the
    // reasoning that has been wrong before in this codebase.
    await execFileAsync('cp', ['-a', `${staging}/.`, blobRoot]);
    await execFileAsync('chown', ['-R', `${owner.uid}:${owner.gid}`, blobRoot]);
    // The repro can delete the sentinel mid-run, which would brick this store for
    // the next run against it. Restore it rather than leave a footgun.
    await writeFile(`${blobRoot}/${SENTINEL}`, '');
  } catch (error) {
    // Failing to persist the evidence is a failure to OBSERVE, not a broken
    // Runner. A repro can force this — /blobs has only 256 fanout names, so
    // pre-creating them all as files makes `cp` refuse — and the exit code is
    // what tells a human where to look. Fail-closed either way: this runs before
    // any event is emitted, so a flush failure kills the whole stream.
    throw new ObservationFailed(`could not persist the evidence to ${blobRoot}`, { cause: error });
  }

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
    const job = JSON.parse(await readStdin()) as Job;
    // Set the code, never call process.exit: stdout on a pipe is asynchronous,
    // and exiting discards whatever is still queued. A large FIX_DIFF_OBSERVED
    // was being cut mid-JSON while the run reported success — silent evidence
    // loss presented as a clean record, which is the worst failure this project
    // has.
    process.exitCode = await runJob(job, WORK, BLOBS, (line) => writeSync(channel, line));
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
