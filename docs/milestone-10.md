---
status: in progress
---

# Milestone 10 — a microVM per phase, and a button that starts the run

Milestone 9 split the product into a plane GitHub can always reach and a runner on
somebody's laptop. That was the right split and the wrong end state: the demo needs the
author's laptop, nobody installs a daemon and Docker to have a bug fixed, and a project
whose thesis is verification cannot be tried by a stranger. This milestone removes the
laptop.

What a person does, when it is built: sign in, pick a repository the App is installed on,
pick an open issue, and press **Start**. A microVM is created for each phase of that run,
the repository is cloned into it with no credential, the recipe is replayed and snapshotted, the agent
reads the code and the report, reproduces the bug in a sealed sandbox, drafts a plan a
second model reviews, fixes, is judged on both commits in sandboxes with no network, and a
pull request opens with the evidence — or the run ends `blocked` because a variable the
recipe marks required was never supplied, and says exactly which one. Every sandbox is
destroyed when the run ends.

## What was decided, and where

- **Where the sandbox runs:** Vercel Sandbox, a Firecracker microVM per phase, with egress
  denied — including DNS — by a firewall outside the VM, and the agent loop in a worker of
  ours. The comparison of eight candidates is [milestone-10-substrate.md](milestone-10-substrate.md);
  the decision is [ADR-0021](adr/0021-the-sandbox-is-a-microvm-we-do-not-operate.md), `accepted`
  on the spike's numbers ([milestone-10-spike.md](milestone-10-spike.md): 32 PASS, 3 FAIL, all
  three design inputs).
- **Manual trigger only.** `issues` webhooks are logged and ignored; `installation*`
  deliveries stay, since they are how the plane learns repositories.
- **Environment, split in two.** Non-secret configuration — ports, the URL of a Postgres the
  recipe provisions, `SMTP_HOST=mailpit` — is recipe content and ships first. Anything that
  authenticates to a system outside the sandbox is a secret: stored encrypted under
  [ADR-0017](adr/0017-environment-secrets-and-the-network-that-has-to-close.md)'s rules and
  injected only into a sandbox whose policy is `deny-all` at that moment.
- **A required variable with no value ends the run `blocked`, before any sandbox exists,
  with no pull request.** ADR-0007's gate holds. The comment names the variables and asks
  for nothing else — and tells the reporter not to paste values into the issue.
- **A plan, reviewed by a second model, before the fix.** At most two rounds. Recorded as
  events with blob refs, never counted in confidence, not shown in the UI, and **measured**
  with the same issues run with it on and off. It defaults to off until the table says
  otherwise.
- **The agent orients before it touches the bug** — a repository map, written into its
  handover commit and hashed into the log; internal.
- **The user's own OpenRouter key**, stored like a secret, spent by the worker on that
  user's runs.
- **A Next.js dashboard in `web/`, same origin, behind the plane**, which becomes a JSON API
  and an SSE feed. [ADR-0022](adr/0022-a-framework-in-front-and-nothing-behind-it.md),
  written in 10i, reverses the README's no-framework decision and says what does not move:
  the plane stays the only public process, the only holder of cookies, and the only place
  authorization is decided. It is a **static export** — HTML, CSS and JavaScript and nothing
  that runs — which is not a compromise but the only shape that keeps that sentence true: a
  Next server would have had to read the cookie to render, and authorization would then live
  in two codebases.
- **Not in this milestone, deliberately:** an MCP surface (first item of M11, cheap once the
  API exists); serving blobs by ref (refs stay text until redaction-at-read is designed);
  diff-coverage.

## What the exploration corrected before a line was written

- ADR-0021's first draft said `orchestrate.ts` reached Docker at 13 call sites, mounted 11
  paths and hard-coded `--network none` 9 times. The count included comments. It is **9 call
  sites, 5 mounts, 1 seal** — and, more importantly, **no `docker exec`**: every container is
  driven over the stdio of one `docker run -i`, so the seam is a phase, not a primitive.
- The hosted plane's SSE tail is unauthenticated. UUIDs make it hard to guess, not
  authorized. Fixed in 10g.
- A single worker of ours cannot claim jobs today: `claimJob` filters by installation and a
  runner row is per installation. Fixed in 10e.
- The plane runs no proving and no drafting; both live behind `serve.ts`. On the hosted
  product, approving a recipe proves nothing. Jobs gain a `kind`; 10h.
- `run_usage` is never written on the hosted path. 10f.

## The work

Two tracks. B never waits on A until 10h and 10l.

| | | depends on | status |
|---|---|---|---|
| **10a** | the spike: what Vercel Sandbox must be shown to do, each with a number (below) | a Vercel login | run 2026-09-06; #68 |
| **10b** | the `Executor` seam; Docker behind it; `orchestrate.ts` names no docker | | merged; #67 |
| **10c** | the Runner on a machine it is not PID 1 of: spool-in, stream-out | 10b | merged; #69 |
| **10d** | `VercelExecutor` against a fake client; `ENV_BUILT`, `SANDBOX_SEALED` | 10c | merged; #72 |
| **10e** | the worker on Fly `iad`; images to Vercel's registry; a runner that claims for any installation; first live run | 10d | merged; #75, #77, #78, #79 |
| **10f** | compute cost per sandbox; the record made true; ADR-0021 `accepted` | 10e | merged; #80 |
| **10g** | manual trigger and the JSON surface; the tail authorized; `issues` ignored | | merged; #66 |
| **10h** | jobs of three kinds: `run`, `prove`, `draft` | 10b, 10e | |
| **10i** | Next.js in `web/`; the plane in front; `web.ts` retires; ADR-0022 | 10g | merged |
| **10j** | recipe `env` and `required`; `blocked` | | merged; #70 |
| **10k** | the model key and secrets: stored, listed by name, never read back | 10j | merged; #71 |
| **10l** | secrets injected only under `deny-all`, with the guard executed | 10d, 10k | merged |
| **10m** | orientation, plan, critic — off by default, proven inert, then measured | | |
| **10n** | every line of the record that this milestone made false | all | |

**10e is done, and it took four defects to get there — three of one kind and one of another.**

Three were this executor assuming Vercel's *managed* image — ubuntu, uid 1000, passwordless
sudo, code wherever the spike put it — where ours are alpine, root, no sudo, code at
`/app`: `sh: sudo: not found`, an entrypoint at a path no Dockerfile creates, and #78's
session length, which is a Hobby plan ceiling rather than an image difference and was named
in the plan's own risk list.

The fourth is a different animal. `sweep()` had **never stopped a single sandbox**, and it
never failed either — it silently returned 0, and was caught by the live smoke test's own
cleanup check rather than by anything failing. Two independent causes in the same adapter:
a structural type this repository wrote itself claimed a `sandboxId` the SDK has never had,
and `Sandbox.list` returns a Paginator that `.map` throws on, which `sweep` swallows by
design so a failed listing cannot stop a worker taking work.

None was findable against the fake, and the fourth is why: **a fake cannot disagree with
the SDK about the SDK.** What replaced finding them one live run at a time is
`scripts/live-smoke-vercel.mts` — the whole engine on real microVMs with no plane, no queue
and no worker in the way — plus spike items 14 and 15, which ask *our* images and *our*
sweep the questions the first thirteen only ever asked the managed one.

The first hosted run to open a real pull request was `f8d10681` on 2026-09-06: five
sandboxes, the four that judge or run an agent each sealed `deny-all` with a probe from
inside (the fifth is the environment build, which is `allow-all` by design because
`install` needs a registry), base red twice, fix green three times, Tier 2 at 98/103.

What is left of the worker's own deploy is a Vercel account token, which the CLI refuses to
mint (`403 cannot create tokens for this app`). Until it exists the worker runs on the
author's laptop against the production plane, which is the same process with a different
`FLY_MACHINE_ID`.

**10l is done, and what unblocked it was not the thing ADR-0017 was waiting for.**

That ADR asked for an *absence* — no stored credential in a container with a network route
— and assumed the only way to get one was to pre-warm the agent's dependencies so its
sandbox could lose its network too. The microVM substrate supplied a different route to the
same property: the phases that judge are created `deny-all` and **probed from the inside,
before they are handed a line of the repository's code or a Job**. That makes the absence a
condition a machine checks rather than an architecture to wait for, and `mayInject` in
`src/executor.ts` is the check — one function, shared by both executors so they cannot
answer differently, returning a reason rather than a boolean so a refusal can be recorded.

**Which commands actually see a stored value, and this is the part worth stating loudly:**
the project's own `test` command and anything the reproduction runs. **Not `install`,
`migrate`, `seed`, or a service's startup** — those run in the agent sandbox, which has a
registry reachable by design (ADR-0013) and is sealed only afterwards. A repository whose
*install* needs a private token still cannot be served, and the run says so rather than
half-booting. Docker injects nothing at all: `--network none` leaves nothing to probe from,
and an unobserved seal is not one.

Two things it found on the way, neither about secrets. `secretNames` had been on the run
request since 10j and **nothing ever set it** — so a recipe declaring `required` blocked
every time, even with the value stored; 10j shipped the gate, 10k the storage, and nothing
connected them until now. And `test/runner-main.test.ts`'s daemon fake was
`as unknown as` its own interface, so adding a method to `DaemonIo` was a clean `tsc` and
four runtime failures — the same lesson `src/vercel-client.ts` records about the SDK,
arrived at from the other side. The fake is typed now.

**10k has two deploy prerequisites, and the next deploy fails without them.**
`PLANE_SECRETS_KEY` is now in the plane's `REQUIRED` set, so a deployment that does not
have it fails `readPlaneConfig` at boot, fails its health check, and rolls back. It is
merged as of 2026-09-06 and **neither of these has been run** — there is no CI, so nothing
has deployed since. Both are required before the next `fly deploy`:

```
fly secrets set PLANE_SECRETS_KEY="$(openssl rand -base64 32)" -a test-framework
psql "$DATABASE_URL" -f db/schema.sql        # repo_secrets, user_model_keys
```

That key is not recoverable and not rotatable yet: lose it and every stored value is
permanently unreadable. That is the property — a backup of the database is worth nothing
on its own — and it is also an operational hazard, so it belongs in whatever holds the
App's private key rather than beside the database URL.

10k ships the storage, the JSON API and the runner routes, and a **read-only** list of
stored names on the onboarding page. There is no form: a `PUT` with a JSON body is not
something an HTML form can send, and writing the JavaScript for one into `src/web.ts` — a
file 10i deletes — would be work done twice. The form arrives with the Next.js UI, which
sends JSON natively. Until then a value is stored with one `curl`, and the API is the
tested surface.

**10i is done, and what it found is that the gap was never cosmetic.** Four things a person
has to do had no screen at all: store a model key, store a secret, pick an issue and press
Start, and watch a four-minute run. Each of them had a route — built, authorized, tested,
deployed — and `curl` as its only client. `POST /api/runs` is milestone 10's entire thesis
and nothing in the product called it; the SSE tail has been streaming since milestone 5 and
nothing consumed it.

**Two tests skip without a built bundle, and they hold the checks that only real Next output
can give** — the landing page pre-rendered into `index.html`, and the CSP hashing against the
flight data Next actually emits. `npm test` does not build; `npm run test:full` does, and is
what a full-signal run means from 10i on. Both skips print what is missing by name, in the
same words the missing-Chromium one uses, because "not built" and "broken" produce the same
blank page and only one of them is a bug.

What shipped: `web/` as a Next.js static export, seven screens, and the plane serving them
from its own port (`src/static.ts`). `src/web.ts` — 1,390 lines — is deleted, and every route
on the surface is now `/api/`.

**Two defects it found in code that was already merged**: `run_projection.ended_at` is not
always written, so keying "is this run over" on it put a live indicator and a *verdict not
yet* chip on a run that had opened a pull request — the fold's `status` is the authority and
is what the screens now ask; and this repository's `.dockerignore` matched `node_modules` at
the root only, so a second npm project would have shipped its whole dependency tree into the
build context.

**And nine it found in its own, of which two are the interesting ones.**

*The live view was dead.* `sse.ts` writes `event: <type>` on every frame — deliberately, so a
consumer can subscribe per type — and `EventSource.onmessage` handles only the default
`message` type. So the first version delivered nothing: an open connection, a clean console,
and **0 events** for the whole of a run. Nothing here could have caught it. `sse.test.ts`
proves the server's frames are right and they were; `screens.test.tsx` proves the timeline
renders frames handed to it and it does; the defect lived in the two lines between, and only
a browser with a log growing underneath it can see those. `test/dashboard.browser.test.ts`
now has one.

*Every sealed sandbox rendered as a security failure.* `SANDBOX_SEALED` carries
`probe: { dns, route }`; the timeline read them at the top level, so `undefined === false`
was false and the row said **"a probe inside it still found: DNS, a route"** — with a red ✗ —
on every run of every repository. Four more payloads were read by the wrong field name.
*Both tests covering that component passed*, because their fixtures were hand-written objects
carrying the same guess the code made. **A fixture invented alongside the code it checks is
not a check; it is the same guess written twice.** Every payload fixture is now typed as its
real type from `src/events.ts`, which also gained a runtime `EVENT_TYPES` with two
`Assert<>`s making it exhaustive against `EventPayload` in both directions — the dashboard
keeps its own copy, and `test/screens.test.tsx` asserts the two are identical.

The rest, briefly: the throttle on re-reading the fold could swallow the *final* refetch, so a
finished run said "still going" for ever; pressing Start landed on "No such run", because the
projection does not exist until a worker claims the job (`/api/runs/:id/evidence` now answers
**202 queued** and the page polls); `/api/me` called GitHub on every page load to read one
bit; a non-uuid run id was a 500 echoing the caller's own path back at them; `useJson`
rendered the previous run's data under the new run's URL for a full round trip; one bad field
blanked the entire application; and the 320px reflow, a dangling `aria-controls`, four
destructive controls with no busy state and nowhere for focus to land, and a live view that
announced nothing at all.

**Two things about the suite are worth recording as process rather than as defects.** A slice
taken to end-of-file deleted seven `readRunnerConfig` tests that have nothing to do with this
milestone — the only coverage the two image defaults, the blob root and the substrate
validation had. And `test/authz.test.ts`, 27 authorization tests and the largest such body in
the repository, was left pointing at deleted routes rather than ported. Both were found by
review, not by the suite: a deleted test file is silent by construction, and a red one is
easy to read as somebody else's problem.

Rough order: week 1 — 10a and 10g; weeks 2–3 — 10b, 10c, 10j, 10k; weeks 4–5 — 10d, 10i;
week 6 — 10e, 10h; week 7 — 10f, 10l, 10m; week 8 — 10n and real runs on repositories the
author did not write. Eight to ten weeks at this repository's review discipline.

If the spike fails on egress (items 1 or 2 below), the substrate becomes E2B through the
same seam and ADR-0021 is rewritten; nothing else in the table changes.

### The spike, itemised

Each is a script under `scripts/spike-vercel/`, gated on `VERCEL_TOKEN`, printing PASS or
FAIL with the number beside it:

1. `deny-all` at create: a DNS lookup, a raw TCP connect to `1.1.1.1:53` and an HTTP fetch all
   fail — as node one-liners, since the managed image has neither `nc` nor `wget`; loopback works.
2. The policy flipped `allow-all` → `deny-all` on a *running* sandbox: both probes fail
   within five seconds, no restart, and a loopback server started before the flip answers.
3. Snapshot after a ~200 MB `npm ci`: how long `snapshot()` takes; create-from-snapshot
   under 15 s p50; `/opt/env` present; `cp -al` works.
4. `writeFiles` at 1, 10, 50, 100 and 250 MB, and `git clone --no-local -- bundle` from the
   result. Pass at 100 MB, or chunk-and-`cat` works.
5. Fifty `runCommand('true')` — p50 and p95 under 300 ms; a detached command's `logs()` at
   ten lines a second for five minutes with no gap; re-attach after dropping the iterator.
6. Chromium in the agent image answers CDP `/json/version` under Firecracker.
7. An exposed port under `deny-all` — recorded only; the design exposes none.
8. `stop()` reports plausible active-CPU and transfer numbers after a known burn.
9. Cold start, ten times from the image and ten from a snapshot — under 10 s p50.
10. The root model: `sudo`, uid 1000, root can `SIGSTOP` uid 1000, `chown` works.
11. What a session timeout looks like to a detached command's `logs()` and `wait()`.
12. Snapshot delete, sandbox list, tags on create, command re-attach — the APIs exist.
13. Both images pushed to Vercel's registry: time and size.

## The honest unknowns, before starting

The long-lived `logs()` stream and the `writeFiles` size ceiling are unverified — the spike
decides between streaming and a blocking-wait over the same spool. Alpine Chromium under
Firecracker may not start; the fix is a Debian agent image. Hobby's 45-minute session sits
below the engine's hour-long wall clock. The isolation claim will cite a vendor's firewall,
so the post-flip probe in every run is what keeps it an observation. A secret under
`deny-all` satisfies startup validation and nothing else, and the UI has to say so. The
critic may cost more than it saves; 24 runs is a small table and will say so about itself.
