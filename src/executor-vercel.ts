// One phase, one microVM, on a substrate we do not operate (M10, ADR-0021).
//
// The Docker executor owns its machine: the Runner is PID 1, the Job arrives on stdin,
// tool calls come back down the same pipe, and `/blobs` is a bind mount that already
// outlives the container. None of that is true here. So the same `runJob` runs with four
// things supplied differently, and the rest of the engine sees no difference at all.
//
//   - **The source is a git bundle**, written in with the Job. There is no bind mount and
//     no credential goes near a sandbox (ADR-0012), so a bundle of the workspace mirror is
//     what a clone inside can be made from. `runner.ts` clones a path; a bundle path works
//     unchanged.
//   - **Tool calls are files.** `writeFiles('/work/rpc/in/<n>.json')` in, the JSON channel
//     out on the detached command's stdout. `runner-vm.ts` turns the directory back into
//     the `AsyncIterable<string>` `runJob` already takes.
//   - **The Runner runs as root; HOW is a property of the image.** The repro always drops
//     to uid 1000 (`runner.ts` decides that, and never inherits it), and what keeps an
//     untrusted agent away from the event channel is the kernel refusing one user
//     another's file descriptors, not any trick with fd 1. So the Runner must be some
//     other user. The managed image's default is uid 1000 with passwordless sudo, so it
//     gets `sudo -n `; ours are alpine with no `USER` and no sudo binary, so a command is
//     already root and gets nothing. `elevationFor` asks, once, at open — and
//     `runner-vm.ts` refuses to start as uid 1000 regardless, so a missed elevation is a
//     loud failure rather than a silent hole.
//   - **The store is copied out.** `/blobs` is an ordinary directory in a machine about to
//     be destroyed, so it is tarred, read back, and `put()` into the host's evidence store
//     — re-digested on the way in, which is stricter than the `cp` Docker does.
//
// THE SEAL, which is the reason this substrate was chosen. A phase that judges is created
// `deny-all` and never changes. The agent sandbox is created `allow-all` because `install`
// needs a registry, and is flipped to `deny-all` after the world is up and before the
// agent's first turn — then PROBED from out here, by running commands inside it that try
// to exchange data with the internet. The probe result is what `SANDBOX_SEALED` records
// and what ADR-0017's injection guard will read. The SDK's own `networkPolicy` getter is
// never consulted: the spike found it is the value this process last sent, not the value
// the platform holds.

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { put } from './blobs.js';
import type { RunEvent } from './events.js';
import { own, type EnvSnapshot, type Executor, type PhaseResult, type PhaseSpec } from './executor.js';
import type { RunPlan } from './orchestrate.js';
import type { Recipe, ReplayOutcome } from './recipe.js';
import { redact } from './redact.js';
import { isWorkerReply, type Job, type SuiteProbe, type WorkerRequest } from './runner.js';
import { MAX_REASON_CHARS } from './verify.js';
import {
  asLines,
  SessionEnded,
  type Compute,
  type Finished,
  type SandboxClient,
  type SandboxHandle,
} from './vercel-client.js';

const execFile = promisify(execFileCb);

/** Output ceiling per phase, matching the Docker executor's. */
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
/** Tail of a phase's diagnostics. The reason is at the end, not the start. */
const MAX_STDERR_CHARS = 8 * 1024;
/**
 * The most a phase may leave in its store.
 *
 * The repro writes its own captures into the store, so the size is the agent's to choose
 * — through `flush()` rather than directly, but the bytes are still its bytes. Generous —
 * a transcript and a few screenshots are orders of magnitude under it — and finite,
 * because everything under it crosses a network into this process's memory.
 */
const MAX_STORE_BYTES = 256 * 1024 * 1024;
/** The wall clock one phase gets from this process. The platform enforces its own beside it. */
const PHASE_TIMEOUT_MS = 3_600_000;

/**
 * The longest session this executor will ASK the platform for.
 *
 * Hobby caps a sandbox at 45 minutes and refuses anything longer at create time — not
 * with a clamp, with `400: timeout restricted to <= 45m on Hobby plans`. The first live
 * run died on exactly that, eight seconds in, because `PHASE_TIMEOUT_MS` is an hour and
 * was passed straight through.
 *
 * So the request is clamped rather than the engine's own ceiling lowered: our wall clock
 * is a guard against a wedge and has nothing to say about somebody's billing plan. On a
 * plan with a longer limit, raise this and the two converge again — and if the session is
 * still the shorter of the two, #76's `ceiling: 'session'` is what reports it, which is
 * the case this default guarantees.
 */
const MAX_SESSION_MS = 45 * 60_000;

/** Where the engine puts things inside a sandbox. Root-owned until `PREPARE` runs. */
const WORK = '/work';
const BLOBS = '/blobs';
const SPOOL = `${WORK}/rpc`;
/**
 * Where the agent's bundle is left, and it has to be a DIRECTORY before the Runner looks.
 *
 * `handOverCommits` stats this and silently returns null when it is not one — correct on
 * Docker, where `-v <dir>:/out` creates it, and a silent no-handover on every agent phase
 * here until `PREPARE` made it. The Runner then reports nothing wrong, because "not
 * mounted" is a legitimate configuration, and `applyHandover` refuses the run one layer
 * up with "the agent handed nothing over".
 */
const HANDOVER = '/out';
const BUNDLE = `${WORK}/src.bundle`;
const JOB = `${WORK}/job.json`;

/**
 * How this executor becomes root, which depends on the image and is DETECTED.
 *
 * The spike measured the root model on Vercel's MANAGED image: `ubuntu`, uid 1000, with
 * passwordless sudo. Our own images are `node:22-alpine` with no `USER`, so a command
 * runs as root and there is no sudo binary at all — `sudo: not found` was the second
 * failure of the first live run, after the session clamp.
 *
 * Both are legitimate targets, so neither is assumed. One `id -u` at open decides, and
 * every command that needs privilege carries the result.
 */
type Elevate = string;

/**
 * Make the paths the Runner needs, and hand them to the user `writeFiles` writes as.
 *
 * `/`, `/opt` and `/blobs` are root's on both images. On the managed one that is the
 * difference between working and every `writeFiles` failing with a permission error that
 * reads like a transport fault; on ours the commands are already root and the chown is a
 * no-op that keeps one code path instead of two. `/blobs` gets the sentinel here rather
 * than in the image, because the Runner refuses a store it cannot prove pre-existed.
 */
const prepareWith = (elevate: Elevate): string =>
  [
    `${elevate}mkdir -p ${WORK} ${SPOOL}/in ${SPOOL}/out /opt/env ${BLOBS} ${HANDOVER}`,
    `${elevate}chown -R "$(id -u):$(id -g)" ${WORK} /opt/env ${BLOBS} ${HANDOVER}`,
    `: > ${BLOBS}/.evidence-store`,
    // Root-owned 0700, so the repro — uid 1000 — cannot forge a `{done: true}` and choose
    // its own ending, or answer a tool call on the host's behalf.
    //
    // Whether the HOST can then write it depends on the image, and this is why `deliver`
    // goes through a command rather than `writeFiles`. On the managed image `writeFiles`
    // runs as uid 1000 — the same user the repro drops to — so no ownership separates
    // them; on ours it runs as root, so it could. A command with `elevate` in front is
    // correct on both, and costs the same round trip either way.
    `${elevate}chown -R root:root ${SPOOL} && ${elevate}chmod -R 0700 ${SPOOL}`,
  ].join(' && ');

/**
 * Work out what this image needs to reach root, or refuse with a reason.
 *
 * One round trip, at open, before anything depends on the answer. Refusing here rather
 * than letting the first `chown` fail matters because that failure reads as a transport
 * fault — `sh: sudo: not found` inside "the environment build could not be run" — and
 * sends the reader to the wrong layer entirely.
 */
async function elevationFor(sandbox: SandboxHandle): Promise<Elevate> {
  const probe = await sandbox.run('id -u; command -v sudo >/dev/null 2>&1 && echo HAVE_SUDO || echo NO_SUDO');
  const said = probe.output.trim();
  if (probe.exitCode !== 0) {
    // The probe not RUNNING is a different fact from the image not being root, and
    // reporting the second when the first happened is what this function exists to
    // prevent one layer down. `output` is all we have, so it goes in whole.
    throw new Error(`could not ask this image what user it runs commands as (exit ${probe.exitCode}): ${said || '(nothing)'}`);
  }
  // `output` is stdout and stderr interleaved, as the SDK gives it, so line 0 is only the
  // uid on an image that prints nothing else — a motd, a shell banner or one line on
  // stderr would make it something else entirely, and the executor would refuse a
  // perfectly good root image while naming the banner as its uid. The uid is the first
  // line that is only digits.
  const uid = said.split('\n').map((one) => one.trim()).find((one) => /^\d+$/.test(one));
  if (uid === '0') return '';
  if (said.includes('HAVE_SUDO')) return 'sudo -n ';
  throw new Error(
    `this image runs commands as uid ${uid ?? '?'} and has no sudo, so the Runner cannot be started ` +
      'as a different user from the repro — build the image to run as root, or install sudo',
  );
}

/**
 * The probes, and why they exchange data rather than connect.
 *
 * The spike's first version asked only whether `connect()` succeeded, and under `deny-all`
 * it did: the egress path is a terminating proxy that completes the TCP handshake and then
 * drops the connection. A connect proves nothing about whether a byte reached the
 * internet. Each of these sends something and waits for an answer only the destination
 * could give, so an exit of 0 means the sandbox is OPEN and anything else means it is not.
 *
 * Two, not one, and they are different transports on purpose: UDP cannot be terminated by
 * an HTTP proxy the way TCP can, and a rule that dropped one and not the other would be
 * invisible to a single probe.
 */
const PROBE = {
  dns: `node -e "require('dns').promises.lookup('registry.npmjs.org').then(r=>{console.log('RESOLVED',r.address);process.exit(0)},e=>{console.log('DNS_FAIL',e.code);process.exit(1)})"`,
  route: `node -e "const d=require('dgram').createSocket('udp4');const n=Buffer.concat([Buffer.from([7]),Buffer.from('example'),Buffer.from([3]),Buffer.from('com'),Buffer.from([0])]);const q=Buffer.concat([Buffer.from([0x12,0x34,1,0,0,1,0,0,0,0,0,0]),n,Buffer.from([0,1,0,1])]);setTimeout(()=>{console.log('UDP_TIMEOUT');process.exit(3)},4000);d.on('message',m=>{console.log('UDP_ANSWERED',m.length);process.exit(0)});d.on('error',e=>{console.log('UDP_FAIL',e.code);process.exit(1)});d.send(q,53,'1.1.1.1')"`,
} as const;

/**
 * How the Runner is started, as a user the repro is not.
 *
 * That difference is the whole precondition (see the header): `runner-vm.ts` refuses to
 * start as uid 1000 because nothing would then separate the agent from the event channel.
 * On our images the command is already root and `elevate` is empty; on the managed image
 * it is `sudo -n `.
 */
const runnerCommand = (elevate: Elevate, entry: string) =>
  `${elevate}${entry} --job ${JOB} --spool ${SPOOL}`;

/**
 * Put one line into the root-owned spool, as root.
 *
 * `writeFiles` cannot: it runs as uid 1000, which is the uid the repro drops to, and a
 * spool uid 1000 can write is a spool the agent can forge `{done: true}` into. So the
 * content travels base64-encoded inside a command — base64 has no shell metacharacters,
 * so nothing here has to reason about quoting somebody else's JSON — and `sudo tee`
 * writes it on the other side.
 *
 * One round trip, the same as `writeFiles` would have cost. The spike measured
 * `runCommand` at a p50 under 300ms, which is the same order as a file write.
 */
const deliver = async (sandbox: SandboxHandle, elevate: Elevate, name: string, line: string): Promise<void> => {
  const encoded = Buffer.from(line, 'utf8').toString('base64');
  // `test -s` after the pipe, because `sh -c` reports the LAST command's status and has no
  // `pipefail` to promise otherwise: a `base64` that failed would leave `tee` exiting 0
  // over an empty file, `spoolRequests` would skip the empty file forever, and the host
  // would wait for a reply to a call that was never delivered — the exact silent hang
  // this function exists to make loud.
  const written = await sandbox.run(
    `printf %s '${encoded}' | base64 -d | ${elevate}tee ${SPOOL}/in/${name} > /dev/null; ` +
      `${elevate}test -s ${SPOOL}/in/${name}`,
  );
  if (written.exitCode !== 0) {
    // Loudly. A swallowed failure here is an agent loop waiting for a reply that will
    // never come, and then a phase burning its whole wall clock with no diagnosis.
    throw new Error(`could not deliver a tool call to the sandbox: ${written.output.trim().slice(-300)}`);
  }
};

/**
 * What a run leaves behind if this process dies: one line per sandbox it created.
 *
 * A file rather than a table, appended the instant `create` returns and before anything
 * else can fail. It cannot be written earlier — the id does not exist until then — so the
 * create-to-append window is real and this does not close it; what it closes is every
 * window after it, which is where the work happens and where the failures are.
 *
 * `sweep()` reads this file rather than only asking the platform, because a tag query is
 * the whole deployment's sandboxes and a worker must not stop another worker's phases.
 */
type Ledger = { path: string };

const remember = async (ledger: Ledger | undefined, entry: { sandboxId: string; runId: string }) => {
  if (!ledger) return;
  await writeFile(ledger.path, `${JSON.stringify(entry)}\n`, { flag: 'a' }).catch(() => {});
};

/** The ids this worker's ledger names, deduplicated, or none if it cannot be read. */
const remembered = async (ledger: Ledger | undefined): Promise<string[]> => {
  if (!ledger) return [];
  const raw = await readFile(ledger.path, 'utf8').catch(() => '');
  const ids = new Set<string>();
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      ids.add((JSON.parse(line) as { sandboxId: string }).sandboxId);
    } catch {
      // A half-written last line is a line we have not finished appending. Skipping it
      // costs one sandbox on this sweep and the platform's own timeout catches it.
    }
  }
  return [...ids];
};

/** A git bundle of everything in a bare repository, as one file on the host. */
async function bundle(source: string, into: string): Promise<Buffer> {
  const path = join(into, 'src.bundle');
  // `--all`, so every ref the mirror holds travels. The container clones by ref name and
  // a bundle missing the branch `baseRef` lives on is a clone that resolves nothing.
  await execFile('git', ['-C', source, 'bundle', 'create', path, '--all']);
  return await readFile(path);
}

export type VercelExecutorOptions = {
  client: SandboxClient;
  /** Where sandboxes are created. One region, because a snapshot is not portable across them. */
  region?: string;
  /** A file listing live sandboxes, so a crashed worker's can be swept on the next boot. */
  ledger?: Ledger;
  /**
   * What every sandbox is tagged with, so `sweep` can find them.
   *
   * It must identify THIS worker, not the deployment: `sweep` stops what the tag matches,
   * and a tag shared between workers turns one booting worker into an outage for the
   * others. The default carries the process id for that reason; a real deployment passes
   * something stable across a restart of the same worker.
   */
  tags?: Record<string, string>;
  /**
   * The command that starts `runner-vm.ts` inside the image.
   *
   * The default is where OUR images put it: `Dockerfile` and `Dockerfile.agent` both
   * `WORKDIR /app` and `COPY src ./src`, and a sandbox created from one starts in `/app`
   * — measured, in `scripts/spike-vercel/14-our-image.ts`. That last part is why `tsx`
   * can be a bare specifier here: node resolves `--import` from the cwd upwards, so the
   * same command run from `/` would die in the loader rather than in the script.
   *
   * An image that lays its code out differently passes its own.
   */
  entrypoint?: string;
  /**
   * The longest session to ask the platform for. Defaults to the Hobby ceiling, which is
   * the value that cannot fail; raise it on a plan that allows more.
   */
  maxSessionMs?: number;
  /** Called with what each sandbox cost, once it is stopped. 10f writes these to a table. */
  onCompute?: (compute: Compute & { runId: string; phase: string }) => void;
};

export function vercelExecutor(options: VercelExecutorOptions): Executor & { sweep: () => Promise<number> } {
  const { client } = options;
  const entry = options.entrypoint ?? 'node --import tsx /app/src/runner-vm.ts';
  const tags = options.tags ?? { engine: 'test-framework-v2', worker: String(process.pid) };

  /** Create, prepare, and record — in the order that leaves nothing unaccounted for. */
  const open = async (
    from: { image: string } | { snapshot: string },
    policy: 'allow-all' | 'deny-all',
    plan: { runId: string; containerTimeoutMs?: number },
  ): Promise<{ sandbox: SandboxHandle; elevate: Elevate }> => {
    // The smaller of what this phase wants and what the plan permits. Asking for more is
    // not a slow failure — the platform refuses the create outright.
    const timeoutMs = Math.min(plan.containerTimeoutMs ?? PHASE_TIMEOUT_MS, options.maxSessionMs ?? MAX_SESSION_MS);
    const sandbox = await client.create({ from, policy, timeoutMs, tags });
    await remember(options.ledger, { sandboxId: sandbox.id, runId: plan.runId });
    let elevate: Elevate;
    try {
      elevate = await elevationFor(sandbox);
    } catch (error) {
      await sandbox.stop().catch(() => {});
      throw error;
    }
    const prepared = await sandbox.run(prepareWith(elevate));
    if (prepared.exitCode !== 0) {
      // Not recoverable and not the repository's fault: the image is ours. Stopping here
      // rather than proceeding means the failure names the step instead of arriving three
      // calls later as a permission error on a file write.
      await sandbox.stop().catch(() => {});
      throw new Error(`could not prepare the sandbox: ${prepared.output.trim().slice(-500)}`);
    }
    return { sandbox, elevate };
  };

  const close = async (sandbox: SandboxHandle, runId: string, phase: string) => {
    const compute = await sandbox.stop().catch(() => null);
    if (compute && options.onCompute) options.onCompute({ ...compute, runId, phase });
  };

  return {
    kind: 'vercel',

    /**
     * Every sandbox this engine's tag can find, stopped.
     *
     * On boot, because the failure it repairs is a worker that died mid-run: the platform
     * will end those sessions at their own timeout, but that is up to an hour of compute
     * per phase nobody is watching. Returns how many it stopped so a caller can log a
     * number rather than a shrug.
     */
    sweep: async () => {
      // THIS WORKER'S sandboxes, from two sources that agree. The ledger is the record a
      // crashed process left; the tag query is the backstop for a ledger that was lost
      // with the disk. Both are scoped to this worker — a tag shared across a deployment
      // would have a booting worker stop every in-flight phase of every other one.
      const listed = await client.list(tags).catch(() => []);
      const ids = new Set([...(await remembered(options.ledger)), ...listed.map((one) => one.id)]);
      let stopped = 0;
      for (const id of ids) {
        const sandbox = await client.get(id);
        if (!sandbox) continue;
        // A sandbox already gone answers with a throw, which is the same outcome as one
        // we stopped and not worth telling apart.
        if (await sandbox.stop().then(() => true, () => false)) stopped += 1;
      }
      // The file has done its job. Left to grow it is an ever-longer list of dead ids
      // that every later sweep re-asks the platform about.
      if (options.ledger) await rm(options.ledger.path, { force: true }).catch(() => {});
      return stopped;
    },

    async buildSnapshot(plan, source, base, recipe) {
      const staging = await mkdtemp(join(tmpdir(), 'engine-vercel-env-'));
      let sandbox: SandboxHandle | undefined;
      try {
        const bytes = await bundle(source, staging);
        const job: Job = {
          runId: plan.runId,
          afterSeq: 0,
          sourcePath: BUNDLE,
          baseRef: base,
          // Never read on this path — the Runner returns before `verify()` — and set to
          // base rather than left to a default so nothing here names a commit that does
          // not exist yet.
          fixRef: base,
          repro: { command: '' },
          symptomPattern: plan.symptomPattern,
          only: 'env',
          recipe,
        };
        // `allow-all`: install needs a package registry, and this is the one sandbox in a
        // run that is allowed to reach one (ADR-0013). Nothing the agent wrote exists yet.
        const opened = await open({ image: plan.image }, 'allow-all', plan);
        sandbox = opened.sandbox;
        const elevate = opened.elevate;
        await sandbox.writeFiles([
          { path: BUNDLE, content: bytes },
          { path: JOB, content: Buffer.from(`${JSON.stringify(job)}\n`) },
        ]);
        // A wall clock of OUR own, beside the one handed to `run`. The Docker executor's
        // equivalent is emphatic that this is the guard against a wedge rather than a
        // scheduling policy, and it guards the one sandbox in a run with a network — the
        // longest operation and the one most able to hang on somebody else's registry.
        // Without it a control plane that stalls wedges the worker indefinitely.
        const ceiling = plan.containerTimeoutMs ?? PHASE_TIMEOUT_MS;
        // Cleared, not merely unref'd. A long-lived worker builds an environment per run,
        // and a timer left pending holds its closure — and the sandbox handle inside it —
        // for the whole ceiling, which is an hour by default.
        let bell: NodeJS.Timeout | undefined;
        const finished = await Promise.race([
          sandbox.run(runnerCommand(elevate, entry), { timeoutMs: ceiling }),
          new Promise<Finished>((resolve) => {
            bell = setTimeout(
              () => resolve({ exitCode: -1, output: `the environment build was stopped after ${ceiling}ms` }),
              ceiling + 30_000,
            );
            bell.unref();
          }),
        ]).finally(() => clearTimeout(bell));

        let env: ReplayOutcome | undefined;
        for (const line of finished.output.split('\n')) {
          if (line.trim() === '') continue;
          try {
            const parsed: unknown = JSON.parse(line);
            if (isWorkerReply(parsed) && 'env' in parsed) env = parsed.env;
          } catch {
            // Not a reply. This sandbox writes no events, so nothing else is expected.
          }
        }

        // Said in the recipe's own words where there are any: `replayRecipe` already names
        // the step that failed and redacts the command, and a paraphrase would be a
        // diagnosis nobody can act on.
        const failed =
          finished.exitCode !== 0
            ? `the environment build exited ${finished.exitCode}: ${finished.output.trim().split('\n').at(-1) ?? ''}`
            : env === undefined
              ? 'the environment build reported nothing about the recipe it replayed'
              : env.ready
                ? null
                : (env.failed ?? 'the environment did not build');
        if (failed !== null) return { failed: redact(failed).slice(0, MAX_REASON_CHARS) };

        // The Job, the bundle and the spool are OURS, not the repository's, and a snapshot
        // carrying them would put this run's inputs into every phase that judges — where a
        // reproduction could read the symptom pattern it is supposed to be tested against.
        const scrubbed = await sandbox.run(`${elevate}rm -rf ${WORK} ${BLOBS}`);
        if (scrubbed.exitCode !== 0) {
          // Reported, not ignored. A snapshot taken over a failed scrub carries this run's
          // Job and bundle into every phase that judges from it — where a reproduction can
          // read the symptom pattern it is supposed to be tested against — and nothing
          // downstream would ever notice.
          return { failed: redact(`could not remove this run's inputs before the snapshot: ${scrubbed.output.trim()}`).slice(0, MAX_REASON_CHARS) };
        }
        const snapshot = await sandbox.snapshot();
        // `snapshot()` stops the sandbox, and the SDK reports what a session cost only
        // from `stop()` — so the environment build, the longest-lived sandbox in a run,
        // reports no compute. Asked for anyway, in case a later SDK answers; a throw here
        // is the expected outcome and is not an error worth reporting.
        await sandbox
          .stop()
          .then((compute) => {
            if (compute && options.onCompute) options.onCompute({ ...compute, runId: plan.runId, phase: 'env' });
          })
          .catch(() => {});
        sandbox = undefined;
        return { snapshot, steps: (env?.steps ?? []).map(({ step, exit_code }) => ({ step, exit_code })) };
      } catch (error) {
        return { failed: `the environment build could not be run: ${String((error as Error).message ?? error)}` };
      } finally {
        if (sandbox) await close(sandbox, plan.runId, 'env');
        await rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    },

    dropSnapshot: async (snapshot) => {
      await client.dropSnapshot(snapshot.ref);
    },

    runPhase: (spec) => runPhase(spec, { client, entry, open, close, ledger: options.ledger }),
  };
}

type Inner = {
  client: SandboxClient;
  entry: string;
  open: (
    from: { image: string } | { snapshot: string },
    policy: 'allow-all' | 'deny-all',
    plan: { runId: string; containerTimeoutMs?: number },
  ) => Promise<{ sandbox: SandboxHandle; elevate: Elevate }>;
  close: (sandbox: SandboxHandle, runId: string, phase: string) => Promise<void>;
  ledger?: Ledger;
};

async function runPhase(spec: PhaseSpec, inner: Inner): Promise<PhaseResult> {
  const { plan, source, afterSeq, phase, overrides, driver } = spec;
  const job: Job = {
    runId: plan.runId,
    afterSeq,
    sourcePath: BUNDLE,
    baseRef: plan.baseRef,
    fixRef: overrides.fixRef ?? plan.fixRef ?? plan.baseRef,
    repro: overrides.repro ?? plan.repro ?? { command: '' },
    symptomPattern: plan.symptomPattern,
    ...(plan.recipe?.test === undefined ? {} : { suiteCommand: plan.recipe.test }),
    // The recipe itself, for its `env`: `world()` hands it to every command a phase runs,
    // and a phase job that carries no recipe gives the container that JUDGES none of the
    // configuration the agent's sandbox and the environment build both had. The Docker
    // executor carries it for the same reason and the same comment.
    //
    // Safe whole: a phase container never replays a recipe — `replayRecipe` is reached
    // only from the agent world and the environment build, both keyed on fields a phase
    // job does not set.
    ...(plan.recipe ? { recipe: plan.recipe } : {}),
    ...(plan.baseRuns === undefined ? {} : { baseRuns: plan.baseRuns }),
    ...(plan.flakeRuns === undefined ? {} : { flakeRuns: plan.flakeRuns }),
    ...(plan.timeoutMs === undefined ? {} : { timeoutMs: plan.timeoutMs }),
    ...(plan.agentTimeoutMs === undefined ? {} : { agentTimeoutMs: plan.agentTimeoutMs }),
    ...overrides,
  };

  const staging = await mkdtemp(join(tmpdir(), 'engine-vercel-phase-'));
  const handover = phase === 'agent' ? await mkdtemp(join(tmpdir(), 'engine-handover-')) : undefined;
  /** Whether the result this returns carries `handover`, which decides who owns it. */
  let returned = false;
  const eventLines: string[] = [];
  const pending = new Map<string, (result: { ok: boolean; output: string }) => void>();
  let ready = () => {};
  const readied = new Promise<void>((resolve) => (ready = resolve));
  let handoverReport: string | null | undefined;
  let envReport: ReplayOutcome | undefined;
  let suiteReport: SuiteProbe | undefined;
  let stderr = '';
  let totalBytes = 0;
  let truncated = false;
  let ceiling: 'wall' | 'session' | undefined;
  let sandbox: SandboxHandle | undefined;
  /**
   * Events this executor writes BEFORE the container says anything, and after.
   *
   * Split because seqs have to be contiguous and the container allocates its own from
   * `job.afterSeq`. A judging phase is probed before its Runner starts, so its seal
   * genuinely precedes everything the container observed and must be numbered that way —
   * the Job's `afterSeq` is bumped past it. Anything written afterwards (the ceiling, a
   * collection failure) continues from the container's last.
   */
  const pre: RunEvent[] = [];
  const post: RunEvent[] = [];

  const take = (line: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Not JSON at all. Kept as an event line so `parse` fails loudly rather than
      // silently dropping something that was supposed to be a fact.
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
      if (settle) {
        pending.delete(parsed.result.id);
        settle({ ok: parsed.result.ok, output: parsed.result.output });
      }
    }
  };

  try {
    const bytes = await bundle(source, staging);
    // The AGENT gets a network, because `install` needs a registry and this is the only
    // sandbox in the run that replays a recipe. Everything that JUDGES is created
    // `deny-all` and stays that way: a reproduction that can reach the network is a
    // reproduction that can be TOLD what to answer, and code under judgement must not be
    // able to exfiltrate the repository it was handed.
    const wantsNetwork = phase === 'agent' && Boolean(plan.recipe || plan.draftingEnvironment);
    const from =
      phase === 'agent'
        ? { image: plan.agentImage ?? plan.image }
        : spec.from
          ? { snapshot: spec.from.ref }
          : { image: plan.image };
    // Refused rather than ignored. Docker mounts this binary into the container; there is
    // no bind mount here, so a plan carrying one would run an agent phase with no agent
    // and report whatever that produced. Only the Docker-gated tests set it today, which
    // is exactly why a silent divergence between two implementations of one contract
    // would go unnoticed.
    if (plan.agentImageMount !== undefined) {
      throw new Error('agentImageMount is a bind mount and this executor has none; build the binary into the image');
    }
    // THE IN-CONTAINER AGENT IS NOT AVAILABLE HERE, and refusing is the only honest
    // answer (ADR-0011, ADR-0021).
    //
    // `agentPrompt` runs the loop inside the sandbox. That needs a model credential in
    // there and a route to the model API for the whole session — which is exactly what
    // ADR-0011 moved outside and what ADR-0021 says is in no sandbox at all. It also has
    // no `{ready}` handshake, so there is no moment at which this executor could seal the
    // machine: `wantsNetwork` would be true, the pre-seal skipped, and the flip lives
    // behind the driver. The agent would run its whole life with a full route out and the
    // log would say nothing about it — a silence exactly where the substrate's central
    // claim is supposed to be.
    //
    // Docker keeps that path because it is the M3.1 shape the suite still drives. This
    // executor supports the ADR-0011 topology only, and says so rather than running an
    // unsealed agent.
    if (overrides.agentPrompt !== undefined) {
      throw new Error(
        'this executor cannot run the agent inside the sandbox: there is no moment at which it ' +
          'could be sealed, and the model key belongs in the worker (ADR-0011, ADR-0021)',
      );
    }
    // The two halves of the tool protocol travel together. `serveTools` with nothing
    // driving it serves forever; a driver with no `serveTools` is a container that never
    // reads the spool, and — because the seal is emitted mid-stream on that path — it is
    // also the one shape in which this executor's own seq and the Runner's could collide.
    if (Boolean(driver) !== Boolean(overrides.serveTools)) {
      throw new Error('a driver and `serveTools` are the two halves of one protocol; pass both or neither');
    }
    const opened = await inner.open(from, wantsNetwork ? 'allow-all' : 'deny-all', plan);
    sandbox = opened.sandbox;
    const elevate = opened.elevate;

    /** Set when a probe found a way out, which refuses the phase without losing it. */
    let unsealed: string | undefined;

    /**
     * The phase, refused, with the record kept.
     *
     * Returned rather than thrown for the reason `executor.ts` gives — this method must
     * not throw for an outcome the design has a name for — and the design has one:
     * `SANDBOX_SEALED` carries `probe: true`, and `cause: 'environment'` is what makes
     * the fold disqualify the attempt and the run end `errored`. Throwing unwound the
     * whole run and took every fact observed before this phase with it.
     */
    const refusal = (): PhaseResult => {
      pre.push(
        own(plan.runId, 0, {
          type: 'VERIFICATION_ABORTED',
          payload: { v: 1, phase: 'setup', cause: 'environment', reason: unsealed!.slice(0, MAX_REASON_CHARS) },
        }),
      );
      let seq = afterSeq;
      return {
        phase,
        events: pre.map((event) => ({ ...event, seq: ++seq })),
        exitCode: 1,
        stderr: unsealed!,
      };
    };

    /**
     * Establish, and RECORD, that this sandbox has no way out.
     *
     * Run for every sandbox whose word this engine then takes — which is all of them, and
     * the judging ones most of all. The agent's sandbox is the one ADR-0010 says "is not
     * contained, and it no longer needs to be": nothing worth stealing lives there and
     * nothing it produces is trusted. Base and fix are the opposite. Their output IS the
     * evidence, and `executor-docker.ts` names the risk in its own words — "a
     * reproduction that can reach the network is a reproduction that can be TOLD what to
     * answer". A `deny-all` the platform accepted and did not apply would produce a
     * fabricated verdict that nothing else in this design would notice.
     *
     * So the ADR's own argument — the policy you sent is not the policy the platform
     * holds — is applied to every sandbox rather than to the one that is easiest to
     * reason about.
     */
    const seal = async (at: SandboxHandle, flip: boolean) => {
      if (flip) await at.setNetworkPolicy('deny-all');
      const observed = await probe(at);
      // Into `pre`, for both kinds. A judging phase is probed before its Runner starts.
      // The agent's is probed mid-stream — but in `serveTools` mode the container writes
      // no events at all (ADR-0006's amendment moves the pen to the host), so this is
      // still the first event of the phase, and it has to be: the orchestrator writes
      // every `AGENT_MESSAGE` afterwards, numbering from where this executor stopped.
      pre.push(
        own(plan.runId, 0, {
          type: 'SANDBOX_SEALED',
          payload: { v: 1, sandbox_id: at.id, phase, policy: 'deny-all', probe: observed },
        }),
      );
      if (observed.dns || observed.route) {
        unsealed =
          `the ${phase} sandbox still reached the network under deny-all ` +
          `(dns ${observed.dns}, route ${observed.route})`;
      }
    };


    // FIRST, for a phase that judges, and before it is given the source or the Job. It was
    // created sealed; this is the check that it is. Doing it here rather than after the
    // Runner starts has two consequences that are both wanted: the seal genuinely
    // precedes every observation the container makes, and a sandbox the platform failed
    // to seal never receives this repository's code at all.
    if (!wantsNetwork) await seal(sandbox, false);
    if (unsealed) return refusal();

    // The Runner continues the log after whatever this executor wrote first, so its own
    // events cannot collide with the seal's seq. The fold refuses a gap and a duplicate
    // alike, and neither would be visible until a real run folded.
    await sandbox.writeFiles([
      { path: BUNDLE, content: bytes },
      { path: JOB, content: Buffer.from(`${JSON.stringify({ ...job, afterSeq: afterSeq + pre.length })}\n`) },
    ]);

    const started = await sandbox.start(runnerCommand(elevate, inner.entry));
    const stdout = (async function* () {
      for await (const chunk of started.chunks()) {
        if (chunk.stream === 'stderr') {
          stderr = (stderr + chunk.data).slice(-MAX_STDERR_CHARS);
          continue;
        }
        if (totalBytes + chunk.data.length > MAX_STREAM_BYTES) {
          truncated = true;
          continue;
        }
        totalBytes += chunk.data.length;
        yield chunk.data;
      }
    })();
    // Consumed in the background, because a driver has to be able to send a call and
    // await its reply while this keeps reading. The promise is awaited before the phase
    // returns, so nothing here outlives the function.
    const draining = (async () => {
      try {
        for await (const line of asLines(stdout)) take(line);
      } catch (error) {
        // THE SUBSTRATE'S CEILING, arriving mid-phase. Everything already taken stays
        // taken — that is the whole reason this is caught rather than allowed to reject.
        if (!(error instanceof SessionEnded)) throw error;
        ceiling ??= 'session';
      }
    })();
    // ABANDONED, not merely killed. A sandbox whose stream has stopped producing is the
    // wedge the ceiling exists for, and `kill()` is a request to the platform: waiting on
    // the iterator to notice would make the ceiling itself hang, which is the one failure
    // this code must not have. So every path that gives up on the phase resolves this,
    // and the drain is awaited only as far as whichever comes first.
    let abandon = () => {};
    const abandoned = new Promise<void>((resolve) => (abandon = resolve));
    const settled = Promise.race([draining.catch(() => {}), abandoned]);

    let calls = 0;
    const invoke = async (tool: string, input: Record<string, unknown>) => {
      const id = `h${++calls}`;
      return await new Promise<{ ok: boolean; output: string }>((resolve, reject) => {
        pending.set(id, resolve);
        // Races the sandbox's own exit, exactly as the Docker path does: a machine that
        // dies mid-loop would otherwise leave the driver awaiting a reply forever.
        void settled.then(() => {
          if (pending.delete(id)) reject(new Error('the sandbox stopped before answering'));
        });
        void deliver(
          sandbox!,
          elevate,
          `${String(calls).padStart(9, '0')}.json`,
          `${JSON.stringify({ call: { id, tool, input } } satisfies WorkerRequest)}\n`,
        ).catch((error: unknown) => {
          if (pending.delete(id)) reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
    };

    const bell = setTimeout(() => {
      ceiling = 'wall';
      void started.kill().catch(() => {});
      abandon();
    }, plan.containerTimeoutMs ?? PHASE_TIMEOUT_MS);

    let exitCode = 0;
    try {
      if (driver) {
        await Promise.race([readied, settled]);
        // THE SEAL, for the agent. After the world is up and before its first turn, which
        // is the only ordering that is both useful and safe: `install` has had its
        // registry, and nothing the model says has reached this machine yet.
        if (wantsNetwork && (!envReport || envReport.ready)) await seal(sandbox, true);
        if (unsealed) {
          // Nothing more will be read from this machine, and the `finally` below stops it.
          await started.kill().catch(() => {});
          abandon();
        }
        try {
          if (!unsealed && (!envReport || envReport.ready)) await driver({ invoke });
        } finally {
          // NOT swallowed. Without this line the Runner serves forever, `wait()` never
          // resolves, and the phase burns its whole wall clock before reporting a
          // ceiling that says nothing about the real cause.
          await deliver(
            sandbox,
            elevate,
            `${String(++calls).padStart(9, '0')}.json`,
            `${JSON.stringify({ done: true } satisfies WorkerRequest)}\n`,
          ).catch((error: unknown) => {
            stderr = `${stderr}\ncould not tell the sandbox to stop serving: ${String(error)}`.slice(
              -MAX_STDERR_CHARS,
            );
            abandon();
          });
        }
      }
      exitCode = ceiling
        ? 1
        : await Promise.race([started.wait(), abandoned.then(() => 1)]).catch((error: unknown) => {
            // `wait()` is the other place the platform says the session is over, and the
            // spike saw it as a 410. Caught here as well as on the stream because either
            // can arrive first, and a phase that got this far has a stream worth keeping.
            if (!(error instanceof SessionEnded)) throw error;
            ceiling ??= 'session';
            return 1;
          });
    } finally {
      clearTimeout(bell);
      await settled;
    }

    // The artifacts, out of a machine about to cease to exist. `put()` rather than a copy,
    // so every blob is re-digested on the way into the evidence store: the bytes crossed a
    // network this time, and a ref that names bytes nobody checked is exactly the kind of
    // claim this project does not make.
    const collection = await collect(sandbox, plan.blobRoot, staging);
    if (handover) {
      const left = await sandbox.readFile('/out/agent.bundle');
      // A bundle that is not there is an agent that committed nothing, which
      // `applyHandover` already reports in its own words. Writing an empty file would turn
      // that into a corrupt-bundle error about a bundle nobody made.
      if (left && left.length > 0) await writeFile(join(handover, 'agent.bundle'), left);
    }

    // A SEAL THAT DID NOT TAKE, recorded rather than thrown (ADR-0006, ADR-0007).
    //
    // Throwing here unwound the whole run: `orchestrate()` accumulates events locally and
    // returns them only at the end, so an exception from the fix agent's phase discarded
    // `ATTEMPT_STARTED`, the registration, every base `TEST_RUN` — every fact observed so
    // far — and left a message string as the only record. That is the evidence-loss shape
    // `executor-docker.ts` says it fixed twice, and `executor.ts` says this method must
    // never throw for an outcome the design has a name for. It has one: the
    // `SANDBOX_SEALED` above carries `probe: true`, the fold has a branch for it, and
    // `cause: 'environment'` is what makes the fold disqualify the attempt and the run end
    // `errored`. Refusing this way refuses just as hard and keeps the record.
    if (unsealed) {
      post.push(
        own(plan.runId, 0, {
          type: 'VERIFICATION_ABORTED',
          payload: { v: 1, phase: 'setup', cause: 'environment', reason: unsealed.slice(0, MAX_REASON_CHARS) },
        }),
      );
      exitCode = exitCode === 0 ? 1 : exitCode;
    }

    if (ceiling) {
      stderr = `${stderr}\n${
        ceiling === 'session'
          ? `the ${phase} sandbox's session was ended by the platform`
          : `the ${phase} sandbox was stopped after ${plan.containerTimeoutMs ?? PHASE_TIMEOUT_MS}ms`
      }`.slice(-MAX_STDERR_CHARS);
      post.push(
        own(plan.runId, 0, {
          type: 'VERIFICATION_ABORTED',
          payload: {
            v: 1,
            phase: 'setup',
            cause: 'ceiling',
            reason:
              ceiling === 'session'
                ? `the ${phase} sandbox's session was ended by the platform before the phase finished`
                : `the ${phase} sandbox exceeded this engine's wall clock`,
          },
        }),
      );
    }

    if (truncated) {
      throw new Error(`the ${phase} sandbox produced more than ${MAX_STREAM_BYTES} bytes of events`);
    }
    const observed = eventLines.map((line) => JSON.parse(line) as RunEvent);
    if (collection) {
      post.push(
        own(plan.runId, 0, {
          type: 'VERIFICATION_ABORTED',
          payload: {
            v: 1,
            phase: 'cleanup',
            cause: 'collection',
            reason: redact(collection).slice(0, MAX_REASON_CHARS),
          },
        }),
      );
    }
    // RENUMBERED, all of it, in one place. Not merely arranged around the Job's bumped
    // `afterSeq`: that only holds while `pre` stops growing before the Job is written, and
    // it does not — the agent's seal is pushed mid-stream. Trusting the arithmetic made a
    // driver-without-`serveTools` phase emit two events at seq 1, and `fold()` threw on
    // the gap that left. The guard above now refuses that combination, and this makes the
    // collision impossible rather than merely unreachable.
    //
    // Safe because a seq is an ordering and nothing else: no payload in this log refers to
    // another event by number, and the Runner allocates contiguously, so shifting its
    // block preserves the order it observed things in.
    let seq = afterSeq;
    const all = [...pre, ...observed, ...post].map((event) => ({ ...event, seq: ++seq }));
    returned = true;
    return {
      phase,
      events: all,
      exitCode,
      stderr: stderr.trim(),
      ...(ceiling ? { ceiling } : {}),
      ...(handover ? { handover } : {}),
      ...(handoverReport === undefined ? {} : { handoverReport }),
      ...(envReport === undefined ? {} : { envReport }),
      ...(suiteReport === undefined ? {} : { suiteReport }),
    };
  } finally {
    // ALWAYS. A sandbox left running bills by the second, and the ledger exists precisely
    // because this line cannot be relied on when the process dies.
    if (sandbox) await inner.close(sandbox, plan.runId, phase);
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    // A refused phase hands nothing over, so its directory is a host temp dir nobody will
    // ever look in. `refusal()` returns without it, which is what makes it removable here
    // — the success path's is the caller's, and `orchestrate` owns that one.
    if (handover && !returned) await rm(handover, { recursive: true, force: true }).catch(() => {});
  }
}

/** What the sandbox could still reach, observed by running commands inside it. */
async function probe(sandbox: SandboxHandle): Promise<{ dns: boolean; route: boolean }> {
  const [dns, route] = await Promise.all([
    sandbox.run(PROBE.dns, { timeoutMs: 30_000 }),
    sandbox.run(PROBE.route, { timeoutMs: 30_000 }),
  ]);
  // Exit 0 means the probe REACHED something. Anything else — including a probe that
  // could not run at all — is reported as "did not reach", which is the safe direction
  // only because the caller refuses on `true` and this cannot manufacture a false.
  return { dns: dns.exitCode === 0, route: route.exitCode === 0 };
}

/**
 * The store, out of the sandbox and into the host's evidence store.
 *
 * Tar rather than a file listing plus reads, because a phase can leave hundreds of blobs
 * and a round trip each would dominate the phase. Returns prose on failure rather than
 * throwing: this runs MID-RUN, and a rejection here would discard every phase captured so
 * far — the evidence-loss shape the Docker executor's own comment records.
 */
async function collect(sandbox: SandboxHandle, blobRoot: string, staging: string): Promise<string> {
  try {
    // Tar's own words kept, not sent to `/dev/null`. The exit code alone turns "no space
    // left on device" into `TAR 2`, which is the drops-the-tool's-diagnosis mistake this
    // codebase has made more than once. `TAR <n>` on its own line is read from the END,
    // because the archive listing precedes it and a substring match anywhere in a stream
    // the guest influences is not a check.
    const tarred = await sandbox.run(`tar -cf ${WORK}/blobs.tar -C ${BLOBS} .; echo "TAR $?"`);
    const status = tarred.output.trim().split('\n').at(-1) ?? '';
    if (status !== 'TAR 0') {
      return `could not archive this sandbox's artifacts (${status}): ${tarred.output.trim().slice(-500)}`;
    }
    const bytes = await sandbox.readFile(`${WORK}/blobs.tar`);
    if (!bytes) return "this sandbox's artifacts could not be read back";
    // A CEILING, because what lands in `/blobs` is what the agent's own commands produced.
    // The event stream has had one since M4 and this did not: a phase that
    // filled its store would have had every byte read into host memory and written into
    // the evidence store. Reported rather than thrown, like every other collection
    // failure — the events are the record and they are worth keeping.
    if (bytes.length > MAX_STORE_BYTES) {
      return `this sandbox's artifacts are ${bytes.length} bytes, more than the ${MAX_STORE_BYTES} a phase may leave`;
    }
    const archive = join(staging, 'blobs.tar');
    await writeFile(archive, bytes);
    const into = join(staging, 'blobs');
    await mkdir(into, { recursive: true });
    await execFile('tar', ['-xf', archive, '-C', into]);

    // RECURSIVELY, and this is not a nicety. `put()` writes `<root>/<aa>/<bb>/<rest>` —
    // two levels of fan-out — so a store contains directories at its top level and no
    // files at all. A loop over the top level that skipped non-files skipped every blob
    // and then returned success, which is the worst available outcome: a complete event
    // stream whose `stdout_hash` refs name bytes that are not in the evidence store, a
    // fold that says `reproduced: true`, and an ENOENT for whoever opens the report.
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === '.evidence-store') continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        if (!entry.isFile()) continue;
        // Re-digested: `put` names the bytes by what they ARE, so a blob altered in
        // transit lands under a ref nothing cites rather than under the ref it claimed.
        await put(blobRoot, await readFile(path));
      }
    };
    await walk(into);
    return '';
  } catch (error) {
    return `could not collect this sandbox's artifacts: ${String((error as Error).message ?? error)}`;
  }
}
