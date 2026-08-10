---
status: accepted
amends: 0010-the-environment-is-part-of-the-evidence.md
---

# Long-lived services, and what the reap is still for

[ADR-0010](0010-the-environment-is-part-of-the-evidence.md) established that
nothing the agent started may still be running when the phases begin, and built a
converging sweep to guarantee it: SIGSTOP the whole population first — which
cannot be caught, blocked, or forked through — repeat until a pass finds nobody
new, and only then kill. It was measured against a self-respawning chain that
defeated the previous version three runs in five.

[ADR-0013](0013-the-environment-recipe.md) now requires the exact opposite. A copy
bug is reproduced against a running frontend. A dev server that dies the moment
setup finishes is a dev server that was never useful.

Read narrowly these are contradictory. Read properly they are not, because the
sweep was never about processes. It was about **one process outliving one
boundary**: a marker flipped *between* base and fix manufactures red-then-green
against an untouched committed test and a no-op fix.

**Decision — part one: services are named, supervised, and the Runner's.**

The shell tool creates named sessions and writes into them by id, rather than
running one command per invocation. A service declared in the recipe lives in a
session the Runner started and holds a handle to. The consequences that matter:

- A supervised service has known **authorship**. The Runner started it from an
  approved recipe, so its existence is a fact the orchestrator recorded rather
  than a residue discovered in `/proc`.
- Its lifetime is bounded by the session, not by a sweep. Teardown closes handles
  the Runner owns; there is nothing to enumerate.
- A process the *agent* backgrounded outside a named session is still exactly what
  ADR-0010 described, and is still swept.

**Decision — part two: the phase boundary becomes a container boundary.**

Base and fix each run in **their own container**, taking a commit and emitting
events — the shape [milestone-4](milestone-4-isolation.md) called candidate B.
ADR-0010's residual channels were all instances of one thing, "these two
participants share a world", and each round closed one entry in a list that was
never complete. A separate container per phase closes the list instead of
extending it:

| ADR-0010 residual | Under separate phase containers |
|---|---|
| `/tmp`, `/var/tmp`, `/dev/shm` shared | not shared — different mount namespaces |
| shared `HOME` | not shared |
| a process surviving into the next phase | cannot — different PID namespace |
| gitignored paths in a shared clone | not shared — each phase clones its own tree |
| the enumeration being complete | no longer load-bearing |

ADR-0010 stated that base and fix "must share the clone, since switching commits
in one tree is what the comparison is." **That is the sentence this ADR retires.**
Switching commits in one tree is one *implementation* of the comparison. Cloning
the same source at two commits into two containers is another, and it compares the
same two trees while sharing nothing. The anchored reproduction
([ADR-0008](0008-the-reproduction-is-anchored.md)) is what makes them comparable,
and it was already doing that work.

**The reap survives, demoted.** It remains, gated on PID 1 as before, and it still
runs before a container's work is considered finished. It is no longer the reason
a timing attack fails — a missing PID namespace is. Keeping it is cheap and its
absence would be a silent regression if a future change ever collapses two phases
back into one container. The suite continues to assert the attack and the defence
in the same test, so the defence cannot quietly stop being the reason the other
test passes.

**What this costs.** [milestone-4](milestone-4-isolation.md) priced candidate B
honestly and the price is unchanged: `runJob` splits, `verify()` splits along the
seam it currently owns (the base→fix transition becomes a container boundary), each
phase must set up independently, and there are three container starts per attempt
instead of one. The per-phase setup cost is the one that stings — and it is
[ADR-0013](0013-the-environment-recipe.md)'s bill, not this ADR's, since a phase
that runs a test needing a booted service has to boot it either way.

**Rejected: keeping one phase container and sweeping harder.** Four review rounds
each added an entry to the list and each went green on a list that was still
wrong. ADR-0010 said in its own words that "the real answer is a mount namespace
per participant, or running the phases in a container of their own." It named the
direction and then kept enumerating. This is the direction.

**Rejected: services in the phase containers.** The tempting version is that a
phase boots the app and runs a browser-driven reproduction against it. It is
refused because a booted service is a writable, stateful thing that both phases
would have to establish identically, and a reproduction that depends on it is
asserting about a world the engine cannot anchor. Reproductions that need a
running application are Tier 2 by way of
[ADR-0007](0007-reproduce-first-gate.md); the engine's evidence stays an exit
code.

**What still leaks.**

- **A shared kernel and clock.** What a container is. Unchanged, and the reason
  this ADR claims a closed list of *filesystem and process* channels rather than a
  closed list.
- **`/blobs` is still a bind mount shared by every participant.** ADR-0010's
  snapshot-and-evict remains necessary and remains the weakest part: the store is
  append-only by convention, not construction, and a participant that truncates an
  earlier run's blob succeeds.
- **Flake re-runs still share everything with each other**, deliberately, because
  isolating them would hide order-dependent flake — which is the thing they exist
  to catch.
- **Named sessions are a supervision claim, not a sandbox.** A service the Runner
  started can still be talked to by anything else in that container. In the agent
  sandbox that is the agent, which is fine, because the agent sandbox produces
  testimony and nothing else.

**Revisit when** three container starts per attempt becomes the dominant cost of a
run. The answer then is warm pools or a per-repository prepared image, and the
second one collides with [ADR-0013](0013-the-environment-recipe.md) — an image
baked with dependencies is pinned to a commit, which is the trade the session
transcript flagged and nobody has priced.
