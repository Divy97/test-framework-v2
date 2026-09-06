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
  and an SSE feed. ADR-0022, written in 10i, will reverse the README's no-framework decision
  and say what does not move: the plane stays the only public process, the only holder of
  cookies, and the only place authorization is decided.
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
| **10f** | compute cost per sandbox; the record made true; ADR-0021 `accepted` | 10e | |
| **10g** | manual trigger and the JSON surface; the tail authorized; `issues` ignored | | merged; #66 |
| **10h** | jobs of three kinds: `run`, `prove`, `draft` | 10b, 10e | |
| **10i** | Next.js in `web/`; the plane in front; `web.ts` retires; ADR-0022 | 10g | |
| **10j** | recipe `env` and `required`; `blocked` | | merged; #70 |
| **10k** | the model key and secrets: stored, listed by name, never read back | 10j | merged; #71 |
| **10l** | secrets injected only under `deny-all`, with the guard executed | 10d, 10k | |
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
