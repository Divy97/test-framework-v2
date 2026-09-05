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
//   - **The Runner runs as root, via sudo.** The managed image's default user is uid 1000,
//     which is the uid the repro drops to — and what keeps an untrusted agent away from
//     the event channel is the kernel refusing one user another's file descriptors, not
//     any trick with fd 1. `runner-vm.ts` refuses to start as uid 1000 for exactly this,
//     so a `sudo` forgotten here is a loud failure rather than a silent hole.
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
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
import { asLines, type Compute, type SandboxClient, type SandboxHandle } from './vercel-client.js';

const execFile = promisify(execFileCb);

/** Output ceiling per phase, matching the Docker executor's. */
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
/** Tail of a phase's diagnostics. The reason is at the end, not the start. */
const MAX_STDERR_CHARS = 8 * 1024;
/** The wall clock one phase gets from this process. The platform enforces its own beside it. */
const PHASE_TIMEOUT_MS = 3_600_000;

/** Where the engine puts things inside a sandbox. Root-owned until `PREPARE` runs. */
const WORK = '/work';
const BLOBS = '/blobs';
const SPOOL = `${WORK}/rpc`;
const BUNDLE = `${WORK}/src.bundle`;
const JOB = `${WORK}/job.json`;

/**
 * Make the paths the Runner needs, and hand them to the user `writeFiles` writes as.
 *
 * The managed image runs as uid 1000 with passwordless sudo, and `/`, `/opt` and `/blobs`
 * are root's. Without this every `writeFiles` fails with a permission error that reads
 * like a transport fault. `/blobs` gets the sentinel here rather than in the image,
 * because the Runner refuses a store it cannot prove pre-existed.
 */
const PREPARE = [
  `sudo -n mkdir -p ${WORK} ${SPOOL}/in ${SPOOL}/out /opt/env ${BLOBS}`,
  `sudo -n chown -R "$(id -u):$(id -g)" ${WORK} /opt/env ${BLOBS}`,
  `: > ${BLOBS}/.evidence-store`,
  // Root-owned 0700, so the repro — uid 1000 — cannot forge a `{done: true}` and choose
  // its own ending, or answer a tool call on the host's behalf.
  `sudo -n chown -R root:root ${SPOOL} && sudo -n chmod -R 0700 ${SPOOL}`,
].join(' && ');

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

/** How the Runner is started. `sudo`, which is the whole precondition (see the header). */
const runnerCommand = (entry: string) => `sudo -n ${entry} --job ${JOB} --spool ${SPOOL}`;

/**
 * What a run leaves behind if this process dies: one line per live sandbox.
 *
 * A file rather than a table, and written BEFORE the sandbox exists rather than after.
 * The window this closes is the one that matters — a worker killed between `create` and
 * the first line of bookkeeping leaves a machine nobody knows about, billing by the
 * second until its own session timeout. Written first, the worst case is a line naming a
 * sandbox that was never made, which `sweep` handles by getting null and moving on.
 */
type Ledger = { path: string };

const remember = async (ledger: Ledger | undefined, entry: { sandboxId: string; runId: string }) => {
  if (!ledger) return;
  await writeFile(ledger.path, `${JSON.stringify(entry)}\n`, { flag: 'a' }).catch(() => {});
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
  /** What every sandbox is tagged with, so `sweep` can find them. */
  tags?: Record<string, string>;
  /** The command that starts `runner-vm.ts` inside the image. */
  entrypoint?: string;
  /** Called with what each sandbox cost, once it is stopped. 10f writes these to a table. */
  onCompute?: (compute: Compute & { runId: string; phase: string }) => void;
};

export function vercelExecutor(options: VercelExecutorOptions): Executor & { sweep: () => Promise<number> } {
  const { client } = options;
  const entry = options.entrypoint ?? 'node --import tsx /engine/src/runner-vm.ts';
  const tags = options.tags ?? { engine: 'test-framework-v2' };

  /** Create, prepare, and record — in the order that leaves nothing unaccounted for. */
  const open = async (
    from: { image: string } | { snapshot: string },
    policy: 'allow-all' | 'deny-all',
    plan: { runId: string; containerTimeoutMs?: number },
  ): Promise<SandboxHandle> => {
    const timeoutMs = plan.containerTimeoutMs ?? PHASE_TIMEOUT_MS;
    const sandbox = await client.create({ from, policy, timeoutMs, tags });
    await remember(options.ledger, { sandboxId: sandbox.id, runId: plan.runId });
    const prepared = await sandbox.run(PREPARE);
    if (prepared.exitCode !== 0) {
      // Not recoverable and not the repository's fault: the image is ours. Stopping here
      // rather than proceeding means the failure names the step instead of arriving three
      // calls later as a permission error on a file write.
      await sandbox.stop().catch(() => {});
      throw new Error(`could not prepare the sandbox: ${prepared.output.trim().slice(-500)}`);
    }
    return sandbox;
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
      const live = await client.list(tags).catch(() => []);
      let stopped = 0;
      for (const { id } of live) {
        const sandbox = await client.get(id);
        if (!sandbox) continue;
        // A sandbox already gone answers with a throw, which is the same outcome as one
        // we stopped and not worth telling apart.
        if (await sandbox.stop().then(() => true, () => false)) stopped += 1;
      }
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
        sandbox = await open({ image: plan.image }, 'allow-all', plan);
        await sandbox.writeFiles([
          { path: BUNDLE, content: bytes },
          { path: JOB, content: Buffer.from(`${JSON.stringify(job)}\n`) },
        ]);
        const finished = await sandbox.run(runnerCommand(entry), {
          timeoutMs: plan.containerTimeoutMs ?? PHASE_TIMEOUT_MS,
        });

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
        await sandbox.run(`sudo -n rm -rf ${WORK} ${BLOBS}`);
        const snapshot = await sandbox.snapshot();
        // `snapshot()` stops the sandbox, so there is nothing left to stop; asking again
        // is an error we do not want to report as one.
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
  ) => Promise<SandboxHandle>;
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
  const events: RunEvent[] = [];
  let nextSeq = afterSeq;

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
    sandbox = await inner.open(from, wantsNetwork ? 'allow-all' : 'deny-all', plan);
    await sandbox.writeFiles([
      { path: BUNDLE, content: bytes },
      { path: JOB, content: Buffer.from(`${JSON.stringify(job)}\n`) },
    ]);

    const started = await sandbox.start(runnerCommand(inner.entry));
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
      for await (const line of asLines(stdout)) take(line);
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
        void sandbox!
          .writeFiles([
            {
              path: `${SPOOL}/in/${String(calls).padStart(9, '0')}.json`,
              content: Buffer.from(`${JSON.stringify({ call: { id, tool, input } } satisfies WorkerRequest)}\n`),
            },
          ])
          .catch((error: unknown) => {
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
        // THE SEAL. After the world is up and before the agent's first turn, which is the
        // only ordering that is both useful and safe: `install` has had its registry, and
        // nothing the model says has reached this machine yet.
        if (wantsNetwork && (!envReport || envReport.ready)) {
          await sandbox.setNetworkPolicy('deny-all');
          const observed = await probe(sandbox);
          events.push(
            own(plan.runId, ++nextSeq, {
              type: 'SANDBOX_SEALED',
              payload: { v: 1, sandbox_id: sandbox.id, policy: 'deny-all', probe: observed },
            }),
          );
          if (observed.dns || observed.route) {
            // Nothing more will be read from this machine, and the `finally` below stops
            // it. Abandoning first means the drain does not hold the throw up.
            await started.kill().catch(() => {});
            abandon();
            // Refused rather than reported. The whole claim this substrate was chosen for
            // is that the agent works with no route out; running one that still has a
            // route and calling the result evidence would be the lie in the other
            // direction from the one ADR-0006 is about.
            throw new SealFailed(
              `the sandbox still reached the network after the policy was set to deny-all ` +
                `(dns ${observed.dns}, route ${observed.route})`,
            );
          }
        }
        try {
          if (!envReport || envReport.ready) await driver({ invoke });
        } finally {
          await sandbox
            .writeFiles([
              {
                path: `${SPOOL}/in/${String(++calls).padStart(9, '0')}.json`,
                content: Buffer.from(`${JSON.stringify({ done: true } satisfies WorkerRequest)}\n`),
              },
            ])
            .catch(() => {});
        }
      }
      exitCode = ceiling ? 1 : await Promise.race([started.wait(), abandoned.then(() => 1)]);
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

    if (ceiling) {
      stderr = `${stderr}\nthe ${phase} sandbox was stopped after ${plan.containerTimeoutMs ?? PHASE_TIMEOUT_MS}ms`.slice(
        -MAX_STDERR_CHARS,
      );
      events.push(
        own(plan.runId, ++nextSeq, {
          type: 'VERIFICATION_ABORTED',
          payload: { v: 1, phase: 'setup', cause: 'ceiling', reason: `the ${phase} sandbox exceeded its wall clock` },
        }),
      );
    }

    if (truncated) {
      throw new Error(`the ${phase} sandbox produced more than ${MAX_STREAM_BYTES} bytes of events`);
    }
    const observed = eventLines.map((line) => JSON.parse(line) as RunEvent);
    // The executor's own events go AFTER the Runner's, renumbered from the last seq the
    // Runner used. Interleaving them would need a seq nobody has allocated yet, and the
    // fold refuses a gap.
    const last = observed.at(-1)?.seq ?? afterSeq;
    const mine = events.map((event, index) => ({ ...event, seq: last + index + 1 }));
    const all = [...observed, ...mine];
    if (collection) {
      all.push(
        own(plan.runId, (all.at(-1)?.seq ?? afterSeq) + 1, {
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
  }
}

/** A seal that did not take. Its own class so a caller can tell it from a transport fault. */
export class SealFailed extends Error {}

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
    const tarred = await sandbox.run(`tar -cf ${WORK}/blobs.tar -C ${BLOBS} . 2>/dev/null; echo TAR $?`);
    if (!tarred.output.includes('TAR 0')) return `could not archive this sandbox's artifacts: ${tarred.output.trim()}`;
    const bytes = await sandbox.readFile(`${WORK}/blobs.tar`);
    if (!bytes) return "this sandbox's artifacts could not be read back";
    const archive = join(staging, 'blobs.tar');
    await writeFile(archive, bytes);
    const into = join(staging, 'blobs');
    await execFile('mkdir', ['-p', into]);
    await execFile('tar', ['-xf', archive, '-C', into]);
    for (const entry of await readdir(into)) {
      if (entry === '.evidence-store') continue;
      const path = join(into, entry);
      if (!(await stat(path)).isFile()) continue;
      // Re-digested: `put` names the bytes by what they ARE, so a blob altered in transit
      // lands under a ref nothing cites rather than under the ref it claimed.
      await put(blobRoot, await readFile(path));
    }
    return '';
  } catch (error) {
    return `could not collect this sandbox's artifacts: ${String((error as Error).message ?? error)}`;
  }
}
