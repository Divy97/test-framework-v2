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

- **Docker-in-Docker.** If the target repo's own setup is `docker compose up`, we
  are running Docker inside Docker. Mounting the host socket, real DinD, and
  requiring services to start in-container all have teeth. Flagged in M2 and
  deferred deliberately; 3a is where it gets answered.
- **How the repo enters the sandbox.** Clone inside, or mount a prepared
  checkout. Mounting is faster and leaks host state; cloning is slower and
  cleaner. Evidence integrity argues for cloning.
- **Where the blob store lives.** `blobs.ts` is already behind `put`/`get`, so
  this is an adapter choice, not a rewrite — but the container needs to write
  somewhere the host can still read.
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
