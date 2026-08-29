# Test Framework v2

> **Runs are non-deterministic, which is exactly why the event log and the verification gate exist.**

You open a GitHub issue. You get back a pull request that **proves** the bug existed before the change and does not exist after it.

Test Framework v2 (name TBD) is an **event-sourced execution and verification platform for AI software engineering**. It is *not* a coding agent. The LLM is a replaceable component; the project is the engineering system around it — intake, sandboxed execution, forensic verification, immutable evidence, and a replayable record of everything that happened.

Trust comes not from the agent, but from immutable evidence and reproducible verification built around it.

## How it works

```
 GitHub issue ──► RUN_REQUESTED
                      │
                      ▼
 ┌────────────────────────────────────────────────────────────────────┐
 │  ORCHESTRATOR (host)   ── the sole event writer                    │
 │  1h installation token lives HERE and never below this line        │
 └──┬──────────────────────────────────────────┬──────────────────────┘
    │ (1) agent phases                         │ (2) judgement phases
    ▼                                          ▼
 ┌───────────────────────┐              ┌──────────────────────────┐
 │  AGENT SANDBOX        │              │  PHASE CONTAINERS        │
 │  recipe replayed:     │              │  base  ·  fix            │
 │   install, boot, poll │              │                          │
 │  named shells         │              │  --network none          │
 │  headless browser     │              │  no agent, no browser    │
 │  full repo @ base     │              │  apply repro files       │
 │                       │              │  run ONE command         │
 │  NO credentials       │              │  exit code decides       │
 │  NO network egress    │              └────────────┬─────────────┘
 └──────────┬────────────┘                           │
            │ tool calls in, results out             │  append-only
            │ the worker dials OUT                   │  fact-events
            ▼                                        ▼
 ┌───────────────────────┐              ┌──────────────────────────┐
 │  AGENT LOOP (outside) │─── model ───►│  Event store (Postgres)  │
 │  shell · edit · grep  │     API      │  (run_id, seq, type,     │
 │  browser · git commit │              │   payload, ts)           │
 └───────────────────────┘              └────────────┬─────────────┘
                                                fold │
                          ┌───────────────┬───────────┴──────┬──────────────┐
                          ▼               ▼                  ▼              ▼
                      Timeline       Confidence          Evidence      SSE tail
                      projection     projection          report        + Replay
                                                              │
                                                              ▼
                                                        GitHub PR
```

There is **no runs table**. A run's state exists only as a fold over its events. Every projection is a disposable cache: deleting it causes no data loss; it is rebuilt by replaying the event stream.

The full target architecture, with the user's flow step by step: [docs/architecture-v1.5.md](docs/architecture-v1.5.md).

## The dashboard, and why it holds nothing

The surface is server-rendered HTML on the same port as the live tail — `/` , `/repos`,
`/runs`, and `/runs/<id>`. No framework and no build step, for the same reason
`src/github.ts` speaks HTTP by hand and `src/browser.ts` speaks the DevTools protocol by
hand: a dependency here would be a large surface for a few pages.

The interesting screen is `/runs/<id>`. It shows base red for the reported symptom, fix
green, the regression arm, and every confidence point beside the `sha256:` it rests on —
and on a Tier 3 it shows the gate **refusing to attempt a fix**, with no diff at all.
Every other product in this category has a run list; the screen that is rare is the one
where a refusal is as legible as a success.

It has exactly **one write** — a human approving a recipe — and that asymmetry is the
design: everything else on it is a projection that can be rebuilt, so a dashboard that
could start runs or edit evidence would be a second producer, and ADR-0009 has one. The
write is refused unless it comes from the dashboard's own page. Binding to `127.0.0.1` is
not a defence there and it is worth saying why, because the intuition is exactly what
makes the bug easy to ship: the same-origin policy stops another page *reading* our
response, never stops it *sending* the request. Approving a recipe stores commands the
engine executes verbatim, so a forged POST would be a stored command no human approved —
which is precisely the control ADR-0013 says onboarding rests on.

**Delete the entire dashboard database and it rebuilds from the log.** `npm run rebuild`
drops `run_projection` and replays `events` into byte-identical rows. That is the property
that makes "there is no runs table" still true with a runs table in the schema: the table
holds no truth, and a test drops it, replays, and compares the bytes.

## Two credentials, and where they are not

The agent sandbox holds **neither** the model API key nor the GitHub token.

The agent loop runs *outside* the sandbox and ships tool calls in, so the container needs no egress at all — that is not hardening added afterwards, it is why the loop is out there ([ADR-0011](docs/adr/0011-the-agent-loop-runs-outside-the-sandbox.md)). The host clones, pushes, and opens the PR; the agent's only outbound artifact is a commit ([ADR-0012](docs/adr/0012-the-github-app-and-where-the-token-lives.md)).

So there is no configuration under which the party being judged can reach a credential. That is a stronger claim than any allowlist makes, and it is the claim the rest of the system rests on.

## Which model, and why that is a setting

"The LLM is a replaceable component" was a claim, not a fact, while the loop was welded to one vendor's SDK. `ENGINE_PROVIDER` now selects between the Anthropic tool runner and an OpenAI-shaped loop against OpenRouter, which reaches ~336 tool-capable models — including reasoning models at roughly a tenth of Opus's output price, which is what makes iterating on a *prompt* affordable ([ADR-0015](docs/adr/0015-the-model-is-behind-an-adapter.md)). One tool surface, two wire formats; the boundary above is untouched either way.

OpenRouter is the **default**, because it is the only path with a real run behind it — no Anthropic credential has ever been present here, so defaulting to Anthropic made the default the path nobody had executed. `ENGINE_PROVIDER=anthropic` is one line, and its tool runner is still the better engine for a run that deserves it. A cheaper model is generally a worse one — but it cannot make the engine *lie*, only report a lower tier, because the gate is executed evidence rather than testimony. What it *could* do is fail silently: a model that writes its tool call as prose completes the turn with nothing executed, and the transcript then reads like an agent that chose to do nothing. `probeToolCalling` refuses such a model by name, in one turn, before the run — **and that covers the model that never could, not the one that stops.** `kimi-k2-thinking` passes the probe and then degrades at turn eight; the run-time check that catches that is `stopped: 'malformed_tool_call'`, set when a turn ends inside the model's reasoning with no content and no call.

## Before a container starts

Two things happen at the front of a run, and both exist because the expensive parts are at the back.

**Triage.** A cheap model reads the report against the repository's file listing and answers one question: could an engineer who has never seen this project begin? If not, it names the single most useful missing fact and the issue gets that question **immediately** — while the person who filed it is still at their keyboard, rather than twenty minutes later when the four-item checklist that used to arrive was a template nobody answered. It never gates. Whatever it says, the run proceeds: a cheap model's opinion of somebody's bug report is the last thing that should be able to stop one.

**The sealed-world probe.** The recipe's own test command is run in the container that will judge the fix — same image, same `--network none`, same restored dependencies, same uid — before either agent starts. The result is what the agent is *told* about the world it is being judged in, which is the sentence this project had wrong twice: once asserting a result nothing had executed, and once describing a container that had stopped being empty three commits earlier.

The same two containers run once more at **onboarding**, the moment a human approves a recipe, so that whether those commands work is known then rather than in the middle of a stranger's issue. What comes out is `ready`, `ready-with-caveats` or `blocked`, with each caveat priced — most importantly the project suite's colour at HEAD, which decides whether every future regression arm on that repository can say anything at all.

## Testimony vs evidence

The agent's transcript is **testimony** — displayed, never trusted. Facts are **evidence** — observed and executed by the engine at its own process boundary: exit codes of commands it ran, hashes of outputs it read, diffs it computed. The agent has zero ability to append events. "Solved" is a verdict only the engine's executed checks can issue.

The browser is the clearest case. The agent drives a real headless browser to *find* bugs it could not find by reading, and its screenshots go in the pull request — but the thing the engine judges is a committed command's exit code, run in a container with no browser in it. A new capability for the agent, nothing new for the judge to trust.

## Replay vs Rerun

|  | Replay | Rerun |
|---|---|---|
| What happens | Pure fold over the immutable event log | Fresh sandbox, new agent execution |
| Code executes | No | Yes |
| Deterministic | Trivially — nothing runs | Intentionally not |
| Result | Reconstructed history | A new run (`parent_run_id` links lineage) |

We never claim "deterministic replay" of an LLM execution. Replay reconstructs history; Rerun creates new history.

## Verification: reproduce first, or don't fix

- **Tier 1** — reproduced by a failing test whose independence is established: fails on base with symptom-matching output, passes on the fix, executed by the engine. Available to a caller-supplied reproduction — and to one the **repository already contained**, which is the same claim reached a different way ([ADR-0018](docs/adr/0018-a-reproduction-the-repository-already-had.md)): nothing applied, every path tracked at the base commit, and the project's own test command over those paths, so the agent chose which existing test to point at and authored none of it.
- **Tier 2** — reproduced, but the reproduction's independence is unverified. **This is where an agent-authored reproduction lands**, including a browser-driven one, because an agent that knows base's tree can write an oracle over the commit instead of over the bug.
- **Tier 3** — not reproduced: **no fix is attempted.** The deliverable is a structured info-request. This gate never bends.

A run that never manages to *boot* the project is `errored`, not Tier 3 — our infrastructure being wrong about someone's repository is not a finding about their bug.

Confidence = tier + deterministic evidence quality. Every point traceable to a content-addressed artifact.

### Two arms, not one

"Did this repair the reported bug" and "did it break anything else" are different questions, and only the first was ever asked. So a change that turned the reproduction green and forty other tests red scored full marks and opened a pull request that said nothing about it.

- **The reproduction arm** — the registered command, red on base **twice** and green on the fix three times, byte-identical every run. Repeated on base for the same reason it is repeated on the fix: one red draw cannot say a failure is reliable, and the largest single ground in the score used to rest on one sample.
- **The regression arm** — the project's *own* test command, executed by the engine on both commits, with the applied reproduction taken out of the tree first (every real suite discovers test files, and ours would otherwise fail the baseline for our own reason). Green→red is a finding: the pull request leads with it, before the bug. Red→red is recorded and never blamed on the fix.

The reported symptom is also observed on **both** sides now. Present on base is what ties the failure to the report; absent on the fix is what makes that tie mean something — while only base was checked, a `console.log` of the symptom string satisfied the anti-gaming check completely, and the repro prompt asked for exactly that print. It is **priced, not enforced**: `eofBug` is an honest reproduction of a missing newline reported as `wrong`, and correct output still says `wrong`. A check that convicts honest work does not get to end runs — the same conclusion six rounds of the sham-fix control reached.

## Architectural decisions

1. [Why event sourcing](docs/adr/0001-why-event-sourcing.md)
2. [Postgres over Kafka](docs/adr/0002-postgres-over-kafka.md)
3. [Replay vs Rerun](docs/adr/0003-replay-vs-rerun.md)
4. [Verification is a process; confidence is a projection](docs/adr/0004-verification-process-confidence-projection.md)
5. [SSE over WebSockets](docs/adr/0005-sse-over-websockets.md)
6. [Testimony vs evidence](docs/adr/0006-testimony-vs-evidence.md)
7. [The reproduce-first gate and tiered confidence](docs/adr/0007-reproduce-first-gate.md)
8. [The reproduction is anchored, not committed](docs/adr/0008-the-reproduction-is-anchored.md)
9. [What a producer may write back into the log](docs/adr/0009-what-a-producer-may-write-back.md)
10. [The environment is part of the evidence](docs/adr/0010-the-environment-is-part-of-the-evidence.md)
11. [The agent loop runs outside the sandbox](docs/adr/0011-the-agent-loop-runs-outside-the-sandbox.md)
12. [The GitHub App, and where the token lives](docs/adr/0012-the-github-app-and-where-the-token-lives.md)
13. [The environment recipe: asked once, replayed forever](docs/adr/0013-the-environment-recipe.md)
14. [Long-lived services, and what the reap is still for](docs/adr/0014-long-lived-services-and-named-shells.md)
15. [The model is behind an adapter](docs/adr/0015-the-model-is-behind-an-adapter.md)
16. [The second arm: the project's own suite, on both commits](docs/adr/0016-the-second-arm.md)
17. [Environment secrets, and the network route that has to close first](docs/adr/0017-environment-secrets-and-the-network-that-has-to-close.md)
18. [A reproduction the repository already had](docs/adr/0018-a-reproduction-the-repository-already-had.md)

The full decision record from the founding design session: [SHARED-UNDERSTANDING.md](SHARED-UNDERSTANDING.md).

## Honest limitations

**A real model has now run, and the first four runs found four defects — all of them ours.** `moonshotai/kimi-k2-thinking`, driven through OpenRouter, took the `shipped-filter` issue to a credited **Tier 2** pull request: reproduction red on base matching the reported symptom, fix green three times, `orders.mjs` changed, confidence 80/85 — *under scoring version 1; the grounds and the ceiling have moved since, which is what `Confidence.scoring` exists to make legible* ([ADR-0016](docs/adr/0016-the-second-arm.md)). It cost **$0.08**. Getting there took four attempts, and not one of the failures was the model's:

1. `tool_choice: 'required'` is not portable — the provider rejected it, so the conformance probe failed on exactly the cheap models it exists to screen.
2. OpenRouter answers **HTTP 200 with an `{error: {code: 400}}` body**, and checking `response.ok` alone reported our own malformed request as the model's inability to call a tool.
3. The engine checked the reproduction's output against a literal string **the agent was never shown**, while the prompt asked only that the output "mention the symptom". A model that paraphrased — as one reasonably did — was refused for a reproduction that was correct.
4. The fix prompt promised *"you have exactly the command above"* and then substituted the sentence *"the command registered in .engine/repro.json"*. The fix agent read the manifest, read the source, and quit in three turns without editing anything.

Every one is a defect in **what we tell the agent**, which is why 365 scripted tests were green through all four: a scripted agent does not read its prompt. That is the argument for running a real one, and the reason the cheap adapter exists ([ADR-0015](docs/adr/0015-the-model-is-behind-an-adapter.md)) — at eight cents a run, finding these is affordable.

**An agent-authored reproduction cannot reach Tier 1, and this is measured rather than assumed.** (A reproduction the *repository* already contained is a different case, and [ADR-0018](docs/adr/0018-a-reproduction-the-repository-already-had.md) makes it Tier 1 on four checkable clauses — the agent chose which existing test to point at and authored none of it.) Six successive versions of a negative control were defeated; the sixth fell to six oracles at once, and the same review showed it convicting honest reproductions at a rate that depended on a random draw. So the control is advisory — it records what it saw and ends nothing — and what withholds the claim is the tier cap, which does not depend on any control working. Diff-coverage is the measurement that would settle it and is not built.

**The isolation took four adversarial review rounds, each of which defeated the previous round's fix.** One of them landed a false `reproduced: true` against a *maintainer-authored, pinned, hashed* test — the strongest provenance the design recognises — with a fix commit that changed one unrelated file. The agent forged nothing; it shared a filesystem with the phases, which was enough. Every fix enumerated a channel and the enumeration was never the answer: [ADR-0014](docs/adr/0014-long-lived-services-and-named-shells.md) replaces it with a container boundary per phase, which closes the class instead of extending the list.

**The judge had no dependencies installed, so for four milestones this engine could only certify repositories that needed none — fixed in 7e, and this page went on saying otherwise for three commits after it, which is its own lesson.** It was invisible through 352 green tests, because every adversarial fixture is a shell script and `demo/` has zero dependencies and runs on `node --test`. What it looked like:

The agent sandbox replays the recipe, so `install` has run: the repro agent boots the project, writes a reproduction, proves it red, commits. The phase containers replay nothing, hold no recipe and run `--network none` — they clone the commit and run the command against a bare checkout, and a dependency is a gitignored path so it is not in the commit either. `npm test` there is exit 127, the output does not contain the reported symptom, the fold correctly refuses it, and the reporter is told **we could not reproduce your bug**. Every step in that chain is right and the conclusion is false. On a React or Next.js repository it is the outcome every time.

**What fixed it (7e):** a build container clones the base commit, replays the recipe's `install`, `migrate` and `seed`, and records what git ignores; the host commits that container into an image, and base and fix run from it with `--network none` intact, hardlinking the ignored paths into each fresh clone. The ordering is the security argument — those bytes were installed before the agent container existed, so there was nobody to plant them. `verify.test.ts` still pins the old behaviour one layer down, where `verify()` is handed a checkout and has no container to install into, and `sandbox.test.ts` §7e runs the same fixture through the containers as a pair: REPRODUCED with a recipe, NOT REPRODUCED without one.

**What it left behind, and 8g closed:** the sham-fix control's own scrub used `-xdff` and took the restored dependency tree with it, so its second draw exited 127 on exactly the repositories 7e existed to support. Never a false accusation — 127 is not green — but the check simply stopped running, and nothing said so.

**What else remains open is named, not waved at.** `/blobs` is a bind mount every participant can write, outlives the run, and is append-only by convention rather than construction. Flake re-runs share everything with each other, deliberately, because isolating them would hide the order-dependent flake they exist to catch. The agent sandbox is *not* contained — it has a browser, booted services and a registry route — which is affordable only because nothing worth stealing lives there and nothing it produces is trusted.

## Status

The engine works; the product does not exist yet.

**Built and tested:** event store · fold and projections · tiers and confidence · the verification engine · the reproduce-first gate · the anchored reproduction · the sandbox and its adversarial suite · agent supervision against a hostile fake · the agent loop outside the sandbox · the environment recipe · the two prompts · one container per phase · the GitHub App in and out · the browser · the SSE tail ([milestone 5](docs/milestone-5-v1.5.md), [report](docs/milestone-5-report.md)) · the regression arm, the repeated base phase and the symptom observed on both sides ([milestone 7](docs/milestone-7.md), [ADR-0016](docs/adr/0016-the-second-arm.md)).

**Still not true, and this is the honest list:** no GitHub App is registered, so nothing here has been accepted by GitHub — a bare repository on disk stood in for the remote, and the real run's pull request was opened against a recording `fetch`. The real run is a run, not a suite: one bug, one model, four attempts, and the other three seeded bugs have never been driven by a real agent. `/blobs` remains append-only by convention rather than construction. Diff-coverage is still not built, so an agent-authored reproduction still cannot earn Tier 1 — the real run capped at Tier 2 for exactly that reason. And the real run exposed one thing about the agent rather than the engine: `git_commit` stages everything, so the recipe's `npm install` left `package-lock.json` in the fix diff, which rule 4 of the fix prompt tells the agent not to do.

**[Milestone 7](docs/milestone-7.md) has now been driven by a real model, and every change fired.** `anthropic/claude-sonnet-5` through OpenRouter took the same `shipped-filter` issue to a credited **Tier 2** in 95 seconds for **$0.064**: base red **twice** for the reported symptom, the symptom **gone** from all three fix runs, the project's own suite green on both commits, **98/103** under `scoring: 2` — where the old scale's best was 80/85. The agent put the symptom on the failing path prompted by nothing but the rewritten `prompts/repro.md`, which is the ground that could not previously be scored.

Two earlier attempts found a **model** rather than a prompt, and are worth recording because the engine's own diagnosis was the part that was wrong. `moonshotai/kimi-k2-thinking` failed 2/2 by ending turns *inside its own reasoning* — once leaking its next call as text, once stopping mid-sentence while planning the commit, having already explored the repository, driven the browser, seen the bug and written the reproduction. The gate held correctly both times and no false pull request was opened; but the run reported *"the agent handed over a commit the repository already had"*, an accusation of idleness against a model that had done nearly everything. `stopped: 'malformed_tool_call'` now names it. `probeToolCalling` cannot: it is one turn, and that model makes structured calls perfectly well for seven of them first ([ADR-0015](docs/adr/0015-the-model-is-behind-an-adapter.md)).

**[Milestone 8](docs/milestone-8.md) is milestone 7's own list, and nothing else.** Seven items that milestone had analysed, priced and left: a wall clock and `--pull never` for the one wait nothing bounded (8a); the recipe's test command run in the container that judges, which found a paragraph in the agent's prompt that 7e had made false three commits earlier (8b); a Tier 3 comment that quotes the fact the agent said it lacked instead of a four-item checklist, and stops asking the reporter for anything when one of our own ceilings ended the run (8c); Tier 1 for a reproduction the repository already contained (8d, [ADR-0018](docs/adr/0018-a-reproduction-the-repository-already-had.md)); triage at t=0, which never gates (8e); a proving run at approval, so whether a recipe works is known when a human presses the button rather than in the middle of a stranger's issue (8f); and the sham-fix control made able to run at all on a repository with dependencies (8g).

**Milestone 6 landed the product around the run** — installations recorded so an
un-onboarded repository is answered rather than run against, recipe approval in the
browser, the drafting run that proposes one, the read model and its rebuild, what a run
cost, redaction, and the dashboard ([milestone 6](docs/milestone-6.md)). One thing in it
is deliberately absent and named there: the environment-variable UI, which that phase
itself blocks on a security ADR that does not exist.

**Deliberately not in v1.5:** Slack and CLI connectors · deployment and preview URLs · multi-repo runs · LSP tools · diff-coverage · observability-triggered runs. The dashboard was on this list until milestone 6 built it — struck rather than quietly deleted, because this is the second time a stale line here has said the opposite of what the code does.

## Prior work

This project inherits its verification discipline from a previous project: a test-generation framework whose central moat claim was **measured honestly and disproven** — the raw model beat the multi-stage engine on all recorded fixtures. That negative result (published in its ADR trail) is what redirected this project toward verification *around* agents rather than reasoning *instead of* them.
