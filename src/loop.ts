// The agent loop, on the host, outside the sandbox (ADR-0011).
//
// M3 put `claude -p` inside the container and spent a milestone trying to give it
// exactly one route to the model API. The route does not exist: `--network none`
// removes every interface and `--add-host … :host-gateway` needs one. This file
// is the answer that deletes the problem instead of solving it — the loop runs
// here, holding the credential, and only tool calls cross into the container.
//
// Two things follow, and they are the whole reason the file is shaped this way:
//
//   1. `invoke` is injected. This module never touches the container; it hands a
//      tool name and an argument object to whatever the caller wired up. The
//      transport is the caller's business (today: the container's stdio, because
//      a sealed container's pipe to the host IS the worker dialling out and needs
//      no interface at all).
//   2. Nothing here writes an event. The loop returns a transcript, and the
//      ORCHESTRATOR turns it into AGENT_MESSAGE payloads — ADR-0006's amendment
//      moves the pen to the host orchestrator, not to whichever host module
//      happens to be talking to the model.
//
// The credential lives in this process and there is no configuration under which
// the container can read it. That is a stronger statement than any allowlist.

import Anthropic from '@anthropic-ai/sdk';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import type { AgentFinishedV1 } from './events.js';
import { TOOL_SCHEMAS } from './tools.js';

/** The model v1.5 runs on, and the thinking configuration ADR-0011's milestone names. */
export const MODEL = 'claude-opus-5';
/**
 * Non-streaming, so this stays under the SDK's HTTP timeout. The loop makes many
 * bounded turns rather than one enormous one, which is what a tool runner is.
 */
const MAX_TOKENS = 16_000;
/** Ceilings on an untrusted, paid-for loop. Every one of them is a recorded fact when hit. */
const MAX_LINES = 10_000;
const MAX_ITERATIONS = 200;
const DEFAULT_TIMEOUT_MS = 1_800_000;

/**
 * One line of the transcript, exactly as it will be stored.
 *
 * `claimed_type` is named for what it is (ADR-0006): what the turn ASSERTED it
 * was. A tool result the worker returned is testimony about the world too — the
 * orchestrator watched a string arrive on a pipe, and nothing more.
 */
export type TranscriptLine = { claimed_type: string; raw: string };

export type AgentTranscript = {
  lines: TranscriptLine[];
  stopped: AgentFinishedV1['stopped'];
  /** 0 when the loop ran to its own end; -1 when a ceiling or a failure stopped it. */
  exitCode: number;
};

export type LoopOptions = {
  prompt: string;
  /** Executes one tool call wherever the tools actually live. Returns the tool's output. */
  invoke: (tool: string, input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
  apiKey?: string;
  /**
   * Points the SDK somewhere other than Anthropic.
   *
   * This is how the loop is tested without a credential: a local server that
   * speaks the Messages API scripts a hostile tool-call sequence, and the whole
   * path — schemas out, calls in, results back, transcript recorded — runs for
   * real. It is the successor to the fake `claude` on PATH, and for the same
   * reason: what has to be proven is behaviour under output a real model will
   * never produce on demand.
   */
  baseURL?: string;
  timeoutMs?: number;
  maxLines?: number;
  maxIterations?: number;
};

/**
 * Run the agent to completion, or to a ceiling, and return what it said.
 *
 * Throws nothing on a model error: an agent that fails is an observation, not a
 * failure to observe. `stopped` says which it was, so a transcript that was cut
 * off can never read as one that finished.
 */
export async function runAgentLoop(options: LoopOptions): Promise<AgentTranscript> {
  const lines: TranscriptLine[] = [];
  const maxLines = options.maxLines ?? MAX_LINES;
  let stopped: AgentFinishedV1['stopped'] = 'exit';
  let exitCode = 0;

  const record = (claimed_type: string, payload: unknown): void => {
    if (lines.length >= maxLines) return;
    lines.push({ claimed_type, raw: JSON.stringify(payload) });
  };

  // `spawn_failed` is reused for "the loop never got going", which is what it has
  // always meant — the state an operator most needs to read off the log, as
  // distinct from an agent that ran and said nothing. There is no process to
  // spawn any more; there is still a difference between a loop that could not
  // start and one that started and produced nothing.
  let client: Anthropic;
  try {
    client = new Anthropic({
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    });
  } catch (error) {
    record('loop_error', { message: String(error) });
    return { lines, stopped: 'spawn_failed', exitCode: -1 };
  }

  // `BetaRunnableTool` by hand rather than through `betaTool()`: that helper infers
  // an argument type from a *const* schema, and ours are runtime data in an array
  // — the whole point being that the surface has one definition (src/tools.ts) that
  // both the model and the worker read. `parse` is the identity because the model's
  // arguments are untyped JSON either way and every tool validates its own.
  const tools: BetaRunnableTool<Record<string, unknown>>[] = TOOL_SCHEMAS.map((schema) => ({
    name: schema.name,
    description: schema.description,
    input_schema: schema.input_schema,
    parse: (content: unknown) => (content ?? {}) as Record<string, unknown>,
    // The tool runner calls this; it reaches the container and comes back.
    // Recorded on BOTH sides: what the model asked for is the interesting half of
    // an agent transcript, and a result with no call beside it is unreadable.
    run: async (input: Record<string, unknown>) => {
      record('tool_use', { name: schema.name, input });
      let result: { ok: boolean; output: string };
      try {
        result = await options.invoke(schema.name, input);
      } catch (error) {
        // The worker is unreachable or died. Told to the model as a failed tool
        // call rather than thrown: an agent that loses one tool call can still
        // finish, and losing the transcript to save the exception is the trade
        // this codebase has already refused twice.
        result = { ok: false, output: `the tool could not be executed: ${String(error)}` };
      }
      record('tool_result', { name: schema.name, ok: result.ok, output: result.output });
      return result.output;
    },
  }));

  const deadline = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), options.timeoutMs ?? DEFAULT_TIMEOUT_MS).unref(),
  );

  const drive = async (): Promise<void> => {
    const runner = client.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Adaptive, and NOT disabled: with thinking off this model can write a tool
      // call into its visible text, where it reads as a completed turn and the
      // call never runs. A silent no-op is the exact failure class this project
      // is built to refuse, so the more expensive setting is the correct one.
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      tools,
      messages: [{ role: 'user', content: options.prompt }],
      max_iterations: options.maxIterations ?? MAX_ITERATIONS,
    });
    for await (const message of runner) {
      for (const block of message.content) {
        if (block.type === 'text') record('assistant', { text: block.text });
        else if (block.type === 'thinking') record('thinking', { thinking: block.thinking });
        else if (block.type !== 'tool_use') record(block.type, block);
        // `tool_use` is deliberately not recorded here: the tool's own `run`
        // records it, on the side that also records the result, so the pair
        // cannot be separated by an early exit.
      }
      record('result', { stop_reason: message.stop_reason, usage: message.usage });
      if (lines.length >= maxLines) {
        stopped = 'line_cap';
        exitCode = -1;
        return;
      }
    }
  };

  try {
    const raced = await Promise.race([drive().then(() => 'done' as const), deadline]);
    if (raced === 'timeout') {
      stopped = 'timeout';
      exitCode = -1;
    }
  } catch (error) {
    // A model API error, a refusal, a rate limit. All of them are things the
    // agent's turn did, recorded as testimony; none of them is a reason to lose
    // the transcript that arrived before it.
    record('loop_error', { message: String(error) });
    if (stopped === 'exit') {
      stopped = lines.length === 0 ? 'spawn_failed' : 'exit';
      exitCode = -1;
    }
  }

  return { lines, stopped, exitCode };
}
