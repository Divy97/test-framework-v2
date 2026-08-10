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

## Two credentials, and where they are not

The agent sandbox holds **neither** the model API key nor the GitHub token.

The agent loop runs *outside* the sandbox and ships tool calls in, so the container needs no egress at all — that is not hardening added afterwards, it is why the loop is out there ([ADR-0011](docs/adr/0011-the-agent-loop-runs-outside-the-sandbox.md)). The host clones, pushes, and opens the PR; the agent's only outbound artifact is a commit ([ADR-0012](docs/adr/0012-the-github-app-and-where-the-token-lives.md)).

So there is no configuration under which the party being judged can reach a credential. That is a stronger claim than any allowlist makes, and it is the claim the rest of the system rests on.

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

- **Tier 1** — reproduced by a failing test whose independence is established: fails on base with symptom-matching output, passes on the fix, executed by the engine. Available to a caller-supplied reproduction.
- **Tier 2** — reproduced, but the reproduction's independence is unverified. **This is where an agent-authored reproduction lands**, including a browser-driven one, because an agent that knows base's tree can write an oracle over the commit instead of over the bug.
- **Tier 3** — not reproduced: **no fix is attempted.** The deliverable is a structured info-request. This gate never bends.

A run that never manages to *boot* the project is `errored`, not Tier 3 — our infrastructure being wrong about someone's repository is not a finding about their bug.

Confidence = tier + deterministic evidence quality. Every point traceable to a content-addressed artifact.

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

The full decision record from the founding design session: [SHARED-UNDERSTANDING.md](SHARED-UNDERSTANDING.md).

## Honest limitations

**No real model has ever run in this system.** The prompts now exist — `prompts/repro.md` states the manifest contract, and its tests read the ceilings out of the engine so a prompt cannot promise a limit the code does not enforce — and the tool surface, the containers and the whole issue-to-pull-request path are driven end to end by a **scripted Messages API on a local port**, the successor to the hostile fake `claude`. What that proves is that the engine accepts a well-formed manifest without a retry. What it cannot prove is that a real agent, reading the prompt, produces one.

**An agent-authored reproduction cannot reach Tier 1, and this is measured rather than assumed.** Six successive versions of a negative control were defeated; the sixth fell to six oracles at once, and the same review showed it convicting honest reproductions at a rate that depended on a random draw. So the control is advisory — it records what it saw and ends nothing — and what withholds the claim is the tier cap, which does not depend on any control working. Diff-coverage is the measurement that would settle it and is not built.

**The isolation took four adversarial review rounds, each of which defeated the previous round's fix.** One of them landed a false `reproduced: true` against a *maintainer-authored, pinned, hashed* test — the strongest provenance the design recognises — with a fix commit that changed one unrelated file. The agent forged nothing; it shared a filesystem with the phases, which was enough. Every fix enumerated a channel and the enumeration was never the answer: [ADR-0014](docs/adr/0014-long-lived-services-and-named-shells.md) replaces it with a container boundary per phase, which closes the class instead of extending the list.

**What remains open is named, not waved at.** `/blobs` is a bind mount every participant can write, outlives the run, and is append-only by convention rather than construction. Flake re-runs share everything with each other, deliberately, because isolating them would hide the order-dependent flake they exist to catch. The agent sandbox is *not* contained — it has a browser, booted services and a registry route — which is affordable only because nothing worth stealing lives there and nothing it produces is trusted.

## Status

The engine works; the product does not exist yet.

**Built and tested:** event store · fold and projections · tiers and confidence · the verification engine · the reproduce-first gate · the anchored reproduction · the sandbox and its adversarial suite · agent supervision against a hostile fake · the agent loop outside the sandbox · the environment recipe · the two prompts · one container per phase · the GitHub App in and out · the browser · the SSE tail ([milestone 5](docs/milestone-5-v1.5.md), [report](docs/milestone-5-report.md)).

**Still not true, and this is the honest list:** no real model has ever run — every agent in every test is a scripted Messages API on a local port, and 5c's done-when is met in every part except the word *real*. No GitHub App is registered, so nothing here has been accepted by GitHub; a bare repository on disk stood in for the remote. `/blobs` remains append-only by convention rather than construction. Diff-coverage is still not built, so an agent-authored reproduction still cannot earn Tier 1.

**Deliberately not in v1.5:** Slack and CLI connectors · the dashboard · deployment and preview URLs · multi-repo runs · LSP tools · diff-coverage · observability-triggered runs.

## Prior work

This project inherits its verification discipline from a previous project: a test-generation framework whose central moat claim was **measured honestly and disproven** — the raw model beat the multi-stage engine on all recorded fixtures. That negative result (published in its ADR trail) is what redirected this project toward verification *around* agents rather than reasoning *instead of* them.
