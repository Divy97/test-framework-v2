---
status: built
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
| **9c** GitHub OAuth, and the human surface | built |
| **9d** the runner daemon | built |
| **9e** deletion, as a tombstone rather than a hole | built |

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
facts to punish a client bug. And the handle is a pool
([ADR-0020](adr/0020-the-database-handle-is-a-pool.md)), so a `begin` and its `commit`
are not promised to reach the same connection — the transaction would open on one and be
committed on another, or never. Nothing
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

## 9c · one login, and the approval behind it

The dashboard had no authentication. Not weak — none. That was correct while it bound to
127.0.0.1 and had one operator, and it is the single most dangerous line in the codebase
to host, because the one write on that surface stores shell commands the engine later
executes verbatim in a sandbox with a package registry reachable (ADR-0013).
Unauthenticated on a public address, that POST is remote code execution on somebody
else's runner.

**One human authentication: GitHub OAuth.** People arriving already have a GitHub
account and the App is installed by one; asking for anything else would be asking them
to remember a credential this product has no business owning.

**Authorization is GitHub's answer, asked every time.** `GET /user/installations`, on
each decision, and deliberately not cached into a roles table of our own — a permission
model here would be a second definition of who owns a repository, free to disagree with
GitHub's, and it would disagree on the day somebody was removed from an org. A GitHub we
cannot reach returns an empty list, which denies; an outage must never become an
authorization.

### The distinctions that carry the weight

- **`state` is the login-CSRF defence, not decoration.** Without it an attacker completes
  their own OAuth flow and redirects the victim's browser to our callback carrying the
  attacker's code — the victim is logged into the attacker's account, and anything they
  approve there belongs to somebody else. Compared in constant time.
- **`SameSite=Lax`, not `Strict`.** The OAuth callback *is* a cross-site navigation back
  from github.com, and Strict drops the cookie on precisely the request that establishes
  the session. Lax still refuses it on cross-site POSTs, which is the case that matters.
- **Sessions expire in the read**, so a process that never runs a cleanup job cannot
  leave a year-old cookie working.
- **The session holds a user-to-server token**, which is narrower than a PAT by
  construction — it can only reach repositories this App is installed on. That is
  ADR-0012's reasoning about personal access tokens, applied to the human half.
- **"Not yours" and "no such thing" are the same answer.** Run ids are uuids and
  repository names are guessable; a stranger probing either learns nothing.

### The local surface did not change

`serve.ts` passes no `auth`, and with none configured nothing is gated — one operator,
127.0.0.1, origin check. A test asserts exactly that, because 9c quietly requiring a
GitHub login to use your own laptop would have been a regression nobody asked for.

### Pairing

`/repos/<repo>/runners` mints the 9a token **because a human is authenticated**: one
login for a person, one credential for a machine, and the second is a consequence of the
first rather than a second thing to remember. The token is rendered once — the row stores
a hash, so "show it again" is not a feature declined but a thing that cannot be done, and
the page says so rather than implying a lookup exists.

### The IDOR review found after it shipped

The pairing routes authorized the **repository** in the path and then passed the runner
id from the URL straight through to `revokeRunner`. So a valid session on *any*
repository could revoke *any* machine whose id it knew — a cross-tenant denial of
service, and the same shape as the run-id checks done correctly two routes away.

The fix is at the data layer rather than the route: `revokeRunner` requires an
installation id and filters on it, so a future caller cannot forget an argument it has
to supply, and a mismatch updates nothing instead of the wrong row. It returns whether
it revoked anything, so the route can answer 404 rather than reporting success for
somebody else's machine.

An audit of every id taken from a URL — nine of them — found no others: the four runner
routes go through `appendFromRunner`'s job-ownership check, the three run pages check
the row's repository, and onboarding checks the repository itself.

### The plane, as a program

`src/plane-server.ts`: one address GitHub can always reach, the App key, the log, and the
queue. No Docker, no model credential, and **no path by which a delivery causes this
process to run a command from a recipe** — the thing holding the credentials is not the
thing that executes.

### What is asserted

`auth.test.ts` (16) covers the exchange, the state, the cookie attributes, expiry, and
that an unreachable GitHub denies. `authz.test.ts` (14) is the gate, and every case is a
person who *is* signed in reaching for a repository that is not theirs — including the
one that matters: **approving for a repository you cannot see stores nothing**, paired
with its control, because a test like that passes just as well on a surface that refuses
everything.

## 9d · the daemon

The half that lives on somebody's laptop. It dials out and never listens, which is the
entire reason this milestone exists.

The engine underneath it did not change, which was the point of doing the boundary
first — `runFromIssue` already took an injected `append`. Three things had to be added,
and each one is a credential decision rather than a plumbing one:

- **`GitHubApp` is a union now.** Either you hold the App key, or you hold a `mint`
  function and somebody else does. The plane mints; the runner asks. Only one function
  in the codebase ever read `appId`, so the union costs one narrowing.
- **Tokens are asked for per call, not handed over at dispatch.**
  `installationToken`'s own comment says *"called when needed, never captured at run
  start: a run that exceeds an hour needs a refresh mid-flight, and a value held in a
  variable cannot refresh itself"* — and that is exactly as true when the value came
  over a wire. `POST /runner/runs/:id/token`, authorized the same way an append is.
- **`runFromIssue` accepts a run id.** The plane mints it at dispatch, before any runner
  sees the work, because "may you append to this run" is only answerable if somebody
  other than the writer decided the run exists. An engine generating its own would have
  had every event of every hosted run refused — and the failure would have looked like
  an authorization bug rather than a plumbing one, which is why `run.test.ts` now
  asserts that every event carries the caller's id.

The recipe travels **with the dispatch**, read fresh from `recipes` at claim time rather
than stored on the job: it is current configuration (ADR-0013), and a human may have
corrected it since the delivery was queued.

### What is asserted

Nine tests in `test/daemon.test.ts` against a fake plane — the loop is what is under
test, and a test of a retry policy that needs Docker and a model credential is a test
nobody runs. Every case is something that will happen to a process on a laptop:

- claims a job, ships events in order, marks it finished;
- uploads the artifacts the events name, by ref, because that is how the engine cites
  bytes — no separate manifest to drift;
- asks for a token per call and never holds one;
- **a plane that fails and recovers costs a retry, not the stream** — the far end is
  idempotent, so a retry costs a request;
- **a refusal is not retried, because a 4xx is an answer.** The first draft failed this:
  the `throw` for the refusal case sat inside the try that implements the retry, so its
  own catch swallowed it and a 403 was hammered four times;
- a run that throws does not end the daemon, and the job is still marked finished — a
  job left dispatched is one no other runner will take;
- a blob that will not upload costs the artifact, never the run;
- an unreachable plane is waited out, not exited on;
- an empty poll loops rather than treating 204 as a failure.

## 9e · forgetting, without editing history

Central blobs made "delete this run" a request somebody will actually make, and it
collides head-on with the property this project is proudest of. Deleting from an
append-only log would make every other claim about that log worth less.

So nothing is deleted from it. **The bytes go; the events stay exactly as they were.**
The answer to *"did you edit my history"* is a flat no — we destroyed bytes we were
holding, and a row in `forgotten` is why the hashes still in those events no longer
resolve.

`forgotten` is not an event, and that is the design rather than a shortcut. The log has
one writer per run and it is the runner (ADR-0009, ADR-0019); a row appended by the plane
would make it a second producer of facts about somebody's bug. Forgetting is not a fact
about the bug at all — it is an administrative act on our storage, the same class as
`jobs`, `installations` and `recipes`.

### The subtlety worth the extra query

Blobs are content-addressed, so **two runs that produced identical bytes share one
file** — the same stdout, the same empty diff. Deleting everything a forgotten run cites
would silently break a run nobody asked about, and it would surface much later as an
evidence page whose hashes do not resolve: precisely the state this feature exists to
make legible.

So a ref is only removed when no *other, not-yet-forgotten* run cites it. The other half
of that rule is tested too: a blob shared only with an already-forgotten run does go, or
the last citation would preserve bytes nobody can see forever.

### The page says which

Destroyed-on-request and gone-missing look identical from the outside. One is a promise
kept and the other is a bug, so the tombstone renders **above the verdict**, before a
reader meets a hash that points at nothing — and the dead references are still shown,
because hiding them would be the edit that was just refused, one layer up.

### What is asserted

`forget.test.ts` (5, real database and a real blob directory): the artifacts go and
**every event row is byte-identical afterwards**; a blob another run cites is kept; a
blob shared only with a forgotten run goes; forgetting twice does not rewrite who asked
or when. `web.test.ts` covers the tombstone and its absence, and `authz.test.ts` covers
the one that matters — deleting the evidence of a run you cannot see deletes nothing.

## What GitHub accepted

On 2026-08-30, for the first time, an issue filed on GitHub reached this engine through
a real webhook delivery and came back as a real pull request:
[Divy97/test-framework-v2-demo#4](https://github.com/Divy97/test-framework-v2-demo/pull/4)
— **Tier 2, 90/103**, `+13/-0` in `orders.mjs`, from
[issue #3](https://github.com/Divy97/test-framework-v2-demo/issues/3).

The whole chain, each link of which had only ever been exercised by a fixture: delivery
signed and verified (`202`), the onboarding gate passed, the recipe replayed with its
service answering a healthcheck, the sealed probe, the repro agent, base red twice with
the reported symptom, the fix agent, fix green three times, the project's own suite green
on both commits, a branch pushed and a pull request opened.

**Two honest limits on what that proves.** It went through `serve.ts` — the
single-machine path — so the plane and the runner built in this milestone are merged and
tested and have never been deployed. And the tunnel in front of it dies with the process,
which is the argument for the plane rather than a counterexample to it.

**And it found something no test here could.** The first delivery failed in the
environment build: *"/blobs is not a host store"*. The deployed `test-framework-v2-*:latest`
images were **two weeks old** — the suite builds `:test`, so nothing had ever run against
what is actually deployed, and that image predates 7e's `only: 'env'` mode. Rebuilt, and
the re-fired delivery went the whole way.

Worth naming as a gap rather than a war story: **nothing checks that the images a
deployment runs are the images this repository builds.** A run against a stale image is
an operational failure that reads, from the log, exactly like an environment that would
not build.

## The rehearsal, and the two bugs it found

Milestone 9 was merged and tested and had **never been executed**. Before deploying it
anywhere, the plane and a runner were run against each other on one machine: a signed
delivery to the plane's receiver, a paired runner polling it, and a real job crossing
between them.

The loop works. The plane accepted the delivery, minted a run id, queued it; the runner
claimed it in seconds, ran the engine unchanged, shipped **124 events and 109
artifacts** back over the wire, and the run ended `PR_OPENED` on a real repository. Every
surface answered as its tests said it would, including the two distinctions that only
matter in production — a browser gets a redirect where an API client gets 401, and an
unpaired runner gets 401 rather than an empty queue.

Both bugs it found are the kind that only appear when the thing runs.

**A blob root is a store, not a directory.** `runner-main.ts` created its root with a
bare `mkdir`, and `orchestrate` refuses a root with no `.evidence-store` sentinel — so
every runner would have failed its first job, on a message about a mount it does not
have. `ensureBlobRoot` now lives in `blobs.ts` and all three programs share it; it was
private to `serve.ts`, and the second program to need it did not know.

**The plane received everything and showed nothing.** 124 events landed and
`run_projection` was empty, because nothing on the plane's side ever called
`projectOne` — so `/runs/<id>` reads the projection for its row and 404s on a run that
completed perfectly. The log was flawless and invisible, on the screen that *is* the
product. The plane projects each accepted batch now, never at the cost of the append:
the log is the truth, the projection is a cache `npm run rebuild` reconstructs, and
failing a runner's write because a cache would not update is the trade this codebase
refuses everywhere else.

## Containerising it found four more

The rehearsal above ran the plane from source. Putting it in an image found four
defects that source could not, and every one of them would have been a first-deploy
failure rather than a bug report:

1. **`process.loadEnvFile('.env')` throws when there is no `.env`.** The `?.` guards
   against an old Node, not against ENOENT — and a container has no `.env` by design,
   because its environment *is* the environment. The image died on a stack trace about a
   file it is meant not to have, before it could print the list naming what each missing
   variable costs. `loadEnv()` in `store.ts` now, used by all three entry points;
   `vitest.config.ts` had been wrapping the same call since M6 for the same reason.
2. **Nothing applied the schema.** A fresh volume is an empty database and
   `npm run db:schema` is a dev command pointed at the dev compose. The plane applies
   `db/schema.sql` on start, which is safe because every statement in it is idempotent —
   and does not make it a migration system: that file's own header names the gap where a
   new column needs a hand-written `alter`.
3. **A non-root process cannot create `/var/lib/plane`.** Made in the image and owned by
   `node`, which also decides the ownership a named volume inherits — so the fix is the
   same line as the one that stops the volume arriving root-owned on the host.
4. **Binding `127.0.0.1` inside a container is the container's own loopback.** The plane
   printed "plane up" and answered nothing, which is the most confusing shape a failure
   takes. The bind address is an option now, still loopback by default — a laptop's
   dashboard has no business on the LAN — and `ENGINE_BIND=0.0.0.0` in the image, where
   the exposure decision belongs to the container boundary rather than to a bind address.

**What the image is proved to do:** serve the surface (200 public, 302 to sign in, 401
for an unpaired runner), verify a signed delivery and refuse a forged one, mint a run id
and queue it, dispatch it to a paired runner **with the repository's current recipe
attached**, give a second poller 204, and accept the finish.

~~Two ports remain~~ — resolved when the host was chosen. The plane serves ONE port and
the receiver is a route on it at `/webhook`; `serve.ts` keeps two, because it is the
local product and a second port on a laptop is free. Both call the same `readWebhook`,
so the signature-first, `202`-before-any-work lifecycle is one implementation rather than
two that can drift.

The open question this paragraph used to end on — proxy in front, or fold it into the
chain — was answered by picking Fly, where there is nowhere to put a proxy.
