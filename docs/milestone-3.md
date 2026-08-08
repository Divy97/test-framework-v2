# Milestone 3 — the sandbox and the Runner

**Goal:** the verification engine stops running on a developer's machine and starts
running as PID 1 inside a disposable container, with the agent supervised beside
it and events leaving through one channel.

## Why this is next, and not 3b/3c

M2's engine took four security review rounds. Every finding was the same root
cause in different clothing: **the engine does untrusted file handling on the
host.** Each fix closed a door while the shape of the problem stayed.

In a container, every one of those findings drops from "arbitrary write on your
machine" to "arbitrary write inside a disposable container" — a nuisance rather
than a breach. The residual findings accepted in ADR-0008's PR are accepted
*because* this milestone exists. It is not a feature; it is the containment the
engine was written against.

It also unblocks the demo. The live agent transcript is the single most
demonstrable screen in the project, and nothing before M3 can produce one.

## Sequencing — sandbox before agent

The same engine-first logic that worked in M2. Three PRs, each shippable alone:

**3a · the sandbox runs the engine, with no agent**
A container image with git and node, the Runner as PID 1, `verify()` executing
inside it against a fixture repo, events written out through one channel. No
Claude Code, no intake. Proves containment and the event path in isolation.

**3b · the Runner supervises the agent**
`claude -p --output-format stream-json`, its output translated into transcript
events. The agent still cannot append events — the Runner writes all of them
(ADR-0006). This is where the agent first supplies a `ReproSpec`, and where the
ordering invariant from ADR-0008 has to become real: registration precedes the
agent seeing or writing the fix, provable from the log by seq.

**3c · egress control**
One authenticated channel out, the model API and nothing else. Deliberately last
because it is the easiest to verify once the first two exist and the hardest to
develop against.

## Decisions this milestone must make

- **Docker-in-Docker — decided in M3.1: no docker client in the sandbox.**
  Mounting the host socket hands a container full control of the host daemon,
  which is the opposite of what this milestone is for; privileged DinD weakens
  the isolation being built. The sandbox carries git, node and a shell and
  nothing else, so a repo whose own setup needs Docker is **refused** rather
  than granted a path back out to the host daemon.
  That refusal is the reproduce-first gate working, not a gap: "we could not
  stand this repo up" is a Tier 3 info-request, which ADR-0007 already treats as
  a real deliverable. Revisit against a named repo we actually care about, so the
  cost is paid deliberately rather than by default.
- **How the repo enters the sandbox — decided in M3.1: mounted read-only, cloned
  inside.** Verifying in the mount would put host state into the evidence and
  give the run a path to write back out through it. The mount is `:ro` and the
  Runner clones out of it, so the tree under test is the sandbox's own.
- **Where the blob store lives — decided in M3.1b: a host directory bind-mounted
  at `/blobs`, written by the Runner as root.** The evidence has to leave the
  container, and this is the narrowest way: no attacker-controlled string ever
  reaches a blob path, because `put()` derives every filename from
  `sha256(content)` computed inside itself. One directory, hash-named files,
  trusted writer — categorically unlike the host writes M2 was doing. The Runner
  refuses to start if `/blobs` is not a mount point, since otherwise a forgotten
  flag yields a complete, plausible event stream whose artifacts die with `--rm`.
  A named volume was rejected (same trust boundary, needs a second container to
  read back); base64 down the event channel was rejected (unbounded
  attacker-influenced data through the one path that must stay parseable). This
  mount is the local stand-in for the S3 adapter `blobs.ts` already anticipates.
  Blobs are written to a root-owned staging directory in the container layer and
  moved across only once the repro has run for the last time: a bind mount does
  not honour container permissions — Docker Desktop ignores them, and on Linux
  the host uid is usually 1000, the uid the repro runs as — so an exposed store
  lets the fix phase delete what the base phase banked while the stream still
  comes out clean. The mount must also carry a sentinel file: `st_dev` proves a
  different filesystem, not a durable one, and an anonymous volume passes that
  test and then dies with `--rm`.
- **Git state lives outside the worktree — decided in M3.1b.** `chown`ing the
  repo to the repro user handed it `.git`, so it could plant a
  `post-checkout` hook that `git clean` never descends into and the Runner then
  executes **as root** — which defeated the uid boundary entirely, including
  M3.1's event-channel guarantee. The clone uses `--separate-git-dir` and every
  engine git call carries an explicit `GIT_DIR`, so the `.git` file left in the
  worktree is never consulted.
- **Dependency install.** Deferred from M2 with no answer: a reproduction that
  needs a package the base commit lacks is currently unrunnable. The sandbox is
  where a `setupCommand` would live if we add one.

## Not in this milestone

Adapters (Slack, GitHub, CLI) · SSE · the dashboard · cloud runners · the
Next.js demo app · `RUN_ENDED`/tier/confidence, which stay as M2's 3b and 3c and
land whenever they are convenient.

## What "done" looks like

A run that starts from a `ReproSpec` and a repo, executes entirely inside a
container, and emits the same event stream the fold already understands — with
the host's filesystem untouched and provably so.
