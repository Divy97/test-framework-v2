// The substrate, as a handful of verbs (M10, ADR-0021).
//
// `executor-vercel.ts` is the interesting file and it is the one that has to be testable
// without a Vercel account, a token, or a network. So the SDK does not appear in it: this
// module defines the seven things the executor asks a sandbox to do, and adapts
// `@vercel/sandbox` to them in one place at the bottom.
//
// The interface is deliberately smaller than the SDK. Three omissions are decisions:
//
//   - **No `networkPolicy` or `status` getter.** The spike found both are the value the
//     SDK last saw, not the value the platform holds: after `updateNetworkPolicy` the
//     object's own field lagged, and after a session ended `status` still said `running`.
//     A guard written against either would be a guard against our own cache. What the
//     executor may rely on is what it OBSERVES — a probe run inside the sandbox — and the
//     one place that matters (ADR-0017's injection guard) reads a probe result, never a
//     getter. So there is nothing here to read one from.
//   - **No `exec`-style session.** A command is either awaited whole or started detached
//     and streamed. Those are the two shapes the engine uses and adding a third would be
//     an affordance nothing needs.
//   - **No port exposure.** ADR-0011 removed the listening port and 10a item 7 recorded
//     inbound-under-`deny-all` as unverified. A method here would invite its use.

import type { Readable } from 'node:stream';
// Types only — erased, so nothing here loads the SDK. See the assertions below `Sdk`.
import type { Sandbox as RealSandbox } from '@vercel/sandbox';

/** What a sandbox may reach. `deny-all` is enforced outside the guest (ADR-0021). */
export type NetworkPolicy = 'allow-all' | 'deny-all';

/** What one whole command did. `output` is stdout and stderr interleaved, as the SDK gives it. */
export type Finished = { exitCode: number; output: string };

/**
 * The PLATFORM ended the session while we were still using it.
 *
 * Its own class because it is not a transport fault and must not be handled as one. A
 * sandbox has a session ceiling enforced outside the guest, and when it fires the SDK
 * stops answering about that machine: the spike measured `logs()` throwing
 * `StreamError: Sandbox stream was closed…` and `wait()` throwing `APIError 410: Sandbox
 * has stopped execution…`, neither of which hangs (10a item 11). On the Hobby tier that
 * ceiling is 45 minutes, which is BELOW this engine's own hour, so it is the one that
 * fires first on a long run.
 *
 * Distinguished here rather than in the executor because the SDK's error shapes are this
 * file's business. What the executor does with it is report `ceiling: 'session'` and keep
 * every event observed up to that point — the alternative is an exception that unwinds
 * the run and takes the evidence with it.
 */
export class SessionEnded extends Error {}

/**
 * Whether an error from the SDK means the session is over.
 *
 * Matched on the two shapes the spike actually observed, plus the status code, rather
 * than on a message alone: a string match is a guess about somebody else's wording, and
 * a 410 is the platform saying the resource is gone in the way HTTP has a word for.
 */
const isSessionEnded = (error: unknown): boolean => {
  const detail = error as { name?: string; status?: number; statusCode?: number; message?: string };
  if (detail?.status === 410 || detail?.statusCode === 410) return true;
  if (detail?.name === 'StreamError') return true;
  return /sandbox (stream was closed|has stopped execution)/i.test(detail?.message ?? '');
};

/**
 * The same translation for a stream, because `for await` throws from inside the loop.
 *
 * A generator rather than a `.catch`: the error arrives on the Nth `next()`, after some
 * chunks have already been yielded, and those chunks are evidence the caller keeps.
 */
async function* throughSessionIterable<T>(source: AsyncIterable<T>): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]();
  for (;;) {
    let step: IteratorResult<T>;
    try {
      step = await iterator.next();
    } catch (error) {
      if (isSessionEnded(error)) throw new SessionEnded(String((error as Error).message ?? error));
      throw error;
    }
    if (step.done) return;
    yield step.value;
  }
}

/** Run something against a sandbox, turning a session end into `SessionEnded`. */
const throughSession = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (isSessionEnded(error)) throw new SessionEnded(String((error as Error).message ?? error));
    throw error;
  }
};

/**
 * A command started and left running, whose stdout is the event channel.
 *
 * ONE stream, carrying both descriptors labelled, rather than a method per descriptor.
 * The SDK's `logs()` is a single subscription: calling it twice opens two, and the second
 * would either duplicate what the first consumed or steal from it. Interleaved-and-tagged
 * is also what actually happened at the source, so the executor can keep the ordering the
 * container had.
 */
export type Started = {
  readonly id: string;
  chunks(): AsyncIterable<{ stream: 'stdout' | 'stderr'; data: string }>;
  wait(): Promise<number>;
  kill(): Promise<void>;
};

/** What a session cost, as the platform reports it when it is stopped. */
export type Compute = {
  sandboxId: string;
  activeCpuMs?: number;
  durationMs?: number;
  ingressBytes?: number;
  egressBytes?: number;
};

export interface SandboxHandle {
  readonly id: string;
  writeFiles(files: { path: string; content: Buffer }[]): Promise<void>;
  /** The bytes, or null when the path is not there. Never a throw for absence. */
  readFile(path: string): Promise<Buffer | null>;
  run(command: string, options?: { sudo?: boolean; timeoutMs?: number }): Promise<Finished>;
  start(command: string, options?: { sudo?: boolean }): Promise<Started>;
  /** Ask the platform to change what this sandbox may reach. Returns when it has accepted. */
  setNetworkPolicy(policy: NetworkPolicy): Promise<void>;
  /** Keep the filesystem as a reference something else can be created from. Stops the sandbox. */
  snapshot(): Promise<{ ref: string }>;
  /** End the session. Returns what it cost, when the platform says. */
  stop(): Promise<Compute | null>;
}

export interface SandboxClient {
  create(options: {
    /** An image reference, or a snapshot to restore. Exactly one. */
    from: { image: string } | { snapshot: string };
    policy: NetworkPolicy;
    /** The session ceiling the PLATFORM enforces, with this process dead. */
    timeoutMs: number;
    /** So a sandbox a crashed worker left behind can be found and stopped. */
    tags?: Record<string, string>;
  }): Promise<SandboxHandle>;
  /** Every sandbox carrying these tags, running or not. For the boot sweep. */
  list(tags: Record<string, string>): Promise<{ id: string }[]>;
  /** A handle for a sandbox this process did not create. Null when it is gone. */
  get(id: string): Promise<SandboxHandle | null>;
  dropSnapshot(ref: string): Promise<void>;
}

// ── The adapter ────────────────────────────────────────────────────────────────
//
// Everything below is `@vercel/sandbox` translated into the interface above, and it is
// the only code in the engine that imports it. It is deliberately dull: no retries, no
// caching, no interpretation. A failure here is the platform's answer and the executor
// decides what it means.

/** How the SDK is told who we are. Validated by the caller; absent fields make it use a CLI login. */
export type VercelCredentials = { token?: string; teamId?: string; projectId?: string };

/**
 * The shortest snapshot expiration the API accepts is `0` (never) or one day; anything
 * between is a 400, which the spike found the hard way. Every snapshot this engine takes
 * is deleted in a `finally`, so this is the floor under a delete that does not happen —
 * not a retention policy.
 */
const SNAPSHOT_EXPIRATION_MS = 24 * 60 * 60_000;

/**
 * Whole lines out of chunks that respect no boundary.
 *
 * Exported because the executor needs it and the transport is what makes it necessary: a
 * chunk may carry three events, or the first half of one. Every caller in this engine
 * parses one JSON object per line, and one buffer they all share is the difference
 * between one implementation of this and three subtly different ones.
 */
export async function* asLines(chunks: AsyncIterable<string>): AsyncIterable<string> {
  let held = '';
  for await (const chunk of chunks) {
    held += chunk;
    let newline = held.indexOf('\n');
    while (newline !== -1) {
      const line = held.slice(0, newline);
      held = held.slice(newline + 1);
      if (line.trim() !== '') yield line;
      newline = held.indexOf('\n');
    }
  }
  // A last line with no newline is still a line. Dropping it silently is how a final
  // event goes missing from a stream that otherwise looks complete.
  if (held.trim() !== '') yield held;
}

/**
 * The SDK's surface, as narrowly as this file uses it.
 *
 * Structural rather than imported: `@vercel/sandbox` is a dependency of the worker and
 * not of the tests, and typing against the shape means `npm test` does not need it
 * resolvable. The one place it IS imported is `vercelClient()`, behind a dynamic import.
 *
 * WHICH MADE THESE SHAPES UNCHECKED, and `as unknown as Sdk` at that import is where the
 * checking stopped. `SdkSandbox` claimed a `sandboxId` the SDK has never had; the compiler
 * compared our claim to our claim and agreed, and every id in this system was `undefined`
 * for as long as the file existed. See the assertions below.
 */
type Sdk = {
  Sandbox: {
    create(params: Record<string, unknown>): Promise<SdkSandbox>;
    get(params: Record<string, unknown>): Promise<SdkSandbox>;
    /** A `Paginator`, which is async-iterable and fetches the next page on demand. */
    list(params: Record<string, unknown>): Promise<AsyncIterable<SdkListed>>;
  };
  Snapshot: { get(params: Record<string, unknown>): Promise<{ delete(): Promise<void> }> };
};

/**
 * The three facts above that this file was WRONG about, checked against the real types.
 *
 * `import type` is erased at compile time — nothing here loads `@vercel/sandbox`, so a
 * Docker-only runner still never resolves it and `npm test` still does not need it. What
 * it buys back is what the cast threw away: rename a property, drop one, or change what
 * `get` takes, and `npm run typecheck` says so instead of a live worker discovering it as
 * a swallowed exception in the sweep.
 *
 * Deliberately NOT `RealSandbox extends SdkSandbox`. Ours declares
 * `runCommand(params: Record<string, unknown>)` where the SDK's is fully typed, so whole
 * assignability fails for a reason that is not a defect — and an assertion that fails for
 * a reason nobody can fix is one somebody deletes.
 */
type Assert<T extends true> = T;
/** What a sandbox is CALLED. This does not compile unless the property exists. */
type _SandboxIsNamed = Assert<RealSandbox['name'] extends string ? true : false>;
/** And what `get` takes to find one again — `{ sandboxId }` was not it. */
type _GetTakesAName = Assert<Parameters<typeof RealSandbox.get>[0] extends { name: string } ? true : false>;
/** And that a listed row carries the three fields the sweep reads off it. */
type _ListedIsAsClaimed = Assert<
  Awaited<ReturnType<typeof RealSandbox.list>> extends { sandboxes: (infer Row)[] }
    ? Row extends SdkListed
      ? true
      : false
    : false
>;

type SdkCommand = {
  cmdId: string;
  logs(): AsyncIterable<{ data: string; stream: string }> & { close(): void };
  wait(): Promise<{ exitCode: number }>;
  kill(): Promise<void>;
  output(which: 'both' | 'stdout' | 'stderr'): Promise<string>;
  exitCode: number;
};

type SdkSandbox = {
  /**
   * WHAT A SANDBOX IS CALLED, and there is nothing else to call it by.
   *
   * This said `sandboxId` — a property `@vercel/sandbox@3.2.1` does not have anywhere in
   * its surface. Nothing caught it: this is a structural type we wrote ourselves, so the
   * compiler checked our claim against our claim. Every `id` was `undefined`, which meant
   * the ledger recorded nothing usable, `SANDBOX_SEALED` carried no sandbox, and `sweep()`
   * could not name a single machine to stop.
   */
  readonly name: string;
  writeFiles(files: { path: string; content: Buffer }[]): Promise<void>;
  readFile(params: { path: string }): Promise<Readable | null>;
  runCommand(params: Record<string, unknown>): Promise<SdkCommand>;
  updateNetworkPolicy(policy: string): Promise<void>;
  snapshot(params: { expiration: number }): Promise<{ snapshotId: string }>;
  stop(): Promise<{
    activeCpuDurationMs?: number;
    duration?: number;
    networkTransfer?: { ingressBytes?: number; egressBytes?: number };
  }>;
};

/** One row of `Sandbox.list`, which is not a `Sandbox` and shares almost nothing with one. */
type SdkListed = {
  name: string;
  status: 'pending' | 'running' | 'stopping' | 'stopped' | 'failed' | 'aborted' | 'snapshotting';
  tags?: Record<string, string>;
};

const drain = async (stream: Readable | null): Promise<Buffer | null> => {
  if (!stream) return null;
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(parts);
};

const wrap = (sandbox: SdkSandbox): SandboxHandle => ({
  id: sandbox.name,
  writeFiles: (files) => sandbox.writeFiles(files),
  // Absence is an answer here, not a fault: the executor reads `/out/agent.bundle` on
  // every agent phase and an agent that committed nothing legitimately leaves none. The
  // try wraps the lookup as well as the drain, because the SDK signals a missing path by
  // throwing on some transports and by answering null on others.
  readFile: async (path) => {
    try {
      return await drain(await sandbox.readFile({ path }));
    } catch {
      return null;
    }
  },
  run: async (command, options = {}) =>
    await throughSession(async () => {
      const finished = await sandbox.runCommand({
        cmd: 'sh',
        args: ['-c', command],
        ...(options.sudo ? { sudo: true } : {}),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      await finished.wait();
      return { exitCode: finished.exitCode, output: await finished.output('both') };
    }),
  start: async (command, options = {}) => {
    const started = await sandbox.runCommand({
      cmd: 'sh',
      args: ['-c', command],
      detached: true,
      ...(options.sudo ? { sudo: true } : {}),
    });
    return {
      id: started.cmdId,
      chunks: () =>
        (async function* () {
          const logs = started.logs();
          try {
            // The iteration itself, not just the setup: the stream is where a session end
            // shows up first, mid-phase, while this process is very much alive.
            for await (const chunk of throughSessionIterable(logs)) {
              yield { stream: chunk.stream === 'stderr' ? ('stderr' as const) : ('stdout' as const), data: chunk.data };
            }
          } finally {
            // A caller that breaks out — the ceiling fired, the driver finished — leaves
            // the subscription open otherwise, and the spike found a dropped iterator is
            // not resumable: the next attach replays a window and closes. Closing here is
            // what keeps that from being the executor's problem.
            logs.close();
          }
        })(),
      wait: async () => await throughSession(async () => (await started.wait()).exitCode),
      kill: () => started.kill(),
    };
  },
  setNetworkPolicy: (policy) => sandbox.updateNetworkPolicy(policy),
  snapshot: async () => ({ ref: (await sandbox.snapshot({ expiration: SNAPSHOT_EXPIRATION_MS })).snapshotId }),
  stop: async () => {
    const result = await sandbox.stop();
    return {
      sandboxId: sandbox.name,
      ...(result.activeCpuDurationMs === undefined ? {} : { activeCpuMs: result.activeCpuDurationMs }),
      ...(result.duration === undefined ? {} : { durationMs: result.duration }),
      ...(result.networkTransfer?.ingressBytes === undefined
        ? {}
        : { ingressBytes: result.networkTransfer.ingressBytes }),
      ...(result.networkTransfer?.egressBytes === undefined
        ? {}
        : { egressBytes: result.networkTransfer.egressBytes }),
    };
  },
});

/**
 * The real client. Imported dynamically so the engine loads on a machine that has no
 * `@vercel/sandbox` installed — a Docker-only runner, and every test in this suite.
 */
export async function vercelClient(options: {
  credentials: VercelCredentials;
  region: string;
}): Promise<SandboxClient> {
  const sdk = (await import('@vercel/sandbox')) as unknown as Sdk;
  const { credentials, region } = options;
  return {
    create: async ({ from, policy, timeoutMs, tags }) =>
      wrap(
        await sdk.Sandbox.create({
          ...credentials,
          region,
          // Never kept beyond its session. A persistent sandbox outlives the worker that
          // forgot it, and this engine creates one per phase.
          persistent: false,
          timeout: timeoutMs,
          networkPolicy: policy,
          ...('image' in from ? { image: from.image } : { source: { type: 'snapshot', snapshotId: from.snapshot } }),
          ...(tags ? { tags } : {}),
        }),
      ),
    list: async (tags) => {
      // THE PLATFORM FILTERS BY ONE TAG, so the rest is filtered here.
      //
      // `Sandbox.list` takes `tags` but its type is `SingleTagFilter` — a second key is
      // refused. The sweep's whole point is a pair, `engine` AND this worker, because a
      // query that matched every worker's machines would have a booting worker stop every
      // other worker's in-flight phase. So the narrower half goes to the platform and the
      // rest is applied to what comes back, which is the same answer with more rows on
      // the wire.
      const [first, ...rest] = Object.entries(tags);
      if (!first) return [];
      const page = await sdk.Sandbox.list({ ...credentials, tags: { [first[0]]: first[1] } });
      const found: { id: string }[] = [];
      // A Paginator, not an array — it is async-iterable and pages on demand. Awaiting it
      // and calling `.map` threw, and `sweep()` swallows a listing that fails, so this
      // half of the sweep was silently dead from the day it was written.
      for await (const row of page) {
        if (rest.some(([key, value]) => row.tags?.[key] !== value)) continue;
        // Already over. Asking the platform to stop these costs a round trip each and
        // grows with every run this project has ever done.
        if (row.status === 'stopped' || row.status === 'failed' || row.status === 'aborted') continue;
        found.push({ id: row.name });
      }
      return found;
    },
    get: async (id) => {
      try {
        // BY NAME. `Sandbox.get` takes `{ name }`; `{ sandboxId }` is not a parameter it
        // has, and the platform answered `Named sandbox 'undefined' not found` — which is
        // caught below and read as "gone", so every sweep found nothing to stop.
        return wrap(await sdk.Sandbox.get({ ...credentials, name: id }));
      } catch {
        // Gone is the answer the sweep wants, not an error it has to classify.
        return null;
      }
    },
    dropSnapshot: async (ref) => {
      await (await sdk.Snapshot.get({ ...credentials, snapshotId: ref })).delete();
    },
  };
}
