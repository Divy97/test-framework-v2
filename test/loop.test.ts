// The loop runs on the host and the tools run somewhere else (ADR-0011).
//
// Driven by a scripted Messages API rather than a real model, for the reason the
// fake `claude` existed: the interesting cases are output a real model will not
// produce on demand. What is real here is everything between the schema and the
// filesystem — the SDK's tool runner, our tool definitions, the dispatch, the
// results going back, the transcript.
//
// `invoke` is a function, which is the point of the design: these tests wire it
// to an in-process ToolHost, and the sandbox suite wires the same loop to a
// container over a pipe. Neither path knows about the other.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { MODEL, runAgentLoop } from '../src/loop.js';
import { TOOL_SCHEMAS, ToolHost, type ToolWorld } from '../src/tools.js';
import { call, fakeModel, type FakeModel } from './fixtures/model.js';

const dirs: string[] = [];
const hosts: ToolHost[] = [];
const models: FakeModel[] = [];

afterEach(async () => {
  for (const model of models.splice(0)) await model.close();
  for (const host of hosts.splice(0)) await host.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

function world(): ToolWorld {
  const root = temp('engine-loop-');
  const gitDir = temp('engine-loopgit-');
  writeFileSync(join(root, 'src.txt'), 'wrong\n');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: root } });
  git('init', '--quiet', '--initial-branch=main');
  git('add', '-A', '--');
  git('-c', 'user.email=f@example.invalid', '-c', 'user.name=f', 'commit', '--quiet', '-m', 'base');
  return { root, gitDir, env: { TMPDIR: temp('engine-looptmp-'), HOME: temp('engine-loophome-') } };
}

/** The loop, its tools, and a scripted model — wired together as the orchestrator does. */
async function drive(turns: Parameters<typeof fakeModel>[0], options: Parameters<typeof fakeModel>[1] = {}) {
  const w = world();
  const host = new ToolHost(w);
  hosts.push(host);
  const model = await fakeModel(turns, options);
  models.push(model);
  let id = 0;
  const transcript = await runAgentLoop({
    prompt: 'reproduce the bug',
    apiKey: 'sk-ant-not-a-real-key',
    baseURL: model.baseURL,
    timeoutMs: 30_000,
    invoke: async (tool, input) => {
      const result = await host.run({ id: `c${++id}`, tool, input });
      return { ok: result.ok, output: result.output };
    },
  });
  return { transcript, model, world: w };
}

const claimed = (transcript: { lines: { claimed_type: string }[] }) =>
  transcript.lines.map((line) => line.claimed_type);

describe('a scripted tool-call sequence drives a full run', () => {
  test('the agent writes a file and commits it, and the transcript pairs every call with its result', async () => {
    const { transcript, world: w } = await drive([
      { content: [{ type: 'text', text: 'fixing it' }, call('write', { path: 'fix.txt', content: 'fixed\n' })], stop_reason: 'tool_use' },
      { content: [call('git_commit', { message: 'fix: the claim' }, 'toolu_commit')], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ]);

    // The side effects happened, in the workspace, through the tools.
    expect(readFileSync(join(w.root, 'fix.txt'), 'utf8')).toBe('fixed\n');
    const log = execFileSync('git', ['log', '--format=%s'], {
      cwd: w.root,
      encoding: 'utf8',
      env: { ...process.env, GIT_DIR: w.gitDir, GIT_WORK_TREE: w.root },
    });
    expect(log).toMatch(/fix: the claim/);

    // And the record of them is a transcript with no orphan halves: a `tool_use`
    // with no `tool_result` beside it is an unreadable log, and so is the reverse.
    //
    // The `result` marker for a turn lands BEFORE that turn's tool calls, which
    // looks wrong and is not: the runner yields the assistant message and only then
    // executes the tools it asked for, so this is the order things happened in. The
    // pairing is what the log needs; a marker moved to make the list read nicely
    // would be a marker asserting something the run did not do.
    expect(claimed(transcript)).toEqual([
      'assistant',
      'result',
      'tool_use',
      'tool_result',
      'result',
      'tool_use',
      'tool_result',
      'assistant',
      'result',
    ]);
    expect(transcript.stopped).toBe('exit');
    expect(transcript.exitCode).toBe(0);
  });

  test('the model is offered exactly the surface we think it is', async () => {
    // The schemas are what the model plans against, so a drift between what this
    // file believes and what goes on the wire is a drift nobody would notice
    // until an agent called something that does not exist.
    const { model } = await drive([{ content: [{ type: 'text', text: 'no thanks' }], stop_reason: 'end_turn' }]);

    const request = model.requests[0] as { model: string; tools: { name: string }[]; thinking: unknown };
    expect(request.model).toBe(MODEL);
    expect(request.tools.map((t) => t.name)).toEqual(TOOL_SCHEMAS.map((t) => t.name));
    // Adaptive, never disabled. With thinking off this model can write a tool call
    // into its visible text: the turn completes, the call silently never runs, and
    // an agentic loop then reasons over its own fiction.
    expect(request.thinking).toEqual({ type: 'adaptive' });
  });

  test('a refused tool call goes back to the model and the run continues', async () => {
    const { transcript, model, world: w } = await drive([
      { content: [call('write', { path: '../escaped.txt', content: 'x' })], stop_reason: 'tool_use' },
      { content: [call('write', { path: 'inside.txt', content: 'ok\n' }, 'toolu_2')], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'gave up on that' }], stop_reason: 'end_turn' },
    ]);

    // The boundary holding must not end the run. A tool that aborts on refusal
    // hands the agent a way to kill its own run, which ADR-0009 is explicit about:
    // a status the agent can choose is not a status.
    expect(transcript.stopped).toBe('exit');
    expect(existsSync(join(w.root, '..', 'escaped.txt'))).toBe(false);
    expect(readFileSync(join(w.root, 'inside.txt'), 'utf8')).toBe('ok\n');
    // And the model was TOLD, so it can try something else. A refusal the agent
    // cannot see is a hang waiting to happen.
    expect(JSON.stringify(model.requests[1])).toMatch(/refused: path escapes the repository/);
  });

  test('the credential stays in this process', async () => {
    // Not a proof, an alarm: if a later refactor threads options through to the
    // tool side, this fails. The structural claim is that `invoke` takes a tool
    // name and an argument object and nothing else.
    const model = await fakeModel([
      { content: [call('read', { path: 'src.txt' })], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'read it' }], stop_reason: 'end_turn' },
    ]);
    models.push(model);
    const key = 'sk-ant-canary-0000';
    const seen: string[] = [];
    await runAgentLoop({
      prompt: 'look at it',
      apiKey: key,
      baseURL: model.baseURL,
      timeoutMs: 30_000,
      invoke: async (tool, input) => {
        seen.push(JSON.stringify({ tool, input }));
        return { ok: true, output: 'wrong\n' };
      },
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) expect(call).not.toContain(key);
  });
});

describe('the loop ends honestly', () => {
  test('a model API failure keeps what was already said', async () => {
    const model = await fakeModel([], { status: 500 });
    models.push(model);
    const transcript = await runAgentLoop({
      prompt: 'reproduce the bug',
      apiKey: 'sk-ant-not-a-real-key',
      baseURL: model.baseURL,
      timeoutMs: 30_000,
      maxIterations: 1,
      invoke: async () => ({ ok: true, output: '' }),
    });

    // It does not throw. An agent that fails is an observation; losing the record
    // of the attempt is a failure to observe, and those are not the same thing.
    expect(transcript.exitCode).toBe(-1);
    expect(claimed(transcript)).toContain('loop_error');
  });

  test('a runaway transcript stops at the cap and records that it did', async () => {
    const model = await fakeModel(
      Array.from({ length: 50 }, (_, n) => ({
        content: [call('read', { path: 'src.txt' }, `toolu_${n}`)],
        stop_reason: 'tool_use' as const,
      })),
    );
    models.push(model);
    const transcript = await runAgentLoop({
      prompt: 'loop forever',
      apiKey: 'sk-ant-not-a-real-key',
      baseURL: model.baseURL,
      timeoutMs: 30_000,
      maxLines: 6,
      invoke: async () => ({ ok: true, output: 'wrong\n' }),
    });

    // `line_cap`, not `exit`. A cut-off transcript that reads as a complete one is
    // the one failure mode every ceiling in this project is shaped to refuse.
    expect(transcript.stopped).toBe('line_cap');
    expect(transcript.lines.length).toBeLessThanOrEqual(6);
  });
});
