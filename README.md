# Test Framework v2

> **Runs are non-deterministic, which is exactly why the event log and the verification gate exist.**

Any bug report — Slack, GitHub, Jira, wherever — becomes a **verified, evidence-backed PR**.

Test Framework v2 (name TBD) is an **event-sourced execution and verification platform for AI software engineering**. It is *not* a coding agent. The LLM (Claude Code, today) is a replaceable component; the project is the engineering system around it: intake, sandboxed execution, forensic verification, immutable evidence, and a replayable record of everything that happened.

Trust comes not from the agent, but from immutable evidence and reproducible verification built around it.

## How it works

```
 Slack        GitHub Issues        (TaskAdapter interface — Jira/Asana/Linear are ~50-line adapters)
   │                │
   └───────┬────────┘
           │  RUN_REQUESTED
           ▼
 ┌──────────────────────────────┐
 │  Sandbox (Docker)            │
 │  ┌────────────────────────┐  │        append-only, versioned fact-events
 │  │ Runner (PID 1)         │  │───────────────────────────────┐
 │  │  ├─ Claude Code        │  │                               ▼
 │  │  │   (testimony)       │  │                 ┌──────────────────────────┐
 │  │  └─ Verifier           │  │                 │  Event Store (Postgres)  │
 │  │      (evidence)        │  │                 │  (run_id, seq, type,     │
 │  └────────────────────────┘  │                 │   payload, ts)           │
 └──────────────────────────────┘                 └────────────┬─────────────┘
                                                          fold │
                              ┌────────────────┬──────────────┼──────────────────┐
                              ▼                ▼              ▼                  ▼
                          Timeline        Confidence      Evidence           Dashboard
                          projection      projection      report             (SSE live tail
                                                                              + Replay)
                                                          │
                                                          ▼
                                                     GitHub PR
```

There is **no runs table**. A run's state exists only as a fold over its events. Every projection is a disposable cache: deleting it causes no data loss; it is rebuilt by replaying the event stream.

## Testimony vs evidence

The agent's transcript is **testimony** — displayed, never trusted. Facts are **evidence** — observed and executed by the Runner at its own process boundary (exit codes, output hashes, diffs). The agent has zero ability to append events. "Solved" is a verdict only the Runner's executed checks can issue.

## Replay vs Rerun

|  | Replay | Rerun |
|---|---|---|
| What happens | Pure fold over the immutable event log | Fresh sandbox, new agent execution |
| Code executes | No | Yes |
| Deterministic | Trivially — nothing runs | Intentionally not |
| Result | Reconstructed history | A new run (`parent_run_id` links lineage) |

We never claim "deterministic replay" of an LLM execution. Replay reconstructs history; Rerun creates new history.

## Verification: reproduce first, or don't fix

- **Tier 1** — bug reproduced by a failing test: fails on base with symptom-matching output, passes on the fix, executed by the Runner. Highest confidence.
- **Tier 2** — reproduced by a deterministic scripted scenario (browser script, API sequence, screenshot diff). Medium confidence.
- **Tier 3** — not reproduced: **no fix is attempted.** The run produces a structured info-request back to the source thread. This gate never bends.

Confidence score = tier + deterministic evidence quality. Every point traceable to a content-addressed artifact.

## Architectural decisions

1. [Why event sourcing](docs/adr/0001-why-event-sourcing.md)
2. [Postgres over Kafka](docs/adr/0002-postgres-over-kafka.md)
3. [Replay vs Rerun](docs/adr/0003-replay-vs-rerun.md)
4. [Verification is a process; confidence is a projection](docs/adr/0004-verification-process-confidence-projection.md)
5. [SSE over WebSockets](docs/adr/0005-sse-over-websockets.md)
6. [Testimony vs evidence](docs/adr/0006-testimony-vs-evidence.md)
7. [The reproduce-first gate and tiered confidence](docs/adr/0007-reproduce-first-gate.md)

The full decision record from the founding design session: [SHARED-UNDERSTANDING.md](SHARED-UNDERSTANDING.md).

## Status

Early — docs-first founding commit. v1 scope is frozen:

**Core:** Slack adapter · GitHub Issues adapter · Docker sandbox · Claude Code runner · Verification engine · GitHub PR creation
**Architecture:** Event store · Replay engine · SSE streaming
**UI:** Live execution timeline · Agent transcript · Replay mode · Evidence report · Confidence score

**Future work (deliberately not v1):** Jira / Asana / Linear adapters · compare-two-fixes · multi-agent support · cloud runners · multi-tenant inference.

## Prior work

This project inherits its verification discipline from a previous project: a test-generation framework whose central moat claim was **measured honestly and disproven** — the raw model beat the multi-stage engine on all recorded fixtures. That negative result (published in its ADR trail) is what redirected this project toward verification *around* agents rather than reasoning *instead of* them.
