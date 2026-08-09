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

That ordering invariant belongs to **3b.2**, not 3b.1. In 3b.1 the agent runs
first and every `AGENT_MESSAGE` carries a lower seq than `REPRO_REGISTERED`,
because the repro still comes from the Job rather than from the agent.

Split in two once the supervision mechanics turned out to be a whole subject:

- **3b.1 — supervision, and the isolation that makes it safe.** Spawn, bound,
  translate. Review of this step found that the agent needed no forged event to
  fabricate a verdict — sharing a filesystem with the phases was enough — so
  each participant now gets its own clone, `TMPDIR` and `HOME`, and the
  verification tree is cloned only after the agent has finished
  ([ADR-0010](adr/0010-the-environment-is-part-of-the-evidence.md)). `AGENT_MESSAGE` carries the
  raw line by `sha256:` ref and the `claimed_type` the stream asserted;
  `AGENT_FINISHED` records how it ended, so a truncated transcript can never
  read as a complete one. The agent gets no stdin, runs as the repro user, and
  every line is re-serialised through `JSON.stringify` on its way into a payload
  — so a message shaped like a `RunEvent` lands inside a string and stays there.
  No output schema is imposed: `claude` has a `--json-schema` flag and not using
  it is the point (Q7, "loose agent, strict judge"). Tested against a fake
  `claude` on `PATH`, which is the only way to exercise hostile output — a
  forged event, a line that never ends, ten thousand messages — that a real
  agent will not produce on demand.
- **3b.2a — the gate.** Landed. The orchestrator emits `ATTEMPT_STARTED` and
  `RUN_ENDED`, and refuses to run the fix container at all unless the base run
  demonstrated the bug (ADR-0007). The decision is read off the fold's
  `shownOnBase` rather than worked out in the producer — a second definition of
  "did it reproduce" is exactly what ADR-0009 forbids, and this projection has
  been bitten by that once already.

  It also closed a quiet gap: nothing had ever emitted `ATTEMPT_STARTED`, and
  the fold refuses to credit runs at attempt 0. Every sandbox test prepended one
  by hand, which meant real Runner output, folded as-is, could never have been
  credited at all.
- **3b.2b — the agent supplying the `ReproSpec`.** Landed, bar bounded attempts.
  The agent's tree is discarded, so its reproduction arrives as a commit: a
  manifest at `.engine/repro.json` NAMES a command and paths, and the engine
  reads those bytes out of the commit itself and applies them over both
  checkouts. A manifest hash would be testimony wearing an evidence event's
  shape (ADR-0006), so the format has nowhere to put one.

  ADR-0008's ordering invariant is now a fact about the log rather than an
  intention: the fix agent is deferred until after the base container emits
  `REPRO_REGISTERED`, so registration provably precedes the fix agent's first
  message by seq. It also means the gate stops the fix agent being spawned at all
  on a bug that was never shown, which the earlier ordering could not do.

  **The reproduction's COMMAND is now attacker-controlled, and that is a new
  class.** Everything before it anchored what the reproduction is made of; a
  command can read what commit it is running on. The repro agent knows base's
  tree exactly — it is the tree in its own clone — so it can write a test that
  hashes the tree and fails only when that hash is base's: red on base, green on
  a fix that changes nothing, byte-identical across phases, deterministic, no
  abort. Tier 1 for a no-op fix, measured.

  The countermeasure is a negative control, not another anchor: a sham fix. An
  unrelated file is committed on top of base and the reproduction runs again —
  the bug is untouched, so a reproduction of the bug must still fail. It runs
  only when the agent authored the reproduction.

  **Its limit, and the decision that follows.** Six successive VERSIONS of this
  control were defeated. The sixth fell to six ORACLES at once — five keyed on
  base and one keyed on the fix — and the same review showed it convicting honest
  reproductions at a rate that depended on a random draw — any bug whose honest assertion is monotone in file
  content (non-empty, minimum length, must-differ-from-template) is satisfied by
  both shams.

  So the control is ADVISORY: it records what it saw and ends nothing. What
  withholds the claim is the tier — an agent-authored reproduction is capped at
  Tier 2, independence unverified — which does not depend on any sham working.
  Diff-coverage remains the measurement that would settle it.

  Bounded attempts remain, and `handedOver` must become per-attempt with them.

  **The last hole in the authorship check is closed, and not by the check.** The
  agent's container used to clone the whole repository, so wherever a fix already
  existed — another branch, the repo's own HEAD, `plan.fixRef` — the agent could
  check it out, add one whitespace byte, and hand over a commit whose content was
  genuinely new and whose work was entirely inherited. Base red, fix green, Tier
  1, and the diff naming the right files. No content-based check can see that: the
  fix IS in the tree, and the agent DID author the commit on top of it.

  Five rounds of trying to recognise inherited work from its content each ended
  with an escape one byte wide. So the capability was removed instead: the agent
  clones a source holding base's ancestry and nothing else, built by
  clone-then-strip-then-prune, and a commit that is not in the object store cannot
  be checked out, cherry-picked, merged or reset to. The content checks stay as a
  second line for what this cannot cover — a repository whose base ancestry
  already contains the fix. Bounded attempts belong here too — retrying is only meaningful once a
  later attempt can propose a different reproduction. The image gains a real
  `claude` here; until then the sandbox tests mount a hostile fake, which proves
  the boundary without the weight.

**The isolation is not finished.** Four review rounds on 3b.1 each defeated the
previous round's fix, and [the M4 scope](milestone-4-isolation.md) is the
structural answer — it has to land before 3b.2 hands the agent authorship of the
`ReproSpec`.

**The PHASE containers have no network at all; the agent's is still
unrestricted.** The half that needs nothing is closed: `--network none` on base
and fix, so the code under judgement can neither exfiltrate the repository it was
handed nor be TOLD what to answer — a reproduction that can reach the network is
an identity oracle over a wire instead of over the tree, which is ADR-0008's
amendment in another medium. It also forecloses dependency install, which M3
already refuses; a `setupCommand` will need its own network decision rather than
inheriting this one.

The agent still reaches anything it likes, because it needs the model API and
nothing yet distinguishes that from the rest of the internet. That is the
remaining half of 3c and it is the harder one: it wants an authenticated proxy
the container is forced through, not a flag.

**3c · egress control**
One authenticated channel out, the model API and nothing else. Deliberately last
because it is the easiest to verify once the first two exist and the hardest to
develop against.

- **3c.1 — the phases have no network.** Landed. `--network none` on every
  container that is not the agent's, asserted by a test that fails when the flag
  is removed (the phase container resolves `api.anthropic.com` without it).
- **3c.2 — the agent's one channel.** Still to come. A flag cannot express "the
  model API and nothing else"; it needs a proxy the container is forced through,
  holding the credential the agent never sees.

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
Next.js demo app · tier/confidence, which stay as M2's 3c.

M2's 3b landed after M3.1 rather than before it: the abort path only became
worth building once a run could die inside a container, where an empty channel
is all a caller sees. `RUN_ENDED` itself is vocabulary until the attempt loop in
3b below emits it.

## What "done" looks like

A run that starts from a `ReproSpec` and a repo, executes entirely inside a
container, and emits the same event stream the fold already understands — with
the host's filesystem untouched and provably so.
