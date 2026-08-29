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
import { DEFAULT_OPENROUTER_MODEL, OPENROUTER_BASE, runOpenRouterLoop } from './openrouter.js';
import { TOOL_SCHEMAS } from './tools.js';

/** The model v1.5 runs on, and the thinking configuration ADR-0011's milestone names. */
export const MODEL = 'claude-opus-5';

/** The two wire shapes this engine can drive an agent over. */
export type Provider = 'anthropic' | 'openrouter';
const PROVIDERS: Provider[] = ['anthropic', 'openrouter'];

/**
 * Which API to talk to: the caller's, then `ENGINE_PROVIDER`, then OpenRouter.
 *
 * OpenRouter is the default because it is the only path with a real run behind it. That
 * reads backwards until you check: no Anthropic credential has ever been present in this
 * repository, so defaulting to `anthropic` made the default the path nobody had executed,
 * gated behind a key nobody had, while the verified one sat behind a flag. ADR-0015
 * originally kept Anthropic on the grounds that it was the tested path; a real run
 * inverted that, and the default follows the evidence rather than the ADR's first draft.
 *
 * It is also the cheap path, which is the point: a round of prompt iteration costs cents.
 * The Anthropic tool runner is still the better engine — native thinking blocks, a
 * maintained agentic loop, prompt caching we did not write — and `ENGINE_PROVIDER=anthropic`
 * is one line for a run on a real repository that deserves it.
 *
 * Validated rather than defaulted: a typo must not silently pick a provider, in either
 * direction.
 */
export const providerName = (override?: string): Provider => {
  const wanted = override ?? process.env.ENGINE_PROVIDER ?? 'openrouter';
  if (!PROVIDERS.includes(wanted as Provider)) {
    throw new Error(`ENGINE_PROVIDER must be one of ${PROVIDERS.join(', ')}, not ${wanted}`);
  }
  return wanted as Provider;
};

/**
 * The model to ask for: the caller's, then `ENGINE_MODEL`, then the default above.
 *
 * A function rather than a constant because a constant is read at module load, and an
 * environment variable set after the first `import` would then be silently ignored —
 * the kind of load-order bug that presents as "my config does nothing".
 *
 * `ENGINE_MODEL` exists because the model id is the ONE thing an Anthropic-compatible
 * gateway may spell differently (OpenRouter takes `anthropic/claude-opus-5`).
 * Everything else such a gateway needs — the base URL and the credential — the SDK
 * already reads from `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` itself, which is
 * why running against one is configuration rather than a change to this file.
 *
 * What that does NOT change is the boundary this project claims. The loop is on the
 * host either way, so the container still cannot reach the credential (ADR-0011) and
 * the phase containers are still sealed and agentless. What it DOES change is who else
 * reads the traffic: a gateway sees every prompt and every tool result, including the
 * issue text and whatever the agent quotes out of the repository. That is a real trade
 * and it is the operator's to make, not this file's.
 */
export const modelId = (override?: string): string =>
  override ?? process.env.ENGINE_MODEL ?? MODEL;
/**
 * Non-streaming, so this stays under the SDK's HTTP timeout. The loop makes many
 * bounded turns rather than one enormous one, which is what a tool runner is.
 */
const MAX_TOKENS = 16_000;
/** Ceilings on an untrusted, paid-for loop. Every one of them is a recorded fact when hit. */
const MAX_LINES = 10_000;
/**
 * Turns, not tokens — and this is the one ceiling that is also a BILL.
 *
 * It was 200, then 25, and 25 was justified by scripted runs using "six to eight". The
 * first real webhook-driven run measured the truth: the repro agent finished naturally in
 * **22** turns, and the fix agent hit **25 exactly** — mid-sentence, having edited the
 * file and verified the fix through the browser, one turn short of committing it. The run
 * aborted on a handover the repository already had.
 *
 * So 25 was not a ceiling chosen to bound a real workload; it was a number derived from
 * agents that do not read. Eighty, from the same measurement: about 110 output tokens per
 * turn on this workload, so eighty turns is roughly 9k output tokens — two cents on a
 * cheap reasoning model, twenty on Opus. Still a ceiling, and now one with a run behind
 * the number rather than an assumption.
 */
const MAX_ITERATIONS = 80;
const DEFAULT_TIMEOUT_MS = 1_800_000;

/**
 * How hard the model is asked to think, and the single biggest lever on what a run
 * costs. It was hardcoded to `high`.
 *
 * `high` is right for a real fix on a real repository. It is wrong for the tenth
 * iteration on a prompt, where `low` or `medium` answers the only question being asked
 * — does the agent read the contract and produce a well-formed manifest — for a
 * fraction of the tokens.
 */
const DEFAULT_EFFORT = 'high';
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** `ENGINE_EFFORT`, validated — a typo must not silently become `high` and a big bill. */
export const effortLevel = (override?: string): Effort => {
  const wanted = override ?? process.env.ENGINE_EFFORT ?? DEFAULT_EFFORT;
  if (!EFFORTS.includes(wanted as Effort)) {
    throw new Error(`ENGINE_EFFORT must be one of ${EFFORTS.join(', ')}, not ${wanted}`);
  }
  return wanted as Effort;
};

/** What the turns actually consumed. Measured, because the alternative is guessing. */
export type LoopUsage = {
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

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
  /**
   * What this loop consumed, totalled.
   *
   * The per-turn numbers were already being recorded into the transcript and nobody
   * could read them without fetching blobs and parsing JSON — so "what did that run
   * cost" was unanswerable, which is a strange gap in a project whose subject is
   * evidence. Not an event: there is no event class for it and inventing one to
   * describe our own spending would put a fact about us in a log about the user's bug.
   */
  usage: LoopUsage;
};

export type LoopOptions = {
  prompt: string;
  /** Executes one tool call wherever the tools actually live. Returns the tool's output. */
  invoke: (tool: string, input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
  apiKey?: string;
  /**
   * A bearer credential instead of an `x-api-key`.
   *
   * Which is what an Anthropic-compatible gateway generally wants — OpenRouter's
   * documented setup is `ANTHROPIC_AUTH_TOKEN` with an `sk-or-` key. Omit both and the
   * SDK reads `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from the environment on its
   * own, which is why no wiring is needed to run against one.
   *
   * Do NOT set `ANTHROPIC_API_KEY=""` alongside it, whatever a gateway's Claude Code
   * instructions say: an empty string is not nullish, so the SDK keeps it and sends an
   * empty `x-api-key` beside the bearer token. That advice exists to stop the Claude
   * Code CLI falling back to Anthropic; it is wrong for a direct SDK caller. Leave it
   * unset.
   */
  authToken?: string;
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
  /** Override the model. Otherwise `ENGINE_MODEL`, otherwise `MODEL`. */
  model?: string;
  /** Override the effort. Otherwise `ENGINE_EFFORT`, otherwise `high`. The cost lever. */
  effort?: string;
  /** Per-turn output ceiling. Lower it to bound spend; a truncated turn is visible. */
  maxTokens?: number;
  timeoutMs?: number;
  maxLines?: number;
  maxIterations?: number;
  /** `anthropic` (default) or `openrouter`. Otherwise `ENGINE_PROVIDER`. */
  provider?: string;
};

/**
 * Run the agent to completion, or to a ceiling, and return what it said.
 *
 * Throws nothing on a model error: an agent that fails is an observation, not a
 * failure to observe. `stopped` says which it was, so a transcript that was cut
 * off can never read as one that finished.
 */
/**
 * The model this project asks a QUESTION of, as opposed to hands a job to.
 *
 * Named separately from `MODEL` because the two decisions are unrelated: the agent
 * model is chosen for whether it can write a reproduction, and this one is chosen
 * for costing almost nothing, since it reads an issue and answers in one sentence.
 * Milestone 7 priced the work it does at "a fraction of a cent", and that price is
 * the reason it can run on every intake.
 */
export const ASK_MODEL = 'claude-haiku-4-5';

/**
 * The same model, named the way OpenRouter names it — which is this project's
 * DEFAULT provider (see `providerName`), so without this line the cheap path would
 * have asked a one-sentence question of a thinking model at ten times the price.
 */
export const ASK_MODEL_OPENROUTER = 'anthropic/claude-haiku-4-5';

/**
 * How long a one-shot question may take before the caller stops waiting.
 *
 * Bounded because its callers are on a path that has somewhere to be: triage runs
 * before the first container of a real run, and the SDK's own default is ten
 * minutes. An unbounded wait in front of a run is the exact failure 8a spent a
 * milestone item removing from the layer below, and a cheap model answering one
 * sentence has no business taking thirty seconds.
 */
const ASK_TIMEOUT_MS = 30_000;

/**
 * One prompt, one answer, no tools, no loop.
 *
 * `runAgentLoop` cannot serve this: it sends `thinking: adaptive` and
 * `output_config.effort`, which the cheap models this exists for reject outright —
 * and it offers a tool surface to a caller with nothing to execute. Two providers
 * here rather than one, because ADR-0015 made the model an adapter and a capability
 * that works on one provider only would quietly undo that.
 *
 * Never throws, and answers `null` for every failure. Its callers use it to make a
 * run BETTER, never to decide whether a run happens — so a model that is down, out
 * of credit or slow must cost nothing but the answer it would have given.
 */
export async function askOnce(options: {
  prompt: string;
  provider?: string;
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  model?: string;
  maxTokens?: number;
  /** The ceiling, injectable for the same reason every other one here is: to test it. */
  timeoutMs?: number;
}): Promise<string | null> {
  const maxTokens = options.maxTokens ?? 512;
  const timeout = options.timeoutMs ?? ASK_TIMEOUT_MS;
  try {
    if (providerName(options.provider) === 'openrouter') {
      const key = options.apiKey ?? options.authToken ?? process.env.OPENROUTER_API_KEY;
      const response = await fetch(`${options.baseURL ?? OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeout),
        headers: { authorization: `Bearer ${key ?? ''}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: options.model ?? ASK_MODEL_OPENROUTER,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: options.prompt }],
        }),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return body.choices?.[0]?.message?.content?.trim() || null;
    }
    const client = new Anthropic({
      // Milliseconds in this SDK, and one retry rather than the default two: a
      // question nobody is waiting on the answer to is not worth three attempts.
      timeout,
      maxRetries: 1,
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    });
    const message = await client.messages.create({
      model: options.model ?? ASK_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: options.prompt }],
    });
    const text = message.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

export async function runAgentLoop(options: LoopOptions): Promise<AgentTranscript> {
  if (providerName(options.provider) === 'openrouter') {
    const apiKey = options.apiKey ?? options.authToken ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      // The same shape a missing Anthropic credential produces, for the same reason: an
      // engine that cannot reach a model has not observed the bug, and must not be able
      // to report a tier as though it had.
      return {
        lines: [{ claimed_type: 'loop_error', raw: JSON.stringify({ message: 'OPENROUTER_API_KEY is not set' }) }],
        stopped: 'spawn_failed',
        exitCode: -1,
        usage: { turns: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
    }
    const effort = effortLevel(options.effort);
    return runOpenRouterLoop({
      prompt: options.prompt,
      invoke: options.invoke,
      apiKey,
      // `ENGINE_MODEL` means "a model id" on both paths, but the default differs: an
      // Anthropic id sent to OpenRouter's OpenAI endpoint is a 404, so falling back to
      // `MODEL` here would be a confusing failure rather than a working default.
      model: options.model ?? process.env.ENGINE_MODEL ?? DEFAULT_OPENROUTER_MODEL,
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      // Collapsed to the three levels OpenRouter's `reasoning.effort` accepts. Asking
      // for more thinking than a provider can express is not an error worth failing on.
      effort: effort === 'xhigh' || effort === 'max' ? 'high' : effort,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.maxIterations === undefined ? {} : { maxIterations: options.maxIterations }),
      ...(options.maxLines === undefined ? {} : { maxLines: options.maxLines }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }

  const lines: TranscriptLine[] = [];
  const maxLines = options.maxLines ?? MAX_LINES;
  let stopped: AgentFinishedV1['stopped'] = 'exit';
  let exitCode = 0;
  const usage: LoopUsage = {
    turns: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

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
    // Every field omitted when not given, so the SDK falls back to its own environment
    // resolution — `ANTHROPIC_API_KEY`, then `ANTHROPIC_AUTH_TOKEN`, then a profile,
    // then `ANTHROPIC_BASE_URL`. That is what makes an Anthropic-compatible gateway a
    // matter of setting two variables rather than of changing this file.
    client = new Anthropic({
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    });
  } catch (error) {
    record('loop_error', { message: String(error) });
    return { lines, stopped: 'spawn_failed', exitCode: -1, usage };
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
      model: modelId(options.model),
      max_tokens: options.maxTokens ?? MAX_TOKENS,
      // Adaptive, and NOT disabled: with thinking off this model can write a tool
      // call into its visible text, where it reads as a completed turn and the
      // call never runs. A silent no-op is the exact failure class this project
      // is built to refuse, so the more expensive setting is the correct one.
      thinking: { type: 'adaptive' },
      output_config: { effort: effortLevel(options.effort) },
      tools,
      messages: [{ role: 'user', content: options.prompt }],
      max_iterations: options.maxIterations ?? MAX_ITERATIONS,
    });
    // The SDK's runner ends its iteration either because the model stopped asking for
    // tools or because `max_iterations` ran out, and the loop cannot tell those apart
    // from the outside. The last turn's `stop_reason` can: `tool_use` means the model
    // still wanted a tool when the runner stopped, which is the ceiling, not a decision.
    let lastStopReason: string | null = null;
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
      lastStopReason = message.stop_reason ?? null;
      // Totalled as it goes, so a run that is stopped by a ceiling still reports what
      // it spent getting there.
      usage.turns += 1;
      usage.input_tokens += message.usage?.input_tokens ?? 0;
      usage.output_tokens += message.usage?.output_tokens ?? 0;
      usage.cache_read_input_tokens += message.usage?.cache_read_input_tokens ?? 0;
      usage.cache_creation_input_tokens += message.usage?.cache_creation_input_tokens ?? 0;
      if (lines.length >= maxLines) {
        stopped = 'line_cap';
        exitCode = -1;
        return;
      }
    }
    // Said out loud, for the same reason as the OpenRouter path: an agent that was
    // interrupted one turn short of committing is not an agent that chose not to.
    if (lastStopReason === 'tool_use') {
      stopped = 'turn_cap';
      exitCode = -1;
      record('loop_error', {
        message: `stopped after ${usage.turns} turns: the iteration ceiling was reached while the model was still calling tools`,
      });
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

  return { lines, stopped, exitCode, usage };
}
