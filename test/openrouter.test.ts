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
    await runOpenRouterLoop({
      prompt: 'p',
      invoke: tools.invoke,
      apiKey: 'k',
      baseURL: model.baseURL,
      maxIterations: 4,
    });
    expect(bodies(model)).toHaveLength(4);
    expect(tools.seen).toHaveLength(4);
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
    expect(transcript.stopped).toBe('spawn_failed');
    expect(transcript.lines[0]!.raw).toContain('429');
    expect(transcript.lines[0]!.raw).toContain('slow down');
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
    model = await fakeChat([], { status: 401 });
    const outcome = await probeToolCalling({ apiKey: 'k', model: 'cheap/model', baseURL: model.baseURL });
    expect(outcome).toEqual({ ok: false, detail: 'HTTP 401' });
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
    expect(transcript.stopped).toBe('spawn_failed');
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
  it('defaults to anthropic, the path with a real run behind it', () => {
    expect(providerName()).toBe('anthropic');
  });

  it('refuses a typo instead of quietly picking the expensive one', () => {
    expect(() => providerName('openrouterr')).toThrow(/ENGINE_PROVIDER must be one of/);
    process.env.ENGINE_PROVIDER = 'openai';
    expect(() => providerName()).toThrow(/openai/);
  });

  it('routes to openrouter through ENGINE_PROVIDER', async () => {
    model = await fakeChat([{ content: 'hello from a cheap model' }]);
    process.env.ENGINE_PROVIDER = 'openrouter';
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
