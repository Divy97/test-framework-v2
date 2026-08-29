---
status: in progress
---

# Milestone 8 — the things milestone 7 named and did not do

Milestone 7 ended with a list rather than a conclusion: six items it had analysed,
priced, and left. This milestone is that list, and nothing else. No new capability
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
| **8d** a suite that is already red on the reported behaviour | M7: "an existing failing test is a free Tier 1" | |
| **8e** triage, before a container starts | M7: "the cheapest available reduction in false Tier 3s" | |
| **8f** onboarding proves the repository, not just the recipe | M7: "onboarding proves a recipe" | |
| **8g** the sham-fix control survives a repository with dependencies | M7's predicted limitation, observed | |

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
