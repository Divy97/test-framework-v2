---
status: in progress
---

# Milestone 9 — the thing people can actually use

Milestone 8 closed milestone 7's list. This one starts from a different question, and it
was asked by a dead ngrok URL: the App had been installed for three weeks, GitHub had
**never delivered anything**, and the dashboard showed an empty repository list that was
entirely correct. A process on a laptop cannot receive an inbound webhook. Every user of
this engine would meet the same tunnel, and it would die the same way.

So the product needs a stable address, and the engine needs Docker and a machine. Those
are different requirements, and this milestone is the seam between them.

| | | |
|---|---|---|
| **9a** the runner dials out — pairing, dispatch, authorized append | built |
| **9b** blobs cross the boundary | built |
| **9c** GitHub OAuth, and the human surface | |
| **9d** the runner daemon | |
| **9e** deletion, as a tombstone rather than a hole | |

The decision behind all of them is
[ADR-0019](adr/0019-who-writes-when-the-runner-is-not-ours.md), and the one sentence
worth carrying: **the plane mints the run id and writes no events.** Everything else
follows from refusing to become a second producer.

## 9a · the runner dials out

`unique (run_id, seq)` and no writer column. `appendEvent` is a bare INSERT with no
authorization. Read that way, "one writer" was never enforced by this codebase at all —
it was enforced by there being one process, on one machine, and that is the mechanism
hosting removes.

So the rule becomes a check. `src/plane.ts` holds two tables and the whole of it:

- **`runners`** — a machine paired to an installation. The token is stored as a
  `sha256` hash and shown once, so a stolen database yields no runner credential; that
  is ADR-0012's reasoning about the App key, one layer down. Revocation is a timestamp,
  not a delete, because a revoked runner's events are in the log forever and a reader
  asking who wrote them deserves a row.
- **`jobs`** — one unit of work, and the `run_id` is minted **here**, before any runner
  sees it. That is what makes authorization possible at all: appending means proving
  this job was dispatched to you, and a runner that invents a run id matches no row.

Authorization is per **run**, not per installation. Two runners paired to the same
account cannot write each other's runs — the writer of a run is the machine that was
given the work.

### Two things the tests changed

**The batch append has no transaction, deliberately.** An append-only log has no
un-append: rolling back three written observations because a fourth collided deletes
facts to punish a client bug. And `pg.Client` is one connection shared by every request,
so a `begin` here interleaves with concurrent statements on the same wire — a bug that
would appear only under load, as events landing inside somebody else's rollback. Nothing
needs serialising, because one runner per run means the only concurrent writer is that
runner retrying itself.

**`jsonb` does not preserve key order**, and the idempotency test found it on its first
run. The retry check compared `JSON.stringify(round-tripped payload)` against the bytes
the runner sent — Postgres's normalisation against ours — so **every honest retry was
refused as an attempt to rewrite history**. The comparison is `payload = $3::jsonb` now,
done by the database that owns the representation.

### What is asserted

`test/plane.test.ts`, against a real database, because a boundary tested with a mocked
`query` is a boundary asserted against a fixture of my own writing. Every test is an
attempt to write somebody else's evidence:

- an unknown token, a missing header, and a **revoked** runner are nobody;
- a runner claims its own installation's job and leaves another installation's queued;
- two runners on one installation never take the same job (`for update skip locked`);
- **another runner, same installation, valid token, is refused and writes nothing** —
  the test this module exists for, and removing the authorization line fails it and
  nothing else;
- a replayed identical batch appends nothing and returns success;
- the same seq with different bytes is refused and the original stands;
- an event naming a different run inside an authorized batch is refused before it lands;
- five malformed batches are refused at the door rather than folded later.

### Landed ahead of its server, on purpose

Nothing calls `runnerRoutes` in production yet — the plane is a different deployment
with a different configuration (no Docker, no model key), and it arrives in 9c. The
precedent is [ADR-0017](adr/0017-environment-secrets-and-the-network-that-has-to-close.md)'s:
redaction was built before the secrets UI *"because the leak existed before any UI did."*
The trust boundary is the part of hosting that can be got wrong quietly, so it is the
part that lands first, tested, with its mutation control.

## 9b · blobs cross the boundary

Events are structural and small; blobs are the content — stdout, diffs, transcripts,
screenshots. Both go central ([ADR-0019](adr/0019-who-writes-when-the-runner-is-not-ours.md)),
because the evidence page **is** the product and one that degrades to *"artifact
unavailable — runner offline"* is not one. The privacy objection is weaker than it looks
here specifically: the engine already pushes a branch and opens a pull request, so the
content leaves the machine by design.

It was not in 9a for a mechanical reason. `Route`'s body was `() => Promise<string>`,
bounded at 256KB — a decoded string, which mangles a PNG, and a ceiling far below a
64MB stdout.

`Route` has `raw(limit)` now, returning `Buffer | null`. **`null`, never a truncated
buffer**, and that is the interesting half: the old reader stopped buffering at its
ceiling and returned what it had, so an oversized upload would have arrived as a
**digest mismatch** — an operational limit wearing a tamper signal's clothes, on the one
check in this system that is supposed to mean tampering. A route can now say "too large"
because it can tell.

**Named before stored.** `digest(bytes)` says what a body is; if that is not the ref the
runner claimed, nothing is written at all. Storing first and refusing afterwards is a
check that reports rather than one that holds — the bytes would already be on our disk,
under a name nobody asked for.

Uploads go **under the run** (`PUT /runner/runs/:id/blobs/:ref`) rather than to a bare
content-addressed endpoint. The store dedups by hash regardless, and routing through the
run makes it the same authorization question as an append instead of a second, weaker
one.

`get()` already re-verifies the digest on read, so a blob fetched from anywhere is
self-verifying, and `blobs.ts` was written for this: *"S3 becomes one adapter behind
put/get … no event schema changes when it does."*

### What is asserted

Seven more tests in `test/plane.test.ts`, and two of them are the reason the contract
changed: **every byte value 0x00–0xFF survives the round trip** (a PNG through the old
string body hashes to something else and is refused as a forgery), and **an oversized
body answers 413 rather than 400**. Plus: bytes that are not what they claim are refused
and neither name resolves afterwards; a blob for another runner's run is refused; a
re-upload succeeds, because a retry must not be an error.

The read side is deliberately absent. Serving a blob to a human is authorized by a human
session, which is 9c.

`get()` already re-verifies the digest on read, so a blob fetched from anywhere is
self-verifying, and `blobs.ts` was written for this: *"S3 becomes one adapter behind
put/get … no event schema changes when it does."*

## 9c–9e

**9c** is GitHub OAuth — one human login, sessions, and authorization answered by
`GET /user/installations` rather than by a roles table of our own. It is also where the
pairing UI lives: **Add a runner** mints the token from 9a while the human is
authenticated, and the token is shown once.

**9d** is the daemon: long-poll, run the existing engine unchanged, post events, upload
blobs, exit. The engine underneath it does not change at all, which is the point of
doing the boundary first.

**9e** is deletion. Central blobs make "delete this run" a real request, and dropping
bytes leaves events citing refs that resolve to nothing. `forgotten` is a fold state to
design; a run whose evidence was destroyed on request must not render like one whose
evidence was lost.
