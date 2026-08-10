---
status: accepted
---

# The environment is part of the evidence

> **Read [ADR-0014](0014-long-lived-services-and-named-shells.md) alongside this.**
> The principle below is intact and is the reason v1.5 is shaped the way it is. Two
> of its mechanisms are not: the phase-boundary sweep is no longer the reason a
> timing attack fails (separate containers per phase are), and the sentence "they
> must share the clone" is retired. The "what still leaks" list at the end is the
> list that motivated the change — most of it closes structurally rather than by
> enumeration. Everything here is kept as written, because the four defeated
> versions are the argument.

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
that calls `setsid` leaves the group. Being PID 1 in the container's own
namespace is what makes a complete sweep possible, since every other process in
`/proc` is something this run started.

**Reading `/proc` and killing what was in it is not enough either, and the first
version of this ADR claimed otherwise.** That is a snapshot, not a fence: a
process that forks a successor and exits is never in the list about to be swept,
so a self-respawning chain walks through it — measured winning three runs in
five, carrying its state in `argv` and its code in the environment so the
directory scrub had nothing to delete. The sweep now stops the population with
SIGSTOP first, which cannot be caught or blocked and which a process cannot fork
through, repeats until a pass finds nobody new, and only then kills. That
converges rather than racing.

The shared writable directories are wiped in the same pass. This is the weaker
half and is honestly a list: `TMPDIR` only redirects a test that honours it, and
one writing `/tmp` literally shares the path regardless. The reap is what makes
the timing attack hard; the wipe removes debris a later variant might use.
Measured in that order — the attack lands with the reap removed and the wipe in
place, and does not land with the reap alone.

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

- **A shared kernel and clock.** What a container is.
- **The AGENT's network.** Sealed — `--network none`, like the phases — because
  the transport for "sealed plus one allowlisted route" is not built and the
  version that claimed to be dropped the seal. What leaks once it IS built is
  what the channel carries: a CONNECT proxy authorises a tunnel and never reads
  it, so an agent can exfiltrate through the one host it may reach. Closing that
  means terminating TLS inside the component built to keep the agent away from
  credentials, which is a worse trade. The PHASE
  containers no longer share a network with anything — `--network none`, since a
  reproduction that can reach the network is an identity oracle over a wire, and
  the code under judgement should not be able to exfiltrate the repository it was
  handed. This list stays concrete because its first version claimed "only a
  commit crosses between them" and was false within a day; leaving the phases in
  it would be false in the safe direction, which is still false.
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
- **Enumeration, checked rather than closed.** Four
  rounds each added an entry — `/tmp`, then `/home/node`, then `/dev/mqueue`,
  which nothing had ever considered — and every time the suite went green on a
  list that was still wrong. What was missing was never a longer list; it was a
  way to know when the list is complete. The image is now enumerated as the
  repro user and asserted to be *exactly* the scrubbed set, so a base image that
  gains a writable path fails the suite instead of waiting for the next review.
  "The set cannot be enumerated with confidence" turned out to be too pessimistic
  — it is five directories in the image — but "closed" was too optimistic, and
  this ADR has now said it twice and been wrong twice. What is true: the list is
  checked against the image on every run of the suite. What is not: that the
  check is complete. `find` runs as uid 1000, so it sees what that user can
  *list*, not what it can *write* — a `0711` parent would hide a writable child
  silently. No such directory exists in the image today.
- **The image is not the run.** That enumeration covers the image; a live run
  mounts more, and review found two channels there immediately: `/blobs`, which
  a bind mount leaves writable whatever the container says and which *outlives
  the run*, and the agent's own world, left standing and uid-1000-owned. The
  store cannot simply be emptied — it is where the evidence lives — so what was
  already in it is snapshotted and only additions are evicted, at each boundary
  and once more before the flush, since the last phase has no boundary after it.
  The agent's world is deleted outright. The snapshot has to be **recursive**:
  a depth-1 version protected a pre-existing name wholesale, and since blobs
  live at `<ab>/<cd>/<rest>`, any store that had ever held an artifact handed the
  participant a fanout directory that was never evicted.
- **Nothing protects prior evidence from deletion or overwrite.** Eviction
  removes what a participant added; a participant that instead truncates or
  unlinks an earlier run's blobs succeeds, and the run still exits 0 with its own
  refs intact. The store is append-only by convention, not by construction.
- **Read-only mounts are why the oracle had to change.** `test -w` answers about
  mode bits and knows nothing about a ro mount: it calls
  `/proc/sys/kernel/ns_last_pid` writable (0666 beneath a ro `/proc/sys`) and
  `/sys/firmware` writable (1777 on a ro tmpfs) when no process can write
  either. An earlier draft of this ADR argued at length that `ns_last_pid` was a
  "different threat class"; it is simply not writable, and the argument was
  defending a hole that does not exist. The enumeration now takes only `rw`
  mounts from `/proc/mounts`.
- **The reap assumes PID 1.** It is gated on it, so outside a container it does
  nothing at all — which is correct, and means the in-process engine used by the
  unit tests has none of this protection. That is acceptable only because the
  agent never runs there.

---

## Amendment — the list above is what argued for a boundary instead (v1.5)

This ADR said it plainly and then kept enumerating: *"The real answer is a mount
namespace per participant, or running the phases in a container of their own."*
[ADR-0014](0014-long-lived-services-and-named-shells.md) takes that answer. Which
entries close and which do not:

**Closed structurally**, because base and fix no longer share a container: the
writable-filesystem enumeration, surviving processes across the phase boundary, the
gitignored-path channel, and the meta-problem of not knowing when the list is
complete. The image scan stays in the suite — it is cheap and it now protects the
*agent* sandbox, where a browser and booted services make the writable set larger
than it has ever been.

**Still open, unchanged.** The shared kernel and clock. `/blobs`, which remains a
bind mount every participant can write and which outlives the run, append-only by
convention rather than construction — the weakest thing in this document and
untouched by v1.5. Flake re-runs sharing everything with each other, deliberately.

**Falsified.** The AGENT's-network entry above reasons about "what leaks once it IS
built." It never gets built —
[ADR-0011](0011-the-agent-loop-runs-outside-the-sandbox.md) abandons the channel
rather than deferring it, because the ceiling that entry names (a tunnel we
authorise and cannot inspect) is the ceiling of the whole shape. The entry is
right about the leak and wrong about the future, which is the useful half to keep.

**Newly open, and named here rather than discovered later.** The agent sandbox now
contains booted services, installed dependencies, a package-registry route and a
browser ([ADR-0013](0013-the-environment-recipe.md)). It is a far richer world than
the one this ADR fought over. That is affordable only because of what left it: no
model credential ([ADR-0011](0011-the-agent-loop-runs-outside-the-sandbox.md)), no
GitHub token ([ADR-0012](0012-the-github-app-and-where-the-token-lives.md)), and no
event channel. The agent sandbox is now a place where nothing worth stealing lives
and nothing it produces is trusted — which is why it can be allowed to get messy,
and the phase containers cannot.

**The sentence this ADR got wrong twice, stated once more.** It claimed a closed
list, was wrong, claimed a checked list, and was right about the check and wrong
about what the check bought. What is true in v1.5: the channels between the two
parties whose comparison decides a verdict are closed by namespace rather than by
enumeration. What is still not true: that the agent sandbox is contained. It is
not, and it no longer needs to be.
