// The agent loop against an OpenAI-shaped API, so the model is genuinely swappable.
//
// The README's second sentence claims "the LLM is a replaceable component; the project
// is the engineering system around it." A loop welded to one vendor's SDK does not
// quite earn that, and ADR-0015 records the decision to stop asserting it and make it
// true instead.
//
// What this is NOT: a hedge against Anthropic. `src/loop.ts` still drives the Messages
// API tool runner and still does it better — native thinking blocks, a maintained
// agentic loop, prompt-cache semantics we did not have to write. This exists because
// 336 of OpenRouter's 403 models advertise tool support and the cheap reasoning ones
// are an order of magnitude cheaper on output, which is what makes iterating on a
// PROMPT affordable. ADR-0011's boundary is untouched either way: the loop is on the
// host, tool calls travel in, and the container has no egress.
//
// No SDK, for the same reason `src/github.ts` has none: this is one POST with JSON in
// it, and `fetch` is already here. An OpenAI client would be a large surface for one
// endpoint, and a second dependency inside the process that holds the credential.
//
// The one thing that genuinely differs between models is whether a tool call arrives
// as a STRUCTURED call or as prose that looks like one. That failure is silent — the
// turn completes, nothing runs, and the transcript reads like an agent that chose to do
// nothing. `probeToolCalling` below exists so an unsuitable model fails at the start
// with a sentence saying why, rather than at the end with an empty log.

import type { AgentFinishedV1 } from './events.js';
import type { AgentTranscript, LoopUsage, TranscriptLine } from './loop.js';
import { TOOL_SCHEMAS } from './tools.js';

/** Where OpenRouter's OpenAI-compatible endpoint lives. */
export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/**
 * The default when this adapter is selected.
 *
 * Kimi K2 Thinking rather than the cheapest thing on the list: it advertises both
 * `tools` and `reasoning`, it was built for agentic tool use, and at $0.60/$2.50 it is
 * roughly a tenth of Opus on output. MiniMax M2.5 is cheaper still ($0.22/$0.90) and is
 * the next thing to try once a real run has shown this path works at all.
 */
export const DEFAULT_OPENROUTER_MODEL = 'moonshotai/kimi-k2-thinking';

type ChatMessage =
  | { role: 'user' | 'system'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; reasoning?: string }
  | { role: 'tool'; tool_call_id: string; content: string };

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

type ChatResponse = {
  choices?: {
    message?: { content?: string | null; tool_calls?: ToolCall[]; reasoning?: string };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: number };
};

export type OpenRouterOptions = {
  prompt: string;
  invoke: (tool: string, input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
  apiKey: string;
  model?: string;
  baseURL?: string;
  effort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
  maxIterations?: number;
  maxLines?: number;
  timeoutMs?: number;
};

/**
 * The error a 200 can be carrying, or null.
 *
 * Found by running against the real API: OpenRouter answers **HTTP 200 with an
 * `{error: {code: 400}}` body** when an upstream provider rejects the request. Checking
 * `response.ok` alone therefore reads a rejected request as a successful turn — and the
 * first thing it cost was a wrong diagnosis. The probe below reported "this model cannot
 * make a structured tool call" when the truth was that OUR request was invalid, which
 * would have sent an operator changing models to fix a bug in this file.
 *
 * Exactly the failure class this project exists to refuse, found in its own code.
 */
export const apiError = (body: ChatResponse): string | null => {
  if (!body.error) return null;
  const code = body.error.code;
  return `${code === undefined ? 'api error' : `api error ${code}`}: ${body.error.message ?? 'no message given'}`;
};

/**
 * Our tool surface, in the OpenAI shape.
 *
 * A pure mapping over the SAME `TOOL_SCHEMAS` the Anthropic path uses — `input_schema`
 * is already JSON Schema, which is what `function.parameters` wants. One definition,
 * two wire formats: a second list of tools for a second provider is how the two
 * silently diverge.
 */
export const openAiTools = () =>
  TOOL_SCHEMAS.map((schema) => ({
    type: 'function' as const,
    function: { name: schema.name, description: schema.description, parameters: schema.input_schema },
  }));

/**
 * Ask the model to make ONE trivial tool call, and check it arrives structured.
 *
 * The reason this exists rather than being optimism: a model that emits a tool call as
 * text produces a turn that completes successfully with nothing executed. The
 * transcript then reads like an agent that read the prompt and declined, which is
 * indistinguishable from a genuine Tier 3 — so the engine would report a finding about
 * the user's bug when the truth is that the model cannot drive our tools.
 *
 * Cheap: one turn, a handful of tokens, and it runs before the prompt is spent.
 */
export async function probeToolCalling(options: {
  apiKey: string;
  model: string;
  baseURL?: string;
}): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(`${options.baseURL ?? OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model,
        max_tokens: 512,
        // No `tool_choice`. It was `'required'`, which reads like the stricter setting and
        // is the obvious thing to want here — but a real run showed Moonshot rejecting it
        // outright, so the probe failed on precisely the cheap models it exists to screen.
        // Omitting it is also NOT the same as sending `'auto'` at this provider: `'auto'`
        // came back with an empty message, omission came back with the call. The prompt
        // does the asking, and a model that answers it in prose is the thing being caught.
        messages: [{ role: 'user', content: 'Call the `glob` tool with the pattern "*". Say nothing else.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'glob',
              description: 'List workspace files matching a glob pattern.',
              parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
            },
          },
        ],
      }),
    });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    const body = (await response.json()) as ChatResponse;
    // Before reading the answer, check the answer is one. A rejected request must never
    // be reportable as a fact about the model's capabilities.
    const failed = apiError(body);
    if (failed !== null) return { ok: false, detail: `${options.model} was not asked successfully — ${failed}` };
    const calls = body.choices?.[0]?.message?.tool_calls ?? [];
    if (calls.length === 0) {
      return {
        ok: false,
        detail:
          `${options.model} answered without a structured tool call, so it cannot drive this ` +
          `engine's tools — every run would look like an agent that chose to do nothing`,
      };
    }
    if (calls[0]!.function.name !== 'glob') {
      return { ok: false, detail: `${options.model} called ${calls[0]!.function.name} instead of glob` };
    }
    return { ok: true, detail: `${options.model} makes structured tool calls` };
  } catch (error) {
    return { ok: false, detail: String((error as Error).message ?? error) };
  }
}

/**
 * Run the agent to completion, or to a ceiling, against an OpenAI-shaped API.
 *
 * The loop the Anthropic SDK's tool runner was doing for us, written out: ask, execute
 * every call the model asked for, feed the results back, repeat. Two details are not
 * optional and both are ways this quietly breaks:
 *
 *   - **Every** tool call in a turn gets a `tool` message back, in ONE go, before the
 *     next request. Returning some of them, or splitting them across turns, trains the
 *     model out of asking for parallel calls and can leave the conversation invalid.
 *   - The assistant message is appended **verbatim**, `tool_calls` included. Rebuilding
 *     it from parts loses the ids the `tool` messages have to match.
 */
export async function runOpenRouterLoop(options: OpenRouterOptions): Promise<AgentTranscript> {
  const model = options.model ?? DEFAULT_OPENROUTER_MODEL;
  const maxLines = options.maxLines ?? 10_000;
  const lines: TranscriptLine[] = [];
  const usage: LoopUsage = {
    turns: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  let stopped: AgentFinishedV1['stopped'] = 'exit';
  let exitCode = 0;
  // Whether the MODEL ended the conversation, as opposed to the ceiling ending it. The
  // two used to be the same value.
  let modelFinished = false;

  const record = (claimed_type: string, payload: unknown): void => {
    if (lines.length >= maxLines) return;
    lines.push({ claimed_type, raw: JSON.stringify(payload) });
  };

  const messages: ChatMessage[] = [{ role: 'user', content: options.prompt }];
  const deadline = Date.now() + (options.timeoutMs ?? 1_800_000);

  for (let turn = 0; turn < (options.maxIterations ?? 25); turn += 1) {
    if (Date.now() > deadline) {
      stopped = 'timeout';
      exitCode = -1;
      break;
    }

    let body: ChatResponse;
    try {
      const response = await fetch(`${options.baseURL ?? OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: options.maxTokens ?? 16_000,
          messages,
          tools: openAiTools(),
          // OpenRouter's own reasoning control. It normalises unsupported parameters
          // away rather than rejecting them, so sending this to a model without
          // reasoning is harmless — which is what lets one code path serve both.
          reasoning: { effort: options.effort ?? 'medium' },
        }),
      });
      if (!response.ok) {
        // Told as testimony, exactly as the Anthropic path does: an agent that fails is
        // an observation, and losing the transcript to save the exception is the trade
        // this codebase refuses.
        //
        // The body goes in the MESSAGE, not beside it. It used to be a second field, and
        // every reader of a transcript renders `loop_error` by its `message` alone — so a
        // real 403 reached the log as the four characters `HTTP 403` while the sentence
        // that said WHY (`Key limit exceeded (total limit)`, and the URL that fixes it)
        // sat in a field nothing printed. A cause that is stored and never shown is a
        // cause nobody has.
        const detail = (await response.text()).slice(0, 2000).trim();
        record('loop_error', { message: `HTTP ${response.status}${detail === '' ? '' : ` — ${detail}`}` });
        exitCode = -1;
        stopped = 'api_error';
        break;
      }
      body = (await response.json()) as ChatResponse;
    } catch (error) {
      record('loop_error', { message: String(error) });
      exitCode = -1;
      stopped = 'api_error';
      break;
    }

    // A 200 can still be a refusal (see `apiError`). Recorded as what it is, rather than
    // falling through to "the response carried no message", which describes the symptom
    // and hides the cause.
    const failed = apiError(body);
    if (failed !== null) {
      record('loop_error', { message: failed });
      exitCode = -1;
      stopped = 'api_error';
      break;
    }

    const message = body.choices?.[0]?.message;
    if (!message) {
      record('loop_error', { message: 'the response carried no message', body });
      exitCode = -1;
      stopped = 'api_error';
      break;
    }

    // Reasoning first, then text, matching the Anthropic path's claimed types so the
    // transcript reads the same whichever provider produced it and nothing downstream
    // has to know which did.
    if (message.reasoning) record('thinking', { thinking: message.reasoning });
    if (message.content) record('assistant', { text: message.content });

    usage.turns += 1;
    usage.input_tokens += body.usage?.prompt_tokens ?? 0;
    usage.output_tokens += body.usage?.completion_tokens ?? 0;

    const toolCalls = message.tool_calls ?? [];
    record('result', {
      stop_reason: toolCalls.length > 0 ? 'tool_use' : (body.choices?.[0]?.finish_reason ?? 'end_turn'),
      usage: body.usage,
    });
    if (lines.length >= maxLines) {
      stopped = 'line_cap';
      exitCode = -1;
      break;
    }
    if (toolCalls.length === 0) {
      // A turn that ended inside the model's own REASONING, with nothing said and
      // nothing called, is not a model that finished — and reporting it as one is the
      // failure class `turn_cap` below was added for.
      //
      // Measured, not guessed: two consecutive `moonshotai/kimi-k2-thinking` runs died
      // exactly here. One leaked its next call as text in the reasoning
      // (`<|tool_call_begin|>functions.read…`), the other stopped mid-sentence while
      // planning its next action — both with `finish_reason: 'stop'`, both well under
      // any length cap. The second had already written its reproduction and simply never
      // reached `git_commit`, so the run reported "the agent handed over a commit the
      // repository already had": an accusation of doing nothing, against a model that
      // had done nearly everything.
      //
      // `probeToolCalling` cannot catch this (ADR-0015) — it is one turn, and this model
      // makes structured calls perfectly well for seven of them before degrading. So the
      // check has to be here, on the shape of the turn.
      //
      // Deliberately narrow: reasoning present, content empty, no calls. A model that is
      // genuinely done says so in `content`.
      if (message.reasoning && !message.content) {
        stopped = 'malformed_tool_call';
        exitCode = -1;
        record('loop_error', {
          message:
            `the model ended turn ${usage.turns} inside its reasoning with no content and no ` +
            `tool call — it did not choose to stop, it failed to emit what it was about to do`,
        });
      }
      modelFinished = true;
      break;
    }

    // Verbatim, `tool_calls` included — the ids below have to match.
    messages.push({
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      let input: Record<string, unknown> = {};
      let output: string;
      try {
        // A weaker model's arguments are the likeliest thing here to be malformed, and
        // that is a fact to hand back rather than an exception: told about it, the model
        // can call the tool again correctly.
        input = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        record('tool_use', { name: toolCall.function.name, input: toolCall.function.arguments });
        output = `the arguments were not valid JSON: ${toolCall.function.arguments.slice(0, 500)}`;
        record('tool_result', { name: toolCall.function.name, ok: false, output });
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: output });
        continue;
      }
      record('tool_use', { name: toolCall.function.name, input });
      try {
        const result = await options.invoke(toolCall.function.name, input);
        output = result.output;
        record('tool_result', { name: toolCall.function.name, ok: result.ok, output });
      } catch (error) {
        output = `the tool could not be executed: ${String(error)}`;
        record('tool_result', { name: toolCall.function.name, ok: false, output });
      }
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: output });
    }
  }

  // The ceiling, said out loud. Reached only by falling out of the loop while the model
  // was still asking for tools — which is an agent that was interrupted, not one that
  // was done, and the difference decides whether a missing commit is the model's choice
  // or our budget.
  if (!modelFinished && stopped === 'exit') {
    stopped = 'turn_cap';
    exitCode = -1;
    record('loop_error', {
      message: `stopped after ${usage.turns} turns: the iteration ceiling was reached while the model was still calling tools`,
    });
  }

  return { lines, stopped, exitCode, usage };
}
