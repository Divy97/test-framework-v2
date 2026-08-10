---
status: accepted
---

# The environment recipe: asked once, replayed forever

M2 deferred dependency install with no answer. M3 restated the deferral and named
the sandbox as where a `setupCommand` would live "if we add one". The gap has a
shape now, because v1.5's bug classes need it: a copy bug needs the frontend
running, an API bug needs the backend and a database, and neither is reachable
from a repository that has never had `npm install` run in it.

The underlying problem is not installing dependencies. It is that **every
repository boots differently**, and nothing in a repository reliably says how.
Package manager, migration step, seed data, which services, which ports, what
"ready" means — the union of those across real projects has no detector.

**Decision.** Do not detect it. Ask the agent once, have a human approve it, then
never ask again.

On first contact with a repository, an agent session explores the codebase and
drafts a **recipe**: install command, migrate, seed, one entry per service with
its start command, port and healthcheck, and the test command. A human reviews
the draft, corrects it, and confirms. It is stored keyed by repository and every
subsequent run replays it verbatim.

This fits the trust model rather than bending it. **The recipe is testimony — the
healthcheck passing is evidence.** The agent's claim about how to boot the project
is worth nothing on its own; a service answering on its port is a fact the
orchestrator observed at its own process boundary. `ENV_READY` is emitted for the
second, never the first.

**The recipe lives on our side, not in the user's repository.** This was a real
fork. A committed `.engine/env.json` would be visible, reviewable, and versioned
with the code that it describes — genuinely the better engineering artifact. It is
rejected because it makes onboarding a pull request against someone else's
codebase before we have delivered anything, and because the product's entire
promise is that the user writes an issue and receives a PR. Writing to their
repository to earn the right to write to their repository inverts that.

**The consequence for the sandbox's network.** Install needs a package registry
and booted services need localhost, so the **agent sandbox** gets network during
the setup phase. This does not touch the phase containers: they stay
`--network none`, because a reproduction that can reach the network is an identity
oracle over a wire, and the code under judgement must not be able to exfiltrate
the repository it was handed.

That asymmetry is the load-bearing part, and it is only affordable because of
[ADR-0011](0011-the-agent-loop-runs-outside-the-sandbox.md): the agent sandbox can
have a registry route without also being the place a model credential lives.

**Rejected: detecting the recipe from the repository on every run.** Lockfiles
name a package manager and nothing else. A `docker-compose.yml` is a strong hint
and M3.1 already refuses a Docker client in the sandbox. Scripts in `package.json`
are named by convention, and the convention is not one. Every detector is a
heuristic that fails silently on the repository we most want to work, and a failed
boot presents as "could not reproduce" — the one verdict that must mean something.

**Rejected: asking the user to fill in a form up front.** It is the same
information with the work moved onto the person we are trying to help, and it
front-loads friction before any value has been delivered. Drafting it and asking
for a correction is the same number of fields with the blank page already filled.

**Rejected: no recipe, and refuse repositories that need one.** M3.1 took exactly
this position on Docker-in-Docker and was right to, because that refusal is a Tier
3 info-request and ADR-0007 already treats it as a deliverable. It does not
generalise here: refusing every repository with a dependency refuses every
repository.

**What still leaks.**

- **A recipe is a stored command we execute.** It was drafted by an agent and
  approved by a human who may have skimmed it. Nothing here sandboxes the recipe
  from the sandbox — it runs with whatever the setup phase has, including the
  registry route. The approval is the control, and an approval is a human reading
  carefully.
- **Recipes rot.** A project that changes its start command has a recipe that
  boots the wrong thing or nothing. A failed healthcheck is the detection, and its
  honest presentation is an operational failure, not "could not reproduce" — the
  fold must be able to tell those apart, which is why `ENV_READY` is an event
  rather than a precondition nobody records.
- **Install is not pinned.** Replaying a recipe a month later resolves different
  dependency versions unless the repository's own lockfile prevents it. The
  reproduction is anchored ([ADR-0008](0008-the-reproduction-is-anchored.md)); the
  tree it runs against is not.
- **Seeded state is shared between the phases.** Both phases boot from the same
  recipe, so a seed that is not deterministic is a flake source the flake re-runs
  will find and the fold will refuse — noisily and correctly, but noisily.

**Revisit when** the first repository needs a service we cannot boot — an external
API with no sandbox, a paid dependency, a database version the image lacks. The
answer at that point is a Tier 3 info-request, and the interesting question is
whether the recipe should be able to declare an unsatisfiable requirement up front
instead of discovering it at boot.
