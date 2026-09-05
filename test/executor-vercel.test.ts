// The seal, the order, and the teardown (M10, 10d, ADR-0021).
//
// Every test here is about a decision the executor makes, never about the transport: the
// substrate is a fake with an in-memory filesystem, and what is asserted is what the
// executor DID with it. Three properties carry the milestone's whole claim about
// isolation, and each has a control that fails when the property is removed:
//
//   - a container that judges is created `deny-all` and never flips;
//   - the agent's sandbox is flipped and PROBED before its first tool call, and the probe
//     is what `SANDBOX_SEALED` records — not the policy we asked for;
//   - a probe that still reaches the network refuses the phase rather than reporting it.
//
// The fourth is unglamorous and is the one that costs money: every sandbox is stopped,
// on every path, including the ones that throw.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { RunEvent } from '../src/events.js';
import { fold } from '../src/fold.js';
import { SealFailed, vercelExecutor } from '../src/executor-vercel.js';
import type { RunPlan } from '../src/orchestrate.js';
import { fakeSandboxes, line, type RunnerContext } from './fixtures/sandbox.js';

const RUN = '7c1e5f20-6b3a-4c8d-9e11-3f4a5b6c7d8e';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** A bare repository with one commit, which is all `git bundle create --all` needs. */
const repo = (): string => {
  const dir = temp('engine-vercel-src-');
  const work = join(dir, 'work');
  execFileSync('git', ['init', '--quiet', work]);
  writeFileSync(join(work, 'README'), 'hello\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' };
  execFileSync('git', ['-C', work, 'add', 'README']);
  execFileSync('git', ['-C', work, 'commit', '--quiet', '-m', 'one'], { env });
  const bare = join(dir, 'mirror.git');
  execFileSync('git', ['clone', '--quiet', '--no-local', '--mirror', '--', work, bare]);
  return bare;
};

const blobRoot = (): string => {
  const dir = temp('engine-vercel-blobs-');
  writeFileSync(join(dir, '.evidence-store'), '');
  return dir;
};

const plan = (over: Partial<RunPlan> = {}): RunPlan =>
  ({
    runId: RUN,
    repoPath: '/unused',
    blobRoot: blobRoot(),
    image: 'engine:test',
    baseRef: 'main',
    symptomPattern: 'wrong',
    repro: { command: 'true' },
    ...over,
  }) as RunPlan;

/** An event line as the Runner writes it: an envelope with a seq the host does not allocate. */
const event = (seq: number, type: string, payload: unknown) =>
  line({ run_id: RUN, seq, ts: '2026-09-06T00:00:00.000Z', type, payload });

describe('a container that judges never has a network', () => {
  test('it is created deny-all, from the snapshot, and the policy is never touched', async () => {
    const fake = fakeSandboxes({
      runner: async function* () {
        yield event(1, 'TEST_RUN', { v: 1, phase: 'base', commit_sha: 'a'.repeat(40), exit_code: 1, duration_ms: 5, symptom_matched: true });
      },
    });
    const executor = vercelExecutor({ client: fake.client });
    const result = await executor.runPhase({
      plan: plan(),
      source: repo(),
      afterSeq: 0,
      phase: 'base',
      overrides: {},
      from: { ref: 'snap-1' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.events).toHaveLength(1);
    const sandbox = fake.sandboxes[0]!;
    expect(sandbox.createdWith).toBe('deny-all');
    expect(sandbox.from).toEqual({ snapshot: 'snap-1' });
    // Never flipped: a phase that could change its own policy is a phase that could open
    // a route to be told what to answer.
    expect(sandbox.flippedAfter).toBeNull();
    expect(sandbox.policy).toBe('deny-all');
    expect(sandbox.stopped).toBe(true);
  });

  test('THE control: the agent phase with a recipe IS created allow-all', async () => {
    // Without this the test above passes on an executor that creates everything sealed,
    // which would be a different bug: `install` needs a package registry, and an agent
    // sandbox with no route out cannot boot the project it is meant to explore.
    const fake = fakeSandboxes({
      runner: async function* ({ awaitSpool }: RunnerContext) {
        yield line({ env: { ready: true, steps: [], services: [] } });
        yield line({ ready: true });
        await awaitSpool((written) => written.includes('"done":true'));
        yield line({ finished: { handover: null } });
      },
    });
    const executor = vercelExecutor({ client: fake.client });
    await executor.runPhase({
      plan: plan({ recipe: { install: 'npm ci', services: [] } }),
      source: repo(),
      afterSeq: 0,
      phase: 'agent',
      overrides: { serveTools: true },
      driver: async () => {},
    });
    expect(fake.sandboxes[0]!.createdWith).toBe('allow-all');
  });
});

describe('the agent sandbox is sealed before it is asked anything', () => {
  /** A Runner that stands the world up, then answers one tool call, then finishes. */
  const serving = async function* ({ awaitSpool }: RunnerContext) {
    yield line({ env: { ready: true, steps: [{ step: 'install', exit_code: 0, output: '' }], services: [] } });
    yield line({ ready: true });
    const call = await awaitSpool((written) => written.includes('"call"'));
    const id = (JSON.parse(call) as { call: { id: string } }).call.id;
    yield line({ result: { id, ok: true, output: 'done' } });
    // No events. That is not a simplification: in `serveTools` mode the container is not
    // a writer at all (ADR-0006's amendment), and the transcript becomes AGENT_MESSAGE
    // payloads in the orchestrator afterwards. Which is exactly why the seal's seq has to
    // come before anything the orchestrator then allocates.
    await awaitSpool((written) => written.includes('"done":true'));
    yield line({ finished: { handover: null } });
  };

  test('the flip and the probe both happen before the first tool call', async () => {
    const fake = fakeSandboxes({ runner: serving });
    const executor = vercelExecutor({ client: fake.client });
    let policyAtFirstCall: string | undefined;
    let probedBefore = 0;

    const result = await executor.runPhase({
      plan: plan({ recipe: { install: 'npm ci', services: [] } }),
      source: repo(),
      afterSeq: 0,
      phase: 'agent',
      overrides: { serveTools: true },
      driver: async ({ invoke }) => {
        const sandbox = fake.sandboxes[0]!;
        policyAtFirstCall = sandbox.policy;
        probedBefore = sandbox.commands.filter((command) => command.includes("require('dns')")).length;
        await invoke('read', { path: 'README' });
      },
    });

    // The ordering, at the moment it matters: the driver's first call is the earliest the
    // model can have influenced anything inside that machine.
    expect(policyAtFirstCall).toBe('deny-all');
    expect(probedBefore).toBe(1);

    // And what it recorded is the PROBE, not the request.
    const sealed = result.events.find((one) => one.type === 'SANDBOX_SEALED')!;
    expect(sealed).toBeDefined();
    expect(sealed.payload).toMatchObject({ policy: 'deny-all', probe: { dns: false, route: false } });

    // THE SEQ, and this is the assertion that nearly went the other way. The seal is the
    // FIRST event of the phase — `afterSeq + 1` — because the orchestrator writes every
    // `AGENT_MESSAGE` after this phase returns, numbering from where the executor
    // stopped. A seal numbered after the phase's events would land after every agent
    // message in the log, and `sealedBeforeAgent` would be false for a sandbox that was
    // in fact sealed in time.
    expect(result.events.map((one) => one.type)).toEqual(['SANDBOX_SEALED']);
    expect(sealed.seq).toBe(1);
  });

  test('a probe that still reaches the network refuses the phase', async () => {
    // The failure this exists for is a policy the platform accepts and does not apply.
    // Running an agent in that sandbox and calling the result evidence would be the same
    // class of lie as an agent writing its own facts — so the phase throws, and the run
    // records an operational fault rather than a finding.
    const fake = fakeSandboxes({ runner: serving, reachable: () => true });
    const executor = vercelExecutor({ client: fake.client });
    await expect(
      executor.runPhase({
        plan: plan({ recipe: { install: 'npm ci', services: [] } }),
        source: repo(),
        afterSeq: 0,
        phase: 'agent',
        overrides: { serveTools: true },
        driver: async ({ invoke }) => void (await invoke('read', { path: 'README' })),
      }),
    ).rejects.toThrow(SealFailed);
    // And the machine is gone anyway. A refusal that leaked a running sandbox would cost
    // money for as long as its session lasts.
    expect(fake.sandboxes[0]!.stopped).toBe(true);
  });

  test('the fold reads the order, and refuses a seal that arrived too late', async () => {
    const stream = (sealedAt: number, messageAt: number): RunEvent[] =>
      [
        { seq: 1, type: 'RUN_REQUESTED', payload: { v: 1, source: 'github_issue', thread_ref: 'o/r#1', raw_text: 'x' } },
        { seq: 2, type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } },
        { seq: sealedAt, type: 'SANDBOX_SEALED', payload: { v: 1, sandbox_id: 's', policy: 'deny-all', probe: { dns: false, route: false } } },
        { seq: messageAt, type: 'AGENT_MESSAGE', payload: { v: 1, role: 'assistant', text: 'hi' } },
      ]
        .sort((a, b) => a.seq - b.seq)
        .map((one) => ({ ...one, run_id: RUN, ts: '2026-09-06T00:00:00.000Z' })) as RunEvent[];

    expect(fold(stream(3, 4)).sealedBeforeAgent).toBe(true);
    // THE control: the same events, the other way round. A seal recorded after the agent
    // has spoken says nothing about what it could reach while speaking.
    expect(fold(stream(4, 3)).sealedBeforeAgent).toBe(false);
  });

  test('a seal whose probe reached the network folds to false, whenever it arrived', async () => {
    const events: RunEvent[] = [
      { seq: 1, type: 'RUN_REQUESTED', payload: { v: 1, source: 'github_issue', thread_ref: 'o/r#1', raw_text: 'x' } },
      { seq: 2, type: 'SANDBOX_SEALED', payload: { v: 1, sandbox_id: 's', policy: 'deny-all', probe: { dns: false, route: true } } },
    ].map((one) => ({ ...one, run_id: RUN, ts: '2026-09-06T00:00:00.000Z' })) as RunEvent[];
    expect(fold(events).sealedBeforeAgent).toBe(false);
  });
});

describe('the environment build keeps nothing of ours in the snapshot', () => {
  test('it installs, wipes the run inputs, snapshots, and reports the steps', async () => {
    const fake = fakeSandboxes({
      runner: async function* () {
        yield line({ env: { ready: true, steps: [{ step: 'install', exit_code: 0, output: 'ok' }], services: [] } });
      },
    });
    const executor = vercelExecutor({ client: fake.client });
    const built = await executor.buildSnapshot(plan(), repo(), 'main', { install: 'npm ci', services: [] });

    expect(built).toMatchObject({ snapshot: { ref: 'snap-1' }, steps: [{ step: 'install', exit_code: 0 }] });
    const sandbox = fake.sandboxes[0]!;
    // `allow-all`, because install needs a registry — the one sandbox in a run that does.
    expect(sandbox.createdWith).toBe('allow-all');
    // The Job, the bundle and the spool are OURS. A snapshot carrying them would put this
    // run's symptom pattern into every phase that judges, where a reproduction could read
    // the thing it is supposed to be tested against.
    expect(sandbox.commands.some((command) => /rm -rf \/work/.test(command))).toBe(true);
    const wiped = sandbox.commands.findIndex((command) => /rm -rf \/work/.test(command));
    const ran = sandbox.commands.findIndex((command) => command.includes('runner-vm'));
    expect(ran).toBeGreaterThanOrEqual(0);
    expect(wiped).toBeGreaterThan(ran);
  });

  test('a recipe that does not boot is REPORTED, not thrown', async () => {
    // A repository whose install fails is an operational fault the caller records and ends
    // the run on. An exception here would discard the run instead of saying why it could
    // not start — the shape ADR-0007's amendment forbids.
    const fake = fakeSandboxes({
      runner: async function* () {
        yield line({ env: { ready: false, steps: [], services: [], failed: 'install exited 1' } });
      },
    });
    const executor = vercelExecutor({ client: fake.client });
    const built = await executor.buildSnapshot(plan(), repo(), 'main', { install: 'npm ci', services: [] });
    expect(built).toEqual({ failed: 'install exited 1' });
    expect(fake.sandboxes[0]!.stopped).toBe(true);
  });

  test('a platform that refuses to create anything is also reported', async () => {
    const fake = fakeSandboxes({ refuseCreate: true });
    const executor = vercelExecutor({ client: fake.client });
    const built = await executor.buildSnapshot(plan(), repo(), 'main', { install: 'npm ci', services: [] });
    expect(built).toMatchObject({ failed: expect.stringContaining('refused') });
  });
});

describe('nothing is left running, and nothing is left uncollected', () => {
  test('artifacts are re-digested into the host store, and a handover is written out', async () => {
    const root = blobRoot();
    const fake = fakeSandboxes({
      blobs: { 'sha256-abc': 'the captured stdout' },
      handover: Buffer.from('a bundle'),
      runner: async function* ({ awaitSpool }: RunnerContext) {
        yield line({ env: { ready: true, steps: [], services: [] } });
        yield line({ ready: true });
        await awaitSpool((written) => written.includes('"done":true'));
        yield line({ finished: { handover: null } });
      },
    });
    const executor = vercelExecutor({ client: fake.client });
    const result = await executor.runPhase({
      plan: plan({ blobRoot: root, recipe: { install: 'npm ci', services: [] } }),
      source: repo(),
      afterSeq: 0,
      phase: 'agent',
      overrides: { serveTools: true },
      driver: async () => {},
    });

    // `applyHandover` does `lstat` on exactly this path, so writing it anywhere else is a
    // handover that silently did not happen.
    expect(result.handover).toBeDefined();
    const { readFileSync, readdirSync } = await import('node:fs');
    expect(readFileSync(join(result.handover!, 'agent.bundle'), 'utf8')).toBe('a bundle');
    // Named by what the bytes ARE, not by what the sandbox called them: `put` re-digests,
    // so a blob altered in transit lands under a ref nothing cites.
    const stored = readdirSync(root).filter((name) => name !== '.evidence-store');
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toBe('sha256-abc');
  });

  test('the ledger names a sandbox BEFORE it exists, and sweep stops what it finds', async () => {
    // The window this closes is a worker killed between `create` and any bookkeeping: the
    // platform ends those sessions at their own timeout, which is up to an hour of
    // compute per phase that nobody is watching.
    const state = temp('engine-vercel-ledger-');
    const ledger = { path: join(state, 'sandboxes.json') };
    const fake = fakeSandboxes({
      runner: async function* () {
        yield event(1, 'TEST_RUN', { v: 1, phase: 'base', commit_sha: 'a'.repeat(40), exit_code: 1, duration_ms: 1, symptom_matched: true });
      },
    });
    const executor = vercelExecutor({ client: fake.client, ledger });
    await executor.runPhase({ plan: plan(), source: repo(), afterSeq: 0, phase: 'base', overrides: {} });

    const { readFileSync } = await import('node:fs');
    expect(readFileSync(ledger.path, 'utf8')).toContain('"sandboxId":"sbx-1"');

    // Nothing to sweep once a run tidied up after itself — and something to sweep when it
    // did not, which is the case the sweep exists for.
    expect(await executor.sweep()).toBe(0);
    await fake.client.create({ from: { image: 'engine:test' }, policy: 'deny-all', timeoutMs: 1000, tags: { engine: 'test-framework-v2' } });
    expect(await executor.sweep()).toBe(1);
  });

  test('an attempt cut short by the ceiling cannot be credited with a reproduction', () => {
    // The disqualification, at the fold. A phase this engine stopped mid-observation is
    // half a comparison, and a red-then-green built out of it would be a claim about a
    // run that did not finish — the same class as a recipe that never booted, with a
    // different cause because the operator's fix is different.
    const at = (seq: number, type: string, payload: unknown): RunEvent =>
      ({ run_id: RUN, seq, ts: 'T', type, payload }) as RunEvent;
    const anchored = { f: 'sha256:aa' };
    const stream = (cause?: string): RunEvent[] =>
      [
        at(1, 'ATTEMPT_STARTED', { v: 1, n: 1 }),
        at(2, 'REPRO_REGISTERED', { v: 1, command: 'c', files: anchored, applied: ['f'] }),
        at(3, 'TEST_RUN', { v: 1, phase: 'base', commit_sha: 'a', exit_code: 1, stdout_hash: 'sha256:x', duration_ms: 1, symptom_matched: true, repeat: 0, repro_hashes: anchored }),
        ...(cause ? [at(4, 'VERIFICATION_ABORTED', { v: 1, phase: 'setup', cause, reason: 'stopped' })] : []),
      ];

    // `shownOnBase` rather than `reproduced`, because this is about the base half: the
    // gate that decides whether a fix is attempted at all (ADR-0007), asked of an attempt
    // whose world stopped existing part-way through being observed.
    //
    // THE positive control first — without it the assertion below passes on a fold that
    // credits nothing at all.
    expect(fold(stream()).shownOnBase).toBe(true);
    expect(fold(stream('ceiling')).shownOnBase).toBe(false);
    // And a cause that is about tidying up does not disqualify anything, which is why it
    // has a name of its own.
    expect(fold(stream('collection')).shownOnBase).toBe(true);
  });

  test('a phase whose stream never ends is stopped, and says so in the log', async () => {
    const fake = fakeSandboxes({
      runner: async function* () {
        yield event(1, 'TEST_RUN', { v: 1, phase: 'base', commit_sha: 'a'.repeat(40), exit_code: 1, duration_ms: 1, symptom_matched: true });
        // Then nothing, forever — the wedge the ceiling exists for.
        await new Promise(() => {});
      },
    });
    const executor = vercelExecutor({ client: fake.client });
    const result = await executor.runPhase({
      plan: plan({ containerTimeoutMs: 150 }),
      source: repo(),
      afterSeq: 0,
      phase: 'base',
      overrides: {},
    });

    expect(result.ceiling).toBe('wall');
    // As an EVENT, which is what Docker's version could not do: it reported this on
    // stderr, where nothing folds it and no projection reads it.
    const abort = result.events.find((one) => one.type === 'VERIFICATION_ABORTED')!;
    expect(abort.payload).toMatchObject({ cause: 'ceiling' });
    // The observation it did make is kept. A phase cut off partway is still evidence of
    // what ran.
    expect(result.events.some((one) => one.type === 'TEST_RUN')).toBe(true);
    expect(fake.sandboxes[0]!.stopped).toBe(true);
  });
});
