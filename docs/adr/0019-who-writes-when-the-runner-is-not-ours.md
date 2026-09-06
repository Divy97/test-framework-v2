---
status: accepted
---

# Who writes, when the runner is not ours

[ADR-0009](0009-what-a-producer-may-write-back.md) says the orchestrator is a trusted
writer and there is exactly one of it. [ADR-0006](0006-testimony-vs-evidence.md) says
the agent's transcript is testimony and the Runner's process-boundary observations are
evidence. Both are true today for one reason: **there is one process, on one machine,
and it is ours.**

"One writer" is not enforced anywhere in the data model. The events table is
`(run_id, seq, type, payload, ts)` with `unique (run_id, seq)` and no writer column at
all, and `appendEvent` is a bare INSERT with no authorization. The rule is a fact about
deployment topology.

Hosting removes the topology and leaves the claim standing. A paired runner is a binary
on hardware the user owns, reporting exit codes from containers we never see. This ADR
is about what survives that, and what has to stop being said.

## Decision

**1. Evidence is installation-scoped, and the product never presents it outside that
scope.** No public run pages, no shareable evidence links, no badges. A user can make
their runner report anything; what they get for it is a lie told to themselves about
their own repository. The moment one installation's verdict is shown to another, this
decision is void and attestation is required.

**2. The plane mints the run id and writes no events.** Dispatch lives in a `jobs`
table — configuration, like `installations` and `recipes` already are, not a fact about
a run. The first event of a run, `RUN_REQUESTED`, comes from the runner with everything
else, so the stream still has one author from seq 1. This is the specific thing that
keeps ADR-0009 intact: the plane decides that a run exists and who may write it, and
never becomes a second producer.

**3. A runner is authorized per RUN, not per installation.** Appending requires that
this run's job was dispatched to *this* runner. Two runners paired to the same
installation cannot write each other's runs — the writer of a run is the machine that
was given the work, which is ADR-0009's rule surviving the move off one machine.

**4. Appends are idempotent, and history is not.** The same `(run_id, seq)` with
identical content is a no-op returning success, because a runner on a home connection
will retry and an error there teaches operators to stop retrying — and what they would
lose is the evidence. The same seq with **different** content is refused. That is the
append-only claim made real against the one participant with a legitimate reason to
write here.

**5. The model credential never leaves the runner.** [ADR-0011](0011-the-agent-loop-runs-outside-the-sandbox.md)
survives verbatim: the loop runs where the containers run, which is now the user's
machine. The plane holds the GitHub App key and nothing else that spends money.

**6. Local mode stays.** `serve.ts` is unchanged and remains a complete, single-machine
product. The plane is additive.

## What this stops claiming

ADR-0006's sentence — *"verification facts only ever originate from the Runner's own
process boundary"* — is still true, and the word doing the work is now **whose**. On the
hosted path the honest form is *"this installation's runner observed"*. The engine
executed the command; we did not watch it happen.

That is a real reduction and it is written down rather than glossed, because a claim
that was true when written and made false by a later change is the exact failure this
project spent milestone 8 finding twice.

## Rejected

**Attestation — signed runner builds, pinned digests, remote attestation.** It is the
only thing that would let the plane claim verification it did not perform. Months of
work, and it buys nothing while every user is judging their own code. Revisit it the day
a public evidence link is proposed, and not before — the two decisions are the same
decision.

**The human's OAuth token as the runner's credential.** It is the personal access token
shape [ADR-0012](0012-the-github-app-and-where-the-token-lives.md) already rejected:
*"a PAT carries its owner's full access for as long as it lives."* A daemon that
reconnects at 4am with no browser needs a credential scoped to one installation and
revocable without logging a human out of anything. One human auth (OAuth); one machine
credential, minted because a human was OAuth'd.

**The plane writing `RUN_REQUESTED` itself.** It receives the webhook, so it is the
natural author — and it would put two producers on one aggregate, which is precisely
what ADR-0009 exists to forbid. The plane queues instead.

**A transaction around the batch append.** Rolling back three written events because a
fourth collided would delete observations that happened, to punish a client bug. And the
handle is a pool ([ADR-0020](0020-the-database-handle-is-a-pool.md)), so a `begin` and
its `commit` are not promised to reach the same connection. There is nothing to
serialise: one runner per run means the only concurrent writer is that runner retrying
itself.

## Consequences

- **Deletion becomes a tombstone.** Central blobs mean "delete this run" is a real
  request, and dropping bytes leaves events citing refs that resolve to nothing. A run
  whose evidence was deliberately destroyed must not render like one whose evidence was
  lost, so `forgotten` is a fold state to design, not an error to handle.
- **Presence is a fact with a timestamp.** `last_seen` distinguishes "no runner is
  online" from "no runner was ever paired" — different answers to a queued job, and a
  user waiting on a run deserves the right one.
- **A revoked runner keeps its row.** Its events are in the log forever, and a reader
  asking who wrote them deserves an answer after the laptop has been sold.


---

## Amendment (M10, 10e): the blast radius this ADR described is no longer the one we have

§1 argues the runner's dishonesty is survivable because *"a user can make their runner
report anything; what they get for it is a lie told to themselves about their own
repository."* That held while every runner was one user's laptop, confined to one
installation.

10e adds a runner that belongs to **no** installation — the worker we operate — and it is
one process that claims everyone's jobs, holds the agent loop and the model key
(ADR-0011), and is handed each job's installation token per call (ADR-0012). A compromise
of that process is not a lie a user tells themselves. It is every tenant's GitHub access
and every stored secret.

**What this does not change.** The plane still refuses what it always refused: a runner
may only write to a run dispatched to it (`appendFromRunner`), and `claimJob` still
confines a runner that names an installation. Nothing here widens what a *user's* runner
can reach, and no route reads a runner's installation to decide what a run may touch — the
job's row decides. The rule "the plane trusts no runner's word about which run it holds"
is intact and is what makes a global runner safe to add at all.

**What it does change** is who the operator is protecting, and from what. Concretely:

- The worker's token is the highest-value credential this system issues, and it must be
  revocable. It was not: `revokeRunner` compared `installation_id = $2`, which matches
  nothing for a null row, so no value revoked it. Fixed in 10e with
  `is not distinct from`, plus `scripts/unpair-worker.mts`.
- A global worker **competes** with a user's own paired runner for that installation's
  jobs. `claimJob` is plain FIFO — whoever polls first wins, and there is no way to
  express a preference. Nobody has decided whether that is right; it is written down here
  so the first person surprised by it finds the reason rather than a bug.
