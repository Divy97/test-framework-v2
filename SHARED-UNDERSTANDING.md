# Shared Understanding — Test Framework v2 (working title, rename freely)

**One-liner:** Any bug report — Slack, GitHub, Jira, wherever — becomes a verified, evidence-backed PR.

**Thesis (front page of README):** Runs are non-deterministic, which is exactly why the event log and the verification gate exist. Trust comes not from the agent, but from immutable evidence and reproducible verification built around it.

**What this is:** An event-sourced execution and verification platform for AI software engineering.
**What this is not:** A coding agent. Not an "execution platform" or "infrastructure layer" (words struck deliberately — that race belongs to Anthropic/OpenAI/GitHub). The LLM is a replaceable component; the engineering system around it is the project.

---

## The optimization target (decided Q5-reveal — **superseded, see below**)

> **Amended at milestone 9.** The filter below governed every decision through
> milestone 8 and is the reason this repository is shaped the way it is: one problem,
> deep, with the ADRs to show for it. It is no longer the target. Milestone 9 builds a
> hosted control plane so that people other than its author can run this, and that is
> breadth by the old filter's own definition — which is why the change is recorded here
> rather than absorbed quietly.
>
> **The filter now: does this make the engine usable by someone who did not write it,
> without weakening a claim it makes?** The second clause is the whole of what carries
> over. Depth was never the point in itself; the point was that every claim is backed by
> something executed, and a product that dilutes that is worse than no product.
> [ADR-0019](docs/adr/0019-who-writes-when-the-runner-is-not-ours.md) is the first test
> of it: hosting cost the engine a claim, and the response was to write down which claim
> and stop making it, not to keep saying it from a machine we no longer own.
>
> What does not change: the reproduce-first gate never bends, testimony never becomes
> evidence, and the log has one writer per run. Those are not portfolio decisions; they
> are the product.

This is a **flagship portfolio project**, not a startup. Every decision passes one filter:

> Does this make the project more impressive to a senior engineer reviewing the repo?

Corollaries:
- Depth over breadth. The repo must say "look how deeply I thought about one problem," not "look how many APIs I integrated."
- The failure mode to avoid: tech-bingo breadth reads as AI-generated slop in 2026. What refutes that suspicion: a golden path that demonstrably works, honest eval numbers, failure handling, ADRs showing judgment, and one subsystem deep enough to survive a 45-minute whiteboard interrogation.
- Business-only concerns (ToS multiplexing risk, ARR, pricing) are explicitly out of scope — noted where they changed a decision.

---

## Decisions, Q1 → Q9

### Q1–Q2 — Positioning
- The loop "sandbox → reproduce → fix → retest → PR" is a shipped feature of Claude Code web, Copilot coding agent, Codex cloud, Cursor, Devin. It is not a differentiator.
- **Wedge = intake** (bug reports live in Slack/Jira/Asana as vague complaints; nobody owns that conversion). **Moat = verification, reproducibility, confidence scoring.** Intake gets us in the door; verification is why we're hard to rip out.
- Scar-tissue rule from the prior project (ADR-0012, moat-doesn't-hold): **a moat is only real once measured adversarially. Benchmark before the ADR claim, not after.**

### Q3 — Whose Claude, running where
- Original decision (business frame): never touch inference; agent runs on Anthropic's surfaces (option iv).
- **Flipped under the portfolio objective:** run Claude Code headless on our own account, inside our own Docker sandbox. ToS multiplexing risk only applies to a multi-tenant product, not personal use.
- Payoff: the dashboard gets the **live agent transcript, streamed** — the single most demo-impressive screen in the project.
- If this ever becomes a product, this decision must be revisited (option iv or wholesale inference).

### Q4 — Reproduce-first gate, tiered verification
- **Tier 1 — Reproduced by failing test.** Fails on base with symptom-matching output, passes on fix, executed by us. Highest confidence.
- **Tier 2 — Reproduced by scripted scenario.** Browser script / API sequence / screenshot diff. Deterministically re-runnable, weaker assertion. Medium confidence.
- **Tier 3 — Not reproduced → NO FIX ATTEMPTED. Hard rule, gate never bends.** Output is a structured info-request back to the source thread ("attempted repro; missing: exact steps / account state / env"). That's a deliverable, not a failure.
- **Confidence score = tier + deterministic evidence quality** (symptom match, flake re-runs, diff-coverage of fix vs repro path).
  - **Amended (M2, PR 3a):** diff-coverage is not built and is deferred to its own milestone; it needs language-specific instrumentation. See [ADR-0008](docs/adr/0008-the-reproduction-is-anchored.md). No vibes, no LLM-judge-only scores. Every point traceable to an artifact.

### Q5 — The 3-minute demo
- **Dashboard-first.** Open a completed run, click **Replay**: task normalization → sandbox creation → agent transcript (live-recorded) → repro test FAILS on base → fix committed → repro PASSES on fix → evidence generated → confidence 96% → PR opened.
- Then: "This run happened because someone reported the bug in Slack" → click through to the original thread. **Intake is context, not the star.** No live-webhook dead air.

### Q6 — Event sourcing (the centerpiece)
- **Full event sourcing, committed. There is no runs table.** State = `fold(events)`. The correct answer to "delete the runs table" is "there is no runs table."
- **One aggregate: `Run`.** Everything belongs to a run; ordering stays trivial.
  - Intake boundary: `RUN_REQUESTED {source, thread_ref, raw_text}` is the **first event of the run** — no Task aggregate.
  - Rerun = a brand-new run whose first event carries `parent_run_id`. Lineage without a second aggregate.
- **Event store: single append-only Postgres table** `(run_id, seq, type, payload jsonb, ts)`, unique `(run_id, seq)`, monotonic seq enforced at write. No Kafka — Kafka solves distributed log replication; we need ordered events per run, which Postgres gives transactionally with near-zero ops.
- **Live streaming: SSE, not WebSockets.** Unidirectional append-only feed; `Last-Event-ID` maps 1:1 onto seq.
- **Events are versioned facts, not interpretations.** `{"v": 1, "type": "TEST_RUN", "phase": "base", "exit_code": 1, "stdout_hash": ...}` — never `TEST_FAILED_AS_EXPECTED`. Interpretation lives in the fold.
- **Small events, content-addressed artifacts.** Transcripts/diffs/screenshots go to a blob store; events carry `sha256:` refs. Evidence links in the confidence report are those hashes.
- **Projections are materialized in Postgres but explicitly disposable caches** (`run_dashboard_projection`, `run_confidence_projection`, …). README states verbatim: deleting them causes no data loss; they rebuild by replaying the event stream.
- **Replay vs Rerun — precise vocabulary, enforced in UI and docs:**
  - *Replay:* pure fold over the immutable log. Reconstructs history. No code runs, no agent runs, read-only, trivially deterministic.
  - *Rerun:* fresh sandbox, new agent execution, new event stream. Intentionally non-deterministic.
  - Never blur the two. "Deterministic replay of an LLM run" is a claim we never make.

### Q7 — Runner boundary: testimony vs evidence (hard rule)
- **Runner** = small TypeScript process, PID 1 in the sandbox container. Three duties:
  1. Spawn/supervise `claude -p --output-format stream-json`; translate its stream into transcript events.
  2. Execute verification phases itself: checkout base → run repro → checkout fix → run repro → flake re-runs → hash everything from the process boundary.
  3. Push events out through one narrow authenticated channel. No other egress except the model API.
- **Testimony vs evidence:** the agent's transcript is *testimony* (displayed, never trusted). Environment facts observed/executed by the Runner are *evidence* (trusted). **Verification facts only ever originate from the Runner's own process boundary — never from agent output.** The agent has zero ability to append events. Two visually distinct event classes in the timeline.
- Hooks (PostToolUse) as optional garnish for high-fidelity FILE_MODIFIED / COMMAND_EXECUTED signals.
- **Loose agent, strict judge:** no output schema imposed on the agent (we don't trust its self-report anyway). Our event schema stays rigid (it's our spine, the model never writes it). Verification criteria stay rigid (anti-gaming: base failure must match reported symptom; pass on fix; flake re-runs; fix diff must overlap repro path) — otherwise a cornered agent writes a test that trivially fails-then-passes without touching the bug.
  - **Amended (M2, PR 3a):** the overlap criterion was disproved by its own adversarial fixture and is retired — see [ADR-0008](docs/adr/0008-the-reproduction-is-anchored.md). The reproduction is now anchored (applied over both checkouts, or pinned and hashed) so that both phases provably run the same thing. Diff-coverage is deferred; until it lands there is no fix-diff/repro-path check at all.
- **Bounded attempts, honest exit:** `ATTEMPT_STARTED {n}` within the run, max 3, each attempt fed the previous verification facts. After 3 → run ends `UNRESOLVED` with full evidence trail + Tier-3-style structured report to the source thread. UNRESOLVED is a first-class dashboard state, not shame.
- Terminology split for ADRs: *verification* is an active process emitting fact-events (has side effects); the *confidence score* is the projection (pure fold). A "projection with side effects" is a contradiction we never utter.

### Q8 — Demo target
- **(a) Purpose-built demo app** (small TS/Next.js), 5–6 seeded bugs spanning tiers — logic bug, API bug, UI bug, and one irreproducible-by-design to demo Tier 3 / UNRESOLVED. One `docker build`, never flakes. **Amended (M2 scoping):** it does *not* double as the verification engine's test fixture — the engine is tested against tiny generated git repos that include the adversarial cases (symptom mismatch, flaky fix, gaming attempt). A demo app is too slow and too coarse for that, and seeding deliberate gaming attempts into a demo makes the demo worse. Two artifacts, two purposes.
- **Plus one recorded run against a real OSS issue**, kept as a replayable artifact — generality proven without live-demo risk.

### Q9 — Fresh repo
- **New repo. Port ideas, not code.** Git history starts at `ADR-0001: Why event sourcing`, not at a pivot.
- Inherited from the test-framework: ADR discipline, honest-eval instinct, recorded-reality fixtures, testimony-vs-evidence thinking. Its eval-runner code fights the event-sourced shape — rewrite native.
- The old repo stays alive as a second portfolio artifact ("measured the moat honestly, published the negative result, let it redirect the next project"), linked from the new README as prior work.

---

## v1 scope freeze

**Core:** Slack adapter · GitHub Issues adapter · CLI adapter · Docker sandbox · Claude Code runner · Verification engine · GitHub PR creation
**Architecture:** Event bus · Event store · Replay engine
**UI:** Live execution timeline · Agent transcript · Replay mode · Evidence report · Confidence score
**Docs:** Architecture diagram · Honest limitations · Recorded 3-minute demo · ADRs (seeds below)
**Adapters:** three real ones; `TaskAdapter { parse, fetchContext, normalize }` interface documented so Jira/Asana/Linear are 50-line README examples. Intake across N tools is one skill — demonstrate the pattern, not the copies.

**Amended (M2 scoping): CLI adapter added to v1.** A terminal entry point — `<cmd> "the bug"` in a repo — emitting the same `RUN_REQUESTED` as Slack and GitHub. Intake is genuinely ~50 lines; the real cost is the **follow mode** the terminal implies. A CLI that fires and returns nothing is worse than no CLI, so it needs a live tail rendering the same event stream the dashboard renders (same SSE feed, terminal output instead of DOM), plus `--detach` for people who'd rather watch the dashboard. Budget the tail, not the parse.

**Future Work (README section, not code):** Jira · Asana · Linear · compare-two-fixes · multi-agent support · cloud runners · multi-tenant inference story.

## ADR seeds
1. Why event sourcing (and its real costs)
2. Postgres over Kafka
3. Replay vs Rerun
4. Verification as process, confidence as projection
5. SSE over WebSockets
6. Testimony vs evidence — why the agent can't write facts
7. Reproduce-first gate and tiered confidence (Tier 3 = no fix)
8. The reproduction is anchored, not committed (added M2, PR 3a)

## Amended by v1.5 — the shape three decisions turned out to have

Recorded here rather than edited into the Q-sections above, because the reasoning
that produced those answers is the record and the answers are what moved. The
target shape is [docs/architecture-v1.5.md](docs/architecture-v1.5.md); the build
order is [docs/milestone-5-v1.5.md](docs/milestone-5-v1.5.md).

**Q3 — the agent no longer runs inside our sandbox.** The decision to run Claude on
our own account holds. Where it runs does not: the loop runs on the **host**, and
tool calls travel into the container
([ADR-0011](docs/adr/0011-the-agent-loop-runs-outside-the-sandbox.md)). M3 spent a
milestone trying to give a container in-sandbox exactly one route to the model API
and the transport does not exist — `--network none` and a host-gateway route are
mutually exclusive, and the version that claimed to do both silently dropped the
seal. Moving the loop out deletes the problem rather than solving it: the container
needs no egress, because nothing inside it talks to Anthropic. Q3's stated payoff —
the live streamed transcript — survives intact, since every tool call now passes
through our own process on its way to becoming an event.

It also stops being *Claude Code* specifically. We own the tool surface (named
shells, edit, grep, browser, commit-only git), which is what
[ADR-0014](docs/adr/0014-long-lived-services-and-named-shells.md) and the browser
both require and what a spawned CLI cannot give.

**Q7 — the Runner's three duties redistribute.** Duty 1 (spawn and supervise the
agent) moves to the host loop. Duty 2 (execute the verification phases) splits, one
container per phase. Duty 3 (push events through one narrow channel) becomes: the
**orchestrator** is the sole writer and the sandbox has no event channel at all.
The rule Q7 was protecting is unchanged and cheaper to hold —
[ADR-0006](docs/adr/0006-testimony-vs-evidence.md) carries the detail.

**Q8's demo app becomes load-bearing.** It was "the demo target, and explicitly not
the engine's test fixture." It is now also the only repository with a recipe, so
5b, 5c and 5f are all tested against it. The Q8 split still holds — the adversarial
fixtures stay tiny generated git repos — but the demo app has stopped being a
demo-only artifact.

## v1.5 scope — one connector

The v1 freeze above stands as the eventual target. v1.5 narrows it to the shortest
path that produces something a person can use:

**In:** GitHub App (issue intake + branch + PR) · environment recipe · agent loop
outside the sandbox · the two prompts · one container per phase · headless browser
· SSE tail · issue comments on every terminal outcome.

**Out, deferred not cut:** Slack and CLI adapters · the dashboard · deployment and
preview URLs · multi-repo runs · LSP tools · diff-coverage.

The dashboard is the painful one, because [Q5](#q5--the-3-minute-demo) made it the
demo. Deferred on the grounds that v1.5 exists to produce a run worth watching, and
a timeline over an empty event log demonstrates nothing.

## Open items
- [ ] Project name ("test-framework-v2" is a placeholder)
- [x] Timeline / milestone cut — M1 event core (merged); M2 verification engine, engine-first with no agent and no container ([docs/milestone-2.md](docs/milestone-2.md)); M3 Runner + sandbox; **M5 v1.5** ([docs/milestone-5-v1.5.md](docs/milestone-5-v1.5.md)), which supersedes M3 §3c.2 and the M4 isolation scope
- [x] **Where the environment recipe lives — decided: on our side, keyed by repository.** Not committed to the user's codebase. A committed `.engine/env.json` is the better engineering artifact and was rejected anyway: onboarding must not be a pull request against someone else's repo before we have delivered anything. [ADR-0013](docs/adr/0013-the-environment-recipe.md)
- [x] **Which connector first — decided: GitHub App.** One integration carries intake, clone access and delivery. Slack has no repository in its payload and would need resolution logic v1.5 does not have. [ADR-0012](docs/adr/0012-the-github-app-and-where-the-token-lives.md)
- [ ] Stack detail pass (queue choice, dashboard framework) — blob store settled: content-addressed local directory, S3 as an adapter later
- [ ] Seeded-bug list for the demo app — now blocking, since v1.5's phases are tested against it. Needs at least: one copy/UI bug (browser-findable), one API bug (needs backend + DB), one irreproducible-by-design (Tier 3), one whose obvious fix is a no-op (control fixture)
- [ ] Which real OSS issue for the recorded run
- [ ] Bounded attempts, carried from M3 §3b.2b — `handedOver` must become per-attempt with them
