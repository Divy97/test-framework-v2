---
status: accepted
supersedes: milestone-3.md §3c.2, milestone-4-isolation.md
---

# Architecture v1.5 — the whole system, one connector

M1 built the event core. M2 built the verification engine. M3 built the sandbox
and the agent supervision inside it. What none of them built is a system a person
can use: there is no connector, no way to stand a repo up, no PR at the end, and
no prompt telling the agent what the engine expects of it.

This document is the target shape. It is not a wish list — every component below
is either already in the repo or named in [milestone-5](milestone-5-v1.5.md) with
the decision that unblocks it.

**One connector: a GitHub App.** One integration carries intake (issues), read
access (clone), and delivery (branch + PR). Slack and CLI reach the same
`RUN_REQUESTED` later and are deliberately out of v1.5 — see
[the scope section](#not-in-v15).

**The agent loop moves out of the sandbox** ([ADR-0011](adr/0011-the-agent-loop-runs-outside-the-sandbox.md)).
This is the structural change v1.5 turns on, and most of what follows is
downstream of it.

## The shape

```
┌──────────────────────────────────────────────────────────────────────────┐
│  GITHUB — the only connector                                             │
│                                                                          │
│  issue opened / labelled ──┐                    ┌── branch pushed        │
│  repo (private, cloned)    │                    │   PR opened            │
└────────────────────────────┼────────────────────┼────────────────────────┘
                    webhook  │                    │  1h installation token
                             ▼                    │  HOST ONLY, never below
┌────────────────────────────┴────────────────────┴────────────────────────┐
│  OUR BACKEND                                                             │
│    webhook receiver     → RUN_REQUESTED                                  │
│    App private key      → JWT → 1h installation token, repo-scoped       │
│    recipe store         → how to boot THIS repo. Ours, not their repo.    │
│    HTTP API + SSE       → status out                                     │
└───────┬──────────────────────────────────────────────────┬───────────────┘
        │ enqueue                              every event │
        ▼                                                  ▼
┌──────────────────────────┐                    ┌──────────────────────────┐
│  ORCHESTRATOR            │                    │  POSTGRES                │
│  orchestrate.ts          │                    │  events: append-only,    │
│                          │                    │  (run_id, seq) unique    │
│  ONE sequencer, not a    │                    │  + recipes               │
│  swarm. The order IS     │                    └───────────┬──────────────┘
│  the product.            │                         fold() │
│                          │                                ▼
│  Sole event writer.      │                    ┌──────────────────────────┐
└──┬────────────────────┬──┘                    │  verdict                 │
   │                    │                       │  tier 1 / 2 / 3          │
   │ (1) agent phases   │ (2) judgement phases  │  confidence              │
   ▼                    ▼                       └───────────┬──────────────┘
┌─────────────────────┐ ┌─────────────────────┐             │
│  AGENT SANDBOX      │ │  PHASE CONTAINERS   │             ▼
│  our infra          │ │  base  ·  fix       │  ┌──────────────────────┐
│                     │ │                     │  │  SSE → status        │
│  recipe replayed:   │ │  --network none     │  │  issue comment       │
│   install           │ │  NO agent           │  │  PR body             │
│   migrate + seed    │ │  NO browser         │  └──────────────────────┘
│   boot services     │ │  NO services        │
│   healthcheck       │ │                     │  ┌──────────────────────┐
│                     │ │  apply repro files  │  │  BLOB STORE          │
│  named shells       │ │  run ONE command    │◄─┤  sha256-named        │
│  headless browser   │ │  exit code decides  │  │  screenshots, logs,  │
│  full repo @ base   │ │                     │  │  diffs, transcripts  │
│                     │ └─────────────────────┘  └──────────────────────┘
│  NO github token    │
│  NO model API key   │
│  NO network egress  │
└─────────┬───────────┘
          │ tool calls in, results out. The worker dials OUT; nothing dials in.
          ▼
┌─────────────────────────────┐        ┌──────────────────────────┐
│  AGENT LOOP — outside       │───────►│  Anthropic API           │
│  Messages API tool runner   │        │  the model credential    │
│                             │        │  lives HERE and only     │
│  our tools:                 │        │  here                    │
│   shell (named sessions)    │        └──────────────────────────┘
│   read / write / edit       │
│   grep / glob               │
│   browser (navigate, click, │
│     type, screenshot)       │
│   git (commit only)         │
└─────────────────────────────┘
```

## Two boundaries, and why they are drawn there

Everything in the diagram exists to keep two credentials out of one place.

**The GitHub token never enters the sandbox.** The host clones, the host pushes,
the host opens the PR. The agent's only outbound artifact is a commit
([ADR-0012](adr/0012-the-github-app-and-where-the-token-lives.md)).

**The model API credential never enters the sandbox.** The loop is outside, so
the container needs no egress at all. This is not a hardening measure bolted on
afterwards — it is the reason the loop moved, and it retires the whole of M3's
§3c.2 rather than solving it ([ADR-0011](adr/0011-the-agent-loop-runs-outside-the-sandbox.md)).

Two rules from earlier milestones survive unchanged and are what the above
protects:

- **Only the orchestrator writes events.** The agent's output becomes a payload,
  never a fact ([ADR-0006](adr/0006-testimony-vs-evidence.md)).
- **The gate reads the fold.** "Did it reproduce" has exactly one definition, and
  no producer gets a second one ([ADR-0009](adr/0009-what-a-producer-may-write-back.md)).

## The user's flow

### Once per organisation

1. The user installs our GitHub App and selects repositories. We request
   `contents: read and write`, `pull_requests: read and write` and
   `issues: read and write` — nothing else.

   **Corrected after tracing the calls.** This said `contents` and
   `pull_requests` only. `issues: write` is required by
   `POST /repos/:repo/issues/:n/comments`, which every run makes on every
   outcome and which for Tier 3 **is** the whole deliverable — there is no PR.
   With the narrower set a Tier 3 run does everything correctly, posts nothing,
   and records no error, because `run.ts` deliberately swallows a failed comment
   (there is no event class for our own outage). An under-specified permission
   here fails silently, which is the one presentation this project refuses.
2. Every delivery carries `installation.id`, and that is where the installation
   comes from — `intake()` reads it per delivery.

   **Also corrected.** This said GitHub calls a setup URL with an installation
   ID and we store it. There is no setup URL and no installations table; nothing
   is stored. Reading it per delivery is the better design for the reason ADR-0012
   gives about the token — an id captured once is an id that can be stale — but the
   document described a mechanism that was never built.

No personal access token is ever requested. A PAT dies when its owner leaves the
organisation and carries that person's full access while it lives; an
installation belongs to the organisation and the user can revoke it from their
own GitHub settings without talking to us.

### Once per repository — onboarding

3. The first run against a new repository has no recipe. An agent session
   explores the codebase and drafts one: install command, migrate, seed, per
   service start command and port, healthcheck URL, test command.
4. We show the draft to the user. They correct it and confirm.
5. It is stored **on our side**, keyed by repository. Every later run replays it
   and never re-derives it ([ADR-0013](adr/0013-the-environment-recipe.md)).

This converts an unbounded per-run guessing problem into a one-time cost per
repository, and it is the only step in the product that asks the user for
anything beyond the bug report.

### Every bug — the product

6. The user opens a GitHub issue, or labels an existing one. **That is the entire
   interaction.**
7. Webhook fires. We mint a 1-hour installation token, create the run, emit
   `RUN_REQUESTED`.
8. The sandbox comes up. The repository is cloned at base. The recipe replays:
   install, migrate, boot the services, wait for the healthcheck.
9. **The repro agent** gets the issue text and a running application. It reads
   code, drives the browser, finds the bug — then commits a failing test and a
   manifest at `.engine/repro.json` naming the command and the files. Its working
   tree is discarded; only the commit survives
   ([ADR-0010](adr/0010-the-environment-is-part-of-the-evidence.md)).
10. **The base phase**, sealed and agentless: applies the repro files over base,
    runs the command. **It must fail.** If it passes, the bug was never shown —
    Tier 3, we comment on the issue with what was tried and what is missing, and
    the run ends. The fix agent is never spawned
    ([ADR-0007](adr/0007-reproduce-first-gate.md)).
11. **The fix agent** — spawned only now, so the log proves by `seq` that it never
    watched the reproduction being written
    ([ADR-0008](adr/0008-the-reproduction-is-anchored.md)). It gets the issue, the
    registered command, and the codebase. It commits a fix.
12. **The fix phase**, sealed: the same files and the same command over the fix
    commit. **It must pass.** `FIX_DIFF_OBSERVED` records every changed file and
    the full diff as a blob.
13. The **host** pushes the branch and opens the PR: what the bug was, the failing
    test, base red and fix green, the diff, the tier reached.
14. The user gets one notification: a pull request. **Merging is always human.**

What the user ever sees is an issue they wrote and a PR we opened. No terminal,
no editor, no streamed browser, no chat.

## The event sequence

```
seq  event                     gate / note
──── ───────────────────────── ──────────────────────────────────────────────
 1   RUN_REQUESTED             {source: "github_issue", thread_ref, raw_text}
 2   ATTEMPT_STARTED           {n}
 3   ENV_READY                 recipe replayed, healthchecks green
 4   AGENT_MESSAGE × n         repro agent. Raw line by sha256: ref, plus the
                               claimed_type the stream asserted. A string.
 5   AGENT_FINISHED            HOW it ended, so a truncated transcript can
                               never read as a complete one
 6   REPRO_REGISTERED          ◄── the fix agent does not exist yet
 7   TEST_RUN(base)            red → continue.  green → ─────────┐
 8   AGENT_MESSAGE × n         fix agent spawns HERE             │
 9   AGENT_FINISHED                                             │
10   TEST_RUN(fix) × 3         flake re-runs                     │
11   FIX_DIFF_OBSERVED                                          │
12   CONTROL_RUN               sham fix. Advisory, ends nothing.  │
13   PR_OPENED                                                  │
14   RUN_ENDED                                              ◄────┘  Tier 3,
                                                                    no fix
```

`ENV_READY` is the one new event class v1.5 adds to the spine. Everything else
already exists in `src/events.ts`.

## Where the browser sits, and why it does not weaken the gate

The browser runs **only in the agent sandbox**. It never runs in a phase
container. That split is load-bearing rather than incidental:

- The browser is how the agent **finds** the bug. Screenshots and console logs
  are **testimony** — stored, shown in the PR, never an input to any verdict.
- A committed test with an exit code is how the engine **proves** it. That is
  **evidence**.

So the phase containers stay sealed and decide on exit code alone, and
[ADR-0006](adr/0006-testimony-vs-evidence.md) holds unchanged. The browser makes
the agent better at its job and gives the engine nothing new to trust — which is
the only way to add a capability to a system built on distrusting its agent.

The consequence for tiering is real and is recorded in
[ADR-0007](adr/0007-reproduce-first-gate.md): a browser-driven reproduction that
the agent authored is Tier 2, exactly like any other agent-authored one. Being
able to see the bug does not make the reproduction independent.

## What changes in the existing code

Four reversals, each with an ADR, because each undoes something a review round
deliberately put there.

| What | Today | v1.5 | Why |
|---|---|---|---|
| Agent location | `claude -p` inside the container | loop outside, tools proxy in | [ADR-0011](adr/0011-the-agent-loop-runs-outside-the-sandbox.md) |
| `runner.ts:170` reap | SIGSTOP the tree, then SIGKILL — nothing survives | named shells supervised by the Runner; the reap stays at the **phase** boundary | [ADR-0014](adr/0014-long-lived-services-and-named-shells.md) |
| Phase network | `--network none` everywhere | unchanged on phases; the **agent sandbox** gets localhost and a registry route during setup | [ADR-0013](adr/0013-the-environment-recipe.md) |
| `src/egress.ts` | built, wired to nothing | deleted | [ADR-0011](adr/0011-the-agent-loop-runs-outside-the-sandbox.md) |

And one gap that is not a reversal, just missing: **no prompt has ever been
authored.** `src/agent.ts:40` says the prompt's content is the caller's business,
and every prompt in the repo is a test stub. Nothing tells the agent that
`.engine/repro.json` exists. The engine has a strict contract and has never
stated it to the party it binds.

## Not in v1.5

Slack and CLI connectors · the dashboard UI (SSE and issue comments only) ·
deployment and preview URLs · multi-repo runs · `code-server` · a streamed
browser · LSP tools · autonomous Sentry-triggered runs · diff-coverage
instrumentation.

The dashboard is the one that will itch, because [Q5](../SHARED-UNDERSTANDING.md)
made it the demo. It is deferred rather than cut: v1.5 exists to make a run that
is worth watching, and a timeline over an empty event log demos nothing.

## Rejected: Anthropic's Managed Agents with a self-hosted sandbox

This is the closest hosted equivalent of the architecture above — Anthropic runs
the loop, our worker runs the tools in our container, outbound-only, and its
`github_repository` resource already injects the git token at an Anthropic-side
proxy so the token never enters the sandbox. It would be less code than
[ADR-0011](adr/0011-the-agent-loop-runs-outside-the-sandbox.md) asks for.

Rejected on the project's own filter. This is a portfolio project whose stated
test is whether a senior engineer finds it impressive, and whose one subsystem
deep enough to survive interrogation is the trust boundary. "The credential
cannot reach the agent, and here is the structure that guarantees it" is the
claim; renting the structure means renting the claim. The rejection is about
authorship, not capability — if this ever became a product, the hosted surface is
the obvious operational answer and this ADR should be revisited on that day.
