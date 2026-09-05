---
status: proposed
---

# The sandbox is a microVM we do not operate

[ADR-0019](0019-who-writes-when-the-runner-is-not-ours.md) put the engine on hardware the
user owns because a laptop cannot receive a webhook and a product needs an address. That
was the right split and the wrong end state: nobody installs a daemon and Docker to have a
bug fixed, and a runner that lives on a laptop can only be demonstrated from that laptop.
Milestone 10 removes the laptop. This ADR says what replaces it and what that costs.

The research behind it is [milestone-10-substrate.md](../milestone-10-substrate.md).

## Decision

**Every phase of a run executes in a Firecracker microVM created for that run and destroyed
when it ends, on Vercel Sandbox.** Nothing long-lived executes anything. The plane still
mints the run id and writes no events; the worker that drives the sandboxes is the single
producer ADR-0009 requires, and it is ours again.

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
   argument is unchanged: those bytes existed before any agent did.
4. **No credential shares a machine with a stranger's code.** The loop, and the model key
   it holds, run in a worker that is ours — ADR-0011's "outside" is now a machine in `iad`
   rather than the host that owns a Docker socket — and every sandbox is `deny-all`, so
   nothing inside one needs a credential and nothing inside one could use it. The
   firewall's credentials brokering (a header attached at egress, never present inside) is
   what Topology A would have needed; here it is held in reserve for the day an
   allowlisted third-party call is wanted.

## What this stops claiming

ADR-0006's milestone-9 amendment — evidence is scoped to *"this installation's runner
observed it"* — **reverses**. The engine executes on infrastructure the project controls;
"the engine executed this" is true again, and the attestation question that amendment
opened closes.

## What this starts owing

- **A worker in `iad`.** Vercel Sandbox has no Asian region and the plane is in `sin`. The
  exec round-trips of Topology B cross the Pacific unless the worker sits beside the
  sandboxes. The worker is the M9 runner with an `Executor` behind it; where it runs is a
  deployment fact, not an architecture one.
- **An `Executor` seam that does not exist.** `orchestrate.ts` reaches Docker at 9 call
  sites (7 `execFile`, 2 `spawn`), mounts 5 host paths, and seals with one `--network none`
  — and there is no `docker exec`: every container is driven over the stdio of a single
  `docker run -i`, so the seam is a phase, not a primitive. The first PR of the milestone
  extracts the interface with Docker as its only implementation and the suite green; the
  second implements it on Vercel. The Docker implementation stays:
  it is what the suite runs against without a Vercel credential, and it is the local path.
- **A provider dependency.** The engine's isolation claims now rest partly on a vendor's
  firewall. That is a real cost and the README will say so: the claim becomes "denied by
  Vercel's firewall outside the microVM", cited to their documentation, rather than "denied
  by a flag we pass to Docker". The Docker `Executor` remains the implementation whose
  every guarantee is ours.
- **Session bounds as run bounds.** 45 minutes on Hobby, 24 hours on Pro. 8a's wall clock
  already bounds a run below that; the session timeout becomes a second ceiling the fold
  must recognise as `errored`, never as a finding.

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
- **Topology A only** (the existing runner plus `dockerd` inside one VM per run): one week,
  hosted, and the right first spike. Rejected as the *end state* because it keeps the agent
  on a network route during its session, keeps one kernel under every phase, and keeps
  `docker commit` where a snapshot should be. It stays the fallback if the seam slips.

## Consequences

- `ENV_READY` carries the snapshot id beside the image digest
  ([ADR-0010](0010-the-environment-is-part-of-the-evidence.md)).
- ADR-0017's "done when" gains a second satisfying condition: the agent sandbox's policy is
  `deny-all` before `AGENT_MESSAGE` seq 1, observable in the log.
- The README's "Two credentials, and where they are not" gains a third: the model key,
  which is in no sandbox — it lives only in the worker, as the App key lives only in the
  plane.
- Cost is a projection like everything else: active-CPU seconds and GB-hours per sandbox
  are recorded per phase and folded into what a run cost (M6).
