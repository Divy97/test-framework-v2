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
import { cp, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent } from './events.js';
import { fold } from './fold.js';
import type { Job } from './runner.js';

/** Output ceiling per container. Matches what the sandbox tests already allow. */
const execFile = promisify(execFileCb);

const MAX_STREAM_BYTES = 32 * 1024 * 1024;
/** Tail of a container's diagnostics. The reason is at the end, not the start. */
const MAX_STDERR_CHARS = 8 * 1024;

export type RunPlan = Omit<Job, 'sourcePath' | 'afterSeq' | 'only' | 'fixRef'> & {
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
  agentImageMount?: string;
};

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
  const source = join(workspace, 'source');
  await execFile('git', ['clone', '--quiet', '--no-local', '--', plan.repoPath, source]);

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
  const attempt = own(plan.runId, ++afterSeq, { type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } });
  events.push(attempt);

  // The agent, if there is one, in a container torn down before the first phase
  // is ever cloned. This is what ADR-0010's "the agent's world is discarded"
  // becomes when the world is a container: it is not scrubbed, it ceases to
  // exist. Note it runs BEFORE the base container, so the gate cannot prevent
  // spawning it — the gate decides whether a FIX is attempted.
  const steps: { phase: PhaseResult['phase']; job: Partial<Job> }[] = [];
  // `only: 'agent'` matters: without it the agent container ran the agent AND
  // both phases, so the fix phase started on the very machine the agent had been
  // working in. It stayed invisible because the duplicate registrations made the
  // fold stricter rather than wrong.
  if (plan.agentPrompt) {
    steps.push({ phase: 'agent', job: { agentPrompt: plan.agentPrompt, only: 'agent' } });
  }
  steps.push({ phase: 'base', job: { only: 'base' } });

  let ended: RunEvent | null = null;
  let fixRef = plan.fixRef;
  for (const step of steps) {
    const result = await runContainer(plan, source, afterSeq, step.phase, step.job);
    if (step.phase === 'agent' && result.exitCode === 0) {
      // Whatever the agent committed becomes the fix under judgement. Fetched
      // into a namespace of its own so it can never be mistaken for a ref the
      // repository already had.
      const head = await applyHandover(source, result.handover!);
      if (head) fixRef = head;
    }
    phases.push(result);
    events.push(...result.events);
    afterSeq = result.events.at(-1)?.seq ?? afterSeq;
    if (result.exitCode !== 0) {
      ended = own(plan.runId, ++afterSeq, { type: 'RUN_ENDED', payload: { v: 1, reason: 'error' } });
      break;
    }
  }

  // THE GATE (ADR-0007). No reproduction, no fix — and the decision is read off
  // the fold rather than worked out here, because a second definition of "did it
  // reproduce" living in a producer is exactly what ADR-0009 forbids. A Tier 3
  // outcome is a real deliverable, not a failure.
  if (!ended) {
    if (fold(events).shownOnBase) {
      const fix = await runContainer(plan, source, afterSeq, 'fix', { only: 'fix', fixRef });
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
        ended = own(plan.runId, ++afterSeq, {
          type: 'RUN_ENDED',
          payload: { v: 1, reason: 'error' },
        });
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
  if (ended) events.push(ended);

  return { events, phases, complete: phases.every((p) => p.exitCode === 0) };
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
 * namespace, it was not overwriting a ref the repository already had.
 */
async function applyHandover(source: string, dir: string): Promise<string | null> {
  const bundle = join(dir, 'agent.bundle');
  const exists = await stat(bundle).then(() => true).catch(() => false);
  if (!exists) return null;

  await execFile('git', ['-C', source, 'fetch', '--quiet', bundle, '+HEAD:refs/heads/engine/agent-work']);
  const { stdout } = await execFile('git', ['-C', source, 'rev-parse', 'refs/heads/engine/agent-work']);
  return stdout.trim();
}

async function runContainer(
  plan: RunPlan,
  source: string,
  afterSeq: number,
  phase: PhaseResult['phase'],
  overrides: Partial<Job>,
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
    repro: plan.repro,
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
  for (const entry of await readdir(store)) {
    if (entry === '.evidence-store') continue;
    await cp(join(store, entry), join(plan.blobRoot, entry), { recursive: true, force: true });
  }
  await rm(store, { recursive: true, force: true });

  if (truncated) {
    // Refusing beats guessing: a stream cut mid-line is not a stream, and the
    // fold would reject it anyway on the seq that never arrived.
    throw new Error(`the ${phase} container produced more than ${MAX_STREAM_BYTES} bytes of events`);
  }
  return { phase, events: parse(stdout), exitCode, stderr: stderr.trim(), ...(handover ? { handover } : {}) };
}

const parse = (stdout: string): RunEvent[] =>
  stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);
