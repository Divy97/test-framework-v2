# Milestone 4 (proposed) — one container per participant

**Status: scoped, not started.** It carries a real cost and a real architectural
commitment, so it is written down rather than begun.

## Why

Four review rounds on the agent-supervision PR each defeated the previous
round's fix, and the through-line is visible in the diffs: every fix
**enumerated** a channel. `/tmp`, then surviving processes, then gitignored
paths, then `/home/node`.

[ADR-0010](adr/0010-the-environment-is-part-of-the-evidence.md) now says plainly
what that cost: "world-writable" was the wrong set all along. The set that
matters is *writable by the repro user*, it is strictly larger, and it cannot be
enumerated with confidence. Every round the list grew and the suite went green,
which is exactly the shape of a defence that is losing.

What holds today is the **reap** — the Runner is PID 1, so it can end every
process in its namespace — because state nobody is alive to place at the right
moment appears in both phases and is credited in neither. That is a real
invariant, and it is the only one here not built on a list.

## What was rejected, and why

- **Nested mount/PID namespaces inside the sandbox.** `unshare` needs
  `CAP_SYS_ADMIN`. Granting it to strengthen the boundary weakens the boundary,
  which is the same trade M3.1 refused for Docker-in-Docker.
- **A separate uid per phase.** Tempting and useless: the attack is *the agent
  writes, the phase reads*, and a different uid does not stop a read of a
  world-readable file. It would only help if every shared directory were `0700`,
  which is the enumeration again.
- **Scrubbing harder.** Already at `git clean -xdff` plus a reap plus a named
  directory list. The next item on that list is the one nobody thought of.

## The shape

Each participant runs in **its own container**, and the host sequences them.
This does not contradict M3.1's "no docker client in the sandbox" — the
sandbox still has none. Orchestration moves **up**, to the host, which already
has a daemon.

```
host orchestrator
  ├─ container: agent      → transcript events, a commit
  ├─ container: base phase → TEST_RUN(base)
  └─ container: fix phase  → TEST_RUN(fix) × n, FIX_DIFF_OBSERVED
```

Nothing crosses between them except what is explicitly carried: a commit, and
blobs by `sha256:` ref. There is no shared filesystem to enumerate, because
there is no shared filesystem.

## What it costs

- **`runJob` splits.** The Runner becomes per-phase; the sequencing it does
  today moves to a host orchestrator. `verify()` splits along the same seam,
  which is the awkward part: it currently owns the base→fix transition, and that
  transition becomes a container boundary.
- **Dependency install stops being deferrable.** Sharing one tree is what let
  `npm install` happen once. Per-phase containers must each set up, which forces
  the `setupCommand` M2 deferred and M3 restated.
- **Wall clock.** Three container starts per attempt instead of one.

## What it buys beyond security

It is the **cloud-runner shape**. A per-phase container that takes a commit and
emits events is exactly what a remote runner is, so this is not only a fix — it
is the M3.1 seam ("nothing but the Runner writes events, nothing reads a blob by
local path") finally paying for itself.

## Do this before 3b.2

3b.2 gives the agent authorship of the `ReproSpec`. Everything above is latent
until then, because the repro comes from the Job — from us. The moment the agent
writes it, every channel in ADR-0010's "what still leaks" becomes live, and the
reproduce-first gate is the thing being bypassed.
