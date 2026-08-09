# Milestone 4 (proposed) — one container per participant

**Status: candidate B landed for the phases, after review caught it making one
channel worse.** Mounting the real evidence store into every container defeated
the premise: the base container flushes before it exits, the fix container
mounts the same directory, and `guardEvidence` counts those blobs as
pre-existing and never evicts them. That is worse than not splitting, because
the whole-run path keeps blobs in root-owned staging until the last repro has
finished. Each container now gets its own empty store and the host collects from
it afterwards — the one thing that genuinely has to cross between containers,
built rather than assumed. `verify()` takes `only`,
`src/orchestrate.ts` runs a container per participant from the host, and the fix
phase now starts on a machine the base phase never touched. Honest about what
that bought: collapsing the orchestrator back to one container still refuses
every attack the suite knows, because the scrubs and the reap close them. The
scrubs remove channels that were *found*; this removes the sharing they were
needed for. The agent step is wired but the attempt loop that uses it is 3b.2.

**Status before that, kept because the reasoning still holds:** An earlier draft downgraded this to
"less urgent" on the grounds that the enumeration had been closed by a test.
That was premature: the very next review round walked a self-respawning process
chain through the reap — the one invariant this doc called load-bearing — and
found a writable path inside `/blobs` that survived every scrub. Both are fixed,
and both were found by looking rather than by the design preventing them.

Six rounds is the evidence. Each fix has been correct and each has been
followed by another way in, because per-participant *directories* and a
best-effort *sweep* are approximations of isolation. Namespaces are not.

Measured, not assumed: `unshare --user --map-root-user` **is** blocked under
Docker's default seccomp profile in this image (`unshare(0x30020000): Operation
not permitted`) and succeeds under `seccomp=unconfined`. So candidate A costs a
seccomp change after all — a narrower one than `CAP_SYS_ADMIN`, but a
container-wide relaxation nonetheless, and a custom profile means shipping a copy
of Docker's default that will drift.

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
moment appears in both phases and is credited in neither. It took two attempts
to get right: the first was a `/proc` snapshot, which a chain that forks a
successor and exits simply outruns. ADR-0010 puts it
exactly right: the reap is what makes the *list* survivable. M3 has other
invariants that owe nothing to enumeration — the `:ro` source mount, the uid drop
that puts `/proc/1/fd` out of reach, `--separate-git-dir` with an explicit
`GIT_DIR`, and blob paths derived from `sha256(content)` computed inside `put()`.
The directory scrub is the one place the design resorted to a list, and it is the
one place it kept losing.

## Two candidates, and one dead end

**Candidate A — nested namespaces inside the sandbox.** The first draft of this
doc rejected it on the grounds that `unshare` needs `CAP_SYS_ADMIN`. **That is
false**, and review disproved it in this project's own image: uid 1000 created
nested user + mount + PID namespaces and mounted a tmpfs over `/tmp` with no
added capabilities at all, via `unshare --user --map-root-user --mount --pid`.
The `--user` route grants `CAP_SYS_ADMIN` *inside* the new namespace and needs
none outside it.

What actually blocks it under a default `docker run` is the **seccomp profile**,
which filters `clone`/`unshare` with `CLONE_NEWUSER`. That is a much narrower
concession than the one that was imagined — and narrower still if it is a custom
profile permitting those calls rather than `seccomp=unconfined`, which unblocks
some forty syscalls and would be trading real attack surface for this.

So A is the cheap candidate: per-participant `/tmp`, `/var/tmp`, `/dev/shm` and
`$HOME` become mount namespaces rather than directories that get wiped, and the
enumeration problem disappears without splitting anything. It costs one custom
seccomp profile and the argument for it.

**Candidate B — one container per participant** (below). More expensive, and it
buys something A does not.

**Dead end — a separate uid per phase.** Tempting and useless. The governing
example is base-writes / fix-reads, and a distinct uid does not stop a read of a
`0644` file. It would only help if every shared directory were `0700`, which is
the enumeration again wearing a permission bit.

**Also rejected — scrubbing harder.** Already at `git clean -xdff` plus a reap
plus a named directory list. The next item on that list is the one nobody
thought of.

## Candidate B: the shape

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

It is the **cloud-runner shape**, which candidate A is not. A per-phase container
that takes a commit and emits events is exactly what a remote runner is, so B is
not only a fix — it is the M3.1 seams (only the Runner writes events; blobs are
read by `sha256:` ref rather than by local path) finally paying for themselves.

**Recommendation: evaluate A first.** It closes the enumeration for a fraction of
the cost, and B remains the right move whenever cloud runners are wanted for
their own sake — at which point A's namespaces come along for free inside each
per-phase container.

## Do this before 3b.2

3b.2 gives the agent authorship of the `ReproSpec`. Everything above is latent
until then, because the repro comes from the Job — from us. The moment the agent
writes it, every channel in ADR-0010's "what still leaks" becomes live, and the
reproduce-first gate is the thing being bypassed.
