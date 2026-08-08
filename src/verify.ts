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
import { constants, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
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
const MAX_REASON_CHARS = 2000;

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
): Promise<Execution> {
  const startedAt = Date.now();
  try {
    const { stdout } = await execFileAsync('sh', ['-c', mergeStreams(command)], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      ...(runAs ?? {}),
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
  const flakeRuns = options.flakeRuns ?? 2;
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

  // From here the engine is working on the base commit: a checkout that fails, a
  // repro that will not apply, and the base command itself are all base-phase
  // failures. Everything above is setup — argument validation and tree hygiene.
  progress.phase = 'base';
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
        throw new ObservationFailed(`could not read repro file ${path}`, { cause: error });
      }
    }
    return hashes;
  };

  await applyRepro();
  const registered = await hashRepro();
  emit({
    type: 'REPRO_REGISTERED',
    payload: { v: 1, command: reproCommand, files: registered, applied: [...appliedFiles.keys()].sort() },
  });

  const base = await run(reproCommand, repoPath, timeoutMs, maxOutputBytes, options.runAs);
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
  await git(['reset', '--hard', '--quiet', baseSha], repoPath, gitEnv);
  await git(['clean', '--quiet', '-dff'], repoPath, gitEnv);
  await checkout(fixSha, repoPath, gitEnv);
  // The same bytes again — this is the whole point. Whatever the fix commit says
  // the reproduction is, the registered version is what runs.
  await applyRepro();
  // Re-runs deliberately share a working tree: they are re-executions of the same
  // fix, not independent trials, and isolating them would hide order-dependent flake.
  for (let repeat = 0; repeat <= flakeRuns; repeat++) {
    const fix = await run(reproCommand, repoPath, timeoutMs, maxOutputBytes, options.runAs);
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
  // Covers the tidy-up below too: both are what happens after the last run, and a
  // fifth phase name to distinguish them would buy a reviewer nothing.
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
  await git(['reset', '--hard', '--quiet', fixSha], repoPath, gitEnv);
  await git(['clean', '--quiet', '-dff'], repoPath, gitEnv);

  return events;
}
