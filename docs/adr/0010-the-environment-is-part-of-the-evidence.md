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
could have written to is never the tree it is judged in.

**And nothing the agent started is still running when the phases begin.** The
first version of this decision stopped at separate directories and was defeated
in review by a process the agent backgrounded: it runs as the same uid, so it
can write the phases' *own private* `TMPDIR` and `HOME`, and separation offers
it nothing. It also supplies the one thing a static plant cannot — timing. A
file present in both phases makes the base pass too and is never credited; a
process that flips a marker *between* them manufactures red-then-green against
an untouched committed test and a no-op fix.

Killing the agent's process group is necessary and not sufficient: a grandchild
that calls `setsid` leaves the group. What closes it is that the Runner is PID 1
in the container's own namespace, so every other process in `/proc` is something
this run started, and nothing legitimate is alive between the agent finishing
and the base phase. The Runner reaps them all.

The shared writable directories are wiped in the same pass — `/tmp`, `/var/tmp`,
`/dev/shm`. This is the weaker half and is honestly a list: `TMPDIR` only
redirects a test that honours it, and one writing `/tmp` literally shares the
path regardless. The reap is what makes the timing attack impossible; the wipe
removes debris a later, cleverer variant might use. Verified in that order — the
attack still lands with the reap removed and the wipe in place, and does not
land with the reap alone.

This makes the ADR-0006 boundary say something it did not say before:

> Verification facts originate at the Runner's process boundary — **and the
> Runner's observations are only worth what the isolation of the observed
> environment is worth.** A faithful observation of a staged world is a faithful
> record of a lie.

**Rejected: scrubbing harder *instead* of separating.** `git clean -xdff` closes
the gitignored channel and nothing else — `/tmp` and `$HOME` stay open — so as a
replacement for separation it fixes one door in a corridor. It is adopted *as
well*, at the phase boundary only, for the reasons in the next section.

**Rejected: trusting the agent not to.** The whole project exists because that
does not work.

**Consequence.** The agent's working tree is discarded. Its fix must arrive as a
commit or it does not arrive — which is the shape the attempt loop wanted
anyway.

## The same rule applies between the phases

Both versions above framed the problem as agent-versus-phases and missed that
**base and fix share one world too** — one clone, one `TMPDIR`, one `HOME`. They
must share the clone, since switching commits in one tree is what the comparison
is. Everything else they shared was an accident.

`verify()` already scrubbed the tree at the phase boundary, precisely because
base-phase residue could carry the fix to green. It scrubbed the tree and only
the tree. So the simplest fabrication of all needs no agent process, no forged
event and no tampering:

```sh
flag="$TMPDIR/.seen"; [ -f "$flag" ] && exit 0; touch "$flag"; <the real test>
```

Red the first time, green every time after. Byte-identical across both
checkouts, hashing identically on every run, so ADR-0008's anchor is completely
satisfied — **the anchor fixes the reproduction's bytes, never its side
effects** — and the fix commit need not touch the code at all.

So the phase boundary gets **everything the agent boundary got**, not a subset:
the same PID-namespace reap and the same directory scrub, plus `git clean -xdff`
on the tree. `-x` there and nowhere else — ignored files are spared in general
because they are usually installed dependencies, but between the phases of one
repo `node_modules/` is simply the easiest place for the base run to leave a
flag, and it is ignored in every real repository. Nothing installs dependencies
yet, so today that costs nothing; a `setupCommand` must run per phase. The suite asserts the attack *and* the defence — one test proves an
unscrubbed run credits a README-only "fix", so the defence cannot quietly stop
being the reason the other test passes.

## What still leaks

Named rather than waved at, and the list is deliberately concrete because the
first version of this ADR claimed "only a commit crosses between them" and that
was false within a day.

- **A shared kernel, clock and network.** Egress control is M3.3; the rest is
  what a container is.
- **The writable filesystem, enumerated rather than isolated.** `/tmp`,
  `/var/tmp` and `/dev/shm` are wiped, not namespaced. A path not on that list
  and writable by uid 1000 is still shared. The real answer is a mount namespace
  per participant, or running the phases in a container of their own — which is
  also the answer to the process question, and the direction if either bites
  again.
- **Flake re-runs still share everything.** They must — they are re-executions
  of the same fix, and isolating them would hide order-dependent flake, which is
  the thing they exist to catch. So a repro can differ between re-run 0 and
  re-run 1. That is survivable only because one red run in the series is already
  enough for the fold to refuse.
- ~~**Enumeration, still.**~~ **Closed by making the list check itself.** Four
  rounds each added an entry — `/tmp`, then `/home/node`, then `/dev/mqueue`,
  which nothing had ever considered — and every time the suite went green on a
  list that was still wrong. What was missing was never a longer list; it was a
  way to know when the list is complete. The image is now enumerated as the
  repro user and asserted to be *exactly* the scrubbed set, so a base image that
  gains a writable path fails the suite instead of waiting for the next review.
  The answer to "the set cannot be enumerated with confidence" turned out to be
  that it can — it is five directories — and that the confidence has to come
  from a test rather than from care.
- **procfs is out of scope, deliberately.** The enumeration covers real
  filesystems. Extending it to `/proc` turns up `/proc/sys/kernel/ns_last_pid`,
  writable by uid 1000 — a kernel tunable rather than a place to leave a file.
  It cannot be scrubbed by removing anything and every process creation rewrites
  it, so it is a different threat class and is recorded rather than swept in.
- **The reap assumes PID 1.** It is gated on it, so outside a container it does
  nothing at all — which is correct, and means the in-process engine used by the
  unit tests has none of this protection. That is acceptable only because the
  agent never runs there.
