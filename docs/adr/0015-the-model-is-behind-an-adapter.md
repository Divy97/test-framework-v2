---
status: accepted
amends: 0011-the-agent-loop-runs-outside-the-sandbox.md
---

# The model is behind an adapter, and the cheap ones must prove they can call a tool

[ADR-0011](0011-the-agent-loop-runs-outside-the-sandbox.md) moved the agent loop
onto the host and named the mechanism it would use:
`client.beta.messages.tool_runner`. That was the right call and the boundary it
bought is untouched — the loop holds the credential, the container gets tool calls
over a pipe, and `--network none` needs no exception. Naming one vendor's SDK in the
decision, however, welded the engine to one vendor's models, while the README's
second sentence claims "the LLM is a replaceable component; the project is the
engineering system around it."

That claim was unearned. Two facts made it worth earning.

**One: the price of a wrong prompt.** A single reproduce-then-fix run on a large
model at `high` effort costs dollars. The tenth iteration on a prompt asks a much
smaller question — does the agent read the contract and emit a well-formed manifest
— and paying reasoning-model prices to answer it is why prompt work stops early.
Measured from OpenRouter's own model catalogue, per million output tokens:

| model | tools | reasoning | in | out |
|---|---|---|---|---|
| `anthropic/claude-opus-5` | yes | yes | $5.00 | $25.00 |
| `anthropic/claude-sonnet-5` | yes | yes | $2.00 | $10.00 |
| `deepseek/deepseek-r1` | yes | yes | $0.70 | $2.50 |
| `moonshotai/kimi-k2-thinking` | yes | yes | $0.60 | $2.50 |
| `minimax/minimax-m2.5` | yes | yes | $0.22 | $0.90 |

**Two: the gateway route was not enough.** Running the Anthropic SDK against
OpenRouter's Anthropic-compatible endpoint is pure configuration — two environment
variables, no code — and it works. It also only serves Anthropic's models, which is
precisely the set whose price was the problem.

**Decision: the provider is an adapter, selected by `ENGINE_PROVIDER`.**

`anthropic` (the default) keeps the SDK's tool runner exactly as ADR-0011 built it.
`openrouter` drives an OpenAI-shaped `/chat/completions` loop in `src/openrouter.ts`
and reaches any of the 336 tool-capable models in that catalogue.

What this deliberately does **not** do:

- **It does not delete the Anthropic path.** At the time of writing it was the only
  path with a real run behind it, and replacing a tested path with an untested one, in
  a repository with no model credential to re-verify either, would be exactly the
  "stub it and report it as working" this project forbids. That has since inverted —
  see "On flipping the default" below — and the path is kept for a different reason
  than the one recorded here.
- **It does not duplicate the tool surface.** `openAiTools()` is a pure mapping over
  the same `TOOL_SCHEMAS`. `input_schema` is already JSON Schema, which is what
  `function.parameters` wants. Two hand-maintained copies of a tool surface diverge,
  and the divergence is silent.
- **It does not add an SDK.** One POST with JSON in it, the same reasoning that left
  `src/github.ts` and `src/browser.ts` dependency-free. A second HTTP client inside
  the process that holds the credential is a cost with nothing on the other side.
- **It does not touch the boundary.** The loop is still on the host; the container
  still has no interface.

**And the part that is not a preference: a cheap model must prove it can call a tool.**

This is the failure that made the decision hard, and it is silent by construction. A
model that writes its tool call into visible text produces a turn that completes
successfully with nothing executed. The transcript then reads like an agent that read
the prompt and declined — which is indistinguishable from a genuine Tier 3. The
engine would report a finding about the *user's bug* when the truth is a fact about
the model. ADR-0011 already met this exact failure on Claude with thinking disabled,
and answered it by refusing to disable thinking.

`probeToolCalling` is the answer here: one turn, a trivial tool, and a check that a
*structured* call came back. A model that fails it is refused by name at the start of a
run, for a few tokens, instead of producing an empty transcript at the end of an
expensive one.

It originally sent `tool_choice: 'required'`, which is the obvious thing to want and is
wrong — see "What the first real run changed" below.

Two smaller consequences, recorded because both are ways this quietly breaks:

- **`ENGINE_MODEL` does not fall back across providers.** It means "a model id" on
  both paths, but `claude-opus-5` is not an id OpenRouter's OpenAI endpoint knows.
  Defaulting to it there would turn a working configuration into a 404 whose cause is
  not in the message, so the OpenRouter path has its own default.
- **Malformed tool arguments are testimony, not an exception.** A weaker model's
  arguments are the likeliest thing on this path to be invalid JSON. Told about it,
  the model calls the tool again; thrown, the transcript is lost.

**The trade this does not hide.** A gateway sees every prompt and every tool result —
the issue text, and whatever the agent quotes out of the repository. That was already
true of the configuration-only route and it is the operator's call, not this file's.
What is new is that a *cheaper* model is also, generally, a worse one: it will
reproduce fewer bugs and write worse fixes. That is visible in the tier the engine
reports, which is the entire point of the tier existing. A cheap model cannot make the
engine *lie* — the gate is executed evidence, not testimony — it can only make it
report less. That asymmetry is what makes this safe to offer.

## What the first real run changed

This ADR was written before a key existed. One arrived, and four attempts on the
`shipped-filter` issue took `moonshotai/kimi-k2-thinking` to a credited **Tier 2** pull
request — base red on the reported symptom, fix green three times, `orders.mjs` changed,
confidence 80/85 — for **$0.082**.

All four failures were in our code, and three of them are amendments to this decision:

1. **`tool_choice: 'required'` is not portable.** Moonshot rejects it outright, so the
   probe failed on exactly the cheap models it exists to screen. It sends no `tool_choice`
   now. Omission is also not the same as `'auto'` at this provider — `'auto'` returned an
   empty message, omission returned the call.
2. **A 200 can be a refusal.** OpenRouter answers `HTTP 200` with `{error: {code: 400}}`
   when an upstream provider rejects the request, so `response.ok` is not sufficient
   evidence that a turn happened. `apiError()` checks the body in both the probe and the
   loop. The first thing this cost was a *wrong diagnosis*: the probe reported that the
   model could not make a structured tool call, when the truth was that our request was
   invalid — which would have sent an operator changing models to fix a bug in
   `src/openrouter.ts`. A refused request must never be reportable as a fact about a
   model's capabilities.
3. **The suite must have no model configuration.** `vitest.config.ts` loads `.env` for
   `DATABASE_URL`, so a real `ENGINE_PROVIDER=openrouter` there routed every
   Anthropic-path test through the OpenRouter branch, where the scripted Messages API
   fixture is the wrong wire format. Six tests went red and nothing named the file
   responsible. The model-selection variables are now scrubbed after loading, and a
   source-level test keeps the scrub.

The fourth was not about this decision but is the reason it earns its keep: the engine
checked the reproduction's output against a literal string **the agent was never shown**,
and the fix prompt promised an exact command while substituting prose. Both are defects in
what we *tell* the agent, which is the class of bug a scripted agent structurally cannot
find — it does not read its prompt. Finding them cost about thirty cents. On Opus the same
four rounds are roughly ten times that, which is the argument for this ADR restated as a
number.

## On flipping the default — done

This ADR said the Anthropic default goes "when a real run has passed on the new one, and
not before." That condition was met, and holding the default anyway did not survive the
obvious question: **why is the default the path nobody has executed?**

No Anthropic credential has ever been present in this repository. So `anthropic` as the
default meant the default was untested and gated behind a key nobody had, while the one
path with a real run behind it sat behind a flag. The reason recorded above for keeping
Anthropic — "it is the path with a real run behind it" — had become false, and a default
justified by a fact that is no longer true is just inertia.

**`ENGINE_PROVIDER` now defaults to `openrouter`.** `ENGINE_PROVIDER=anthropic` is one
line, and it is still the better engine for a run that deserves it: native thinking
blocks, a maintained agentic loop, prompt caching we did not write.

The consequence in the suite is an improvement rather than churn. Every test that drives
the scripted **Messages API** fixture now says `provider: 'anthropic'` — seventeen call
sites across three files. They were all relying on an ambient default to select a wire
format, which is exactly what made the `.env` leak above so hard to read: a test that does
not name the wire format it exercises cannot fail loudly when the wire format changes
underneath it.

What is still true, and is the reason this ADR does not claim more: one bug, one model.
`orders-heading` (browser-driven), `export-button` (Tier 3 info-request) and
`total-rounding` (Tier 3, no fix attempted) have never been driven by a real agent on
either provider.
