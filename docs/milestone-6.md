---
status: draft
---

# Milestone 6 — the product around the run

v1.5 made a run worth watching. Nothing lets a person *start* one without an
operator sending them a URL by hand, and nothing shows them what happened except a
pull request. This milestone is the surface: onboarding, identity, and the one
screen this system can show that nobody else can.

Written before any of it is built, for a reason that is specific to this
conversation: the last milestone shipped with **three documents that contradicted
the code** — the App's permission set, the installation flow, and a claim that a
queue provided a guarantee it did not. Every one was found by running the thing, not
by reading. So each phase below names the test that would catch its document going
stale.

## What this is not

**Not a rewrite, and not a monorepo restructure.** `Dockerfile` and
`Dockerfile.agent` copy `src/`, and the sandbox suite asserts container paths like
`/work/verify/repo`. Moving `src/` under `packages/engine/` would churn the Docker
builds and the path assumptions that are the spine of the adversarial suite, for
nothing. The web app is `web/`, a sibling of `demo/`, excluded from vitest the same
way.

**Not a source of truth.** The README's first architectural claim is that there is
no runs table and every projection is a disposable cache. Everything built here is
droppable and rebuilt by replay. *"Delete the entire dashboard database and it
rebuilds from the log"* is the property, and it is also the most interesting thing
this milestone produces.

---

## 6a · the installation is a fact we record

Today `installation.id` arrives on every delivery and is thrown away, and
`intake()` answers `202 not a trigger` to the `installation` event itself. So the
first thing we ever learn about a repository is an issue — by which point a run has
already started with `recipe: null`, boots nothing, and produces a Tier 3 about a
bug that was never shown. **A user's first experience of the product is a wrong
answer.** That is the gap this phase closes.

- `intake()` accepts `installation` (`created`, `deleted`) and
  `installation_repositories` (`added`, `removed`) alongside `issues`.
- An `installations` table: `installation_id`, `repo`, `account`, `connected_at`,
  `removed_at`. Not append-only — it is current configuration, like `recipes`, not
  a fact about a run.
- An issue on a repository with no approved recipe gets a **comment saying the
  repository is not onboarded yet**, and no run starts. Not a Tier 3.

**Done when:** an `installation` delivery is recorded; an `issues` delivery for an
un-onboarded repo produces a comment and **zero** `RUN_REQUESTED` events; a
`removed` installation stops accepting its issues.

**The test that keeps this honest:** the existing endpoint-drift test in
`test/serve.test.ts` already fails when a new GitHub API call appears. Extend the
same idea to events — assert the set of webhook events `intake()` accepts is
exactly the set `docs/github-app-setup.md` tells the operator to subscribe to. The
permission set was wrong for a whole milestone because no document was ever checked
against the code.

---

## 6b · onboarding, where the recipe already has a place to live

ADR-0013's flow exists on paper and has no trigger: *an agent drafts a recipe, the
user corrects and confirms it, we store it keyed by repository.* Today
`cli.ts recipe approve` reads a JSON file a human wrote.

- Installation (6a) is the trigger, not the first issue.
- A drafting run: the agent explores the repository and writes a recipe draft. This
  is `extractRecipeDraft` and `prompts/recipe.md`, which already exist.
- The draft is shown for confirmation and only then stored. `saveRecipe` already
  does the storing.

**Done when:** connecting a repository with no recipe produces a draft the user can
edit and approve in the browser, and the approved recipe is byte-identical to what
`recipe show` prints.

**Named, not solved: environment variables.** A real repository does not boot
without them, and `Recipe` has no field for them. This is deliberately **out of
scope here** and specified in 6e, because it is a security decision rather than a
form.

---

## 6c · the read model

- A `runs` projection: `run_id`, `repo`, `issue_number`, `status`, `tier`,
  `confidence`, `started_at`, `ended_at`, `pr_url`. Every column derived from
  events — `repo` and `issue_number` from `thread_ref`, which is `owner/repo#41` on
  every `RUN_REQUESTED`.
- A rebuild command that drops it and replays.
- `GET /runs?repo=`, `GET /runs/:id` (timeline + confidence with its cited
  artifacts). The SSE tail at `/runs/:id/events` already exists.

**Done when:** dropping the projection and replaying produces byte-identical rows,
asserted as a test rather than as a claim.

---

## 6d · what a run cost

`AgentTranscript.usage` is totalled and reaches `RunResult.usage`, and `serve.ts`
logs it and drops it. It is deliberately **not** an event: inventing an event class
to describe our own spending would put a fact about us in a log about the user's bug
(ADR-0006).

- A `run_usage` table beside `events`, not inside it: `run_id`, `phase`, `turns`,
  `input_tokens`, `output_tokens`, `provider`, `model`.
- Per-repository totals on the dashboard.

**Done when:** a real run's row matches what the provider billed, to the token.

---

## 6e · secrets, and the boundary that has to move first

**This phase is blocked on a decision, not on code**, and it must not be built as a
form until the decision is made.

Injecting a user's environment variables into the agent sandbox breaks the
justification the architecture rests on. Three facts:

1. `orchestrate.ts` gives the agent sandbox **full network** whenever a recipe
   exists — it needs a registry for `install`.
2. The agent is untrusted by construction, and its prompt contains the issue body,
   which `github.ts` names as attacker-influenced text.
3. The README: the agent sandbox *"is not contained … affordable only because
   **nothing worth stealing lives there** and nothing it produces is trusted."*

Put a production `DATABASE_URL` in there and (3) is false: an untrusted agent,
partly prompted by text a stranger wrote, holding real credentials, with egress.

There is also a leak path **today**, before any UI. Env vars live inline in recipe
commands (`PORT=8080 node server.mjs`). On failure, `recipe.ts` builds
`recipe step ${step} failed: ${command}` and `orchestrate.ts` writes it to
`VERIFICATION_ABORTED.reason`. Events are append-only and immutable by construction
(ADR-0001, ADR-0002) — **a secret written there can never be deleted**, and failure
is exactly when a misconfigured secret appears.

What this phase must include, in this order:

- **Redact before anything else.** A secret must never be able to reach a payload,
  a blob, or a log line. This is worth doing even if no UI is ever built.
- Secrets **not** in the recipe object: the recipe is displayed by `recipe show`,
  stored as plain `jsonb`, and its command text can reach the log. A separate
  encrypted table, referenced by name, resolved at injection.
- Env scoped **per service**, plus separately for `install`/`migrate` — a monorepo
  has a different `.env` per folder, so one global map does not model the real case.
- The UI states the contract in its own copy: **non-production values only.**
- An ADR recording that this breaks "nothing worth stealing", and naming the real
  fix: pre-warm dependencies into the agent image so the recipe needs no registry,
  then `--network none` everywhere. Only then are production values defensible.

**Done when:** a redaction test proves a secret-shaped value in a failing recipe
step does not appear in any event, blob, or log line — and the ADR exists.

---

## 6f · the surface

- A landing page: what the system does, and one **Install** button pointing at
  `github.com/apps/<slug>/installations/new`. GitHub owns the install screen; we do
  not rebuild it.
- Sign-in with GitHub, **for identity only**. Worth stating plainly: this is not a
  personal access token and grants no repository access, so it does not contradict
  ADR-0012's "no personal access token is ever requested" — but it *is* a second
  auth mechanism and needs recording as an amendment rather than slipping in.
- Repository list with an onboarding status per row.
- Run list, and **the evidence view**.

**The evidence view is the point of this milestone.** Every product in this category
has a landing page and a run list. The screen that is rare is the one showing base
red for the reported symptom, fix green three times, each confidence point traceable
to a content-addressed artifact, and — on a Tier 3 — the gate visibly **refusing to
attempt a fix**. All of it is already backed by data. Build that screen well and the
rest can be plain.

**Done when:** a Tier 3 run renders as a finding with a reason and no diff, and a
Tier 2 run renders base-red/fix-green with every hash resolving to bytes in the
store.

---

## Not in this milestone

Slack and CLI connectors · multi-repo runs · deployment and preview URLs · a
streamed browser · diff-coverage instrumentation (still the only thing that would
lift an agent-authored reproduction above Tier 2) · autonomous Sentry-triggered runs
· raising the concurrency of `serve.ts`'s queue (it serialises as a resource policy —
one run is five containers — **not** because ports collide, which an earlier draft of
this document claimed and which is not true: services bind inside each run's own
container namespace and nothing is published to the host).

## What "done" looks like

A person who has never spoken to us installs the App from a public page, is walked
through approving a recipe for their repository, opens an issue, and watches a
timeline that ends in either a pull request proving the bug existed or a finding
explaining why no fix was attempted — with every claim on that screen traceable to
bytes the engine executed.

And the read model can be deleted and rebuilt from the log without losing anything.
