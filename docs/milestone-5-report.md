---
status: living
---

# Milestone 5 — build report

Written as the run proceeds, phase by phase, so it is usable if the run is cut
short. [milestone-5-v1.5](milestone-5-v1.5.md) is the spec; this is what
happened when it was built.

## The environment this was built in

| Thing | State | Consequence |
|---|---|---|
| Docker daemon | available (29.1.2) | the sandbox suite runs |
| `ANTHROPIC_API_KEY` | **absent** | 5c's live end-to-end run cannot happen |
| Registered GitHub App | **absent** | 5e's live install cannot happen |
| `gh` CLI auth | present (`Divy97`) | PRs can be opened for the phases themselves |

Both absences are anticipated by the milestone document, which says to build up
to the boundary and skip the integration test with the reason stated. That is
what was done; every skip below names its missing credential in the skip message
itself, so a green suite cannot read as a verified boundary.

**Baseline before any change:** 494 passed, 2 skipped, 18 files, 737s.

## Phase status

| Phase | State | Notes |
|---|---|---|
| 5a · the loop moves out | **landed** — PR #22 | 307 passed, 2 skipped |
| 5b · the environment recipe | **landed** | see below |
| 5c · the two prompts | **landed**, except the live run | no `ANTHROPIC_API_KEY` |
| 5d · one container per phase | not started | mostly already built; the assertions are what is missing |
| 5e · GitHub in and out | written, not committed | unit half done; live install skipped |
| 5f · the browser | not started | |
| 5g · status out | written, not committed | `src/sse.ts` + tests pass |

---

## 5a · the loop moves out

### What landed

| File | What it is |
|---|---|
| `src/paths.ts` | `resolveInside`, moved out of `verify.ts`. With the loop outside the sandbox the **tools** are the fence, and the only defensible path check is the one four adversarial review rounds already shaped. `verify.ts` now wraps it back into `ObservationFailed` so its messages are byte-identical. |
| `src/tools.ts` | The tool surface: schemas (what the model is offered) and execution (what runs in the container) in one file so they cannot drift. `shell_create` / `shell_write` (named sessions), `read`, `write`, `edit`, `grep`, `glob`, `git_commit`. |
| `src/loop.ts` | The host-side loop on `client.beta.messages.toolRunner`, `claude-opus-5`, `thinking: {type: 'adaptive'}`, `effort: high`. `invoke` is injected, so this module never touches the container. It returns a transcript and writes no events. |
| `src/runner.ts` | A `serveTools` mode: the container builds the agent's world, announces `{ready:true}`, executes tool calls arriving on stdin, and writes **no events at all**. Stdin is now read line by line — the Job is the first line and the stream stays open. |
| `src/orchestrate.ts` | Drives it: keeps stdin open, splits replies from events as they arrive, hands the loop an `invoke`, and turns the returned transcript into `AGENT_MESSAGE` / `AGENT_FINISHED` payloads **written by the host**. |
| `test/fixtures/model.ts` | A scripted Messages API on a local port — the successor to the fake `claude` on `PATH`, and the reason 5a's done-when is reachable with no credential. |
| deleted | `src/egress.ts`, `test/egress.test.ts`. |

### Done-when, item by item

| The milestone asks | Where it is asserted |
|---|---|
| a fake tool-call script drives a full run through the worker, no network in the container | `sandbox.test.ts` → *the host drives the tools and the container never has a network*. A scripted model opens a shell, probes DNS and routing, writes a repro and a manifest, and commits; the run folds with `REPRO_REGISTERED` and `shownOnBase`. |
| the suite proves a `write` outside the workspace is refused | `tools.test.ts` (six spellings, in-process) and `sandbox.test.ts` → *a write outside the workspace is refused inside the container too* (`/work`, `../../blobs`, `/etc/shadow`). |
| `grep -rn egress src test` returns nothing | `sandbox.test.ts` → *the deleted egress proxy is not referenced anywhere* — **restated**, see below. |
| a test fails if the container is given an interface | the probe above asserts `AGENT-NO-DNS` / `AGENT-NO-ROUTE` from the tool **result**, and that `AGENT-RESOLVED` / `AGENT-ROUTED` never appear. |

### What contradicts a document, and what was done about it

1. **`grep -rn egress src test` cannot return nothing.** The string `egress` is a
   substring of `regression`, which appears throughout the suite; the word also
   belongs in comments, since ADR-0011's whole argument is about egress. The
   assertion was narrowed to what a deletion actually means — nothing *imports*
   the module (`grep -rnE "from '[^']*egress"`) and neither file exists. Recorded
   rather than quietly reinterpreted.

2. **`resolveInside` refuses a legal filename beginning with `..`.** The lexical
   guard is `rel.startsWith('..')`, so `..%2f..%2fetc%2fpasswd` — which is one
   weird filename, not a traversal, because nothing here URL-decodes — is turned
   away. The precise form (`rel === '..' || rel.startsWith('..' + sep)`) would be
   a *loosening* of a check four review rounds shaped, so the imprecision is kept
   and asserted as deliberate. Cost: an agent cannot create a file whose name
   starts with two dots.

3. **The tools needed the workspace root resolved, and this was a real bug.**
   `resolveInside` compares a `realpath` against the root it was given, so an
   unresolved root refuses every *existing* file whenever an ancestor is a symlink
   — the ordinary case for a temp directory on macOS. `verify()` resolves its root
   before the first call; `ToolHost` did not, so `read` reported "outside the
   repository" for a file plainly inside it. Caught by the truncation test, fixed
   by resolving once and caching.

4. **The transcript's per-turn `result` marker precedes that turn's tool calls.**
   The SDK's runner yields the assistant message and only then executes the tools
   it asked for. That is the order things happened in, so the expectation was
   corrected rather than the code.

### Deliberately not done in 5a

- `src/agent.ts` and its hostile-fake suite are **kept**. `agentPrompt` still
  spawns `claude` in the container and still cannot reach a model, because the
  container is sealed — which is honest and already documented. The milestone
  lists only `egress.ts` for deletion, and deleting a passing adversarial suite to
  tidy up is the one thing the rules forbid outright. Both agent paths coexist;
  `plan.loop` selects the v1.5 one.
- The browser tools are 5f and are absent from `TOOL_SCHEMAS`; the suite asserts
  the exact tool list, so adding them will require saying so.

### Incidental fix, worth knowing about

`.claude/worktrees/*` holds full checkouts of this repository, so vitest was
collecting every test file **twice** — 18 files where there are 9 — and running the
container suite against a copy of `src` nobody is editing. The baseline's 737s was
roughly double what it needed to be, and a stale worktree could have failed on code
that is not the code under change. `vitest.config.ts` now excludes `.claude/**`.
The worktrees themselves are untracked and were left alone.

---

## 5b · the environment recipe

### What landed

| File | What it is |
|---|---|
| `src/recipe.ts` | The schema, its validator, the Postgres store keyed by repository, and `replayRecipe` — which runs install/migrate/seed in a session, boots each service in **its own named session**, and then polls. |
| `db/schema.sql` | A `recipes` table. Not append-only, unlike `events`: a recipe is current configuration, and what a run *did* with the one it was given is in the log where it cannot be edited. |
| `src/events.ts` | `ENV_READY` — the one new event class v1.5 adds to the spine — and `cause: 'environment'` on `VERIFICATION_ABORTED`. |
| `src/fold.ts` | `state.env`, and the refusal: an attempt with an `environment` setup abort is disqualified. |
| `src/runner.ts` | `Job.recipe`; the `serveTools` container replays it before announcing `ready` and reports what it observed on the channel. |
| `src/orchestrate.ts` | Emits `ENV_READY` for an observed healthcheck, or the abort plus `RUN_ENDED {error}`; **and the network asymmetry**. |
| `src/cli.ts` | `recipe show` and `recipe approve <draft.json> <owner/repo>` — prints the draft, explains that nothing sandboxes it, and takes a literal `yes`. |
| `prompts/recipe.md` | The drafting session. |
| `demo/` | The one repository with a recipe, with four seeded bugs written as the issue text a user would actually open. |

### Done-when, item by item

| The milestone asks | Where it is asserted |
|---|---|
| the seeded demo app boots from its recipe inside the sandbox, healthcheck passes, `ENV_READY` appears | `sandbox.test.ts` → *the demo boots from its recipe, and ENV_READY says what actually answered*. The payload carries `detail: 'HTTP 200'` and the three steps; the agent then fetches the page from inside the container and gets the buggy heading back. |
| a deliberately broken recipe folds to `errored` rather than to a tier | *a recipe that no longer boots the app is errored, never a tier* — status `errored`, `cause: 'environment'`, tier 3, `shownOnBase: false`, **and no model spent**: the loop is never started on a dead world, so the transcript is empty and nothing claims supervision happened. |
| the phase containers do not get the network, and a test fails if that changes | *the phase containers stay sealed while the agent sandbox has a network* — one run, three containers: the agent resolves `registry.npmjs.org`, and both judging containers report no DNS and no route while still executing the reproduction. |
| a run that never reaches `ENV_READY` ends `errored`, not `not_reproduced` | `fold.test.ts` → *folds a failed environment to errored, never to unresolved*. |

### The contradiction, and the reading taken

**"The fold refuses a run that claims a phase without `ENV_READY`" cannot be
implemented as written.** No stream in the repository carries `ENV_READY` — not the
demo fixture, not one of the adversarial fixtures, which are tiny generated git repos
with nothing to boot — so an unconditional refusal would fail all 494 existing tests,
and weakening them is the one thing the rules forbid outright.

The reading that preserves the stricter constraint, keyed on something that is
actually in the log:

- `ENV_READY` is emitted **only** for a healthcheck the Runner observed. The recipe's
  claim is never enough. (ADR-0013: "the recipe is testimony — the healthcheck
  passing is evidence.")
- A recipe that fails to boot produces `VERIFICATION_ABORTED {phase: 'setup', cause:
  'environment'}` and `RUN_ENDED {reason: 'error'}`, so the run folds to `errored` and
  never to `not_reproduced`. That is the operative sentence of ADR-0007's amendment.
- The fold-side refusal disqualifies any attempt carrying that abort — so a base run
  that is a perfectly clean red, with matching symptom and intact hashes, is still not
  credited if the world it ran in was never established. `fold.test.ts` asserts
  exactly that, and asserts that the other two `cause` values do **not** disqualify,
  so the change is as narrow as the case behind it.

**The agent sandbox gets the full bridge, not a registry-only allowlist.** ADR-0013
asks for "a package-registry route and localhost". ADR-0011 established that this
project cannot express "sealed plus one route" — `--network none` removes every
interface, the transport does not exist, and the version that claimed to do both
dropped the seal. ADR-0010's v1.5 amendment settles it: the agent sandbox "is not
contained, and it no longer needs to be", because no model credential, no GitHub
token and no event channel live there. So the agent container gets the default bridge
**only when a recipe is present**, and every other container — including an agent
container with no recipe, which is what 5a's seal test uses — keeps `--network none`.
The asymmetry is what the tests pin, in both directions.

## 5c · the two prompts

`prompts/repro.md`, `prompts/fix.md`, `prompts/recipe.md`, `src/prompts.ts`.

The gap was real and total: `src/agent.ts:40` said the prompt was the caller's
business, every prompt in the repo was a stub like `'fix it'`, and **nothing had ever
told an agent that `.engine/repro.json` exists**. A real agent would have produced a
commit with no manifest and `readReproFromCommit` would have thrown.

The tests are not "the prompt mentions the manifest". They read `REPRO_MANIFEST`,
`MAX_REPRO_FILES` and `MAX_REPRO_BYTES` **from `src/orchestrate.ts`** and assert the
prompt quotes those, so a prompt promising a limit the engine does not enforce fails
the suite. The two constants were exported for that purpose.

`describeEnvironment` builds the environment paragraph from the recipe's own services,
so a prompt cannot promise a booted service that never came up — it describes the same
facts `ENV_READY` is emitted for.

**Skipped: the live run.** No `ANTHROPIC_API_KEY`, so no run against a real model.
What is *not* skipped is the manifest contract itself: `sandbox.test.ts` drives a
scripted model that writes `.engine/repro.json`, commits it, and the engine accepts
it **without a retry** and registers `sh repro.sh`. That is 5c's done-when minus the
model, and the prompt-versus-code assertions cover the part a live run would have
exercised least reliably.

## Blockers and how each was routed around

| Blocker | Route |
|---|---|
| No `ANTHROPIC_API_KEY` | The loop is driven by a **local HTTP server that speaks the Messages API** (`test/fixtures/model.ts`). The SDK, the tool runner, our schemas, the dispatch into the container and the transcript are all real; only the model is scripted. 5a's done-when is therefore met rather than skipped, and so is 5c's manifest contract. What remains skipped is a run against a *real* model. |
| No registered GitHub App | 5e's webhook receiver, HMAC verification, intake mapping, JWT minting and the PR/comment calls are tested against recorded payloads, a generated key pair and a recording `fetch`. The live install is a `test.skip` naming the three environment variables that would unskip it. |
| No Postgres running | `src/recipe.ts`'s `saveRecipe`/`loadRecipe` and `src/store.ts` are the only untested paths, and they are three `client.query` calls each. `replayRecipe`, the schema validator and the SSE tail all take their I/O as injected functions and are tested without a database. Stated rather than glossed: **the recipe store's SQL has not been executed.** |

## The exact next step

Commit 5b and 5c, then 5d — which is mostly already built (`Job.only`,
`orchestrate()`'s container-per-phase, `verify()`'s split all exist). What 5d owes is
its *assertions*: the milestone asks that the `/tmp`-marker and `$TMPDIR/.seen`
fixtures now fail for a **different reason** — the file is not there because the
container is not the same one — and nothing in the suite currently says which reason
they fail for.
