// The Docker executor: one container per phase, on this machine (M4 → M10).
//
// This is `orchestrate.ts`'s container code, moved behind the `Executor` seam
// unchanged in what it does. The comments travelled with it because they are the
// record of why each line is the way it is — six review rounds, ADR-0011, ADR-0013,
// ADR-0014, 7e, 8a — and a move that dropped them would leave the next reader
// re-deriving decisions this file already paid for.
//
// Two things about the shape are worth saying here rather than in the middle:
//
//   - There is no `docker exec`. Every container is one `docker run -i`, and the
//     host drives it over that process's stdin and stdout: the Job goes in as one
//     JSON line, events and replies come out interleaved, and for an agent phase the
//     tool protocol (`WorkerRequest`/`WorkerReply`, runner.ts) rides the same pipe.
//     That is why the seam above this file is a PHASE and not a primitive.
//   - The "snapshot" is `docker commit` of a container deliberately not `--rm`'d, so
//     it can outlive its own exit long enough to be committed. Another substrate has
//     a snapshot API and no such container; the `Executor` contract only asks for a
//     reference back.

import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent } from './events.js';
import type { Recipe, ReplayOutcome } from './recipe.js';
import { isWorkerReply, type Job, type SuiteProbe, type WorkerRequest } from './runner.js';
import { redact } from './redact.js';
import { MAX_REASON_CHARS } from './verify.js';
import type { RunPlan } from './orchestrate.js';
import { own, type EnvSnapshot, type Executor, type PhaseResult, type PhaseSpec } from './executor.js';

const execFile = promisify(execFileCb);

/** Output ceiling per container. Matches what the sandbox tests already allow. */
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
/** Tail of a container's diagnostics. The reason is at the end, not the start. */
const MAX_STDERR_CHARS = 8 * 1024;

/**
 * The wall clock ONE container gets from the host before it is stopped.
 *
 * Every timeout this engine had lived below this line: `verify` bounds each
 * command, the loop bounds the agent, `replayRecipe` bounds a step. All of them
 * are inside a container, so all of them are moot when the container itself never
 * starts — a missing image plus a registry the daemon cannot reach wedges
 * `docker run` before PID 1 exists, and a run in that state waits forever with
 * nothing to show for it. Observed while running milestone 7's own suite.
 *
 * Generous on purpose: an hour is longer than anything legitimate this project
 * runs (the agent loop's own ceiling is 30 minutes and the recipe's steps are 10),
 * because this is the guard against a wedge, not a scheduling policy. A caller who
 * wants a tighter one passes `containerTimeoutMs`.
 */
const CONTAINER_TIMEOUT_MS = 3_600_000;

/** Unique per container within a process, so a timed-out one can be named and removed. */
let containers = 0;

/** The one executor every run had until M10. */
export function dockerExecutor(): Executor {
  return {
    kind: 'docker',
    runPhase,
    buildSnapshot,
    // A dependency tree on top of the sandbox image, per run. Left behind it is
    // unbounded host-disk growth exactly as a leaked workspace is.
    dropSnapshot: async (snapshot) => {
      await execFile('docker', ['image', 'rm', '--force', snapshot.ref]);
    },
  };
}

/**
 * Build the image the phases judge from: the sealed phase image, plus this
 * repository's dependencies, installed once.
 *
 * Not `--rm`, which is the whole reason this does not go through `runPhase`:
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
async function buildSnapshot(
  plan: RunPlan,
  source: string,
  base: string,
  recipe: Recipe,
): Promise<{ snapshot: EnvSnapshot } | { failed: string }> {
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
    // `--pull never` for the same reason the phases have it: this image is one we
    // built, and a pull here would block on a registry with the run already
    // committed to waiting.
    ['run', '--pull', 'never', '--name', container, '-i', '-v', `${source}:/src:ro`, plan.image],
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
  // The same ceiling the phases get, and the container this one needs it most:
  // it is the only one with a network, so it is the only one whose `install` can
  // wait on a registry that never answers. The `finally` below removes the
  // container itself; this only stops the host waiting on it.
  let timedOut = false;
  let stopping: Promise<unknown> | undefined;
  const ceiling = plan.containerTimeoutMs ?? CONTAINER_TIMEOUT_MS;
  const bell = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
    // Here rather than in the `finally` below, which this path returns before
    // reaching — and a container still running is exactly what a wedge is.
    stopping = execFile('docker', ['rm', '--force', container]).catch(() => {});
  }, ceiling);
  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
  clearTimeout(bell);
  if (timedOut) {
    await stopping;
    return { failed: `the environment build was stopped after ${ceiling}ms` };
  }

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
    return { snapshot: { ref: image } };
  } catch (error) {
    return { failed: `could not commit the environment: ${String(error)}` };
  } finally {
    // Whatever happened. The image is what the run needs; the container it was
    // committed from is a copy of the same bytes waiting to be forgotten.
    await execFile('docker', ['rm', '--force', container]).catch(() => {});
  }
}

async function runPhase(spec: PhaseSpec): Promise<PhaseResult> {
  const { plan, source, afterSeq, phase, overrides, driver } = spec;
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

  // Named so the host can still reach it after the client is gone: killing
  // `docker run` does not stop the container the daemon is running, so a wedge
  // would survive the ceiling that is supposed to end it.
  const name = `engine-${phase}-${plan.runId.replace(/[^A-Za-z0-9_-]/g, '')}-${process.pid}-${++containers}`;

  const args = [
    // Never from a registry. Every image this engine runs is one it built —
    // `plan.image`, `plan.agentImage`, the environment snapshot — so a pull is
    // always a mistake, and it is the mistake that hangs: `docker run` on a
    // missing image blocks on a registry the daemon may never reach, before PID 1
    // exists and before any timeout inside the container could apply. Refusing it
    // turns an indefinite wedge into `Unable to find image ... locally`, which is
    // the diagnosis the caller wanted anyway.
    'run', '--rm', '-i', '--pull', 'never', '--name', name,
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
    // reach nothing and no longer need to (see `buildSnapshot`).
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
    // The agent's image when there is one, and for everything that judges the
    // environment snapshot when one was built (`spec.from`, the 7e image) or
    // `plan.image` when not. This one line is the whole of "the browser runs in the
    // agent sandbox only": the agent never runs from the snapshot, and the snapshot
    // was never built from the agent's image.
    phase === 'agent' ? (plan.agentImage ?? plan.image) : (spec.from?.ref ?? plan.image),
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
  let suiteReport: SuiteProbe | undefined;
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
    else if ('suite' in parsed) suiteReport = parsed.suite;
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

  // The ceiling. Killing the client unblocks the host; removing the container
  // stops the work, because with the client gone the daemon keeps running it and
  // `--rm` only fires on an exit that may never come.
  let timedOut = false;
  // Awaited before this function returns. Fired and forgotten, the container is
  // still being removed when the caller reads `docker ps` — which is the same
  // "it is gone" claim being false for a shorter time.
  let stopping: Promise<unknown> | undefined;
  const ceiling = plan.containerTimeoutMs ?? CONTAINER_TIMEOUT_MS;
  const bell = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
    stopping = execFile('docker', ['rm', '--force', name]).catch(() => {});
  }, ceiling);

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
  clearTimeout(bell);
  if (stopping) await stopping;
  // On `stderr`, where every other operational failure of this container is
  // already reported and where `EXIT.silent` tells a reader to look. The events
  // it did emit are kept: a phase cut off partway is still evidence of what ran.
  if (timedOut) {
    stderr = `${stderr}\nthe ${phase} container was stopped after ${ceiling}ms`.slice(-MAX_STDERR_CHARS);
  }

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
    ...(suiteReport === undefined ? {} : { suiteReport }),
  };
}

const parse = (lines: string[]): RunEvent[] => lines.map((line) => JSON.parse(line) as RunEvent);
