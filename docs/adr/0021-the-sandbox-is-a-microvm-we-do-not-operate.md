---
status: accepted
---

# The sandbox is a microVM we do not operate

[ADR-0019](0019-who-writes-when-the-runner-is-not-ours.md) put the engine on hardware the
user owns because a laptop cannot receive a webhook and a product needs an address. That
was the right split and the wrong end state: nobody installs a daemon and Docker to have a
bug fixed, and a runner that lives on a laptop can only be demonstrated from that laptop.
Milestone 10 removes the laptop. This ADR says what replaces it and what that costs.

The research behind it is [milestone-10-substrate.md](../milestone-10-substrate.md); the
spike that made it `accepted` is [milestone-10-spike.md](../milestone-10-spike.md).

## The spike, and what it corrected

Thirteen things the substrate had to be shown to do were run once against a real account
on 2026-09-06: 32 PASS, 3 FAIL, every FAIL a design input rather than a reason to fall back.
Four of its findings correct sentences below, and are left standing in the text with these
corrections beside them:

- **`deny-all` is a terminating proxy for TCP and a drop for UDP**, not a packet filter. A
  raw `connect()` to `1.1.1.1:53` succeeds; nothing the connection carries reaches the
  destination, TLS is reset, a UDP query is never answered. Sealed in substance, and the
  probes that prove it exchange data rather than stopping at `connect`. The flip on a
  running sandbox took effect within 351–2,029 ms, with a loopback server surviving.
- **A snapshot expires in no less than a day** — `expiration` must be 0 or ≥ 86,400,000 ms.
  The six-hour snapshot below is a one-day snapshot deleted explicitly.
- **The SDK's `networkPolicy` and `status` getters are stale** after a flip and after a
  session ends. The executor records the policy it set and lets the post-flip probe be the
  evidence; it reads neither getter.
- **Re-attaching to a command's stream is a replay, not a resume**, and the managed image
  runs as uid 1000 with dash and no `procps`. One `logs()` iterator is held for a phase's
  whole life, with mirrored results as the recovery path; the Runner is started with `sudo`
  or the paths are made writable first.

And the numbers the decision rests on: a sealed phase boots from a 338 MB snapshot in
504 ms; cold start is 0.9 s from the image and 1.2 s from a snapshot; this project's own
alpine agent image runs under Firecracker and answers CDP; `stop()` reports plausible
active-CPU. The one criterion that failed as measured — `runCommand` p50 of 332 ms — was
measured from a laptop in Mumbai to `iad1`; the worker lives in `iad`, and 10e records the
in-region number.

## Decision

**Every phase of a run executes in a Firecracker microVM created for that run and destroyed
when it ends, on Vercel Sandbox.** Nothing long-lived executes a stranger's code. The plane
still mints the run id and writes no events; the worker that drives the sandboxes is the
single producer ADR-0009 requires and ADR-0019 re-established as a check, and it is ours
again.

Four properties are the reason, in the order the criteria were ranked:

1. **Egress is denied by the substrate, including DNS, from outside the VM**, and the
   policy can be changed on a running sandbox. So the agent sandbox's lifecycle becomes:
   replay the recipe with the registry reachable → snapshot → set `deny-all` → start the
   agent. **The agent runs its entire session with no network route.** That is the
   precondition [ADR-0017](0017-environment-secrets-and-the-network-that-has-to-close.md)
   named for injecting a secret, met by a policy flip rather than by a pre-warmed image.
2. **A kernel per phase.** The four adversarial rounds that ended in
   [ADR-0014](0014-long-lived-services-and-named-shells.md) fought a shared filesystem at
   the container boundary. Base, fix and the agent now share nothing but a snapshot id.
3. **The snapshot is 7e.** `snapshot()` on the build sandbox after `install`, `migrate`,
   `seed`; base and fix are created from that snapshot with `deny-all`. The security
   argument is unchanged: those bytes existed before any agent did. (Measured: 3.2 s to
   snapshot 338 MB, 504 ms to boot a sealed phase from it.)
4. **No credential shares a machine with a stranger's code.** The loop, and the model key
   it holds, run in a worker that is ours — ADR-0011's "outside" is now a machine in `iad`
   rather than the host that owns a Docker socket — and every sandbox is `deny-all`, so
   nothing inside one needs a credential and nothing inside one could use it. The
   firewall's credentials brokering (a header attached at egress, never present inside) is
   what Topology A would have needed; here it is held in reserve for the day an
   allowlisted third-party call is wanted.

## What this stops claiming

ADR-0006's milestone-9 amendment — evidence is scoped to *"this installation's runner
observed"* — **reverses**. The observer is ours again: the worker that reads exit codes and
hashes outputs is a process this project runs, on machines it provisions and destroys, so
"the engine executed this" is true again and the attestation question that amendment opened
closes. (The isolation beneath it rests partly on a vendor's firewall — see below — which
is a different claim, and priced separately.)

## What this starts owing

- **A worker in `iad`.** Vercel Sandbox has no Asian region and the plane is in `sin`. The
  exec round-trips of Topology B cross the Pacific unless the worker sits beside the
  sandboxes. The worker is the M9 runner with an `Executor` behind it; where it runs is a
  deployment fact, not an architecture one.
- **An `Executor` seam that does not exist.** `orchestrate.ts` reaches Docker at 9 call
  sites (7 `execFile`, 2 `spawn`), mounts 5 host paths, and seals with one `--network none`
  — and there is no `docker exec`: every container is driven over the stdio of a single
  `docker run -i`, so the seam is a phase, not a primitive. 10b extracts the interface with
  Docker as its only implementation and the suite green; 10d implements it on Vercel. The Docker implementation stays:
  it is what the suite runs against without a Vercel credential, and it is the local path.
- **A provider dependency.** The engine's isolation claims now rest partly on a vendor's
  firewall. That is a real cost and the README will say so: the claim becomes "denied by
  Vercel's firewall outside the microVM", cited to their documentation, rather than "denied
  by a flag we pass to Docker". The Docker `Executor` remains the implementation whose
  every guarantee is ours.
- **Session bounds as run bounds.** 45 minutes on Hobby, 24 hours on Pro. 8a's wall clock
  is an hour *per container* (`CONTAINER_TIMEOUT_MS`), so on Hobby the session is the
  tighter ceiling, not the looser one; it becomes a second ceiling the fold must recognise
  as `errored`, never as a finding. Pro removes it.

## Rejected

- **Fly Machines**, where the plane lives: the API's `exec` has a 60-second hard timeout,
  there is no machine snapshot, and network-policy enforcement is documented with the
  caveat "test with direct IPs, not hostnames". Fly's own guidance for this workload is
  Sprites.
- **Fly Sprites**: packet-level egress enforcement outside the VM — the strongest
  statement of criterion 1 in the set — but exec timeouts, checkpoint-to-new-Sprite,
  Docker-inside and GA status are undocumented. Re-evaluate when they are not; the
  single-vendor argument is real.
- **E2B**: technically equivalent on every row; no credential brokering; Pro is $150/month.
  The runner-up, and the `Executor` seam is what keeps it one PR away.
- **Modal**: the best-specified network controls of the set, but gVisor rather than a
  hardware boundary, no Docker inside, and a Python-first SDK against a TypeScript engine.
- **Daytona**: per-sandbox deny-all is gated to Tier 3+ accounts.
- **Cloudflare Sandbox**: egress control is an HTTP(S) proxy; raw TCP and UDP are not
  covered.
- **Self-hosted Firecracker**: exactly the guarantee, and a VMM host, an image pipeline, a
  jailer and an exec agent to build first. The BYOC story, if there is ever one.
- **Topology A only** (the existing runner plus `dockerd` inside one VM per run): one to
  two weeks, hosted, and the right first spike. Rejected as the *end state* because it keeps the agent
  on a network route during its session, keeps one kernel under every phase, and keeps
  `docker commit` where a snapshot should be. It stays the fallback if the seam slips.

## Consequences

- A new event class, `ENV_BUILT`, records the image reference and the snapshot id the
  phases ran from ([ADR-0010](0010-the-environment-is-part-of-the-evidence.md)). Not a
  field on `ENV_READY`: that event is the *agent* sandbox's replay, a different sandbox,
  and `SANDBOX_CREATED` — typed, folded, and never emitted — is not an optional field
  either.
- ADR-0017's "done when" gains a second satisfying condition: the agent sandbox's policy is
  `deny-all` before `AGENT_MESSAGE` seq 1, observable in the log.
- The README's "Two credentials, and where they are not" gains a third: the model key,
  which is in no sandbox — it lives only in the worker, as the App key lives only in the
  plane.
- Cost is a projection like everything else: active-CPU seconds and GB-hours per sandbox
  are recorded per phase and folded into what a run cost (M6).

## Amendment (10d): what the executor actually depends on

The executor is written against a seven-verb interface (`src/vercel-client.ts`), not
against `@vercel/sandbox` — which appears in exactly one function, behind a dynamic
import, so the engine still loads on a machine that has never installed it. Three
consequences of that shape are decisions rather than style:

- **`@vercel/sandbox` is the only new runtime dependency, and it is optional at import
  time.** A Docker-only runner never resolves it. The whole test suite for the Vercel path
  runs with no token, no network, and no SDK.
- **Nothing reads the SDK's `networkPolicy` or `status`.** The spike found both are the
  value this process last sent rather than the value the platform holds — after a live
  flip the field lagged, and after a session ended `status` still said `running`. A guard
  written against either would be a guard against our own cache. So the interface has no
  method to read one, and the seal is established by running two data-exchanging probes
  inside the sandbox and recording what they found (`SANDBOX_SEALED.probe`).
- **Every sandbox is probed, not only the agent's.** The argument above — the policy you
  sent is not the policy the platform holds — applies hardest to the containers that
  judge. The agent's sandbox is the one ADR-0010 says "is not contained, and it no longer
  needs to be"; base and fix are the opposite, and their output IS the evidence. A
  `deny-all` the platform accepted and failed to apply on a base sandbox would produce a
  reproduction that could have been told what to answer, and nothing else in this design
  would notice. So a judging phase is probed before it is given the source or the Job.
- **A probe that still reaches the network refuses the phase.** Refuses by RETURNING,
  though. Throwing unwound the whole run — `orchestrate()` accumulates events locally and
  returns them at the end — so an exception from the fix agent's phase discarded the
  attempt, the registration and every base observation. The design has a name for this
  outcome (`SANDBOX_SEALED` with `probe: true`, and `cause: 'environment'`, which
  disqualifies the attempt and ends the run `errored`), and `Executor.runPhase` must not
  throw for an outcome the design has a name for.

Two costs this adds, named rather than left to be discovered:

- **The transport is not resumable.** Re-attaching to a detached command's output replays
  a window and then closes (spike item 5), so a stream dropped mid-phase cannot be picked
  up where it left off. `runner-vm.ts` mirrors every reply to `<spool>/out/<id>.json` for
  that reason; the events themselves are durable in the plane once appended.
- **A phase now has two ceilings.** Ours, enforced by the process driving it, and the
  platform's session timeout, enforced with that process dead. `PhaseResult.ceiling`
  reports the first; the second cannot be reported by a process that is dead, and what
  surfaces then is a stream that ends and a sandbox the boot sweep finds.
  `VERIFICATION_ABORTED{cause:'ceiling'}` puts ours in the log — where the fold
  disqualifies the attempt, because a comparison cut short mid-observation is half a
  comparison and must not be credited with a reproduction.
- **The host cannot write the spool, and that is the point.** `writeFiles` runs as uid
  1000 — the uid the repro drops to — so there is no ownership that lets the host write a
  spool the agent cannot. Tool calls therefore go in base64 inside a `sudo tee`, one round
  trip, the same cost the file write would have been. The spool stays root-owned 0700, so
  the agent cannot forge `{done: true}` and choose its own ending.
- **The in-container agent is not available here, and is refused rather than degraded.**
  `agentPrompt` runs the loop inside the sandbox — a model credential in there, and a route
  to the model API for the whole session, which is what [ADR-0011](0011-the-agent-loop-runs-outside-the-sandbox.md)
  moved out and what this ADR says is in no sandbox at all. It also has no `{ready}`
  handshake, so there is no moment at which the executor could close the route: the agent
  would run its whole life with a way out and nothing in the log would say so. Docker keeps
  that path because the suite still drives it. This executor supports the ADR-0011 topology
  only, and throws for the other.
- **`SANDBOX_SEALED` names which sandbox it is about.** Once every sandbox is probed, a
  base phase's seal sits in the log before the next agent speaks — and the fold's
  `sealedBeforeAgent` is a question about AGENTS. Without the `phase` field it answered
  `true` for an agent nobody had sealed.
- **`sweep()` is scoped to one worker.** It reads this worker's ledger and a tag carrying
  this worker's identity. A tag shared across a deployment would turn one booting worker
  into an outage for every other one.
