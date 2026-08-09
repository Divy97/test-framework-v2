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
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
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
    await setUp(
      `hand ${name} to the repro user`,
      execFileAsync('chown', ['-R', `${REPRO_UID}:${REPRO_GID}`, root]),
    );
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
  // phases, the agent needs no forged event to fabricate a verdict: it seeds a
  // file in /tmp, or in a gitignored directory the phase scrub deliberately
  // spares, or under $HOME, and a test that reads it goes red then green while
  // the "fix" changes nothing. Every anti-gaming check still passes, because not
  // one of them is about the environment. So the trees are separate clones, the
  // verification tree is made only after the agent is finished, and neither
  // TMPDIR nor HOME is shared.
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
