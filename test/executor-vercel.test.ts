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
import { digest, get } from '../src/blobs.js';
import { fold } from '../src/fold.js';
import { vercelExecutor } from '../src/executor-vercel.js';
import type { RunPlan } from '../src/orchestrate.js';
import { afterSeqOf, fakeSandboxes, line, type RunnerContext } from './fixtures/sandbox.js';

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
      runner: async function* ({ sandbox }: RunnerContext) {
        yield event(afterSeqOf(sandbox) + 1, 'TEST_RUN', { v: 1, phase: 'base', commit_sha: 'a'.repeat(40), exit_code: 1, duration_ms: 5, symptom_matched: true });
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
    // Two: the seal this executor observed, then what the container reported. The seal is
    // first because the sandbox is probed before it is given the source or the Job.
    expect(result.events.map((one) => one.type)).toEqual(['SANDBOX_SEALED', 'TEST_RUN']);
    expect(result.events.map((one) => one.seq)).toEqual([1, 2]);
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

describe('the world the Runner needs, and the one thing the host may not write', () => {
  test('PREPARE makes /out, or every agent hands over nothing and says nothing', async () => {
    // `handOverCommits` stats `/out` and returns null when it is not a directory —
    // legitimate on a run that only wants a transcript, and silent. The orchestrator reads
    // that null as "the bundle was made". On Docker the bind mount creates the path; here
    // nothing did, so every agent phase would have handed over nothing, invisibly.
    const fake = fakeSandboxes({
      runner: async function* ({ awaitSpool }: RunnerContext) {
        yield line({ env: { ready: true, steps: [], services: [] } });
        yield line({ ready: true });
        await awaitSpool((written) => written.includes('"done":true'));
        yield line({ finished: { handover: null } });
      },
    });
    await vercelExecutor({ client: fake.client }).runPhase({
      plan: plan({ recipe: { install: 'npm ci', services: [] } }),
      source: repo(),
      afterSeq: 0,
      phase: 'agent',
      overrides: { serveTools: true },
      driver: async () => {},
    });
    expect([...fake.sandboxes[0]!.prepared]).toEqual(expect.arrayContaining(['/work', '/blobs', '/out']));
  });

  test('a tool call goes in as root, because the host writes as the user the repro is', async () => {
    // The uid the SDK writes files as and the uid the repro drops to are the same one, so
    // a spool the host can write is a spool the agent can forge `{done: true}` into. The
    // fake refuses a `writeFiles` under `/work/rpc`, which is what a real sandbox would do
    // with a root-owned 0700 directory — so an executor that went back to writing tool
    // calls that way fails here instead of on the first live agent phase.
    const fake = fakeSandboxes({
      runner: async function* ({ awaitSpool }: RunnerContext) {
        yield line({ env: { ready: true, steps: [], services: [] } });
        yield line({ ready: true });
        const call = await awaitSpool((written) => written.includes('"call"'));
        yield line({ result: { id: (JSON.parse(call) as { call: { id: string } }).call.id, ok: true, output: 'ok' } });
        await awaitSpool((written) => written.includes('"done":true'));
        yield line({ finished: { handover: null } });
      },
    });
    const result = await vercelExecutor({ client: fake.client }).runPhase({
      plan: plan({ recipe: { install: 'npm ci', services: [] } }),
      source: repo(),
      afterSeq: 0,
      phase: 'agent',
      overrides: { serveTools: true },
      driver: async ({ invoke }) => void (await invoke('read', { path: 'README' })),
    });
    expect(result.exitCode).toBe(0);
    // Delivered through `sudo`, and verified afterwards: `sh -c` reports the last
    // command's status, so without the `test -s` a failing `base64` would leave an empty
    // spool file, which the Runner skips forever while the host waits for a reply.
    const delivered = fake.sandboxes[0]!.commands.filter((one) => one.includes('/rpc/in/'));
    expect(delivered).toHaveLength(2); // the call, and `{done:true}`
    for (const command of delivered) {
      expect(command).toMatch(/sudo -n tee/);
      expect(command).toMatch(/sudo -n test -s/);
    }
  });

  test('the in-container agent is refused, because there is no moment to seal it', async () => {
    // `agentPrompt` runs the loop inside the sandbox: a model credential in there, and a
    // route to the model API for the whole session. There is no `{ready}` handshake on
    // that path, so this executor has no moment at which it could close the route — the
    // agent would run its whole life with a way out and the log would say nothing. Docker
    // keeps the path; this substrate says so instead of running an unsealed agent.
    const fake = fakeSandboxes();
    await expect(
      vercelExecutor({ client: fake.client }).runPhase({
        plan: plan({ recipe: { install: 'npm ci', services: [] } }),
        source: repo(),
        afterSeq: 0,
        phase: 'agent',
        overrides: { agentPrompt: 'find the bug' },
      }),
    ).rejects.toThrow(/could be sealed/);
    // And the two halves of the tool protocol travel together, which is also the one
    // shape in which this executor's seq and the Runner's could have collided.
    await expect(
      vercelExecutor({ client: fake.client }).runPhase({
        plan: plan({ recipe: { install: 'npm ci', services: [] } }),
        source: repo(),
        afterSeq: 0,
        phase: 'agent',
        overrides: {},
        driver: async () => {},
      }),
    ).rejects.toThrow(/two halves of one protocol/);
  });

  test('a base phase’s seal does not answer the question about an agent', () => {
    // Every sandbox is sealed and probed now, so a judging phase's `SANDBOX_SEALED` sits
    // in the log before the next agent speaks — and without the `phase` field it satisfied
    // `sealedBeforeAgent` for an agent nobody sealed.
    const at = (seq: number, type: string, payload: unknown): RunEvent =>
      ({ run_id: RUN, seq, ts: 'T', type, payload }) as RunEvent;
    const seal = (seq: number, phase: string) =>
      at(seq, 'SANDBOX_SEALED', { v: 1, sandbox_id: 's', phase, policy: 'deny-all', probe: { dns: false, route: false } });
    const said = (seq: number) => at(seq, 'AGENT_MESSAGE', { v: 1, n: 0, claimed_type: 'text', bytes: 1 });
    const done = (seq: number) => at(seq, 'AGENT_FINISHED', { v: 1, messages: 1, exit_code: 0, stopped: 'end' });

    expect(fold([seal(1, 'base'), said(2), done(3)]).sealedBeforeAgent).toBe(false);
    // THE positive control: the same shape with the agent's own seal.
    expect(fold([seal(1, 'agent'), said(2), done(3)]).sealedBeforeAgent).toBe(true);
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

  test('a probe that still reaches the network refuses the phase, and KEEPS the record', async () => {
    // The failure this exists for is a policy the platform accepts and does not apply.
    // Running an agent in that sandbox and calling the result evidence would be the same
    // class of lie as an agent writing its own facts.
    //
    // Refused by RETURNING, not by throwing. `orchestrate()` accumulates events locally
    // and returns them at the end, so an exception out of the fix agent's phase would
    // discard the attempt, the registration and every base observation — the
    // evidence-loss shape the Docker executor says it fixed twice. The design has a name
    // for this outcome (`probe: true`, and `cause: 'environment'` disqualifies the
    // attempt), and `executor.ts` says this method must not throw for one.
    let called = 0;
    const fake = fakeSandboxes({ runner: serving, reachable: () => true });
    const executor = vercelExecutor({ client: fake.client });
    const result = await executor.runPhase({
      plan: plan({ recipe: { install: 'npm ci', services: [] } }),
      source: repo(),
      afterSeq: 0,
      phase: 'agent',
      overrides: { serveTools: true },
      driver: async ({ invoke }) => {
        called += 1;
        await invoke('read', { path: 'README' });
      },
    });

    // The model was never asked for a turn.
    expect(called).toBe(0);
    expect(result.exitCode).not.toBe(0);
    const sealed = result.events.find((one) => one.type === 'SANDBOX_SEALED')!;
    expect(sealed.payload).toMatchObject({ probe: { dns: true, route: true } });
    const abort = result.events.find((one) => one.type === 'VERIFICATION_ABORTED')!;
    expect(abort.payload).toMatchObject({ cause: 'environment' });
    expect((abort.payload as { reason: string }).reason).toMatch(/still reached the network/);
    // And the machine is gone anyway. A refusal that leaked a running sandbox would cost
    // money for as long as its session lasts.
    expect(fake.sandboxes[0]!.stopped).toBe(true);
  });

  test('a phase that JUDGES is probed too, and refused if the seal did not take', async () => {
    // The ADR's argument — the policy you sent is not the policy the platform holds —
    // applies hardest here. The agent's sandbox is the one ADR-0010 says nothing worth
    // stealing lives in; base and fix are the opposite, and their output IS the evidence.
    // A `deny-all` the platform accepted and failed to apply on a base sandbox produces a
    // reproduction that could have been TOLD what to answer.
    const honest = fakeSandboxes({
      runner: async function* ({ sandbox }: RunnerContext) {
        yield event(afterSeqOf(sandbox) + 1, 'TEST_RUN', { v: 1, phase: 'base', commit_sha: 'a'.repeat(40), exit_code: 1, duration_ms: 1, symptom_matched: true });
      },
    });
    const clean = await vercelExecutor({ client: honest.client }).runPhase({
      plan: plan(), source: repo(), afterSeq: 0, phase: 'base', overrides: {}, from: { ref: 'snap-1' },
    });
    // Observed, not assumed: the phase carries a seal event of its own, and it precedes
    // everything the container said.
    expect(clean.events[0]!.type).toBe('SANDBOX_SEALED');
    expect(clean.events[0]!.payload).toMatchObject({ probe: { dns: false, route: false } });
    expect(clean.exitCode).toBe(0);

    // THE control: the same phase on a platform that did not apply the policy.
    const open = fakeSandboxes({ reachable: () => true });
    const refused = await vercelExecutor({ client: open.client }).runPhase({
      plan: plan(), source: repo(), afterSeq: 0, phase: 'base', overrides: {}, from: { ref: 'snap-1' },
    });
    expect(refused.events.some((one) => one.type === 'TEST_RUN')).toBe(false);
    expect(refused.events.find((one) => one.type === 'VERIFICATION_ABORTED')?.payload).toMatchObject({
      cause: 'environment',
    });
    expect(open.sandboxes[0]!.stopped).toBe(true);
  });

  test('the fold reads the order, and refuses a seal that arrived too late', async () => {
    const stream = (sealedAt: number, messageAt: number): RunEvent[] =>
      [
        { seq: 1, type: 'RUN_REQUESTED', payload: { v: 1, source: 'github_issue', thread_ref: 'o/r#1', raw_text: 'x' } },
        { seq: 2, type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } },
        { seq: sealedAt, type: 'SANDBOX_SEALED', payload: { v: 1, sandbox_id: 's', phase: 'agent', policy: 'deny-all', probe: { dns: false, route: false } } },
        { seq: messageAt, type: 'AGENT_MESSAGE', payload: { v: 1, role: 'assistant', text: 'hi' } },
      ]
        .sort((a, b) => a.seq - b.seq)
        .map((one) => ({ ...one, run_id: RUN, ts: '2026-09-06T00:00:00.000Z' })) as RunEvent[];

    expect(fold(stream(3, 4)).sealedBeforeAgent).toBe(true);
    // THE control: the same events, the other way round. A seal recorded after the agent
    // has spoken says nothing about what it could reach while speaking.
    expect(fold(stream(4, 3)).sealedBeforeAgent).toBe(false);
  });

  test('a run with TWO agent phases is not punished for the first one having spoken', () => {
    // The defect this pins. A standard run has two agents per attempt — the repro agent
    // and the fix agent — and up to ten attempts. Reading the rule as "was the transcript
    // empty when the seal arrived" makes every seal after the first one false, so the
    // field was false for every run in which both sandboxes were sealed correctly. The
    // question is per AGENT PHASE, and `AGENT_FINISHED` is the boundary the log carries.
    const at = (seq: number, type: string, payload: unknown): RunEvent =>
      ({ run_id: RUN, seq, ts: 'T', type, payload }) as RunEvent;
    const seal = (seq: number, reached = false) =>
      at(seq, 'SANDBOX_SEALED', { v: 1, sandbox_id: 's', phase: 'agent', policy: 'deny-all', probe: { dns: reached, route: false } });
    const said = (seq: number) => at(seq, 'AGENT_MESSAGE', { v: 1, n: 0, claimed_type: 'text', bytes: 1 });
    const done = (seq: number) => at(seq, 'AGENT_FINISHED', { v: 1, messages: 1, exit_code: 0, stopped: 'end' });

    // Both phases sealed before their own agent spoke.
    expect(fold([seal(1), said(2), done(3), seal(4), said(5), done(6)]).sealedBeforeAgent).toBe(true);
    // THE control: the SECOND phase's agent spoke before its seal. The first was fine,
    // and the run is still not one where every agent was sealed.
    expect(fold([seal(1), said(2), done(3), said(4), seal(5), done(6)]).sealedBeforeAgent).toBe(false);
    // A second phase with no seal at all — the case a partial rollout would produce.
    expect(fold([seal(1), said(2), done(3), said(4), done(5)]).sealedBeforeAgent).toBe(false);
    // And a phase still open at the end of a log, which is a run cut short mid-agent.
    expect(fold([seal(1), said(2), done(3), said(4)]).sealedBeforeAgent).toBe(false);
  });

  test('a seal whose probe reached the network folds to false, whenever it arrived', async () => {
    const events: RunEvent[] = [
      { seq: 1, type: 'RUN_REQUESTED', payload: { v: 1, source: 'github_issue', thread_ref: 'o/r#1', raw_text: 'x' } },
      { seq: 2, type: 'SANDBOX_SEALED', payload: { v: 1, sandbox_id: 's', phase: 'agent', policy: 'deny-all', probe: { dns: false, route: true } } },
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
    // THE REAL LAYOUT. `put()` writes `<root>/<aa>/<bb>/<rest>` — two levels of fan-out —
    // so a store contains directories at its top level and no files at all. An earlier
    // version of this test used a flat `sha256-abc`, which `put()` can never produce, and
    // the collection loop it was written against skipped every blob and returned success:
    // a complete event stream whose refs named bytes that were not in the store, a fold
    // that said `reproduced: true`, and an ENOENT for whoever opened the report.
    const captured = 'the captured stdout';
    const ref = digest(Buffer.from(captured));
    const hex = ref.slice('sha256:'.length);
    const fake = fakeSandboxes({
      blobs: { [`./${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(4)}`]: captured },
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
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(result.handover!, 'agent.bundle'), 'utf8')).toBe('a bundle');
    // Readable through the store's own reader, which re-digests: that is the whole claim,
    // and a directory listing could not make it.
    expect((await get(root, ref)).toString('utf8')).toBe(captured);
    // And no collection failure was reported, because there was none.
    expect(result.events.some((one) => (one.payload as { cause?: string }).cause === 'collection')).toBe(false);
  });

  test('a store that cannot be archived is REPORTED, not lost', async () => {
    // The events are the record, and a stream whose blobs went missing is still worth
    // vastly more than no stream. So a collection failure is an event beside them, never
    // a throw that discards the phase.
    const fake = fakeSandboxes({
      tarFails: 'tar: /blobs: Cannot open: No such file or directory',
      runner: async function* ({ sandbox }: RunnerContext) {
        yield event(afterSeqOf(sandbox) + 1, 'TEST_RUN', { v: 1, phase: 'base', commit_sha: 'a'.repeat(40), exit_code: 1, duration_ms: 1, symptom_matched: true });
      },
    });
    const result = await vercelExecutor({ client: fake.client }).runPhase({
      plan: plan(), source: repo(), afterSeq: 0, phase: 'base', overrides: {},
    });
    expect(result.events.some((one) => one.type === 'TEST_RUN')).toBe(true);
    const abort = result.events.find((one) => (one.payload as { cause?: string }).cause === 'collection')!;
    expect(abort).toBeDefined();
    // Tar's own words, not a paraphrase: the exit code alone turns "no space left on
    // device" into `TAR 2`.
    expect((abort.payload as { reason: string }).reason).toMatch(/Cannot open/);
  });

  test('the ledger names a sandbox BEFORE it exists, and sweep stops what it finds', async () => {
    // The window this closes is a worker killed between `create` and any bookkeeping: the
    // platform ends those sessions at their own timeout, which is up to an hour of
    // compute per phase that nobody is watching.
    const state = temp('engine-vercel-ledger-');
    const ledger = { path: join(state, 'sandboxes.json') };
    const fake = fakeSandboxes({
      runner: async function* ({ sandbox }: RunnerContext) {
        yield event(afterSeqOf(sandbox) + 1, 'TEST_RUN', { v: 1, phase: 'base', commit_sha: 'a'.repeat(40), exit_code: 1, duration_ms: 1, symptom_matched: true });
      },
    });
    // Tagged for THIS worker, not for the deployment. A tag shared between workers turns
    // one booting worker into an outage for every other one, because `sweep` stops what
    // the tag matches.
    const tags = { engine: 'test-framework-v2', worker: 'this-one' };
    const executor = vercelExecutor({ client: fake.client, ledger, tags });
    await executor.runPhase({ plan: plan(), source: repo(), afterSeq: 0, phase: 'base', overrides: {} });

    const { existsSync, readFileSync } = await import('node:fs');
    expect(readFileSync(ledger.path, 'utf8')).toContain('"sandboxId":"sbx-1"');

    // Nothing to sweep once a run tidied up after itself: the ledger still names the
    // sandbox, and stopping an already-stopped session is not something this counts.
    expect(await executor.sweep()).toBe(0);
    // And the file is gone, so a later sweep does not re-ask the platform about the dead.
    expect(existsSync(ledger.path)).toBe(false);

    // The ledger is what a crashed worker leaves, and the sweep has to READ it: a tag
    // query alone answers about the platform, and a ledger nothing opens is a file that
    // grows forever while the sandboxes it names bill by the second.
    const { writeFileSync } = await import('node:fs');
    const orphan = await fake.client.create({ from: { image: 'engine:test' }, policy: 'deny-all', timeoutMs: 1000, tags: {} });
    writeFileSync(ledger.path, `${JSON.stringify({ sandboxId: orphan.id, runId: RUN })}\n`);
    expect(await executor.sweep()).toBe(1);
    expect(fake.sandboxes.find((one) => one.id === orphan.id)!.stopped).toBe(true);

    // The case the sweep exists for: a sandbox this worker made and did not stop.
    await fake.client.create({ from: { image: 'engine:test' }, policy: 'deny-all', timeoutMs: 1000, tags });
    expect(await executor.sweep()).toBe(1);
    // THE control: another worker's sandbox, carrying another worker's tag, is left alone.
    await fake.client.create({
      from: { image: 'engine:test' },
      policy: 'deny-all',
      timeoutMs: 1000,
      tags: { engine: 'test-framework-v2', worker: 'somebody-else' },
    });
    expect(await executor.sweep()).toBe(0);
    expect(fake.sandboxes.at(-1)!.stopped).toBe(false);
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
      runner: async function* ({ sandbox }: RunnerContext) {
        yield event(afterSeqOf(sandbox) + 1, 'TEST_RUN', { v: 1, phase: 'base', commit_sha: 'a'.repeat(40), exit_code: 1, duration_ms: 1, symptom_matched: true });
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
