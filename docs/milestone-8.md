---
status: in progress
---

# Milestone 8 — the things milestone 7 named and did not do

Milestone 7 ended with a list rather than a conclusion: six items it had analysed,
priced, and left. This milestone is that list, and nothing else. No new capability
is invented here — every phase below already exists as a paragraph in
[milestone-7.md](milestone-7.md), written by the session that found it and had no
budget left to fix it.

The order is not the order they were found in. It is cheapest-first, because two of
them cost a model run every time they fire and one of them cost this project a
wedged suite.

| | | |
|---|---|---|
| **8a** a container that will not finish is stopped | M7: "`runContainer` has no timeout" | built |
| **8b** the recipe's own test command is judged where the agent will be judged | M7 defect 3, "still open" | |
| **8c** the info request says what was actually missing | M7: "the info-request is a template" | |
| **8d** a suite that is already red on the reported behaviour | M7: "an existing failing test is a free Tier 1" | |
| **8e** triage, before a container starts | M7: "the cheapest available reduction in false Tier 3s" | |
| **8f** onboarding proves the repository, not just the recipe | M7: "onboarding proves a recipe" | |
| **8g** the sham-fix control survives a repository with dependencies | M7's predicted limitation, observed | |

## 8a · a container that will not finish is stopped

Every timeout this engine had was inside a container. `verify` bounds each command,
`runAgentLoop` bounds the agent, `replayRecipe` bounds a step — and all three are
moot for a container that never reaches PID 1. `docker run` against a missing image
pulls by default, and against a daemon that cannot reach a registry that pull does
not return. Milestone 7 observed it on its own suite: `a container that could not
run says why` hung, and was written off as environmental.

It was environmental. It was also the only unbounded wait in the system, and the
first host-side one — everything below the container had been bounded for four
milestones by people who could not see this line.

Two changes, and the smaller one is the fix:

- **`--pull never`, on every container this engine runs.** Every image here is one
  we built — `plan.image`, `plan.agentImage`, `engine-env:<runId>` — so a pull is
  always a mistake, and refusing it turns an indefinite wedge into `No such image`
  in under two seconds. The test that hung now asserts a 60-second deadline it
  finishes in 1.9.
- **A wall clock per container**, `containerTimeoutMs`, an hour by default. Longer
  than anything legitimate (the agent's own ceiling is 30 minutes) because it is a
  guard against a wedge, not a scheduling policy.

**The ceiling has to name the container to be worth anything.** Killing `docker
run` unblocks the host and leaves the daemon running what it started: `--rm` fires
on an exit that, in this case, is never coming. So every container is named now,
the ceiling removes it by name, and `runContainer` awaits that removal before it
returns — fired and forgotten, "the container is gone" is merely false for a
shorter time. `a container that will not finish is stopped by the host` asserts
both halves: the stderr line that is the *entire* diagnosis (the Runner emits its
events when `verify` returns, and it never did), and `docker ps -a` afterwards.
