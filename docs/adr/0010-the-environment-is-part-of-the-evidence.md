---
status: accepted
---

# The environment is part of the evidence

[ADR-0008](0008-the-reproduction-is-anchored.md) anchors the reproduction so both
phases provably run the same thing. [ADR-0006](0006-testimony-vs-evidence.md)
says the agent cannot write facts. Both hold. Neither was enough.

Review of the agent-supervision PR demonstrated, end to end in the real
container, a run folding to `reproduced: true` where:

- the reproduction was a maintainer-authored committed test, `pinned` and hashed
  — the strongest provenance ADR-0008 recognises — byte-identical on every run;
- the base failed with a matching symptom, all three fix runs passed, and
  `FIX_DIFF_OBSERVED` vouched that the series completed;
- **the fix commit changed one unrelated file and nothing else.**

The agent forged no event. It did not need to. It ran before the phases, as the
same uid, on the same filesystem, and wrote a file into `/tmp` that the test
read. Every anti-gaming check passed, because **not one of them is about the
environment.**

`/tmp` was the easiest channel, not the only one. A gitignored directory works
too — `git status --porcelain` does not list ignored files and the phase-boundary
`git clean -dff` deliberately spares them, which is correct for installed
dependencies and fatal here. `$HOME` is a third.

**Decision.** Anchoring *what* runs is not anchoring *where* it runs. Every
participant gets its own world: its own clone, its own `TMPDIR`, its own `HOME`.
The verification tree is cloned only after the agent has finished, so a tree it
could have written to is never the tree it is judged in. Only a commit crosses
between them.

This makes the ADR-0006 boundary say something it did not say before:

> Verification facts originate at the Runner's process boundary — **and the
> Runner's observations are only worth what the isolation of the observed
> environment is worth.** A faithful observation of a staged world is a faithful
> record of a lie.

**Rejected: scrubbing harder.** `git clean -xdff` at the phase boundary would
close the gitignored channel and destroy installed dependencies with it, which
changes what is under test far more than it isolates it. It also leaves `/tmp`
and `$HOME` open. Separation is cheaper than enumeration, and enumeration is a
list nobody finishes.

**Rejected: trusting the agent not to.** The whole project exists because that
does not work.

**Consequence.** The agent's working tree is discarded. Its fix must arrive as a
commit or it does not arrive — which is the shape the attempt loop wanted
anyway. Residual, and named rather than waved at: the phases still share a
kernel, a clock, and a network with everything else in the container. Egress
control is M3.3; the rest is what a container is.
