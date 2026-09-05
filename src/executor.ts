// Where a phase runs, as an interface (M10, ADR-0021).
//
// Every container this engine has ever started went through two functions in
// `orchestrate.ts` — one for a phase, one for the environment build — and every one of
// them was Docker: a `docker run -i` driven over its own stdin and stdout. That was the right shape for a laptop and it is the wrong
// shape for a milestone that puts each phase in a microVM somebody else operates. The
// seam is drawn at the PHASE, not at the container primitive — create, exec, mount —
// because Docker here has no `exec`, no file transfer that is not a bind mount, and a
// "snapshot" that is `docker commit` of a container deliberately left un-`--rm`'d.
// Forcing a second substrate through those primitives would leak one into the other.
// Every caller already asked for a phase and received a `PhaseResult`; that is what an
// `Executor` answers.
//
// What does NOT move across this seam is the orchestration: the order of phases, the
// gate, the seq counter, the handover, the fold. Those are the product. An executor
// runs one phase where it is told to and reports what happened.

import type { RunEvent } from './events.js';
import type { LoopUsage } from './loop.js';
import type { Recipe, ReplayOutcome } from './recipe.js';
import type { Job, SuiteProbe } from './runner.js';
import type { RunPlan } from './orchestrate.js';

/**
 * The world the phases judge from, once the recipe has been replayed into it (7e).
 *
 * A reference and nothing else: a Docker image tag on one substrate, a snapshot id
 * on another. The orchestrator hands it back to the executor that made it and never
 * looks inside.
 */
export type EnvSnapshot = { ref: string };

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
   * The phase was stopped by this engine's wall clock rather than finishing (M10).
   *
   * Beside the `VERIFICATION_ABORTED{cause:'ceiling'}` the executor also emits, not
   * instead of it: the event is what the fold reads and what disqualifies the attempt.
   * This field is for a caller that wants the fact without re-reading the events, and
   * nothing reads it today.
   *
   * `'wall'` only. The substrate's own session timeout — enforced with our process dead —
   * is the other ceiling a microVM adds, and it is not reported here because a process
   * that is dead reports nothing; what surfaces then is a stream that ends and a sandbox
   * the boot sweep finds. A `'session'` value would be a name for an observation this
   * design cannot make.
   */
  ceiling?: 'wall';
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
   * What the sealed-world probe observed, when this was a probe container (8b).
   * Absent for every other kind, which is every container that judges anything.
   */
  suiteReport?: SuiteProbe;
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

/** One phase to run: everything `runPhase` needs, and nothing it must work out. */
export type PhaseSpec = {
  plan: RunPlan;
  /** Host path the container clones from: the workspace mirror, or the agent's stripped source. */
  source: string;
  afterSeq: number;
  phase: PhaseResult['phase'];
  /**
   * Fields of the `Job` the caller decides. `Job.sourcePath` is container-internal
   * (`/src` on Docker) and is the executor's to set, not the caller's — an override of
   * it here is a Docker assumption leaking through.
   */
  overrides: Partial<Job>;
  /** Present only for a `serveTools` container: what to run while it serves. */
  driver?: ContainerDriver;
  /**
   * The 7e world to run from, for the phases that JUDGE. Absent for the agent
   * sandbox, which replays the recipe itself, and for any run without an `install`.
   */
  from?: EnvSnapshot;
};

/**
 * Two host-side obligations travel with this contract, and a remote implementation has
 * to materialise both rather than assume a shared filesystem:
 *
 *   - every artifact a phase produced is in `plan.blobRoot` — a HOST directory, the
 *     evidence store — by the time `runPhase` returns, re-digested on the way in;
 *   - an `agent` phase returns `handover` as a HOST directory holding `agent.bundle`,
 *     because `applyHandover` in `orchestrate.ts` does `lstat` and `git fetch` on it.
 *
 * Docker gets both for free from bind mounts. Anything else copies bytes out.
 */
export interface Executor {
  readonly kind: 'docker' | 'vercel';
  /** Run one phase to completion and report what it did. Never throws for an outcome the design has a name for. */
  runPhase(spec: PhaseSpec): Promise<PhaseResult>;
  /**
   * Replay the recipe's install/migrate/seed once, from the base commit, and keep the
   * result as the world the phases judge from. Returns the failure rather than
   * throwing it — a repository whose install does not complete is an operational
   * fault the caller records and ends the run on.
   */
  buildSnapshot(
    plan: RunPlan,
    source: string,
    base: string,
    recipe: Recipe,
  ): Promise<
    | {
        snapshot: EnvSnapshot;
        /**
         * What the replay returned, for `ENV_BUILT` (M10). Optional because it is a
         * report and not the product: an executor that cannot recover the step list
         * still built a usable world, and a snapshot is worth more than its provenance.
         */
        steps?: { step: string; exit_code: number }[];
      }
    | { failed: string }
  >;
  /** Forget a snapshot. Never at the cost of the run: callers `.catch` it. */
  dropSnapshot(snapshot: EnvSnapshot): Promise<void>;
}

/**
 * The orchestrator's own events. It is a trusted writer — ADR-0006's constraint
 * is that the AGENT cannot write facts, and ADR-0009 makes the orchestrator the
 * one producer allowed to state why a run stopped.
 */
export const own = (runId: string, seq: number, event: Omit<RunEvent, 'run_id' | 'seq' | 'ts'>): RunEvent =>
  ({ ...event, run_id: runId, seq, ts: new Date().toISOString() }) as RunEvent;
