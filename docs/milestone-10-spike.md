---
status: complete — 32 PASS, 3 FAIL, all three design inputs rather than blockers
---

# The spike — what Vercel Sandbox was shown to do

Thirteen things `docs/milestone-10.md` said the substrate had to be shown to do before an
executor was built on it, each run once against a real account and recorded with the
number beside it. The scripts are `scripts/spike-vercel/`; the raw verdict lines are
`docs/milestone-10-spike.log`. This document is what they mean.

Run on 2026-09-06 from a laptop with the Vercel CLI logged in and this repository linked
to a Hobby project; `@vercel/sandbox@3.2.1`; region `iad1`; the managed image
`vercel/sandbox/node:22` for every item but 6, which uses this repository's own agent
image pushed by item 13.

## What was found before a single number: the image, and the API's rules

The independent review of the scripts read the managed image's Dockerfiles and found what
the SDK's types do not say: `vercel/sandbox/node:22` is Ubuntu 26.04, runs as `ubuntu`
(uid 1000, passwordless `sudo`), `/bin/sh` is dash, and it ships no `procps`, `nc` or
`wget`. `writeFiles` writes as that user, so `/opt/env` and `/work` — the paths the Runner
uses — have to be made writable first. The executor will carry the same step.

Two rules the API enforces that the documentation reads past:

- **A snapshot expires in no less than a day.** `snapshot({ expiration })` accepts `0`
  (never) or ≥ 86,400,000 ms; anything shorter is a 400. The plan's six-hour snapshots
  become one-day snapshots deleted explicitly, which the executor's `dropSnapshot` already
  is.
- **The SDK's `networkPolicy` getter is stale after a live flip.** After
  `updateNetworkPolicy('deny-all')` the sandbox object still reported `allow-all` while the
  probes proved the seal. The executor's `policy()` — the guard secrets injection (10l)
  rests on — must track the policy it set, or re-fetch; it must never read the cached
  getter.

One operational surprise, recorded so it is not repeated: `vercel link` connects the GitHub
repository to the project by default, and Vercel then builds every push — a deployment of
a repository that has nothing to deploy. The project is disconnected from Git and
`vercel.json` says `git.deploymentEnabled: false`; nothing of this product runs on Vercel
but the sandboxes.

## What `deny-all` actually is

The criterion said "egress kill enforced by the substrate". The first live probe found
that a raw TCP `connect()` to `1.1.1.1:53` **succeeds** under `deny-all`. Everything after
the handshake fails: a DNS query over that connection gets the socket closed with no data,
a TLS handshake is reset, HTTP dies with a socket error — and a DNS query over UDP straight
to `1.1.1.1` is never answered. So the firewall is a **terminating proxy for TCP and a drop
for UDP**: it completes the handshake so the sandbox sees a socket, and nothing the socket
carries reaches the destination. Sealed in substance; not a packet filter, and the record
should say so rather than "no network". The probes were rewritten to exchange data, because
a probe that stops at `connect` cannot tell the two apart — that correction is itself a
result of the spike.

The live flip from `allow-all` to `deny-all` on a running sandbox took effect between 351 ms
and 2,029 ms after the call, without a restart, and a loopback server started before the
flip kept answering. That is ADR-0017's precondition — an agent whose whole session runs
with no route — met by a policy change.

## The thirteen items

| # | asks | result |
|---|---|---|
| 1 | `deny-all` at create | **PASS** — resolver fails, UDP dropped, TCP connects then closes with no data, TLS reset, HTTP dies; loopback answers |
| 2 | live flip on a running sandbox | **PASS** — sealed within 351–2,029 ms; loopback survives; same session |
| 3 | snapshot after a real install | **PASS** — `npm install` of five packages (349 MB) in 17.9 s as uid 1000; `snapshot()` 3.2 s (338 MB); a `deny-all` sandbox created from it in **504 ms** with `/opt/env` present; `cp -al` across it gives link count 2; UDP dropped. The first attempt crashed on the one-day expiration floor |
| 4 | `writeFiles` 1–250 MB, chunking, a bundle cloned | **PASS** — every size intact by hash up to 250 MB (147 s, ~1.7–2.1 MB/s from this laptop); 120 MB in 40 MB chunks re-joined intact; a 1.1 MB bundle of this repository written in 2 s and `git clone --no-local` from it succeeds |
| 5 | transport cost | **MIXED** — `runCommand('true')` p50 **332 ms**, p95 651 ms *from a laptop in Mumbai to `iad1`*, against a 300 ms criterion written for a worker in the same region: FAIL as measured, and the number that matters is measured from the worker in 10e. `writeFiles` 1 KB p50 349 ms. A detached command's `logs()` at 10 lines/s: 1,500 lines over 154 s, worst gap **576 ms** — PASS. Re-attach via `getCommand(id).logs()` delivered 2,258 lines (overlapping, so a replayed window) and **closed before END** while the command was still running — FAIL: re-attach does not follow live. `wait()` still resolved exit 0 at 308 s |
| 6 | Chromium in our agent image | **PASS** — the alpine agent image boots under Firecracker and headless Chromium 152 answers CDP `/json/version` on the first attempt; the pushed image was usable immediately |
| 7 | inbound port under `deny-all` | **recorded** — an exposed port answered `HTTP 200` from the public internet under `deny-all`. Inbound is independent of the egress policy; the executor never passes `ports` for a judging sandbox, and this is why |
| 8 | `stop()` usage | **PASS** — 17,167 ms active CPU for a 15.1 s busy loop; ingress 2.6 KB, egress 1.6 KB; duration 16.7 s. `stop()`'s `activeCpuDurationMs` and the sandbox getter agree |
| 9 | cold start ×10, image and snapshot | **PASS** — create plus first command: from the image p50 **918 ms** / p95 1,390 ms; from a snapshot p50 **1,219 ms** / p95 1,717 ms; 10/10 each |
| 10 | root model | **MIXED** — default user uid 1000 (`ubuntu`); `sudo -n` → 0; root `SIGSTOP`s a uid-1000 process (`State: T`, owner 1000); `chown` works — PASS. **`readlink /proc/<root pid>/fd/1` as uid 1000 succeeded** (`/tmp/root-out`) — FAIL against the Runner's assumption. The *path* of root's stdout was visible; opening or writing it was not tested, and the SDK's `sudo: true` may leave the process ptrace-accessible. 10c verifies the real `/proc` semantics before `runner-vm` relies on the fd/1 trick; a kernel per phase does not depend on it |
| 11 | session timeout | **recorded** — at 59.6 s of a 60 s session, `logs()` threw `StreamError: Sandbox stream was closed…` after 12 ticks and `wait()` threw `APIError 410: Sandbox has stopped execution…`; neither hung. The `status` getter still said `running`. The executor maps a `StreamError` or 410 to `ceiling: 'session'`, and reads nothing from the getter |
| 12 | the APIs | **PASS** — `Sandbox.list` by tag; `getCommand` re-attach on a finished command; `snapshot()` (128 MB, `created`); `Snapshot.list`; `delete()` → `deleted` |
| 13 | images to the registry | **PASS** — both images cross-built for `linux/amd64` on an arm64 laptop and pushed via `vercel vcr` (sandbox 101 s, agent 354 s); refs pinned by digest `sha256:2c9119…` and `sha256:f7461d…` |

## Decision

**Vercel Sandbox proceeds; ADR-0021 is `accepted`.** The two criteria that gated the
decision — egress denied by the substrate, and denied on a *running* sandbox by a policy
change — both hold, with the mechanism now stated precisely. Nothing failed that E2B would
have answered differently, and the fallback is not taken.

The three FAIL lines and the two recorded items are inputs to the executor, and each has a
consequence:

1. **The Runner is not root, and paths are root's.** `prepare()` — or the Runner started
   with `sudo: true` — before anything is written to `/opt/env` or `/work`.
2. **A snapshot lives a day at minimum.** `buildSnapshot` asks for one day and
   `dropSnapshot` deletes explicitly; expiration is the floor under a delete that did not
   happen.
3. **The policy getter is stale.** The executor records the policy it set, and the
   post-flip probe (`SANDBOX_SEALED`) is the evidence — never the SDK's getter.
4. **One `logs()` iterator per phase, held for the phase's whole life.** Re-attaching
   replays a window and closes; it is not a way to resume. The mirrored `/work/rpc/out`
   results and `wait()` are the recovery path when the stream drops.
5. **Never `ports` on a judging sandbox.** Inbound is open regardless of `deny-all`.
6. **A session ceiling is an exception, not a hang.** `StreamError` or a 410 on `wait()`
   becomes `PhaseResult.ceiling: 'session'` → `VERIFICATION_ABORTED{cause:'ceiling'}`.
7. **Round-trip cost is the worker's to measure.** 332 ms is Mumbai to Virginia; 10e puts
   the worker in `iad` and records the in-region number a 100-call agent session pays.
8. **`/proc` under the SDK's `sudo` is not Docker's PID 1.** 10c re-verifies what uid 1000
   can reach of the Runner's process before `runner-vm` inherits any of `runner.ts`'s
   `/proc` tricks.

What it cost: 35 sandboxes over about forty-five minutes, plus a 349 MB install three times;
the Hobby plan's Usage page holds the CPU-hours, and nothing was left running.
