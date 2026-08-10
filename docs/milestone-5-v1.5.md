---
status: accepted
supersedes: milestone-3.md §3c.2, milestone-4-isolation.md
---

# Milestone 5 — v1.5: a run a person can start and a PR they can merge

[architecture-v1.5](architecture-v1.5.md) is the target. This is the order to
build it in, and what "done" means for each step.

Every phase leaves the suite green and is shippable alone. The order is dependency
first, not importance first — the loop moving out unblocks the tool surface, and
the tool surface is what everything after it needs.

**Two phases cannot be completed without credentials** (5c needs an Anthropic API
key, 5e needs a registered GitHub App). Where a credential is missing, build
everything up to the boundary, leave the integration test skipped with an explicit
reason, and **say so**. Do not stub a real integration and report it as done — an
untested boundary that reads as tested is the one failure mode this project exists
to refuse.

---

## 5a · the loop moves out

The structural change. [ADR-0011](adr/0011-the-agent-loop-runs-outside-the-sandbox.md).

- A host-side loop on `client.beta.messages.tool_runner`, model `claude-opus-5`,
  `thinking: {type: "adaptive"}`.
- A worker inside the sandbox that **polls outward** for tool calls and returns
  results. No listening port in the container. No inbound rule.
- Tools: `shell_create` / `shell_write` (named sessions, [ADR-0014](adr/0014-long-lived-services-and-named-shells.md)),
  `read`, `write`, `edit`, `grep`, `glob`, `git_commit`.
- Every tool call and result becomes an `AGENT_MESSAGE` payload written by the
  **orchestrator**, never by the worker.
- `src/egress.ts` and `test/egress.test.ts` are **deleted**.
  [ADR-0011](adr/0011-the-agent-loop-runs-outside-the-sandbox.md) is explicit that
  a sealed container with an unused proxy beside it is worse than neither.
- `--network none` stays on every container in this phase. The agent cannot reach
  the model API because it does not need to; the loop does. PR #21 already sealed
  the agent's container as a stopgap — 5a is what makes that seal correct instead
  of merely honest.

**Path confinement is load-bearing here and was not before.** The container was
the fence; now the tools are. `write`, `edit` and `read` resolve their path to
canonical form and refuse anything outside the workspace root — `..`, symlinks out,
absolute paths, encoded traversal. `git_commit` can commit and cannot push, add a
remote, or check out a ref.

**Done when** a fake tool-call script drives a full run through the worker with no
network in the container, the suite proves a `write` outside the workspace is
refused, `grep -rn egress src test` returns nothing, and a test fails if the
container is given an interface.

## 5b · the environment recipe

[ADR-0013](adr/0013-the-environment-recipe.md).

- Recipe schema: `install`, `migrate`, `seed`, `services: [{name, command, port,
  healthcheck}]`, `test`. Stored in Postgres keyed by repository. **Never written
  to the user's repository.**
- A drafting session: the agent explores and proposes a recipe; a human approves it.
  Until there is a UI, approval is a CLI command that prints the draft and takes a
  yes.
- A setup phase in the agent sandbox: replay the recipe, boot each service in its
  own named shell, poll each healthcheck, emit **`ENV_READY`**.
- The agent sandbox gets a package-registry route and localhost for this phase. The
  phase containers do not, and a test must fail if that ever changes.
- A run that never reaches `ENV_READY` ends `errored`, **not** `not_reproduced`
  ([ADR-0007](adr/0007-reproduce-first-gate.md) amendment). The fold refuses a run
  that claims a phase without it.

**Done when** the seeded demo app boots from its recipe inside the sandbox, its
healthcheck passes, `ENV_READY` appears in the log, and a deliberately broken
recipe folds to `errored` rather than to a tier.

## 5c · the two prompts, and the first real run

The gap that makes everything above untested: **no prompt has ever been authored.**
`src/agent.ts:40` says the prompt is the caller's business, every prompt in the repo
is a test stub like `'fix it'`, and nothing tells the agent that
`.engine/repro.json` exists. A real agent today produces a commit with no manifest
and `readReproManifest` throws.

- **The repro prompt** states the manifest contract — path, `{command, files[]}`,
  the 32-file and 256KB limits — that the working tree is discarded so only
  committed files count, that the command must **fail** on this commit, and what is
  available in the environment.
- **The fix prompt** states the bug, the registered repro command, that the same
  command will be re-run by something the agent cannot reach, and that it must not
  touch the repro files.
- Both live in version control as their own files, not as string literals in a
  call site. They are prompts; they will be iterated.

**Needs an Anthropic API key.** With one: a real run against a seeded bug in the
demo app, end to end, folding to a tier. Without one: the prompts land, the
contract is asserted against the hostile fake, and the end-to-end test is skipped
with the reason stated.

**Done when** a real `claude` produces a commit whose `.engine/repro.json` the
engine accepts without a retry, and the run folds to Tier 2.

## 5d · one container per phase

[ADR-0014](adr/0014-long-lived-services-and-named-shells.md), which is
[milestone-4](milestone-4-isolation.md)'s candidate B.

- `runJob` splits; the base→fix transition becomes a container boundary.
- `verify()` splits along the same seam. This is the awkward part and it is the
  known cost.
- Each phase clones the same source at its own commit. Neither shares a tree, a
  `TMPDIR`, a `HOME`, or a PID namespace with the other.
- The reap stays, gated on PID 1, demoted to belt-and-braces.
- The adversarial suite must still pass — including the test that proves an
  unscrubbed run credits a README-only "fix", so the defence cannot quietly stop
  being the reason the other test passes.

**Done when** every ADR-0010 attack fixture still fails to land, and the
`/tmp`-marker and `$TMPDIR/.seen` fixtures fail for a *different* reason than
before: the file is not there because the container is not the same one.

## 5e · GitHub: in and out

[ADR-0012](adr/0012-the-github-app-and-where-the-token-lives.md).

- Webhook receiver: verify the HMAC, reject anything else, map issue-opened and
  issue-labelled to `RUN_REQUESTED {source: "github_issue", thread_ref, raw_text}`.
- App private key → JWT → 1-hour installation token, minted **when needed** rather
  than captured at run start, because a run can outlive an hour.
- The host clones with the token and mounts read-only. The token never enters any
  container.
- After the fix phase passes: the host pushes the branch and opens the PR with the
  five mandatory sections — the bug, the failing test, base red / fix green, the
  diff, the tier.
- An issue comment on every terminal outcome, including Tier 3 and `errored`. A run
  that ends silently is worse than no run.

**Needs a registered GitHub App.** Without one: the token-minting path is unit
tested against the documented JWT shape, the webhook receiver is tested against
recorded payloads, and the live install is skipped with the reason stated.

**Done when** an issue opened on the demo repository produces a PR on the same
repository with no human step between them, and no container ever held the token.

## 5f · the browser

[ADR-0006](adr/0006-testimony-vs-evidence.md) amendment.

- Headless Chromium in the **agent sandbox only**. A test must fail if a phase
  container ever gains one.
- Tools: `browser_navigate`, `browser_click`, `browser_type`, `browser_screenshot`.
- Screenshots, console logs and network traces are banked as blobs by `sha256:`
  ref and attached to the PR. They are inputs to **no verdict**.
- A browser-driven agent-authored reproduction is Tier 2. There is no path by
  which visual evidence raises a tier.

**Done when** the agent finds a wrong string rendered in the demo app by looking
at it, and the reproduction it commits is a test the sealed phase container can
run without a browser.

## 5g · status out

- SSE tail: `Last-Event-ID` → `WHERE run_id = ? AND seq > ?`
  ([ADR-0005](adr/0005-sse-over-websockets.md)). No protocol invented.
- The issue comment is the user-facing surface in v1.5. The dashboard is M6.

**Done when** a dropped connection resumes with no missed and no duplicated
events.

---

## Not in this milestone

Slack and CLI connectors · the dashboard · deployment and preview URLs ·
multi-repo runs · LSP tools · diff-coverage instrumentation · autonomous
observability-triggered runs.

**Bounded attempts** remain outstanding from
[milestone-3](milestone-3.md) §3b.2b, and `handedOver` must become per-attempt
with them. It is not in v1.5 because retrying is only meaningful once a later
attempt can propose a different reproduction, and nothing above changes that.

## What "done" looks like

A person opens a GitHub issue on a repository they have installed the App on, and
receives a pull request whose description proves the bug existed before the change
and does not exist after it — with no step in between where the engine trusted
anything the agent said.
