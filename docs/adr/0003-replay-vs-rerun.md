---
status: accepted
---

# Replay vs Rerun: two words, never blurred

LLM agent executions cannot be deterministically re-executed, and every
reviewer of this system knows it. The vocabulary must therefore be surgical —
in the README, the UI, and the API.

**Decision.**

- **Replay** is a pure fold over the immutable event log. It reconstructs
  every intermediate state of a past run, byte-for-byte. No code runs, no
  agent runs, no side effects, read-only. It is deterministic *trivially* —
  because nothing executes.
- **Rerun** creates a brand-new run: fresh sandbox, same normalized task, new
  agent execution, new event stream. Its first event carries `parent_run_id`
  for lineage. It is **intentionally non-deterministic** — that is the honest
  property of agent execution, and the reason the event log and verification
  gate exist at all.

The UI presents these as distinct actions with distinct affordances (Replay is
a scrubber over history; Rerun is a button that costs money and time and
produces a sibling run). The docs never use "deterministic replay" to describe
anything involving agent execution.

**Rejected.** Any claim of deterministic re-execution (snapshot the model,
pin the seed, cache the completions). Even where partially achievable, it
invites a claim we cannot defend in general and do not need: reproducibility
here comes from re-runnable *verification* against immutable evidence, not
from replaying the agent's cognition.
