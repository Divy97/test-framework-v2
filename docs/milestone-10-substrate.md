# Milestone 10 — where the sandbox runs when the machine is not ours

status: research complete · decision proposed in [ADR-0021](adr/0021-the-sandbox-is-a-microvm-we-do-not-operate.md)
researched: 2026-09-05, from each provider's current documentation (sources at the end)

## The question

Milestone 9 split the product into a plane GitHub can always reach and a runner on
somebody's laptop. Milestone 10 removes the laptop: **one sandbox per issue**, created when a
person presses the button, destroyed when the run ends. This document answers *which*
sandbox — and it answers against this engine's requirements rather than against a feature
list, because the claims the README makes are exactly the things a substrate can take away
without anybody noticing.

## Criteria, in priority order

1. **Egress kill enforced by the substrate.** Outside the VM, not by code inside it. This
   is ADR-0011 and ADR-0017's shape: not "which hosts can this reach", but "can this reach
   anything at all".
2. **Per-run ephemeral.** Created for one run, destroyed after. Nothing long-lived.
3. **Cold start and image build, per run.** With nothing long-lived, this is paid every
   time.
4. **Snapshot or image commit from a running sandbox.** The 7e path: install once, judge
   from that image, `--network none` intact, nobody around to plant anything.
5. **Exec-into via API with no per-command cap.** The loop stays outside (ADR-0011).
   `npm install` and a test run exceed a minute routinely.
6. **Headless Chromium inside.**
7. **Docker inside.** Keeps Topology A open (below).
8. **Cost per run.**

## Two topologies, because "cloud sandbox" names two different projects

**A — the runner in a microVM.** One VM per run. Inside it: the existing runner, `dockerd`,
and the engine unchanged. Phase containers keep Docker's `--network none`; the VM's own
firewall allows only the model API, GitHub, the package registries `install` needs, and the
plane. Effort: 1–2 weeks — a launcher that creates the VM from an image this repository
builds, hands it a job, and destroys it. What it buys beyond hosting: the `:latest`
staleness that killed the first real delivery cannot recur, because the VM image *is* the
build. Where the provider brokers credentials, the model key never enters the VM at all —
a stronger claim than the laptop runner makes.

**B — the executor seam.** The loop runs in a worker outside; every phase is its own
provider sandbox with egress denied; the 7e build becomes a provider snapshot. Effort: 3–4
weeks — `orchestrate.ts` reaches Docker at 9 call sites (7 `execFile`, 2 `spawn`), mounts
5 host paths, seals with one `--network none`, and drives every container over the stdio
of a single `docker run -i`; there is no interface and no `docker exec` to swap for an API
call. What it buys beyond A: **a kernel per phase**, which
closes at the VM boundary the shared-filesystem class the four adversarial rounds fought at
the container boundary; and **an agent sandbox with no network route for its whole
session** — replay the recipe with the registry reachable, snapshot, flip the policy to
deny-all, *then* start the agent. That is ADR-0017's precondition met by a policy change
rather than by the pre-warmed image the ADR proposed.

Both are measured below. A provider that cannot do A loses criterion 7; one that cannot do
B loses 4 or 5.

## The candidates

| | Egress kill (1) | Ephemeral (2) | Cold start (3) | Snapshot (4) | Exec, no cap (5) | Chromium (6) | Docker inside (7) | Cost (8) |
|---|---|---|---|---|---|---|---|---|
| **Vercel Sandbox** | ✅ `deny-all`, incl. DNS, live-updatable | ✅ | ✅ "milliseconds" | ✅ `snapshot()` → `source.snapshot` | ✅ `runCommand`, none | ✅ custom OCI image | ✅ documented, `sudo` | $0.128/CPU-h *active*, $0.0212/GB-h |
| **E2B** | ✅ `allowInternetAccess:false` ≡ deny 0.0.0.0/0 | ✅ | ⚠️ not stated; ~1 s resume | ✅ fs + memory | ✅ | ✅ template | ✅ documented | ~$0.05/vCPU-h, $0.016/GiB-h; Pro $150/mo |
| **Modal** | ✅ `block_network=True` | ✅ | ✅ sub-second | ✅ `snapshot_filesystem()` GA | ✅ `sb.exec()` | ✅ image | ❌ gVisor, not offered | ~$0.07/vCPU-h, $0.024/GiB-h |
| **Fly Sprites** | ✅ packet-level, raw IP blocked | ✅ | ⚠️ 1–12 s cold, <1 s warm | ⚠️ checkpoint/restore; new-Sprite-from-checkpoint undocumented | ⚠️ `exec`, cap undocumented | likely | ⚠️ undocumented | $0.07/CPU-h, $0.044/GB-h (unverified) |
| **Fly Machines** | ⚠️ policies; enforcement point unclear; "test with IPs, not hostnames" | ✅ `auto_destroy` | ⚠️ create 10–20 s | ❌ none | ❌ **60 s hard cap** | ✅ | ⚠️ community `docker-daemon` only | not evaluated |
| **Daytona** | ❌ `networkBlockAll` exists but **Tier 1–2 cannot set it per sandbox** | ✅ | ✅ <90 ms | ✅ | ✅ | ✅ | not stated | $0.05/vCPU-h, $0.016/GiB-h |
| **Cloudflare Sandbox** | ❌ HTTP(S) proxy only; TCP/UDP not covered | ✅ | not stated | ⚠️ ephemeral by default | ✅ `exec()` | ✅ | not stated | per-10 ms; Workers Paid $5/mo |
| **Self-hosted Firecracker** | ✅ no tap device | ✅ | you build it | you build it | you build it | ✅ | ✅ | a host, and weeks |

### Vercel Sandbox — Firecracker microVM, GA 2026-01-30

The only candidate that scores on every row without a caveat, and the one whose firewall
is designed around the exact threat this project names.

- **Egress.** Three modes, updatable on a running sandbox without a restart: `allow-all`,
  `deny-all` — *"Denies all outbound network access, including DNS"* — and user-defined
  allowlists by domain (SNI) or CIDR, with the documented warning that an empty policy
  *behaves as* `deny-all`. The install-then-lock pattern is a named use case: *"Start with
  Internet access, get required data, lock access and start untrusted process."*
- **Credentials brokering.** A `transform` rule attaches a header at the firewall: *"The
  secrets never enter the sandbox, so code running inside it cannot exfiltrate them."* Under
  Topology A this means the loop calls the model API with no key in the VM.
- **Snapshot.** `sandbox.snapshot()` captures a running sandbox's filesystem and shuts it
  down; `Sandbox.create({ source: { snapshot: { snapshotId } } })` starts from it;
  `Sandbox.fork()` clones. This is 7e's `docker commit`, native.
- **Exec.** `runCommand({ cmd, args, cwd, env, sudo, detached })` returns `exitCode`,
  `stdout()`, `stderr()`, `durationMs`; *"No per-command timeout option"* — the session is
  the bound (45 min Hobby, 24 h Pro, extendable).
- **Docker inside.** *"Container runtimes: Run Docker and other container engines inside the
  sandbox"*, with `sudo`; inner containers do not inherit the proxy CA (irrelevant under
  deny-all, relevant if a `transform` rule is in play).
- **Images.** Any OCI image from Vercel Container Registry; `Ubuntu 26.04` default.
- **Who runs on it.** *"Each Devin session runs on Vercel infrastructure in a dedicated
  Vercel Sandbox Firecracker microVM."* v0's VM-backed chats run on it.
- **Caveats.** Regions are `iad1`, `sfo1`, `cle1`, `cdg1` — no Asia; the plane is in `sin`.
  For B the exec round-trips cross the Pacific, so the worker belongs in `iad`. Domain
  allowlists match SNI and the docs name domain fronting as a limit — irrelevant under
  `deny-all`, relevant to A's allowlist. Hobby caps a session at 45 minutes and 10
  concurrent sandboxes; Pro is $20/month of credit.

### E2B — Firecracker microVM (per third-party sources; E2B's own docs do not name it)

Equivalent to Vercel on rows 1–7 and the strongest alternative. `allowInternetAccess:
false` is documented as *"equivalent to setting `network.denyOut` to `['0.0.0.0/0']`"*,
firewall-enforced. Snapshots capture *"filesystem and memory"*; pause/resume preserves
running processes. Templates are built with a Template SDK (`.fromBaseImage()`,
`Template.build()`), and *"running Docker containers as part of the setup"* is explicitly
supported. Two things kept it second: no credential brokering, and the plan shape — Hobby
is a one-time $100 credit with 1-hour sessions; Pro is $150/month. One gap in the docs:
under *domain* filtering *"the default nameserver 8.8.8.8 is automatically allowed"*, a DNS
channel; whether full deny closes it is not stated.

### Modal — gVisor

The best-specified network controls of the set: `block_network=True` *"Drops all outbound
traffic"*, blocked connections *"securely blocked and logged to the Sandbox's system output
stream"*, plus CIDR and (beta) domain allowlists. `snapshot_filesystem()` is GA and feeds
straight into `Sandbox.create(image=…)` — the 7e path with no translation. Eliminated on
two rows that are not about quality: **no Docker inside** (gVisor is a user-space kernel;
nested runtimes are not offered), so Topology A is impossible; and the SDK is Python-first
with Node support described by third parties as limited, against a TypeScript engine. The
isolation is a user-space kernel rather than a hardware boundary — the technology Google
Cloud Run uses, and a legitimate choice, but one boundary weaker than the rest of this
table for the specific job of running a stranger's issue.

### Fly Sprites — Firecracker microVM, Fly's own answer

The right Fly product — Fly's agent-sandbox guidance now points here, not at Machines. The
firewall is the strongest statement in the set: *"Enforcement lands at the packet level
rather than at the name lookup… Code that skips DNS and dials a raw IP doesn't get out
either."* Policy is *"readable from inside the Sprite and only writable from outside it."*
Checkpoint and restore are copy-on-write and sub-second. What kept it off the top: the docs
this project needs are the ones missing — `exec`'s timeout behaviour, whether a checkpoint
can seed a *new* Sprite (base and fix need to run from one checkpoint in parallel), Docker
inside, and GA status. Pricing and cold-start numbers here are from third parties. The
single-vendor appeal is real, since the plane already lives on Fly; **re-evaluate when
the docs answer those four questions.**

### Fly Machines — eliminated on 4 and 5

Machines are Firecracker VMs with `auto_destroy`, and the plane runs on one. But the
Machines API `exec` endpoint has a **60-second hard timeout** (`deadline_exceeded`),
background processes are a known problem, there is no machine snapshot — volumes only — so
7e means pushing an image to a registry from inside the VM, and the network-policy docs
say *"test with direct IPs, not hostnames"* and require a restart after policy changes.
Docker inside is possible (`fly-apps/docker-daemon` is a dockerd running in a Machine) but
not a supported pattern. Fly's own guidance for this workload is Sprites.

### Daytona — eliminated on 1

`networkBlockAll: true` exists and is platform-enforced, but *"Tier 1–2 organizations cannot
override network policy at sandbox level"* — a new account cannot deny egress per sandbox,
which is the first criterion. One third-party source reports the codebase went closed in
June 2026; unverified and not load-bearing here.

### Cloudflare Sandbox SDK — eliminated on 1

Egress control is an HTTP(S) transparent proxy via Outbound Workers (`allowedHosts`,
`deniedHosts`, `setOutboundHandler`), enforced *"in the Workers runtime, outside the
sandbox"* — good design, wrong scope: raw TCP and UDP are not covered by anything in the
docs. The credential-injection pattern is the same idea as Vercel's brokering.

### Self-hosted Firecracker — not for M10

Exactly `--network none` (no tap device), full control, the story if BYOC is ever the
product. It is also a VMM host, an image pipeline, a jailer, a snapshot service and an exec
agent, all of which the providers above sell. Named so that it is a decision, not an
omission.

## Recommendation

**Vercel Sandbox.** It is the only candidate with no caveat on any row; its `deny-all`
denies DNS and is enforced outside the microVM; its snapshot is 7e without translation;
credentials brokering is there for the day an allowlisted third-party call is wanted; the
SDK is TypeScript; and a shipping coding agent (Devin) runs one microVM per session on it.
Firecracker per sandbox is what AWS Lambda, Fargate, Fly, E2B and Sprites also use — it is
the category default for untrusted agent code, and deny-all-plus-brokering is the 2026
pattern that both Vercel and Cloudflare ship.

**Topology B**, with A as the fallback if the seam slips. B is the design the criteria
were written for: a kernel per phase, and an agent that runs its entire session with no
network route because the recipe was replayed and snapshotted before it existed. That
second property is what unblocks the environment-secrets form (ADR-0017) inside M10, and
it is the sentence to defend in an interview. A remains one week of work at any point, and
is the right first spike regardless — it proves the provider end to end before a line of
the seam is written.

**Runner-up: E2B**, equivalent on every technical row, behind on brokering and plan shape.
**Watch: Sprites**, for single-vendor simplicity, once its docs cover exec timeouts,
checkpoint-to-new-Sprite and Docker.

## What a run costs

Vercel bills *active* CPU — *"Time spent waiting for I/O (such as network requests,
database queries, or AI model calls) does not count."* A run here is mostly I/O wait: the
agent waits on the model, the phases run for seconds. Estimate for the milestone-7 real run
(95 s of agent time, five phase executions, two suite runs, one install): roughly 6–8
minutes of active CPU and ~1.6 GB-hours of memory across the sandboxes, **≈ $0.05 in
compute** against $0.064 for the model. Hobby's 5 CPU-hours a month is ~40 runs free.
Creation is $0.60 per million.

## What this changes in the record

- **ADR-0021** (proposed): the sandbox is a microVM the project does not operate.
- **ADR-0017** amended: the precondition for injecting a secret becomes "the agent sandbox's
  network policy is `deny-all` before the agent's first turn", achievable by a policy flip
  after recipe replay, not only by a pre-warmed image.
- **ADR-0011** unchanged in substance: the loop stays outside; "outside" now means a worker
  in `iad` rather than the host that owns the Docker socket.
- **ADR-0006**'s milestone-9 amendment — evidence scoped to "this installation's runner" —
  **reverses**: the engine executes on infrastructure the project controls again, so the
  attestation question closes rather than opens.
- **ADR-0010**: the environment is part of the evidence — the snapshot id joins the image
  digest in `ENV_READY`.

## Sources

- Vercel Sandbox: [overview](https://vercel.com/docs/sandbox) · [concepts / isolation](https://vercel.com/docs/sandbox/concepts) · [firewall](https://vercel.com/docs/sandbox/concepts/firewall) · [snapshots](https://vercel.com/docs/sandbox/concepts/snapshots) · [SDK reference](https://vercel.com/docs/sandbox/sdk-reference) · [pricing](https://vercel.com/docs/sandbox/pricing) · [egress firewall on Hobby](https://vercel.com/changelog/full-sandbox-egress-firewall-now-available-on-hobby-plan) · [Devin Outposts on Vercel Sandbox](https://vercel.com/kb/guide/devin-outposts-vercel-sandbox)
- E2B: [internet access](https://docs.e2b.dev/sandbox/internet-access) · [sandbox lifecycle](https://docs.e2b.dev/sandbox) · [templates](https://docs.e2b.dev/sandbox-template) · [docs index](https://docs.e2b.dev/llms.txt) · [pricing](https://e2b.dev/pricing)
- Modal: [sandbox networking](https://modal.com/docs/guide/sandbox-networking) · [sandboxes](https://modal.com/docs/guide/sandbox) · [snapshots](https://modal.com/docs/guide/sandbox-snapshots) · [security (gVisor)](https://modal.com/docs/guide/security) · [pricing](https://modal.com/pricing)
- Fly: [Machines overview](https://fly.io/docs/machines/overview/) · [Machines API](https://fly.io/docs/machines/api/machines-resource/) · [network policies](https://fly.io/docs/machines/guides-examples/network-policies/) · [exec 60 s limit (community)](https://community.fly.io/t/extending-timeout-of-execute-command-machines-api-endpoint/26074) · [agent sandboxes → Sprites](https://fly.io/learn/agent-sandbox/) · [Sprites network policy](https://fly.io/run-agent-code/) · [docker-daemon on Fly](https://github.com/fly-apps/docker-daemon)
- Daytona: [network limits](https://www.daytona.io/docs/en/network-limits/) · [sandboxes](https://www.daytona.io/docs/en/sandboxes/) · [pricing](https://www.daytona.io/pricing)
- Cloudflare: [Sandbox SDK](https://developers.cloudflare.com/sandbox/) · [egress policies changelog](https://developers.cloudflare.com/changelog/post/2026-04-13-sandbox-outbound-workers-tls-auth/) · [limits](https://developers.cloudflare.com/sandbox/platform/limits/)
- Landscape: [Developers Digest comparison](https://www.developersdigest.tech/blog/ai-agent-code-sandbox-comparison-2026) · [Modal's roundup](https://modal.com/resources/best-code-execution-sandboxes-ai-agents) · [Northflank: Daytona vs E2B](https://northflank.com/blog/daytona-vs-e2b-ai-code-execution-sandboxes)
