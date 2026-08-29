---
status: built
---

# Milestone 8 — the things milestone 7 named and did not do

Milestone 7 ended with a list rather than a conclusion: seven items it had analysed,
priced, and left — five under "what this milestone did not touch, and should", one
defect it recorded as "still open", and one limitation it predicted and then
observed. This milestone is that list, and nothing else. No new capability
is invented here — every phase below already exists as a paragraph in
[milestone-7.md](milestone-7.md), written by the session that found it and had no
budget left to fix it.

The order is not the order they were found in. It is cheapest-first, because two of
them cost a model run every time they fire and one of them cost this project a
wedged suite.

| | | |
|---|---|---|
| **8a** a container that will not finish is stopped | M7: "`runContainer` has no timeout" | built |
| **8b** the recipe's own test command is judged where the agent will be judged | M7 defect 3, "still open" | built |
| **8c** the info request says what was actually missing | M7: "the info-request is a template" | built |
| **8d** a suite that is already red on the reported behaviour | M7: "an existing failing test is a free Tier 1" | built |
| **8e** triage, before a container starts | M7: "the cheapest available reduction in false Tier 3s" | built |
| **8f** onboarding proves the repository, not just the recipe | M7: "onboarding proves a recipe" | built |
| **8g** the sham-fix control survives a repository with dependencies | M7's predicted limitation, observed | built |

## 8a · a container that will not finish is stopped

Every timeout this engine had was inside a container. `verify` bounds each command,
`runAgentLoop` bounds the agent, `replayRecipe` bounds a step — and all three are
moot for a container that never reaches PID 1. `docker run` against a missing image
pulls by default, and against a daemon that cannot reach a registry that pull does
not return. Milestone 7 observed it on its own suite: `a container that could not
run says why` hung, and was written off as environmental.

It was environmental. It was also the only unbounded wait in the system, and the
first host-side one — everything below the container had been bounded for four
milestones by people who could not see this line.

Two changes, and the smaller one is the fix:

- **`--pull never`, on every container this engine runs.** Every image here is one
  we built — `plan.image`, `plan.agentImage`, `engine-env:<runId>` — so a pull is
  always a mistake, and refusing it turns an indefinite wedge into `No such image`
  in under two seconds. The test that hung now asserts a 60-second deadline it
  finishes in 1.9.
- **A wall clock per container**, `containerTimeoutMs`, an hour by default. Longer
  than anything legitimate (the agent's own ceiling is 30 minutes) because it is a
  guard against a wedge, not a scheduling policy.

**The ceiling has to name the container to be worth anything.** Killing `docker
run` unblocks the host and leaves the daemon running what it started: `--rm` fires
on an exit that, in this case, is never coming. So every container is named now,
the ceiling removes it by name, and `runContainer` awaits that removal before it
returns — fired and forgotten, "the container is gone" is merely false for a
shorter time. `a container that will not finish is stopped by the host` asserts
both halves: the stderr line that is the *entire* diagnosis (the Runner emits its
events when `verify` returns, and it never did), and `docker ps -a` afterwards.

## 8b · the judge's world is described by running in it

Milestone 7's third defect, left open: a recipe whose test command resolves from a
registry — `npx --yes pnpm@10 vitest`, the standard idiom — cannot run in a
container with no network. It cost three model runs to diagnose, and the reason it
was expensive is that the command is **the template the agent imitates**: the agent
copied the recipe's command style into its reproduction, so a recipe that needs the
network teaches the agent to write a reproduction that needs one.

The engine now runs that command where the reproduction will be judged, before
either agent starts. Not a static check for `npx --yes` — a heuristic blocklist is
the vibes this project refuses — and not an approximation of the phase container
either: milestone 7's *first* defect was `corepack enable` succeeding as root in the
environment build and failing as uid 1000 in the agent sandbox, so anything short of
the real thing answers a different question.

**So the probe IS a base phase**, with the project's test command in the place of a
reproduction: same image, same `--network none`, same clone, same restored
dependencies, same uid. Its events are discarded, and that is the point rather than
waste — they describe our environment, not the user's bug, and a `TEST_RUN` here
would be a second base-phase observation for the fold to pair against the real one.
What the engine learns about its own world travels on the reply channel, the way
`ReplayOutcome` already does (ADR-0006).

### The lie it found on the way

`describeEnvironment` told a booted agent that the judging container "has **none of
that** … nothing is installed in it", and that a reproduction may use "the language
runtime and standard library, and nothing else".

That was true when it was written and 7e made it false three commits later: the
phases run from an image carrying this repository's installed dependencies. Nothing
noticed, because 7e never opened `prompts.ts` — and a prompt is the one thing this
suite structurally cannot check, which is [ADR-0015's
amendment](adr/0015-the-model-is-behind-an-adapter.md) and the reason 7a exists at
all. The engine spent a milestone building the judge a `node_modules` and then told
the agent it was not there.

So the paragraph now says what the judge has (the dependencies, no network, nothing
running), what does not cross (anything the agent installs after that point), and
names the trap in the agent's own idiom: invoke `./node_modules/.bin/…`, not `npx
--yes …`. And the sentence 7a deleted for asserting an unmeasured result — *"The
project's own test command is `X`. It passes on this commit."* — comes back as the
observation it always should have been: what the command did, in the container that
will judge, with its output. When the probe did not run, the disclaimer stands.

**`already_red` is a first-class value here too.** A test command that exits
non-zero in the sealed world is the repository's own baseline, and the agent is told
so in those words — 7d's rule, one layer up. Only a command that could not *run*
there is described as something not to imitate.

### What is asserted

- `prompts.test.ts` — the words, because nothing else can check them. Including
  `not.toMatch(/nothing is installed in it/)`: the claim that stopped being true
  comes back here if it comes back at all.
- `sandbox.test.ts` — a recipe whose `test` lives in a **gitignored** path, so it
  exists only in what `install` wrote: it exits 0 in the probe, which no bare clone
  and no build container could report. And its pair, a test command that reaches for
  a registry, which does not.

## 8c · the info request says what was actually missing

Every Tier 3 shipped the same four-item checklist — exact steps, expected versus
actual, account state, environment — while the agent that had just spent twenty
turns on the issue knew precisely which single fact it lacked. That knowledge was
in the transcript and was discarded; what the comment shipped of it was the
transcript's *length*.

**Testimony is admissible here, and it is worth being exact about why.**
[ADR-0006](adr/0006-testimony-vs-evidence.md) forbids testimony becoming a *fact* —
the agent cannot append events, and no verdict may rest on what it says. An info
request is not a verdict. It is a question, and the run that just looked is the only
thing in the system that knows what to ask. So the agent's last message is quoted,
labelled as its account, and explicitly marked as unchecked. The checklist stays as
the fallback for a run that had no agent or whose agent said nothing usable — which
is the negative control, because a comment that always quotes and never lists is the
same bug facing the other way.

Read in `run.ts` rather than `report.ts`: the text lives in the blob store, and the
report builder is a pure function of the fold that reaches for nothing. `RunState`'s
transcript carries hashes, which is the right thing for a fold to carry.

### The half that was not in the plan

**An agent that was cut off does not become a question for the reporter.** Every
`stopped` value but `exit` means a ceiling of ours ended the run — and milestone 7
hit exactly that twice, when a model ended its turns inside its own reasoning and
the engine's diagnosis accused it of handing over a commit the repository already
had. Asking that reporter for better steps bills them for our limit. A cut-off run
now says so, names what stopped it in plain words, states that nothing here is a
finding about the report, and asks for nothing but a re-run.

Its last sentence is the honest one: *"If it stops here twice, the report is probably
fine and the bug is ours."*

### What is asserted

- `github.test.ts` — the quote, the label, the missing checklist; the fallback when
  there is nothing to quote; the cut-off run; and a hostile last word, which is
  quoted line by line because the agent's text is attacker-influenced twice over
  (the issue steers it, and so does the repository it read).
- `run.test.ts` — end to end, through `runFromIssue`. The assertion that used to
  pin the checklist now pins what the agent actually said: *"There is no Export
  control anywhere in this project."*

## 8d · a reproduction the repository already had

Milestone 7: *"A repository whose suite is already red on the reported behaviour
contains the reproduction, authored by a maintainer — the strongest provenance the
design recognises, and unreachable today because nothing looks."*

Two things were missing, and only one of them was looking.

**The agent had no way to say it.** The manifest format accepted `files` and
nothing else — paths whose bytes the engine reads out of the agent's commit and
writes over both checkouts. There was no way to name a test that is *already there*,
and the prompt correctly told the agent that naming a tracked path would be refused.
`pinned` is now part of the manifest: names, never bytes, read from the base
checkout and hashed there. A path cannot be in both lists, and the manifest is
refused if it tries.

**The engine had no way to credit it.** [ADR-0018](adr/0018-a-reproduction-the-repository-already-had.md)
records the decision and its four clauses, each one an observation rather than a
claim: nothing applied, every path tracked at the base commit, the command is the
project's own test command over those paths, and there is a project test command at
all. `REPRO_REGISTERED` now carries `committed` — which of the registered paths git
had at base — because a log carries no tree and nothing downstream could ever ask.

The clause that matters most is the one that looks pedantic: **being in the tree is
not provenance.** Since 7e every phase container is handed a restored dependency
tree, and a file in `node_modules/` is present in both phases, identical in both,
and authored by nobody. `test/verify.test.ts` pins that with a gitignored test that
satisfies every other clause and is still refused.

### What it does not claim

- **The runner is not anchored.** The test is hashed on every run; what runs it is
  not. Stated in the score's own `unmeasured` list rather than left for a reader to
  work out, and the fix diff is the mitigation.
- **The symptom rule still decides most cases.** A maintainer's test that fails for
  the right reason in its own words is not credited, and `prompts/repro.md` says so
  rather than inviting the agent to contort someone else's test into printing our
  string. The ordinary run stays Tier 2, and that is the honest expectation.

## 8e · triage, before a container starts

Milestone 7: *"The reporter is at the keyboard at t=0 — the only moment a question
is cheap."* Twenty minutes later they are somewhere else, and the four-item
checklist that arrives then is a template nobody answers.

So a cheap model now reads the report against the repository's file listing before
any container starts, and answers one question: could an engineer who has never seen
this project begin? If not, it names the single most useful missing fact, and the
engine asks it immediately.

**It never gates, and that is the design rather than timidity.** This project's own
precedent is 7c's: *a check that convicts honest work does not get to end runs* —
and the thing convicting here would be a cheap model's opinion of somebody's bug
report. So the question is asked and the run proceeds; the two race. If the run
wins, the reporter gets a pull request and the question cost a cent. If the gate
holds, the answer is already on its way.

The comment says three things, and each one is there for a reason: that a run has
started (the engine used to say nothing at all until it was finished), the question,
and **where the question came from** — a model reading their report — because a
question whose provenance is visible is one the reporter can also dismiss.

### The parts that needed building

- **`askOnce`.** `runAgentLoop` could not serve this: it sends `thinking: adaptive`
  and `output_config.effort`, which the cheap models this exists for reject
  outright, and it offers a tool surface to a caller with nothing to execute. One
  prompt, one answer, no tools — and both providers, because
  [ADR-0015](adr/0015-the-model-is-behind-an-adapter.md) made the model an adapter
  and a capability that worked on one provider would quietly undo that.
- **A cheap model by name.** `claude-haiku-4-5`, and `anthropic/claude-haiku-4-5` on
  the OpenRouter path — which is this project's *default* provider, so without the
  second name the cheap path would have asked its one-sentence question of a
  thinking model.
- **A parser that refuses to invent.** The first non-empty line, only if it contains
  a `?`. A model that ignores the instruction and diagnoses the bug instead gets
  nothing posted — the engine asserting an unmeasured cause is the one thing it
  never does.

### The bug in the first draft of the test

Three of the eight triage tests passed on a version where **triage never worked at
all**: the fixture speaks the Messages API, the test did not name a provider, this
project's default provider is OpenRouter, and the Anthropic-shaped answer came back
through the OpenRouter branch as `null`. Every assertion expecting `null` passed.

It is written down because it is the same shape the project has hit repeatedly — a
test passing for a reason unrelated to the code — and because the thing that caught
it was having the positive case at all.

## 8f · onboarding proves the repository, not just the recipe

6b gave the drafting run a trigger and a human an approve button. What neither gave
anyone was an answer: the first time it was known whether those commands actually
work was in the middle of a real run, twenty minutes after a stranger filed an
issue — where it arrives dressed as a finding about their bug.

Approving a recipe now starts a **proving run**: it builds the environment from that
recipe and runs the project's own test command in the sealed container that judges a
fix. Three states come out — `ready`, `ready_with_caveats`, `blocked` — and the state
is derived from those two observations rather than asserted beside them.

**The same two containers a real run uses**, and not a cheaper approximation. The
whole value is that the answer is the one a run will get: an onboarding check that
passes where runs fail is worse than no check, because it certifies a repository into
a false Tier 3.

**At approval, not at drafting.** A draft is a proposal, and there is nothing to
prove about commands nobody has agreed to. The moment they become the commands this
engine will execute verbatim is the moment they are worth executing once, while a
human is still looking at the page.

### The caveat that was the point

*"Run the suite and record its colour at HEAD — which decides whether every future
regression arm is interpretable."* A repository whose suite is already red at HEAD
gets `already_red` from 7d's second arm forever, and 7d's own rule is that such a
repository must never be told its own state is a fix's fault. Now the human is told
at connect time, in those words: what it costs, and that nothing here is a claim
their project is wrong.

The other two caveats are the same shape: a recipe that installs nothing (correct for
a project with no dependencies, a false "could not reproduce" for one that has them),
and a test command that cannot run sealed (8b's finding, surfaced at the moment
somebody can still fix it).

### What is stored, and what is not built

The proof lives in the `recipes` row, not a table of its own — a proof is an
observation about a specific set of commands, so approving a new recipe has to
invalidate it, and here that is a fact about where the bytes live rather than an
invariant to remember. It is read back as opaque JSON and rendered defensively: a
proof written before a field existed is still the best thing anyone has about that
repository.

Milestone 7's list had two more items, and they are **named rather than silently
absent** — the page prints them under "not checked by this engine at all", apart from
the repository's own caveats, because collapsing the two would tell someone their
project is missing something that is ours:

- **the single-test invocation**, which nothing has executed;
- **a screenshot of the booted app** as a UI baseline.

Both need an agent session with a network and a browser — a drafting-shaped run —
which is a different thing from the two sealed containers this is.

## 8g · the control survives a repository with dependencies

Milestone 7 predicted this the moment the environment snapshot was built, and then
observed it exactly: *"the sham-fix control's `git clean -xdff` takes the restored
environment with it, so its second draw exits 127 on a dependency repository —
conservative, never a false accusation, but blind."*

Conservative is right — 127 is never green, and the control only accuses when both
draws go green, so nobody was ever falsely convicted. Blind is the problem: on
exactly the repositories 7e existed to support, the strongest anti-gaming check in
the engine ran once and then stopped running, and nothing said so.

**The fix is one flag.** The control's own scrub drops `-x`, so the ignored paths
survive it. What `-x` was protecting against there is already handled: the sham is a
tracked-file edit plus a commit, and the `reset --hard` on the line above undoes
both. And a reproduction that plants an ignored flag between draws is the
order-dependence that repeated draws exist to *expose* — this file's own reasoning
about the base repeats says the shared tree is deliberate, *"because isolating them
would hide the order-dependent flake they exist to catch"*.

The phase boundary keeps its `-x`, unchanged. That scrub is about what the base phase
could leave for the fix phase to read, and in production those are different
containers anyway, each restoring its own environment.

**The test was checked against its own absence.** With `-xdff` restored it fails on
the assertion that names the defect — `exit_code` 127 on the second draw — and with
the flag removed it passes. A control test that passes either way would have been
this project's most familiar bug: an assertion satisfied by the check never running.

## A real model ran against all of it

The suite proves the engine accepts a well-formed answer; it can never prove the
prompt asks for one ([ADR-0015](adr/0015-the-model-is-behind-an-adapter.md)). This
milestone changed three prompt surfaces — `describeEnvironment`'s two-worlds
paragraph, `prompts/repro.md`'s section on a reproduction the repository already had,
and `prompts/triage.md`, which did not exist — so the suite being green said nothing
about any of them.

**The full run held.** `scripts/real-run.mts` against the demo repository, a real
model, no scripted turns: base red **twice** with the reported symptom matched, fix
green **three** times with the symptom gone, the project's own suite green on both
commits, **Tier 2, 98/103**, and a pull request body that renders the Tier-1 cap
paragraph correctly — which is the line 8d moved off `reproAuthoredByAgent` and onto
the tier, and the run is where that would have shown up as a document contradicting
its own headline. The agent read the rewritten environment paragraph and wrote a
reproduction that survived the boundary.

**Triage did not hold, and one call found it.** Given a precise, reproducible report —
an endpoint and the wrong value it returns — the first version of `prompts/triage.md`
asked *"what steps did you take to set up and run the application, and what data did
you use"*. Both halves are answerable by reading the repository, which that prompt
forbids asking for, and two asks joined by "and" is two questions, which it also
forbids. **The prompt stated both rules and neither held.**

Rewritten around the bar instead of the rules — *most reports are enough*, the test
is "could a competent engineer make a first attempt", and the two prohibitions carry
a worked rewrite rather than an assertion. Measured after:

| report | answer |
|---|---|
| an endpoint and the wrong value it returns | `ENOUGH` |
| a heading with a visible typo | *"What did you expect the heading to say instead of 'Ordres'?"* |
| "export is broken again, please fix" | *"What does the export do that it should not — an error message, a wrong file, nothing at all, or something else?"* |
| "some users see an empty dashboard, others do not" | *"Does the empty dashboard appear for specific user accounts, roles, or data states, or is it random?"* |

Single questions, all of them, and every one asks for something only the reporter
knows. **The second row moved the wrong way** — it answered `ENOUGH` before the
rewrite — and it is recorded rather than tuned away, because iterating further would
be fitting four samples. Triage never gates, so an unnecessary question costs one
comment line and a missing one costs a run.

## Honest status

`npm run typecheck` is green. Worth saying, because it was red on `main` through
milestone 6 — a `RunPlan` missing `symptomPattern` in `sandbox.test.ts` — so a red
typecheck now belongs to whoever made it red.

- **Without Docker: 496 passed, 1 skipped**, across 26 files.
- **The containment suite: 58 passed, 1 skipped, 0 failed.**

Milestone 7 ended at 412/417 with three named failures, and two of them are gone here
rather than rounded off: `a container that could not run says why` hung for the whole
of that milestone and finishes in 1.9 seconds now (8a), and `the phases share no
tree…` was repaired at the end of 7 and holds. The third was a 300ms timing test under
full parallelism, and it passed every run of this milestone.

**What is still not covered.** No prompt is checked by any of the above. The four
triage measurements and one real run are what stands behind this milestone's prompt
changes, and they are four samples and one run.
