// The verification engine. Executes the phases itself and reports what it saw
// (ADR-0006): checkout base -> run repro -> checkout fix -> run repro -> flake
// re-runs -> observe the diff. Every fact originates at this process boundary,
// never from agent output.
//
// It emits fact-events and issues NO verdict. `reproduced`, tier, and
// confidence are the fold's job (ADR-0001, ADR-0004).
//
// The governing rule for error handling here: an event is only ever emitted for
// something actually observed. Anything that prevented observation throws — a
// missing run is recoverable, a fabricated one is not.
//
// Postcondition: the repo is left checked out at fixRef with a clean tree —
// including the repro files the engine itself applied. A later attempt on the
// same repo must not trip the dirty-tree refusal on this run's leftovers.

import { execFile } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { constants, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { put } from './blobs.js';
import type { ArtifactRef, RunEvent, VerificationPhase } from './events.js';

const execFileAsync = promisify(execFile);

type Env = Record<string, string>;

/** Output capture ceiling. Beyond this the engine refuses to record rather than truncate. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Redirect the shell's own stderr, then run the command verbatim on its own line.
 *
 * Wrapping the command in `( … )` looked equivalent and is not: a command ending
 * in a comment swallows the closing paren, so `sh` dies of a syntax error and
 * reports exit 2 with empty output — a fabricated TEST_RUN. `exec 2>&1` never
 * touches the command text, and it captures sh's own diagnostics too, so a
 * malformed repro shows up in the artifact instead of vanishing.
 */
const mergeStreams = (command: string) => `exec 2>&1\n${command}`;

/** The engine could not observe the outcome. Never confuse this with observing a failure. */
export class ObservationFailed extends Error {
  /**
   * What the engine had already observed when it stopped, ending in
   * VERIFICATION_ABORTED. Populated only by `verify()`, at the top of the stack
   * where the event list lives.
   *
   * Those events are real facts and the caller is expected to emit them: a run
   * that dies in the fix phase still watched the base phase fail for the reported
   * reason, and throwing that away leaves the run invisible — the worst outcome
   * for a project whose whole claim is an evidence trail.
   */
  observed: RunEvent[] = [];

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ObservationFailed';
  }
}

/**
 * Ceiling on the text of an abort reason.
 *
 * The message quotes things the agent under judgement chose — a repro command, a
 * path — so it is attacker-influenced, and the event channel is one JSON object
 * per line. An unbounded reason is an unbounded line.
 */
export const MAX_REASON_CHARS = 2000;


const abortReason = (error: Error): string => {
  const text = `${error.name}: ${error.message}`;
  return text.length <= MAX_REASON_CHARS ? text : `${text.slice(0, MAX_REASON_CHARS)}… (truncated)`;
};

/**
 * How the reproduction is anchored so both phases run the same thing.
 *
 * `files` are written over both checkouts — tampering cannot happen, because the
 * fix commit's version is overwritten before it ever runs. `pinned` names paths
 * already committed: the engine cannot prevent a change there, but it hashes them
 * at base and after every run, so a change is a recorded fact.
 *
 * `pinned` exists because requiring `files` would refuse the most common real
 * reproduction — a bug that already has a failing test, authored by a maintainer
 * before the fix, which is stronger provenance than an agent-authored one — and
 * would make repos whose tests must be registered in a manifest unrunnable.
 */
export type ReproSpec = {
  command: string;
  files?: Record<string, string>;
  pinned?: string[];
};

export type VerifyOptions = {
  runId: string;
  /** Seq of the last event already in the log; the engine emits from afterSeq + 1. */
  afterSeq: number;
  repoPath: string;
  baseRef: string;
  fixRef: string;
  /** The reproduction, and how it is anchored across both phases. */
  repro: ReproSpec;
  /** The reported symptom. Base output must match it, or the repro is of some other bug. */
  symptomPattern: RegExp;
  blobRoot: string;
  /** Extra fix-phase executions beyond the first, to catch a flaky pass. */
  flakeRuns?: number;
  /** Per-command ceiling. A repro that hangs must fail the run, not wedge it. */
  timeoutMs?: number;
  /** Output ceiling. Exceeding it aborts the run rather than storing a truncated artifact. */
  maxOutputBytes?: number;
  /**
   * Extra environment for the engine's own git calls, never for the repro.
   *
   * The sandbox uses it to pin GIT_DIR outside the worktree. Git state inside a
   * tree the repro can write is a root escalation: it plants
   * `.git/hooks/post-checkout`, which `git clean` never descends into, and the
   * Runner then executes it as root on the next checkout. `.git/config` is worse
   * still — `diff.external` and `core.fsmonitor` turn an ordinary `git diff`
   * into arbitrary execution.
   */
  gitEnv?: Record<string, string>;
  /**
   * Run the repro as this uid/gid instead of the current user.
   *
   * The sandbox sets it. A repro running as root in the Runner's own PID
   * namespace can open any fd the Runner holds through /proc/1/fd/N — including
   * the event channel — and no amount of fd juggling inside the Runner closes
   * that, because every fd it owns is reachable there. Dropping privileges does:
   * another user's /proc/1/fd/N is listable but not openable.
   */
  runAs?: { uid: number; gid: number };
  /**
   * Environment for the repro, layered over the engine's own.
   *
   * The sandbox uses it to give the phases a private TMPDIR and HOME. Anchoring
   * the reproduction fixes WHAT runs; it says nothing about the world it runs
   * in, and an agent sharing a temp directory with the phases can seed a file
   * the test reads and make a no-op fix go green. Every anti-gaming check still
   * passes, because none of them is about the environment.
   *
   * It redirects only a test that honours TMPDIR; one writing `/tmp` literally
   * still shares the path. That half is closed in the Runner (ADR-0010).
   */
  runEnv?: Env;
  /**
   * Run at the phase boundary, alongside the git scrub.
   *
   * The tree is scrubbed between base and fix because base-phase residue could
   * carry the fix to green on its own. Everything OUTSIDE the tree was left
   * alone, and that is the same hole one step further out: base and fix share a
   * TMPDIR, a HOME and every world-writable path in the container, so a repro
   * that merely behaves differently the second time manufactures red-then-green
   * against a fix that changes nothing.
   *
   *     flag="$TMPDIR/.seen"; [ -f "$flag" ] && exit 0; touch "$flag"; <test>
   *
   * That repro is byte-identical across both checkouts and hashes identically on
   * every run, so the anchor is intact and every anti-gaming check passes. It is
   * agent-authored, which is exactly the threat ADR-0008 exists for — the anchor
   * fixes the repro's BYTES, never its side effects.
   */
  onPhaseBoundary?: () => Promise<void>;
  /**
   * Observe ONE phase and stop, instead of both.
   *
   * The whole-run form shares a filesystem between base and fix by necessity —
   * switching commits in one tree is what the comparison is — and every channel
   * ADR-0010 lists exists because of that sharing. Running each phase in a
   * container of its own removes the sharing rather than scrubbing it, which is
   * the only move that has not needed a follow-up fix.
   *
   * Omitted, the engine behaves exactly as it always has. Both halves emit
   * REPRO_REGISTERED-comparable hashes from the same `repro.files` bytes, so the
   * fold's anchor check works across containers with no extra plumbing: matching
   * bytes hash the same, and a `pinned` path the fix commit rewrote does not.
   */
  only?: 'base' | 'fix';
  /**
   * Prove the reproduction is testing the BUG and not the commit's identity.
   *
   * Only needed when the agent wrote the reproduction, which is also when it
   * knows base's tree exactly — it is the tree in its own clone. A repro that
   * hashes the tree and fails only when that hash matches base passes every
   * defence this engine has: it is byte-identical across phases, so ADR-0008's
   * anchor holds; it needs no cross-phase state, so ADR-0010's reap and the
   * container split are irrelevant to it; and it is deterministic, so the flake
   * re-runs agree. Red on base, green on the fix, no abort — and the fix changed
   * nothing. Review demonstrated exactly that: Tier 1, score 80.
   *
   * The control is a sham fix. Commit an unrelated file on top of base and run
   * the reproduction again: the bug is still there, so a reproduction OF THE BUG
   * must still fail. One that went green has told us it was reading identity.
   */
  controlRun?: boolean;
};

type Execution = { exitCode: number; signal?: string; output: string; durationMs: number };

/**
 * Run a command, capturing merged output and the real exit status.
 *
 * A non-zero exit is the expected base-phase result, so it returns rather than
 * throws. Everything else execFile can reject with — spawn failure, missing cwd,
 * output overflow, our own timeout kill — is a failure to observe and throws,
 * because recording it would put a plausible-looking exit code on an execution
 * that never produced one.
 */
async function run(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  runAs?: { uid: number; gid: number },
  runEnv?: Env,
): Promise<Execution> {
  const startedAt = Date.now();
  try {
    const { stdout } = await execFileAsync('sh', ['-c', mergeStreams(command)], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      ...(runAs ?? {}),
      ...(runEnv ? { env: { ...process.env, ...runEnv } } : {}),
    });
    return { exitCode: 0, output: stdout, durationMs: Date.now() - startedAt };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      signal?: string | null;
      killed?: boolean;
      stdout?: string;
    };

    // A string code is never an exit status: ENOENT, EACCES, and — the one that
    // matters most — ERR_CHILD_PROCESS_STDIO_MAXBUFFER, where Node hands back a
    // truncated buffer that would otherwise be hashed and stored as if complete.
    if (typeof failure.code === 'string') {
      throw new ObservationFailed(`could not run repro in ${cwd} (${failure.code}): ${command}`, {
        cause: error,
      });
    }
    if (failure.killed) {
      throw new ObservationFailed(`repro command exceeded ${timeoutMs}ms: ${command}`, {
        cause: error,
      });
    }
    if (typeof failure.code !== 'number') {
      // Killed from outside — OOM killer, docker stop, a crash. The process ran
      // and died; that is observable and worth recording, but it did not exit,
      // so -1 stands in and `signal` says what really happened.
      return {
        exitCode: -1,
        signal: failure.signal ?? 'unknown',
        output: failure.stdout ?? '',
        durationMs: Date.now() - startedAt,
      };
    }
    return {
      exitCode: failure.code,
      output: failure.stdout ?? '',
      durationMs: Date.now() - startedAt,
    };
  }
}

/** Git is infrastructure, not the thing under test: any failure here is a failure to observe. */
async function git(
  args: string[],
  cwd: string,
  env?: Env,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: MAX_OUTPUT_BYTES,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return stdout;
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    const detail = (failure.stderr || failure.message || '').trim().split('\n')[0];
    throw new ObservationFailed(`git ${args.join(' ')} failed in ${cwd}: ${detail}`, {
      cause: error,
    });
  }
}

/** Check out a ref and report the commit it actually resolved to. */
async function checkout(ref: string, cwd: string, env?: Env): Promise<string> {
  await git(['checkout', '--quiet', ref], cwd, env);
  return (await git(['rev-parse', 'HEAD'], cwd, env)).trim();
}

/** Every path committed at a given commit, lowercased — case-insensitive filesystems clobber. */
async function trackedPaths(sha: string, cwd: string, env?: Env): Promise<Set<string>> {
  const listing = await git(['ls-tree', '-r', '-z', '--name-only', sha], cwd, env);
  return new Set(listing.split('\0').filter(Boolean).map((p) => p.toLowerCase()));
}

/**
 * Resolve a repro path and prove it stays inside the repository.
 *
 * Normalise first, then validate — checking the caller's raw string lets `./`
 * slip past every guard, and the caller here is the agent under judgement
 * (ADR-0008). Containment is re-derived at each use rather than cached, because
 * the fix commit controls the tree's shape: a parent directory committed as a
 * symlink would redirect a write that was proved safe against the base checkout.
 */
async function resolveInside(root: string, input: string, allowSymlinks = false): Promise<Resolved> {
  const target = resolve(root, input);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new ObservationFailed(`repro path escapes the repository: ${input}`);
  }
  if (hasGitSegment(rel)) {
    throw new ObservationFailed(`repro path writes into git's own state: ${input}`);
  }
  // Containment is not the invariant. The committed-path guard compares *names*,
  // so a fix commit that ships `t -> .` makes the applied path `t/src.txt` — a
  // name matching nothing tracked — land on the tracked `src.txt`, and the engine
  // writes the agent's bytes over the code it is judging. The path has to be what
  // its name says, so walk down from the root refusing any symlinked component.
  //
  // lstat, not realpath: a dangling link makes realpath throw, and the loop below
  // would then treat "cannot resolve" as "nothing to check".
  if (!allowSymlinks) {
    let walked = root;
    for (const segment of rel.split(sep)) {
      walked = join(walked, segment);
      try {
        if ((await lstat(walked)).isSymbolicLink()) {
          throw new ObservationFailed(`repro path traverses a symlink: ${input}`);
        }
      } catch (error) {
        if (error instanceof ObservationFailed) throw error;
        break; // Does not exist yet, so nothing below it can either.
      }
    }
  }
  // Both rules again, this time against the *real* path. The lexical check above
  // only sees the name: a symlink the fix commit ships can point into `.git`
  // while satisfying containment, which is the same arbitrary-config write by a
  // different door. The walk starts at the target itself, not its parent — the
  // final component is a symlink the attacker controls just as easily.
  let probe = target;
  while (probe !== root) {
    try {
      const realRel = relative(root, await realpath(probe));
      if (realRel.startsWith('..') || isAbsolute(realRel)) {
        throw new ObservationFailed(`repro path resolves outside the repository: ${input}`);
      }
      if (hasGitSegment(realRel)) {
        throw new ObservationFailed(`repro path resolves into git's own state: ${input}`);
      }
      break;
    } catch (error) {
      if (error instanceof ObservationFailed) throw error;
      // Does not exist yet: keep walking up to the deepest part that does.
      probe = dirname(probe);
    }
  }
  return { rel, target };
}

/** `.git` in any position, case-folded — `sub/.git/hooks` and `.Git` are git state too. */
const hasGitSegment = (path: string) =>
  path.split(sep).some((segment) => segment.toLowerCase() === '.git');

type Resolved = { rel: string; target: string };

/** Mutable bookkeeping shared with the abort handler: where we are, and how far the log got. */
type Progress = { phase: VerificationPhase; seq: number };

/**
 * Run the phases, and if observation stops, still hand back what was seen.
 *
 * The engine keeps throwing on a failure to observe — a caller must never be able
 * to mistake "could not look" for "looked and saw nothing wrong". What changed is
 * that the error now carries the observations that did happen, closed off by a
 * VERIFICATION_ABORTED saying where it stopped.
 */
export async function verify(options: VerifyOptions): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  const progress: Progress = { phase: 'setup', seq: options.afterSeq };
  try {
    return await observe(options, events, progress);
  } catch (error) {
    // A bug in the engine is not an abortable observation. Only the error type
    // that means "I could not look" earns an event.
    if (!(error instanceof ObservationFailed)) throw error;
    events.push({
      run_id: options.runId,
      seq: progress.seq + 1,
      ts: new Date().toISOString(),
      type: 'VERIFICATION_ABORTED',
      payload: { v: 1, phase: progress.phase, reason: abortReason(error) },
    });
    error.observed = events;
    throw error;
  }
}

async function observe(
  options: VerifyOptions,
  events: RunEvent[],
  progress: Progress,
): Promise<RunEvent[]> {
  const { runId, repoPath, baseRef, fixRef, repro, blobRoot } = options;
  const reproCommand = repro.command;
  const gitEnv = options.gitEnv;
  // Clamped, because it arrives over the wire from a Job. A negative value makes
  // the loop below run zero times, so the engine would emit the completion
  // witness over a fix phase that never executed.
  const flakeRuns = Math.max(0, options.flakeRuns ?? 2);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;

  // A caller's /g or /y regex carries lastIndex between calls, so the same output
  // could be observed differently on a second run. Strip the stateful flags.
  const symptom = new RegExp(
    options.symptomPattern.source,
    options.symptomPattern.flags.replace(/[gy]/g, ''),
  );

  // Uncommitted work would silently ride along into both phases, so the result
  // would describe neither commit. Refuse rather than verify the wrong tree.
  const dirty = await git(['status', '--porcelain', '--untracked-files=all'], repoPath, gitEnv);
  if (dirty.trim()) {
    throw new ObservationFailed(
      `working tree at ${repoPath} is not clean; verification would not describe either commit`,
    );
  }

  // Normalise every caller-supplied path once, up front, and work only in the
  // normalised form from here — the raw strings are never trusted again.
  const root = await realpath(repoPath);
  const appliedFiles = new Map<string, string>();
  for (const [input, content] of Object.entries(repro.files ?? {})) {
    appliedFiles.set((await resolveInside(root, input)).rel, content);
  }
  const pinnedPaths: string[] = [];
  for (const input of repro.pinned ?? []) {
    // Pinned paths are only ever read, and a repo may legitimately symlink a
    // test directory; containment below still refuses anything outside.
    pinnedPaths.push((await resolveInside(root, input, true)).rel);
  }
  const pinned = new Set(pinnedPaths);
  const reproPaths = [...appliedFiles.keys(), ...pinnedPaths].sort();

  // A reproduction anchored to nothing is a reproduction the fix commit owns
  // outright: it could rewrite the whole suite and still be credited.
  if (reproPaths.length === 0) {
    throw new ObservationFailed(
      'the reproduction is anchored to nothing: give repro.files to apply, or repro.pinned to hash',
    );
  }

  const emit = (event: Omit<RunEvent, 'run_id' | 'seq' | 'ts'>) => {
    const seq = ++progress.seq;
    events.push({ ...event, run_id: runId, seq, ts: new Date().toISOString() } as RunEvent);
  };

  const baseSha = await checkout(baseRef, repoPath, gitEnv);

  // Applied paths must be additive. Writing over a tracked file would put the
  // tree in the "describes neither commit" state refused above — deliberately,
  // this time, which is worse. Compared lowercased because a case-insensitive
  // filesystem lets `Tests/Repro.js` clobber a committed `tests/repro.js`.
  // Resolve the fix ref up front: a branch name could move between this check
  // and the checkout that eventually uses it.
  const fixSha = (await git(['rev-parse', fixRef], repoPath, gitEnv)).trim();
  const tracked = new Set([
    ...(await trackedPaths(baseSha, repoPath, gitEnv)),
    ...(await trackedPaths(fixSha, repoPath, gitEnv)),
  ]);
  for (const path of appliedFiles.keys()) {
    if (tracked.has(path.toLowerCase())) {
      throw new ObservationFailed(
        `repro path ${path} is committed; applying it would overwrite the code under test`,
      );
    }
  }

  const applyRepro = async () => {
    for (const [path, content] of appliedFiles) {
      // Re-resolved per write: between the base and fix phases the commit under
      // judgement can turn a parent directory into a symlink pointing anywhere.
      const { target } = await resolveInside(root, path);
      try {
        await mkdir(dirname(target), { recursive: true });
        // Remove, then create exclusively. O_CREAT|O_EXCL refuses to open an
        // existing path *including a symlink*, so a link planted between the
        // check above and this write cannot redirect it — and the repro command
        // gets to run arbitrary shell between phases.
        //
        // Knowingly untested, and I was wrong about why once already: it is the
        // realpath containment check that covers the fixtures, not the O_NOFOLLOW
        // read — removing both fs primitives leaves the suite green, which it
        // could not if O_NOFOLLOW were doing this work. What remains here is the
        // residual race where a link appears between resolveInside above and this
        // open, which no fixture can schedule.
        await rm(target, { force: true });
        const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
        try {
          await handle.writeFile(content);
        } finally {
          await handle.close();
        }
      } catch (error) {
        throw new ObservationFailed(`could not apply repro file ${path}`, { cause: error });
      }
    }
  };

  /**
   * Hash every repro path as it stands right now, storing the bytes as they are
   * read. A divergent hash is the tamper this whole design exists to catch, so it
   * is exactly the artifact a reviewer most needs to be able to open.
   */
  const hashRepro = async (): Promise<Record<string, ArtifactRef>> => {
    const hashes: Record<string, ArtifactRef> = {};
    for (const path of reproPaths) {
      const { target } = await resolveInside(root, path, pinned.has(path));
      try {
        // O_NOFOLLOW stops a symlink at the leaf. It is a second layer here: the
        // containment check above already refuses a link pointing outside, so
        // this covers the ordering where the link appears after that check.
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          // O_NOFOLLOW refuses a symlink; a hardlink is a second *name* for the
          // same inode and looks like an ordinary file, so the bytes of anything
          // linked into the tree would land in the evidence store.
          if ((await handle.stat()).nlink > 1) {
            throw new ObservationFailed(`repro path ${path} is a hardlink to another file`);
          }
          hashes[path] = await put(blobRoot, await handle.readFile());
        } finally {
          await handle.close();
        }
      } catch (error) {
        // Let our own diagnosis through untouched. The hardlink refusal above is
        // a tamper signal, and the generic message would bury it — `abortReason`
        // serialises only `name: message`, never `cause`, so on the abort path
        // that string IS the durable record of what went wrong.
        if (error instanceof ObservationFailed) throw error;
        throw new ObservationFailed(`could not read repro file ${path}`, { cause: error });
      }
    }
    return hashes;
  };

  // Only now is the engine working on the base commit's tree in a way that could
  // produce evidence. Everything above is setup: resolving the caller's refs and
  // refusing a repro path that would overwrite committed code — argument
  // validation that was otherwise reporting a typo'd `fixRef` as a base-phase
  // failure. The base checkout sits above the line too; it mutates the worktree,
  // but no event has been emitted yet, so nothing is left half-observed.
  progress.phase = 'base';
  await applyRepro();
  // The base half registers, and only the base half. A fix-only container that
  // emitted its own registration would anchor the run to hashes taken AFTER the
  // fix commit had its way with them — so a rewritten `pinned` test would match
  // its own tampered registration and be credited. The registration has to
  // predate the thing it judges.
  if (options.only !== 'fix') {
    emit({
      type: 'REPRO_REGISTERED',
      payload: {
        v: 1,
        command: reproCommand,
        files: await hashRepro(),
        applied: [...appliedFiles.keys()].sort(),
      },
    });
  }

  // Whether the base run actually showed the bug. The control below is about a
  // reproduction that is CHEATING, and a reproduction that simply does not
  // reproduce is green on the sham for the honest reason — so running the control
  // on it turned ADR-0007's Tier 3 deliverable into an accusation of gaming, in
  // an immutable log. The gate already handles a bug that was never shown.
  let baseRed = false;
  if (options.only !== 'fix') {
    const base = await run(reproCommand, repoPath, timeoutMs, maxOutputBytes, options.runAs, options.runEnv);
    baseRed = base.exitCode !== 0 && !base.signal;
    emit({
      type: 'TEST_RUN',
      payload: {
        v: 1,
        phase: 'base',
        commit_sha: baseSha,
        exit_code: base.exitCode,
        ...(base.signal ? { signal: base.signal } : {}),
        stdout_hash: await put(blobRoot, base.output),
        duration_ms: base.durationMs,
        symptom_matched: symptom.test(base.output),
        repeat: 0,
        repro_hashes: await hashRepro(),
      },
    });
  }

  // THE SHAM FIX. A negative control, and the only defence here that is about
  // what the reproduction MEANS rather than about what it is made of.
  //
  // Everything else anchors the repro's bytes, its environment, or its
  // provenance. None of that can tell a test of the bug from a test of the
  // commit's identity, because the identity test cheats with no byte out of
  // place. So: put an unrelated file on top of base and ask again. The bug is
  // untouched, so a reproduction of the bug must still fail. One that turns
  // green has just announced it was reading the tree, not the behaviour.
  //
  // Deliberately a COMMIT, not an untracked file: a repro hashing `git ls-tree
  // HEAD` would not notice a stray file, and the cheapest oracle to write is the
  // one over tracked content.
  if (options.controlRun && options.only !== 'fix' && baseRed) {
    // ADVISORY MEANS ADVISORY. The previous version removed the accusation and
    // left every other throwing path standing — `run()` on timeout or overflow,
    // six `git()` calls, `applyRepro()`, and the no-tracked-files refusal. The
    // control executes attacker-controlled code two extra times, so review
    // measured an HONEST reproduction aborted in 5 of 10 identical runs, and
    // earlier than the accusation would have: before the fix phase ran at all.
    // That is worse than the defect the advisory change was made to remove.
    //
    // Nothing inside this block may end the run. Whatever it learns, it learns as
    // evidence; whatever goes wrong, goes wrong quietly and the run proceeds as
    // though the control had not been asked for.
    try {
    progress.phase = 'base';
    // TWO independent shams, and an accusation only if both go green.
    //
    // One was not enough, and the failure was not theoretical: the sham appends
    // to a tracked file, and for an EOF-conformance bug — `eol-last`,
    // `insert_final_newline`, a golden-file or checksum test — that append IS the
    // fix. An honest reproduction then goes green on the sham and was told, in an
    // immutable log, that it was testing which commit it was standing on. Two
    // draws pick different victims and different perturbations, so a repro that
    // is genuinely about one file's ending survives the one that does not touch
    // it. Disagreement is inconclusive, and inconclusive is not an accusation.
    const tracked = (await git(['ls-files', '-z'], repoPath, gitEnv)).split('\0').filter(Boolean);
    // Not a refusal, and not a return: an empty root commit is unusual rather
    // than hostile, and `return events` here would skip the FIX PHASE — ending
    // the run in the one branch written to avoid ending runs.
    if (tracked.length > 0) {
    for (let draw = 0; draw < 2; draw += 1) {
      // Through the same guard every other path in this file uses. This was the
      // ONE write in `verify()` that did not: `victim` is committed data chosen
      // by the repository under test, and `readFile`/`writeFile` follow symlinks,
      // so a tracked `link.conf -> /anywhere` had the engine rewrite a file
      // outside the repository — in the sandbox, as root, including into the
      // gitdir that `--separate-git-dir` exists to withhold.
      const victim = tracked[randomInt(tracked.length)]!;
      // Not `resolveInside`: that walks symlinked components against a
      // non-realpath'd root, which is right for a path being CREATED and wrong
      // for one that already exists under a symlinked tmpdir. The property needed
      // here is narrower — a regular file whose real path is inside the repo's
      // real path — so it is checked directly.
      const target = join(repoPath, victim);
      const kind = await lstat(target).catch(() => null);
      const inside = await realpath(target)
        .then(async (real) => real.startsWith((await realpath(repoPath)) + sep))
        .catch(() => false);
      // `nlink > 1` too. A hardlink is a second NAME for the same inode: it is a
      // regular file and realpath does not resolve it away, so it satisfied both
      // checks while pointing outside the repository — and the repro can create
      // one DURING the base run. `hashRepro` in this same file already refuses
      // exactly this and says why; the guard was rewritten instead of reused.
      if (!kind?.isFile() || kind.nlink > 1 || !inside) {
        // Recorded, not silent. A repository of symlinks quietly produced ZERO
        // control runs — no abort, no marker — so coverage degraded to nothing
        // while the log looked exactly like a clean one. That is the failure
        // `phase: 'control'` was introduced to prevent, reappearing in the branch
        // that skips it. `exit_code: -1` is the same "no status to report"
        // convention TEST_RUN already uses for a signalled process.
        emit({
          type: 'TEST_RUN',
          payload: {
            v: 1,
            phase: 'control',
            commit_sha: baseSha,
            exit_code: -1,
            stdout_hash: await put(blobRoot, `no sham: ${victim} is not a plain file inside the repo\n`),
            duration_ms: 0,
            repeat: draw,
          },
        });
        continue;
      }
      // `lstat`, so a symlink is refused rather than followed, and a dangling
      // link, a directory and a submodule gitlink are all skipped — each of those
      // threw a raw ENOENT/EISDIR out of `verify()`, past the ObservationFailed
      // wrapper, losing REPRO_REGISTERED and the base TEST_RUN with it. All three
      // are ordinary shapes in real repositories.
      // Random length and content, at the end or as a fresh line — the previous
      // sham always added exactly one empty line, and `diff --numstat HEAD^ HEAD`
      // reading `1 0` with an empty added line is a signature no real fix has.
      const filler = randomBytes(randomInt(4, 40)).toString('hex');
      // Draw 0 appends; draw 1 PREPENDS. The difference is the whole point: an
      // append changes a file's final byte, which for an EOF-conformance bug is
      // the fix itself, so two appends agree with each other and convict an
      // honest reproduction. A prepend changes the content and leaves the ending
      // exactly as it was, so a repro that is genuinely about the ending stays
      // red on it — while an oracle reading identity goes green on both.
      const body = await readFile(target);
      await writeFile(
        target,
        draw === 0 ? Buffer.concat([body, Buffer.from(`\n${filler}\n`)])
                   : Buffer.concat([Buffer.from(`${filler}\n`), body]),
      );
      // Author, name and message drawn SEPARATELY. One nonce feeding all three
      // made `%an === %s` a constant relation, and `@example.invalid` was a
      // literal in this file the agent reads — randomising the value while fixing
      // the relation is the same mistake as randomising a suffix and keeping the
      // stem.
      const who = randomBytes(6).toString('hex');
      const where = randomBytes(4).toString('hex');
      const what = randomBytes(7).toString('hex');
      await git(['add', '--', victim], repoPath, gitEnv);
      await git(
        [
          '-c', `user.email=${who}@${where}.example`,
          '-c', `user.name=${what}`,
          'commit', '--quiet', '-m', randomBytes(9).toString('hex'),
        ],
        repoPath,
        gitEnv,
      );
      const control = await run(reproCommand, repoPath, timeoutMs, maxOutputBytes, options.runAs, options.runEnv);
      emit({
        type: 'TEST_RUN',
        payload: {
          v: 1,
          phase: 'control',
          // The sham's own sha: what actually ran, not what was intended.
          commit_sha: (await git(['rev-parse', 'HEAD'], repoPath, gitEnv)).trim(),
          exit_code: control.exitCode,
          ...(control.signal ? { signal: control.signal } : {}),
          stdout_hash: await put(blobRoot, control.output),
          duration_ms: control.durationMs,
          repeat: draw,
        },
      });
      await git(['reset', '--hard', '--quiet', baseSha], repoPath, gitEnv);
      await git(['clean', '--quiet', '-xdff'], repoPath, gitEnv);
      await applyRepro();
    }
      }
    } catch {
      // Deliberately swallowed, and deliberately not re-raised as an abort: this
      // is a diagnostic the engine chose to run, not an observation the caller
      // asked for. A control that cannot complete tells us nothing, and telling
      // nothing must not cost the run its verdict.
    }
    // The tree, whatever happened above. A control that died mid-perturbation
    // must not hand the fix phase a dirty tree — the contamination the container
    // split exists to prevent.
    await git(['reset', '--hard', '--quiet', baseSha], repoPath, gitEnv).catch(() => {});
    await git(['clean', '--quiet', '-xdff'], repoPath, gitEnv).catch(() => {});
    await applyRepro();
  }

  // The base container's work ends here. It leaves the tree as it found it, and
  // the fix phase happens in a container that never saw this one.
  if (options.only === 'base') {
    progress.phase = 'cleanup';
    await git(['reset', '--hard', '--quiet', baseSha], repoPath, gitEnv);
    await git(['clean', '--quiet', '-xdff'], repoPath, gitEnv);
    return events;
  }

  // Scrub before switching, not after. Whatever the base phase left behind —
  // caches, generated files, a seeded DB, an edit to a tracked file that both
  // commits share — could carry the fix phase to green on its own. `checkout`
  // preserves modifications to files the two commits agree on, and aborts
  // outright when untracked residue collides with a file the fix commit adds, so
  // cleaning afterwards is both too late and unreachable.
  //
  // Ignored files are deliberately spared: they are usually installed
  // dependencies, and removing them would change what is under test far more
  // than it isolates it.
  progress.phase = 'fix';
  // Only meaningful when this process ran the base phase too. A fix-only
  // container starts from a clone nothing has touched, which is the point.
  if (options.only !== 'fix') {
    await git(['reset', '--hard', '--quiet', baseSha], repoPath, gitEnv);
  // `-x` here and nowhere else. Ignored files are spared elsewhere because they
  // are usually installed dependencies, and removing them changes what is under
  // test — but between the phases of one repo they are simply the easiest place
  // for the base run to leave a flag the fix run reads, and `node_modules/`,
  // `dist/` and `coverage/` are ignored in every real repository. Nothing
  // installs dependencies yet (M2 deferred it), so today this costs nothing; a
  // `setupCommand` must run per phase rather than once.
    await git(['clean', '--quiet', '-xdff'], repoPath, gitEnv);
    // The same scrub, one step further out. Whatever the base run left behind
    // outside the tree — state on disk, or a process still running — is what the
    // fix run would otherwise inherit, and a repro needs no more than that to be
    // red once and green afterwards. The Runner owns what that means; the engine
    // only owns the tree.
    await options.onPhaseBoundary?.();
  }
  await checkout(fixSha, repoPath, gitEnv);
  // The same bytes again — this is the whole point. Whatever the fix commit says
  // the reproduction is, the registered version is what runs.
  await applyRepro();
  // Re-runs deliberately share a working tree: they are re-executions of the same
  // fix, not independent trials, and isolating them would hide order-dependent flake.
  for (let repeat = 0; repeat <= flakeRuns; repeat++) {
    const fix = await run(reproCommand, repoPath, timeoutMs, maxOutputBytes, options.runAs, options.runEnv);
    emit({
      type: 'TEST_RUN',
      payload: {
        v: 1,
        phase: 'fix',
        commit_sha: fixSha,
        exit_code: fix.exitCode,
        ...(fix.signal ? { signal: fix.signal } : {}),
        stdout_hash: await put(blobRoot, fix.output),
        duration_ms: fix.durationMs,
        repeat,
        repro_hashes: await hashRepro(),
      },
    });
  }

  // Three-dot: what the fix side changed since the merge base. Two-dot would
  // attribute base-side commits to the fix, over-reporting the very paths the
  // overlap check trusts. -z avoids core.quotePath mangling non-ASCII names, and
  // --no-renames keeps the original path visible instead of only the destination.
  progress.phase = 'diff';
  const range = `${baseSha}...${fixSha}`;
  const changed = await git(['diff', '--name-only', '-z', '--no-renames', range], repoPath, gitEnv);
  emit({
    type: 'FIX_DIFF_OBSERVED',
    payload: {
      v: 1,
      base_sha: baseSha,
      fix_sha: fixSha,
      changed_files: changed.split('\0').filter(Boolean),
      diff_hash: await put(blobRoot, await git(['diff', range], repoPath, gitEnv)),
    },
  });

  // Leave the tree as it was found. Applied repro files are untracked, so without
  // this the next attempt on the same repo trips the dirty-tree refusal on our own
  // leftovers — and bounded attempts up to three is a documented feature, not an
  // edge case. No fixture can catch this: each builds a fresh repo.
  //
  // Its own phase, because a failure here aborts a run in which every phase
  // completed and every fact was observed. Called `diff` it would tell an
  // orchestrator to retry good evidence — and the retry would die immediately on
  // the dirty-tree refusal, since the tidy-up is precisely what failed.
  progress.phase = 'cleanup';
  await git(['reset', '--hard', '--quiet', fixSha], repoPath, gitEnv);
  await git(['clean', '--quiet', '-dff'], repoPath, gitEnv);

  return events;
}
