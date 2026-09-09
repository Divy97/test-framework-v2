// The OpenRouter path, asserted against a scripted OpenAI-shaped API.
//
// Every test here fails if a specific boundary is removed, because on this path the
// turn-taking is OURS — the SDK is not underneath it catching mistakes. Three of them
// cover failures that are silent by construction: a tool call that arrives as prose, a
// turn whose second tool call never gets a result, and a model id from the wrong
// provider. All three produce a run that LOOKS like an agent that found nothing.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { effortLevel, providerName, runAgentLoop } from '../src/loop.js';
import { DEFAULT_OPENROUTER_MODEL, openAiTools, probeToolCalling, runOpenRouterLoop } from '../src/openrouter.js';
import { TOOL_SCHEMAS } from '../src/tools.js';
import { type FakeModel, fakeChat, fnCall } from './fixtures/model.js';
import { draftRecipe } from '../src/orchestrate.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { cleanupFixtures, demoRepo } from './fixtures/repo.js';

let model: FakeModel | undefined;
afterEach(async () => {
  await model?.close();
  model = undefined;
  delete process.env.ENGINE_PROVIDER;
  delete process.env.ENGINE_MODEL;
  delete process.env.OPENROUTER_API_KEY;
});

/** Collects what the loop asked for, so a test can assert on calls it never scripted. */
const recorder = () => {
  const seen: { tool: string; input: Record<string, unknown> }[] = [];
  return {
    seen,
    invoke: async (tool: string, input: Record<string, unknown>) => {
      seen.push({ tool, input });
      return { ok: true, output: `${tool} ran` };
    },
  };
};

const bodies = (fake: FakeModel) => fake.requests as unknown as {
  model: string;
  messages: { role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }[];
  tools: { type: string; function: { name: string; parameters: unknown } }[];
  reasoning?: { effort: string };
  max_tokens?: number;
}[];

describe('the tool surface has one definition', () => {
  it('sends every tool, in order, in the OpenAI shape', () => {
    const sent = openAiTools();
    expect(sent.map((tool) => tool.function.name)).toEqual(TOOL_SCHEMAS.map((schema) => schema.name));
    expect(sent.every((tool) => tool.type === 'function')).toBe(true);
    // `parameters`, not `input_schema` — and it must be the SAME object, because two
    // hand-maintained copies of a tool surface diverge and the divergence is silent.
    for (const [index, tool] of sent.entries()) {
      expect(tool.function.parameters).toBe(TOOL_SCHEMAS[index]!.input_schema);
      expect(tool.function.description).toBe(TOOL_SCHEMAS[index]!.description);
    }
  });

  it('reaches the wire with the whole surface, not a subset', async () => {
    model = await fakeChat([{ content: 'nothing to do' }]);
    await runOpenRouterLoop({ prompt: 'p', invoke: recorder().invoke, apiKey: 'k', baseURL: model.baseURL });
    expect(bodies(model)[0]!.tools.map((tool) => tool.function.name)).toEqual(
      TOOL_SCHEMAS.map((schema) => schema.name),
    );
  });
});

describe('a tool call becomes an execution and a result', () => {
  it('executes the call and feeds the output back under the matching id', async () => {
    model = await fakeChat([
      { content: 'looking', tool_calls: [fnCall('read', { path: 'src/a.ts' }, 'call_abc')] },
      { content: 'found it' },
    ]);
    const tools = recorder();
    const transcript = await runOpenRouterLoop({
      prompt: 'p',
      invoke: tools.invoke,
      apiKey: 'k',
      baseURL: model.baseURL,
    });

    expect(tools.seen).toEqual([{ tool: 'read', input: { path: 'src/a.ts' } }]);
    const second = bodies(model)[1]!.messages;
    // The assistant turn goes back verbatim with its `tool_calls`, then the result
    // quoting the SAME id. Rebuild either and the conversation is invalid.
    expect(second[1]!.role).toBe('assistant');
    expect(second[1]!.tool_calls).toHaveLength(1);
    expect(second[2]).toEqual({ role: 'tool', tool_call_id: 'call_abc', content: 'read ran' });
    expect(transcript.stopped).toBe('exit');
    expect(transcript.exitCode).toBe(0);
  });

  it('records the call and its result as a pair', async () => {
    model = await fakeChat([
      { reasoning: 'I should look', tool_calls: [fnCall('grep', { pattern: 'x' })] },
      { content: 'done' },
    ]);
    const transcript = await runOpenRouterLoop({
      prompt: 'p',
      invoke: recorder().invoke,
      apiKey: 'k',
      baseURL: model.baseURL,
    });
    expect(transcript.lines.map((line) => line.claimed_type)).toEqual([
      'thinking',
      'result',
      'tool_use',
      'tool_result',
      'assistant',
      'result',
    ]);
    // Reasoning is testimony like any other turn content, and it must survive into the
    // transcript: a run whose thinking is dropped cannot be audited afterwards.
    expect(JSON.parse(transcript.lines[0]!.raw)).toEqual({ thinking: 'I should look' });
  });

  it('answers EVERY call in a turn before taking another one', async () => {
    // The boundary: return three calls and answer two, and the model quietly stops
    // asking for parallel work — or the provider rejects the conversation. Either way
    // the run degrades and nothing says so.
    model = await fakeChat([
      {
        tool_calls: [
          fnCall('read', { path: 'a' }, 'call_1'),
          fnCall('read', { path: 'b' }, 'call_2'),
          fnCall('glob', { pattern: '*' }, 'call_3'),
        ],
      },
      { content: 'done' },
    ]);
    const tools = recorder();
    await runOpenRouterLoop({ prompt: 'p', invoke: tools.invoke, apiKey: 'k', baseURL: model.baseURL });

    expect(tools.seen).toHaveLength(3);
    const followUp = bodies(model)[1]!.messages;
    expect(followUp.filter((message) => message.role === 'tool').map((message) => message.tool_call_id)).toEqual([
      'call_1',
      'call_2',
      'call_3',
    ]);
    // And all three in the SAME request, not spread over the next few turns.
    expect(bodies(model)).toHaveLength(2);
  });

  it('tells the model when its arguments were not JSON, and runs nothing', async () => {
    // The likeliest way a cheap model breaks this loop. An exception here would lose the
    // transcript; told about it, the model can simply call the tool again.
    model = await fakeChat([{ tool_calls: [fnCall('read', '{"path": ', 'call_bad')] }, { content: 'sorry' }]);
    const tools = recorder();
    const transcript = await runOpenRouterLoop({
      prompt: 'p',
      invoke: tools.invoke,
      apiKey: 'k',
      baseURL: model.baseURL,
    });

    expect(tools.seen).toEqual([]);
    expect(transcript.stopped).toBe('exit');
    const result = JSON.parse(transcript.lines.find((line) => line.claimed_type === 'tool_result')!.raw) as {
      ok: boolean;
      output: string;
    };
    expect(result.ok).toBe(false);
    expect(result.output).toContain('not valid JSON');
    expect(bodies(model)[1]!.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_bad' });
  });

  it('keeps going when one tool throws', async () => {
    model = await fakeChat([{ tool_calls: [fnCall('read', { path: 'a' })] }, { content: 'noted' }]);
    const transcript = await runOpenRouterLoop({
      prompt: 'p',
      invoke: async () => {
        throw new Error('the worker died');
      },
      apiKey: 'k',
      baseURL: model.baseURL,
    });
    expect(transcript.stopped).toBe('exit');
    expect(transcript.lines.find((line) => line.claimed_type === 'tool_result')!.raw).toContain('the worker died');
  });
});

describe('the ceilings are real', () => {
  it('stops at maxIterations rather than looping on a model that never finishes', async () => {
    model = await fakeChat([{ tool_calls: [fnCall('glob', { pattern: '*' })] }], { repeatLast: true });
    const tools = recorder();
    const transcript = await runOpenRouterLoop({
      prompt: 'p',
      invoke: tools.invoke,
      apiKey: 'k',
      baseURL: model.baseURL,
      maxIterations: 4,
    });
    expect(bodies(model)).toHaveLength(4);
    expect(tools.seen).toHaveLength(4);
    // And SAYS it stopped, rather than reporting the same thing a finished run reports.
    expect(transcript.stopped).toBe('turn_cap');
    expect(transcript.exitCode).toBe(-1);
  });

  it('names a turn that ended inside the reasoning, rather than calling it a finish', async () => {
    // Measured on a real model, twice, before this existed. `moonshotai/kimi-k2-thinking`
    // ends turns inside its own reasoning: once leaking its next call as text
    // (`<|tool_call_begin|>functions.read…`), once stopping mid-sentence while planning
    // the commit — both `finish_reason: 'stop'`, both far under any length cap.
    //
    // The second run had explored the repository, driven the browser, seen the bug and
    // written the reproduction. It never reached `git_commit`, so the run reported "the
    // agent handed over a commit the repository already had": an accusation of idleness
    // against a model that had done nearly everything. That is the same failure class
    // `turn_cap` above exists for — a fault reporting itself as a choice.
    //
    // `probeToolCalling` cannot catch it (ADR-0015): it is one turn, and this model makes
    // structured calls perfectly well for seven of them first.
    model = await fakeChat([{ reasoning: 'I will read the test file next and then commit' }]);
    const transcript = await runOpenRouterLoop({
      prompt: 'p',
      invoke: recorder().invoke,
      apiKey: 'k',
      baseURL: model.baseURL,
    });
    expect(transcript.stopped).toBe('malformed_tool_call');
    expect(transcript.exitCode).toBe(-1);
    expect(JSON.stringify(transcript.lines)).toMatch(/failed to emit what it was about to do/);
  });

  it('leaves a model that answers in prose alone, because that is a real ending', async () => {
    // The other half, and what keeps the check narrow. A model that is genuinely done
    // says so in `content` — including one that thought first. Keying on "no tool call"
    // alone would convict every honest refusal, and `prompts/repro.md` asks for exactly
    // that when a bug cannot be reproduced: "say so plainly and commit nothing".
    model = await fakeChat([{ reasoning: 'weighing it up', content: 'I cannot reproduce this.' }]);
    const transcript = await runOpenRouterLoop({
      prompt: 'p',
      invoke: recorder().invoke,
      apiKey: 'k',
      baseURL: model.baseURL,
    });
    expect(transcript.stopped).toBe('exit');
    expect(transcript.exitCode).toBe(0);
  });

  it('does not cry turn_cap when the model simply finished', async () => {
    // The other half, and the one that makes the value mean something: a model that ends
    // its own conversation on the last permitted turn finished, and must not be recorded
    // as interrupted.
    model = await fakeChat([{ tool_calls: [fnCall('glob', { pattern: '*' })] }, { content: 'all done' }]);
    const transcript = await runOpenRouterLoop({
      prompt: 'p',
      invoke: recorder().invoke,
      apiKey: 'k',
      baseURL: model.baseURL,
      maxIterations: 2,
    });
    expect(transcript.stopped).toBe('exit');
    expect(transcript.exitCode).toBe(0);
  });

  it('reports the ceiling as testimony, so a cut-off agent is legible in the log', async () => {
    // The failure this exists for: the first real webhook-driven run's fix agent hit the
    // ceiling one turn short of committing, having already edited the file and verified
    // the fix. `AGENT_FINISHED` said `stopped: 'exit'`, `exit_code: 0` — a clean finish —
    // and the run then aborted on "a commit the repository already had". Nothing named
    // the ceiling, so the missing commit read as the model's choice.
    model = await fakeChat([{ tool_calls: [fnCall('edit', { path: 'a' })] }], { repeatLast: true });
    const transcript = await runOpenRouterLoop({
      prompt: 'p',
      invoke: recorder().invoke,
      apiKey: 'k',
      baseURL: model.baseURL,
      maxIterations: 3,
    });
    const error = transcript.lines.at(-1)!;
    expect(error.claimed_type).toBe('loop_error');
    expect(error.raw).toContain('iteration ceiling');
    expect(error.raw).toContain('3 turns');
  });

  it('reports the line cap instead of silently truncating', async () => {
    model = await fakeChat([{ tool_calls: [fnCall('glob', { pattern: '*' })] }], { repeatLast: true });
    const transcript = await runOpenRouterLoop({
      prompt: 'p',
      invoke: recorder().invoke,
      apiKey: 'k',
      baseURL: model.baseURL,
      maxLines: 3,
      maxIterations: 50,
    });
    expect(transcript.stopped).toBe('line_cap');
    expect(transcript.exitCode).toBe(-1);
    expect(transcript.lines).toHaveLength(3);
  });

  it('keeps the transcript when the API refuses mid-run', async () => {
    model = await fakeChat([{ content: 'first' }], { status: 429, body: '{"error":{"message":"slow down"}}' });
    const transcript = await runOpenRouterLoop({
      prompt: 'p',
      invoke: recorder().invoke,
      apiKey: 'k',
      baseURL: model.baseURL,
    });
    expect(transcript.exitCode).toBe(-1);
    // `api_error`, not the `spawn_failed` this asserted for as long as `stopped` was
    // guessed from a line count. The name of this test is the argument: a loop the API
    // refused mid-run is not a loop that never got going, and the two send whoever reads
    // the report to look at different things.
    expect(transcript.stopped).toBe('api_error');
    expect(transcript.lines[0]!.raw).toContain('429');
    // The body, IN the message. Every reader of a transcript renders `loop_error` by its
    // `message` alone, so a cause in a field beside it is a cause nobody sees — which is
    // how a real `403 Key limit exceeded` reached the log as the string `HTTP 403`.
    const first = JSON.parse(transcript.lines[0]!.raw) as { message: string };
    expect(first.message).toContain('slow down');
  });

  it('does not call a spend cap an iteration ceiling', async () => {
    // The production failure this file exists to stop repeating. A real `draft` job on a
    // new repository ran sixteen tool-calling turns — it booted the app, passed
    // `/healthz`, loaded the page, saw the orders — and then OpenRouter answered
    //   403 {"error":{"message":"Key limit exceeded (total limit) ..."}}
    // The loop broke, left `stopped` at `exit`, and fell into the `turn_cap` relabel at
    // the bottom, so the only thing the log said was "the iteration ceiling was reached
    // while the model was still calling tools". The ceiling was 25 and it was nowhere
    // near it. An operator reading that goes looking at `prompts/recipe.md` and
    // `maxIterations` for a fault that was a two-dollar key.
    model = await fakeChat([{ tool_calls: [fnCall('glob', { pattern: '*' })] }], {
      repeatLast: true,
      failAfter: 3,
      status: 403,
      body: '{"error":{"message":"Key limit exceeded (total limit)","code":403}}',
    });
    const transcript = await runOpenRouterLoop({
      prompt: 'p',
      invoke: recorder().invoke,
      apiKey: 'k',
      baseURL: model.baseURL,
      maxIterations: 25,
    });

    expect(transcript.stopped).toBe('api_error');
    expect(transcript.exitCode).toBe(-1);
    // The work it DID do survives — three turns of it, both halves of every tool call.
    expect(transcript.usage.turns).toBe(3);
    expect(transcript.lines.filter((line) => line.claimed_type === 'tool_result')).toHaveLength(3);

    const errors = transcript.lines
      .filter((line) => line.claimed_type === 'loop_error')
      .map((line) => (JSON.parse(line.raw) as { message: string }).message);
    // Exactly one account of what went wrong, and it names the cause.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('403');
    expect(errors[0]).toContain('Key limit exceeded');
    // The lie, gone. Both halves of it: the label and the sentence.
    expect(transcript.stopped).not.toBe('turn_cap');
    expect(errors.join(' ')).not.toContain('iteration ceiling');
  });

  it('totals what it spent', async () => {
    model = await fakeChat([{ tool_calls: [fnCall('glob', { pattern: '*' })] }, { content: 'done' }]);
    const transcript = await runOpenRouterLoop({
      prompt: 'p',
      invoke: recorder().invoke,
      apiKey: 'k',
      baseURL: model.baseURL,
    });
    expect(transcript.usage).toEqual({
      turns: 2,
      input_tokens: 6,
      output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });
});

describe('the probe refuses a model that cannot drive the tools', () => {
  it('passes when the tool call arrives structured', async () => {
    model = await fakeChat([{ tool_calls: [fnCall('glob', { pattern: '*' })] }]);
    const outcome = await probeToolCalling({ apiKey: 'k', model: 'cheap/model', baseURL: model.baseURL });
    expect(outcome.ok).toBe(true);
  });

  it('fails, naming the model, when the call arrives as prose', async () => {
    // The failure this whole function exists for. Without it the run completes, the
    // transcript reads like an agent that chose to do nothing, and the engine reports a
    // tier about the USER'S bug that is really a fact about the model.
    model = await fakeChat([{ content: 'Sure! I would call glob("*") now.' }]);
    const outcome = await probeToolCalling({ apiKey: 'k', model: 'cheap/model', baseURL: model.baseURL });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('cheap/model');
    expect(outcome.detail).toContain('structured tool call');
  });

  it('fails when the model calls something that was never offered', async () => {
    model = await fakeChat([{ tool_calls: [fnCall('deploy_to_production', {})] }]);
    const outcome = await probeToolCalling({ apiKey: 'k', model: 'cheap/model', baseURL: model.baseURL });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('deploy_to_production');
  });

  it('fails on an HTTP error rather than reporting a usable model', async () => {
    model = await fakeChat([], { status: 403, body: '{"error":{"message":"Key limit exceeded (total limit)"}}' });
    const outcome = await probeToolCalling({ apiKey: 'k', model: 'cheap/model', baseURL: model.baseURL });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('403');
    // AND the body. This asserted `detail: 'HTTP 401'` exactly, which passed while the
    // probe threw the provider's explanation away — the same hole the loop had, and the
    // reason a spent key looked like an iteration ceiling. What an operator needs from a
    // refused key is which of expired, revoked, out of credit, or not entitled to this
    // model it was, and only the provider knows.
    expect(outcome.detail).toContain('Key limit exceeded');
  });

  it('fails when the endpoint is unreachable instead of throwing', async () => {
    const outcome = await probeToolCalling({ apiKey: 'k', model: 'm', baseURL: 'http://127.0.0.1:1' });
    expect(outcome.ok).toBe(false);
  });
});

describe('a 200 is not proof the request was accepted', () => {
  // Both tests below are regressions on bugs the FIRST real run found, in this file's
  // own code. OpenRouter answers HTTP 200 with `{error: {code: 400}}` when an upstream
  // provider rejects the request, and `response.ok` alone cannot see it.

  it('names the API error instead of blaming the model', async () => {
    // The cost of getting this wrong was a wrong diagnosis: the probe reported that Kimi
    // could not make a structured tool call, when the truth was that OUR request was
    // invalid. That sends an operator changing models to fix a bug in src/openrouter.ts.
    model = await fakeChat([], { errorBody: { message: 'invalid request error trace_id: abc', code: 400 } });
    const outcome = await probeToolCalling({ apiKey: 'k', model: 'cheap/model', baseURL: model.baseURL });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('was not asked successfully');
    expect(outcome.detail).toContain('api error 400');
    expect(outcome.detail).not.toContain('answered without a structured tool call');
  });

  it('records the cause in the loop, not the symptom', async () => {
    model = await fakeChat([], { errorBody: { message: 'no endpoints found', code: 404 } });
    const transcript = await runOpenRouterLoop({
      prompt: 'p',
      invoke: recorder().invoke,
      apiKey: 'k',
      baseURL: model.baseURL,
    });
    expect(transcript.stopped).toBe('api_error');
    expect(transcript.exitCode).toBe(-1);
    expect(transcript.lines[0]!.raw).toContain('api error 404');
    expect(transcript.lines[0]!.raw).toContain('no endpoints found');
    // "the response carried no message" describes the symptom and hides the cause.
    expect(transcript.lines[0]!.raw).not.toContain('carried no message');
    expect(transcript.usage.turns).toBe(0);
  });

  it('does not send tool_choice, which a real provider rejected', async () => {
    // `'required'` reads like the stricter setting and is the obvious thing to want in a
    // probe. Moonshot rejects it outright, so it made the probe fail on exactly the cheap
    // models the probe exists to screen. Asserted so it cannot be helpfully re-added.
    model = await fakeChat([{ tool_calls: [fnCall('glob', { pattern: '*' })] }]);
    await probeToolCalling({ apiKey: 'k', model: 'cheap/model', baseURL: model.baseURL });
    expect(model.requests[0]).not.toHaveProperty('tool_choice');
  });
});

describe('choosing a provider', () => {
  it('defaults to openrouter, the path with a real run behind it', () => {
    // This asserted `anthropic` when the adapter landed, on the grounds that Anthropic
    // was the tested path. A real run inverted it: no Anthropic credential has ever been
    // present here, so that default was the path nobody had executed, behind a key nobody
    // had. The default follows the evidence.
    expect(providerName()).toBe('openrouter');
    expect(providerName('anthropic')).toBe('anthropic');
    process.env.ENGINE_PROVIDER = 'anthropic';
    expect(providerName()).toBe('anthropic');
  });

  it('refuses a typo instead of quietly picking the expensive one', () => {
    expect(() => providerName('openrouterr')).toThrow(/ENGINE_PROVIDER must be one of/);
    process.env.ENGINE_PROVIDER = 'openai';
    expect(() => providerName()).toThrow(/openai/);
  });

  it('routes to openrouter with no provider configured at all', async () => {
    model = await fakeChat([{ content: 'hello from a cheap model' }]);
    // No `ENGINE_PROVIDER` and no `provider` — this is the default path now.
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const transcript = await runAgentLoop({ prompt: 'p', invoke: recorder().invoke, baseURL: model.baseURL });
    expect(JSON.parse(transcript.lines[0]!.raw)).toEqual({ text: 'hello from a cheap model' });
    expect(bodies(model)[0]!.model).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it('does not fall back to the Anthropic model id, which would 404 here', async () => {
    // `ENGINE_MODEL` means "a model id" on both paths, and `claude-opus-5` is not one
    // OpenRouter's OpenAI endpoint knows. Defaulting to it would turn a working config
    // into a 404 whose cause is not in the message.
    model = await fakeChat([{ content: 'ok' }]);
    const transcript = await runAgentLoop({
      prompt: 'p',
      invoke: recorder().invoke,
      provider: 'openrouter',
      apiKey: 'k',
      baseURL: model.baseURL,
    });
    expect(transcript.exitCode).toBe(0);
    expect(bodies(model)[0]!.model).toBe('moonshotai/kimi-k2-thinking');
    expect(bodies(model)[0]!.model).not.toContain('claude');
  });

  it('honours ENGINE_MODEL so any of OpenRouter’s models can be selected', async () => {
    model = await fakeChat([{ content: 'ok' }]);
    process.env.ENGINE_MODEL = 'deepseek/deepseek-r1';
    await runAgentLoop({
      prompt: 'p',
      invoke: recorder().invoke,
      provider: 'openrouter',
      apiKey: 'k',
      baseURL: model.baseURL,
    });
    expect(bodies(model)[0]!.model).toBe('deepseek/deepseek-r1');
  });

  it('refuses to run without a credential rather than reporting an empty transcript', async () => {
    // The rule this project will not bend: an engine that cannot reach a model has not
    // observed anything, and must not be able to produce a tier as though it had.
    const transcript = await runAgentLoop({ prompt: 'p', invoke: recorder().invoke, provider: 'openrouter' });
    expect(transcript.stopped).toBe('spawn_failed');
    expect(transcript.exitCode).toBe(-1);
    expect(transcript.lines[0]!.raw).toContain('OPENROUTER_API_KEY');
    expect(transcript.usage.turns).toBe(0);
  });

  it('collapses effort to the three levels this API accepts', async () => {
    model = await fakeChat([{ content: 'ok' }]);
    await runAgentLoop({
      prompt: 'p',
      invoke: recorder().invoke,
      provider: 'openrouter',
      apiKey: 'k',
      baseURL: model.baseURL,
      effort: 'max',
    });
    expect(bodies(model)[0]!.reasoning).toEqual({ effort: 'high' });
    // Still validated on the way through: a typo must not become a silent default.
    expect(() => effortLevel('hihg')).toThrow(/ENGINE_EFFORT/);
  });

  it('passes the spend ceilings through instead of quietly using its own', async () => {
    model = await fakeChat([{ content: 'ok' }]);
    await runAgentLoop({
      prompt: 'p',
      invoke: recorder().invoke,
      provider: 'openrouter',
      apiKey: 'k',
      baseURL: model.baseURL,
      maxTokens: 256,
    });
    expect(bodies(model)[0]!.max_tokens).toBe(256);
  });
});

describe('the suite has no model configuration of its own', () => {
  it('scrubs the operator\'s model selection out of the environment', () => {
    // Asserted over the config's SOURCE rather than over `process.env`, because a test
    // that reads the variable passes either way once an earlier `afterEach` has deleted
    // it — which is exactly how this hole stayed open.
    //
    // The hole: `vitest.config.ts` loads `.env` for `DATABASE_URL`, so a real
    // `ENGINE_PROVIDER=openrouter` put there for an actual run sent every Anthropic-path
    // test through the OpenRouter branch, where the scripted Messages API fixture is the
    // wrong wire format. Six tests went red and nothing named the file responsible.
    const config = readFileSync(new URL('../vitest.config.ts', import.meta.url), 'utf8');
    for (const key of ['ENGINE_PROVIDER', 'ENGINE_MODEL', 'ENGINE_EFFORT', 'OPENROUTER_API_KEY']) {
      expect(config).toContain(key);
    }
    expect(config).toMatch(/delete process\.env\[key\]/);
  });
});

// ── what the caller is told a cut-off session was ────────────────────────────
//
// `runOpenRouterLoop` naming the cause correctly buys nothing if the layer above
// overwrites it, and that is exactly what happened. `draftRecipe` reported the FIRST
// real draft job on a new repository as "the drafting session produced no fenced JSON
// block" — true, and a description of the symptom. The session had been cut off by a
// 403 four lines earlier in its own transcript.

describe('a cut-off drafting session reports what cut it off', () => {
  it('prefers the loop error over the missing JSON block', async () => {
    const fixture = demoRepo();
    const model = await fakeChat([{ tool_calls: [fnCall('glob', { pattern: '*' })] }], {
      repeatLast: true,
      failAfter: 2,
      status: 403,
      body: '{"error":{"message":"Key limit exceeded (total limit)","code":403}}',
    });

    // Enough of an executor to hand the driver an `invoke` and get out of the way. What
    // is under test is the sentence `draftRecipe` returns, not a container.
    const executor = {
      kind: 'docker' as const,
      runPhase: async (spec: {
        phase: string;
        driver?: (io: { invoke: (name: string, input: unknown) => Promise<{ ok: boolean; output: string }> }) => Promise<void>;
      }) => {
        await spec.driver?.({ invoke: async () => ({ ok: true, output: 'ok' }) });
        return { phase: spec.phase, events: [], exitCode: 0, stderr: '' } as never;
      },
      buildSnapshot: async () => ({ failed: 'not used' }),
      dropSnapshot: async () => {},
    };

    try {
      const outcome = await draftRecipe({
        runId: '3f1c9a52-7b0e-4d2f-9c41-8a6e5d0b21c7',
        repoPath: fixture.repo,
        image: 'engine:test',
        loop: { provider: 'openrouter', apiKey: 'k', baseURL: model.baseURL },
        executor: executor as never,
      });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      // The cause, in the sentence an operator reads.
      expect(outcome.reason).toContain('403');
      expect(outcome.reason).toContain('Key limit exceeded');
      expect(outcome.reason).toContain('api_error');
      // And NOT the symptom it used to report instead.
      expect(outcome.reason).not.toContain('no fenced JSON block');
    } finally {
      await model.close();
      cleanupFixtures();
    }
  });
});

// ── an empty repository is a state, not a crash (10n) ────────────────────────
//
// The most likely state of a repository somebody has just created and connected: no
// commits. `git rev-parse HEAD` exits non-zero on one, and a real `draft` job on
// `Divy97/git-practice` died as
//   ended badly — Error: Command failed: git -C … rev-parse HEAD
//   fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree
// which is a stack trace where an answer belongs.

describe('drafting an empty repository', () => {
  it('says the repository has no commits instead of throwing git at somebody', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'engine-empty-repo-'));
    await execFileAsync('git', ['-C', bare, 'init', '--quiet']);
    let ran = false;

    const outcome = await draftRecipe({
      runId: '3f1c9a52-7b0e-4d2f-9c41-8a6e5d0b21c7',
      repoPath: bare,
      image: 'engine:test',
      loop: { provider: 'openrouter', apiKey: 'k' },
      executor: {
        kind: 'docker' as const,
        runPhase: async () => {
          ran = true;
          return {} as never;
        },
        buildSnapshot: async () => ({ failed: 'not used' }),
        dropSnapshot: async () => {},
      } as never,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('no commits');
    // Nothing about git's own words reaches the caller.
    expect(outcome.reason).not.toContain('rev-parse');
    expect(outcome.reason).not.toContain('ambiguous argument');
    // And no container was started for a repository with nothing in it.
    expect(ran).toBe(false);
    await rm(bare, { recursive: true, force: true });
  });
});
