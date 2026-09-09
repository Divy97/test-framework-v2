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
import { createServer } from 'node:http';
import { effortLevel, MODEL, modelId, runAgentLoop } from '../src/loop.js';
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
    provider: 'anthropic',
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
      provider: 'anthropic',
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
      provider: 'anthropic',
      baseURL: model.baseURL,
      timeoutMs: 30_000,
      maxIterations: 1,
      invoke: async () => ({ ok: true, output: '' }),
    });

    // It does not throw. An agent that fails is an observation; losing the record
    // of the attempt is a failure to observe, and those are not the same thing.
    expect(transcript.exitCode).toBe(-1);
    expect(claimed(transcript)).toContain('loop_error');
    // And it SAYS SO in `stopped`, which this asserted nothing about for four
    // milestones. The fallback was `lines.length === 0 ? 'spawn_failed' : 'exit'`, so a
    // loop that lost the model part-way through reported `exit` — a value with no
    // `CUT_OFF` entry in `report.ts`, which means the person who filed the bug was told
    // the agent had finished and found nothing. Mutating this line back to `exit` left
    // the whole suite green, which is how it survived.
    expect(transcript.stopped).toBe('api_error');
    expect(transcript.stopped).not.toBe('exit');
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
      provider: 'anthropic',
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

describe('an Anthropic-compatible gateway is configuration, not code', () => {
  test('the base URL, the bearer credential and the model all come from the environment', async () => {
    // The practical question this answers: can this run against OpenRouter (or any
    // Anthropic-Messages-compatible gateway) without editing the loop? The SDK reads
    // `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` itself, so the only thing that
    // had to change was the hardcoded model id.
    //
    // Asserted by pointing the environment at the scripted server and passing NO
    // options at all — if any of the three stopped being environment-driven, the
    // request would not arrive here.
    const model = await fakeModel([{ content: [{ type: 'text', text: 'via the gateway' }], stop_reason: 'end_turn' }]);
    models.push(model);

    const before = {
      base: process.env.ANTHROPIC_BASE_URL,
      token: process.env.ANTHROPIC_AUTH_TOKEN,
      model: process.env.ENGINE_MODEL,
    };
    process.env.ANTHROPIC_BASE_URL = model.baseURL;
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-or-v1-not-a-real-openrouter-key';
    process.env.ENGINE_MODEL = 'anthropic/claude-opus-5';
    try {
      // Read at CALL time, not at module load. A constant would mean a variable set
      // after the first `import` is silently ignored — config that does nothing.
      expect(modelId()).toBe('anthropic/claude-opus-5');
      const transcript = await runAgentLoop({
        // Named, because this test is ABOUT the SDK resolving its own environment.
        provider: 'anthropic',
        prompt: 'reproduce the bug',
        timeoutMs: 30_000,
        invoke: async () => ({ ok: true, output: '' }),
      });
      expect(transcript.stopped).toBe('exit');
      expect(transcript.exitCode).toBe(0);
    } finally {
      restore('ANTHROPIC_BASE_URL', before.base);
      restore('ANTHROPIC_AUTH_TOKEN', before.token);
      restore('ENGINE_MODEL', before.model);
    }

    // It reached the scripted server, and it asked for the model the environment named
    // rather than the compiled-in default.
    const request = model.requests[0] as { model: string; thinking: unknown; tools: { name: string }[] };
    expect(request.model).toBe('anthropic/claude-opus-5');
    // And the request is otherwise unchanged — a gateway gets the same adaptive
    // thinking and the same tool surface, because that is what "Anthropic-compatible"
    // has to mean for this loop to work at all.
    expect(request.thinking).toEqual({ type: 'adaptive' });
    expect(request.tools.map((t) => t.name)).toEqual(TOOL_SCHEMAS.map((t) => t.name));
  });

  test('the bearer credential goes in Authorization, and no empty x-api-key rides along', async () => {
    // OpenRouter's Claude Code instructions say to set `ANTHROPIC_API_KEY=""`. That is
    // right for the CLI and WRONG here: an empty string is not nullish, so the SDK
    // keeps it and sends an empty `x-api-key` beside the bearer token. Asserted so the
    // advice cannot be followed into this codebase by accident.
    const headers: Record<string, string>[] = [];
    const server = createServer((request, response) => {
      headers.push(request.headers as Record<string, string>);
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'x',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    const port = (server.address() as { port: number }).port;

    try {
      await runAgentLoop({
        prompt: 'x',
        authToken: 'sk-or-v1-not-a-real-openrouter-key',
        provider: 'anthropic',
        baseURL: `http://127.0.0.1:${port}`,
        timeoutMs: 30_000,
        invoke: async () => ({ ok: true, output: '' }),
      });
      expect(headers[0]!.authorization).toBe('Bearer sk-or-v1-not-a-real-openrouter-key');
      expect(headers[0]!['x-api-key']).toBeUndefined();
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

/** Put an environment variable back exactly as it was, including having been unset. */
function restore(name: string, was: string | undefined): void {
  if (was === undefined) delete process.env[name];
  else process.env[name] = was;
}

describe('what a run costs is measured, not guessed', () => {
  test('the usage of every turn is totalled onto the transcript', async () => {
    // The per-turn numbers were already recorded into the transcript, where reading
    // them meant fetching blobs and parsing JSON — so "what did that run cost" was
    // unanswerable. For a project whose subject is evidence that was a strange gap.
    const { transcript } = await drive([
      { content: [call('read', { path: 'src.txt' })], stop_reason: 'tool_use' },
      { content: [call('read', { path: 'src.txt' }, 'toolu_2')], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ]);

    // Three turns, and the scripted server reports one token each way per turn.
    expect(transcript.usage.turns).toBe(3);
    expect(transcript.usage.input_tokens).toBe(3);
    expect(transcript.usage.output_tokens).toBe(3);
  });

  test('a run stopped by a ceiling still reports what it spent getting there', async () => {
    // Totalled as it goes rather than at the end, because the expensive runs are
    // exactly the ones a ceiling stops — and those are the ones worth costing.
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
      provider: 'anthropic',
      baseURL: model.baseURL,
      timeoutMs: 30_000,
      maxLines: 6,
      invoke: async () => ({ ok: true, output: 'wrong\n' }),
    });

    expect(transcript.stopped).toBe('line_cap');
    expect(transcript.usage.turns).toBeGreaterThan(0);
    expect(transcript.usage.output_tokens).toBe(transcript.usage.turns);
  });

  test('the turn ceiling says it stopped the agent, on this path too', async () => {
    // The SDK's runner ends its iteration whether the model finished or `max_iterations`
    // ran out, and from outside those looked identical: `stopped: 'exit'`, `exit_code: 0`.
    // The first real webhook-driven run's fix agent hit the ceiling one turn short of
    // committing — file edited, fix verified through the browser — and the log called it
    // a clean exit. The last turn's `stop_reason` is what tells them apart.
    const model = await fakeModel(
      Array.from({ length: 20 }, (_, n) => ({
        content: [call('read', { path: 'src.txt' }, `toolu_${n}`)],
        stop_reason: 'tool_use' as const,
      })),
    );
    models.push(model);
    const transcript = await runAgentLoop({
      prompt: 'never finish',
      apiKey: 'sk-ant-not-a-real-key',
      provider: 'anthropic',
      baseURL: model.baseURL,
      timeoutMs: 30_000,
      maxIterations: 3,
      invoke: async () => ({ ok: true, output: 'again\n' }),
    });

    expect(transcript.stopped).toBe('turn_cap');
    expect(transcript.exitCode).toBe(-1);
    expect(transcript.lines.at(-1)!.raw).toContain('iteration ceiling');
  });

  test('a model that ends its own turn is not accused of hitting the ceiling', async () => {
    const model = await fakeModel([
      { content: [call('read', { path: 'src.txt' }, 'toolu_1')], stop_reason: 'tool_use' as const },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' as const },
    ]);
    models.push(model);
    const transcript = await runAgentLoop({
      prompt: 'finish',
      apiKey: 'sk-ant-not-a-real-key',
      provider: 'anthropic',
      baseURL: model.baseURL,
      timeoutMs: 30_000,
      maxIterations: 2,
      invoke: async () => ({ ok: true, output: 'ok\n' }),
    });
    expect(transcript.stopped).toBe('exit');
    expect(transcript.exitCode).toBe(0);
  });

  test('the effort level is configurable, and a typo is refused rather than billed', async () => {
    // Effort was hardcoded to `high`. It is the single biggest lever on what a run
    // costs, and `low` answers the only question prompt iteration asks.
    const model = await fakeModel([{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }]);
    models.push(model);
    await runAgentLoop({
      prompt: 'x',
      apiKey: 'sk-ant-not-a-real-key',
      provider: 'anthropic',
      baseURL: model.baseURL,
      effort: 'low',
      maxTokens: 2048,
      timeoutMs: 30_000,
      invoke: async () => ({ ok: true, output: '' }),
    });
    const request = model.requests[0] as { output_config: unknown; max_tokens: number };
    expect(request.output_config).toEqual({ effort: 'low' });
    expect(request.max_tokens).toBe(2048);

    // A misspelling must not silently fall back to `high` and a surprising bill.
    expect(() => effortLevel('lowish')).toThrow(/must be one of/);
    expect(effortLevel('max')).toBe('max');
  });

  test('the iteration ceiling is a ceiling, and now a measured one', () => {
    // It was 200 — a single run on a large model costing more than a developer expected
    // to spend all day. A ceiling chosen so it never fires is not a ceiling.
    //
    // It was then 25, and this test asserted `<= 25`. That bound came from scripted runs
    // using "six to eight", and the first real webhook-driven run disproved it: the repro
    // agent finished naturally in 22 turns and the fix agent hit 25 EXACTLY, one turn
    // short of committing a fix it had already written and verified. A bound derived from
    // agents that never read the prompt was measuring the wrong workload.
    //
    // So the assertion moves, and stays an assertion: still bounded, and still far below
    // the 200 that made it meaningless. Raising it past 200 fails here, and so does
    // deleting it.
    const source = readFileSync(join(process.cwd(), 'src/loop.ts'), 'utf8');
    const cap = Number(/const MAX_ITERATIONS = (\d+)/.exec(source)?.[1]);
    expect(cap).toBeGreaterThanOrEqual(40); // below this, a real fix phase is cut off
    expect(cap).toBeLessThanOrEqual(120); // above this, it stops bounding the bill
  });

  test('a ceiling nobody can hear is not a ceiling', () => {
    // The property behind `turn_cap`, asserted over the source because it is about what
    // the code CANNOT do: report an interrupted agent and a finished one with the same
    // value. Both loops must name the ceiling.
    for (const file of ['src/loop.ts', 'src/openrouter.ts']) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source, file).toContain("stopped = 'turn_cap'");
      expect(source, file).toContain('iteration ceiling');
    }
  });
});
