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
// the read-only source mount) and the seq counter. Nothing else is carried,
// because nothing else exists to carry.

import { spawn } from 'node:child_process';
import type { RunEvent } from './events.js';
import type { Job } from './runner.js';

/** Output ceiling per container. Matches what the sandbox tests already allow. */
const MAX_STREAM_BYTES = 32 * 1024 * 1024;

export type RunPlan = Omit<Job, 'sourcePath' | 'afterSeq' | 'only'> & {
  /** Host path to the repository. Mounted read-only into every container. */
  repoPath: string;
  /** Host directory holding the evidence. Must pre-exist with its sentinel. */
  blobRoot: string;
  image: string;
  afterSeq?: number;
};

/** What one container reported, and how it exited. */
export type PhaseResult = {
  phase: 'agent' | 'base' | 'fix';
  events: RunEvent[];
  exitCode: number;
};

export type RunOutcome = {
  events: RunEvent[];
  phases: PhaseResult[];
  /** True when every container completed its phases; see EXIT in runner.ts. */
  complete: boolean;
};

/**
 * Run one attempt as a sequence of containers.
 *
 * Stops at the first container that could not observe its phase. A fix phase run
 * after a base phase that failed to complete would be comparing against nothing,
 * and the partial stream already says where it stopped.
 */
export async function orchestrate(plan: RunPlan): Promise<RunOutcome> {
  const phases: PhaseResult[] = [];
  const events: RunEvent[] = [];
  let afterSeq = plan.afterSeq ?? 0;

  // The agent, if there is one, in a container that is torn down before the
  // first phase is ever cloned. This is what ADR-0010's "the agent's world is
  // discarded" becomes when the world is a container: it is not scrubbed, it
  // ceases to exist.
  const steps: { phase: PhaseResult['phase']; job: Partial<Job> }[] = [];
  if (plan.agentPrompt) steps.push({ phase: 'agent', job: { agentPrompt: plan.agentPrompt } });
  steps.push({ phase: 'base', job: { only: 'base' } });
  steps.push({ phase: 'fix', job: { only: 'fix' } });

  for (const step of steps) {
    const result = await runContainer(plan, afterSeq, step.phase, step.job);
    phases.push(result);
    events.push(...result.events);
    afterSeq = result.events.at(-1)?.seq ?? afterSeq;
    if (result.exitCode !== 0) break;
  }

  return { events, phases, complete: phases.every((p) => p.exitCode === 0) };
}

async function runContainer(
  plan: RunPlan,
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
    fixRef: plan.fixRef,
    repro: plan.repro,
    symptomPattern: plan.symptomPattern,
    ...(plan.flakeRuns === undefined ? {} : { flakeRuns: plan.flakeRuns }),
    ...(plan.timeoutMs === undefined ? {} : { timeoutMs: plan.timeoutMs }),
    ...(plan.agentTimeoutMs === undefined ? {} : { agentTimeoutMs: plan.agentTimeoutMs }),
    ...overrides,
  };

  const args = [
    'run', '--rm', '-i',
    '-v', `${plan.repoPath}:/src:ro`,
    '-v', `${plan.blobRoot}:/blobs`,
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
  // Drained, or a container that says a lot on stderr blocks writing to it and
  // never reaches its own exit — the same deadlock the agent supervisor has.
  child.stderr.resume();

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });

  if (truncated) {
    // Refusing beats guessing: a stream cut mid-line is not a stream, and the
    // fold would reject it anyway on the seq that never arrived.
    throw new Error(`the ${phase} container produced more than ${MAX_STREAM_BYTES} bytes of events`);
  }
  return { phase, events: parse(stdout), exitCode };
}

const parse = (stdout: string): RunEvent[] =>
  stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);
