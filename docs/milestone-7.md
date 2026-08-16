---
status: in progress
---

# Milestone 7 — the harness around the fix

Milestone 5 produced a run worth watching and milestone 6 sketched the product around
it. This one is neither: it is about whether the thing in the middle is actually
measuring what it claims.

The question that started it was not "what should we build next" but "what does the
engine *know*, and how does it know it". Written down here because the answer changed
several load-bearing beliefs, and because two of the things it found were wrong in our
own documents rather than in the code.

## The frame: five links, and what measured each one

The engine is a certification pipeline for a causal chain. **Report → defect →
reproduction → fix → nothing-else-broke.** Five links, each needing an independent
measurement. The state before this milestone:

| Link | Claim needed | What measured it | |
|---|---|---|---|
| report → repro | the reproduction is about *this* bug | a literal string from the issue appears in base stdout | vacuous |
| repro → base | it fails here | **one** execution | undersampled |
| repro → defect | fails from the bug, not from the commit's identity | sham control (advisory) + the Tier-2 cap | honestly unmeasured |
| defect → fix | repairs the cause | nothing — flake re-runs measure determinism, not causality | unmeasured |
| fix → the rest | nothing else broke | **nothing at all** | absent |

And beneath all five, one precondition nobody had written down: **the judge's world must
equal the world the reproduction was proven in.** It does not. That one makes the other
four moot on any repository with dependencies — see 7e.

## What landed

### 7a · the agent is told the truth about its world

`describeEnvironment` stated *"There is no network"* unconditionally. `orchestrate.ts`
gives the agent sandbox the default bridge whenever a recipe exists, which is every
shipping configuration — so the prompt was false exactly when the product is real. The
constraint that IS true, and matters far more, was stated nowhere: the container that
judges the work has no network, nothing installed, and no services running.

The same function asserted *"The project's own test command is `X`. It passes on this
commit."* `recipe.test` appeared in exactly one place in `src/`: that sentence. Nothing
had ever executed it. We asserted an unverified result to the party we then judged.

Both replaced with what was observed. The prompt now names the asymmetry between the two
worlds, because a reproduction that cannot survive the boundary is the most common way a
correct reproduction fails.

**Guarded by:** `prompts.test.ts`, including `expect(text).not.toMatch(/snapshot/)` —
which exists because the first draft of this fix described the *snapshot's* world (7e,
not built), replacing one false claim about the environment with another.

### 7b · the fix agent is given what the engine saw

It had the registered command and never its output, so its first act was always to re-run
the command to rediscover a failure the engine had already observed and hashed. Worse
when the two disagree: the sandbox and the phase container are different worlds, so "run
it yourself" is not guaranteed to show the failure the verdict is taken from.

The fix prompt now carries the tail of base's actual output, read out of the blob store,
plus the suite baseline (7d). `RunPlan.agentPrompt` takes a `FixContext` rather than a
`ReproSpec`, because everything worth adding here is a fact the base container observed
and the caller cannot know in advance — the command was the first, and it will not be the
last.

### 7c · the symptom anchor means something, and the base phase repeats

`symptom_matched` was recorded on base only. So the anti-gaming check was satisfied by a
`console.log` of the symptom string on any code path at all — and `prompts/repro.md`
asked for precisely that print: *"on its own line, alongside whatever else you want to
say."* The engine handed the agent the string, told it to print it unconditionally, and
treated the echo as evidence the failure was about the reported bug.

It is now observed on both sides, and the fix prompt asks for it to come from the failing
path.

**It is priced, not gated, and that is the interesting part.** Gating on "absent from the
fix" was implemented, and `eofBug` refuted it within the hour: a missing terminating
newline, reported as `wrong`, honestly reproduced by a test that prints the file. The
fixed file still says `wrong` — only the newline changed. Any rule requiring the symptom
to vanish refuses a correct reproduction of a real bug.

That is the same false-positive class that took the sham-fix control six rounds to reach,
and the precedent governs: **a check that convicts honest work does not get to end
runs.** The observation is kept, shown in the pull request table, and priced by
`confidence()` at 8 points — which is exactly ADR-0004's split between facts the engine
observed and how much they are worth. `eofBug` is now a permanent test so the gate cannot
come back.

The base phase also **repeats** (two draws by default). It was run once while the fix was
run three times, so the largest single ground in the score — 45 points — rested on one
sample. Red-then-green is only evidence if the red is reliable.

### 7d · the second arm

The project's own test command, executed by the engine on both commits, as a distinct
fact class. Full reasoning in [ADR-0016](adr/0016-the-second-arm.md). The short version:
a fix that turned the reproduction green and forty other tests red scored full marks and
opened a pull request that said nothing about it.

Two things in it were not obvious until they were built:

- **The applied reproduction leaves the tree while the suite runs.** Every real suite
  discovers test files, so a reproduction that *is* a test file gets collected by the
  project's own suite and fails the baseline for our own reason. Without this the arm
  reports `already_red` forever — a check that says "cannot tell" in every case, reading
  as caution and behaving as a bug. It shipped with this defect and no tests; the
  fixture that pins it is `suiteThatDiscoversTests`.
- **`already_red` is a first-class value.** A repository that arrived with failing tests
  must never be told that state is its fix's fault.

## 7e · what did NOT land, and why it is the largest item

**The judge has no dependencies installed, so this engine can only certify repositories
that need none.**

The agent sandbox replays the recipe, so `install` has run: the repro agent boots the
project, writes a reproduction, proves it red, commits. The phase containers replay
nothing, hold no recipe and run `--network none` — they clone the commit and run the
command against a bare checkout, and a dependency is a gitignored path so it is not in
the commit either. `npm test` there is exit 127, the output does not contain the reported
symptom, the fold correctly refuses it, and the reporter is told **we could not reproduce
your bug.** Every step is right and the conclusion is false. On a React or Next.js
repository — the stack this is aimed at — it is the outcome every time.

It was invisible through 352 green tests because every adversarial fixture is a shell
script and `demo/` has zero dependencies and runs on `node --test`.

**The intended fix, and the obstacle that stopped it landing here.** Snapshot the agent
container after `replayRecipe` reports ready and *before* the agent's first tool call
(`docker commit`), and run the phase containers from that image with `--network none`
intact. The agent cannot poison it because it has not run yet, and the image digest
becomes an artifact ref — which makes ADR-0010's title literally true rather than
aspirational.

The obstacle is that `install` writes into **gitignored paths**, and the phase-boundary
scrub (`git clean -xdff`) destroys those deliberately — that is what catches
`IGNORED_PATH_REPRO`. So the snapshot needs an ignored-path restore into each phase's
clone, in `runner.ts`, the file with four adversarial review rounds behind it. That is
its own PR with its own adversarial round, not a rider on this one.

**The defect is pinned rather than described**: `verify.test.ts`, *"a reproduction that
needs an installed dependency reports NOT REPRODUCED"*, asserting exit 127,
`symptom_matched: false`, tier 3 and no abort — a false Tier 3 caused entirely by us,
with a regression guard that goes green when the snapshot lands.

What the snapshot unblocks, all at once: real repositories become verifiable; phase
containers can boot services, so API and browser reproductions become judgeable; the
regression arm becomes worth something on repositories that have dependencies;
`--network none` everywhere becomes achievable, which is 6e's precondition for secrets;
and coverage instrumentation becomes *possible* in the phase container, which is the
precondition for diff-coverage — still the only measurement that would lift an
agent-authored reproduction above Tier 2.

## What this milestone did not touch, and should

Named here so the next session starts from the analysis rather than redoing it.

**Triage, before a container starts.** The reporter is at the keyboard at t=0 — the only
moment a question is cheap. A cheap model reading the issue against the file tree can
answer "is there enough here to attempt a reproduction" for a fraction of a cent, and ask
for the specific missing thing immediately instead of answering twenty minutes later with
a template. This is the cheapest available reduction in false Tier 3s and it does not
exist.

**The info-request is a template.** Every Tier 3 gets the identical four-item checklist
while the agent that just spent twenty turns knows exactly which one fact it lacked. That
knowledge is in the transcript and is discarded; the comment ships the transcript's
*length*. An info request is not a verdict, so testimony is admissible here —
ADR-0006 forbids testimony becoming *facts*, not testimony being displayed as a question.

**Onboarding proves nothing today.** 6b's drafting run has no trigger. Beyond the trigger,
the connect-time job is not "draft a recipe" but *prove the repo runs and record what
could not be proved*: boot it, snapshot it, run the suite and **record its colour at
HEAD** (which decides whether every future regression arm is interpretable), discover the
single-test invocation by executing it, screenshot the booted app as a UI baseline. Then
one of three states — ready, ready-with-caveats, or blocked with each missing item priced.

**An existing failing test is a free Tier 1.** A repository whose suite is already red on
the reported behaviour contains the reproduction, authored by a maintainer — the
strongest provenance the design recognises, and unreachable today because nothing looks.
The suite run added in 7d is the mechanism; nothing consumes it that way yet.

**`runContainer` has no timeout.** A missing image plus a stalled registry wedges a run
indefinitely — observed while running this milestone's suite.

## Honest status

The last full run with Docker up was `412 passed / 417`. Its three failures are named
rather than rounded off, because two of them are not this milestone's and one of them was
never anybody's:

1. **A registry the daemon could not reach.** `a container that could not run says why`
   runs a nonexistent image on purpose, and `docker run` hangs attempting a pull —
   `docker pull hello-world` hangs on this machine too. Environmental, and it is what
   surfaced the missing `runContainer` timeout above.
2. **One 300ms timing test** (`closing the host kills a service…`) under a fully parallel
   suite plus Docker load. `20/20` in isolation. Pre-existing sensitivity, untouched here.
3. **`the phases share no tree…`, which was wrong for four milestones.** It compared
   `ls -di` inode numbers — unique only within a filesystem, so two identically-built
   containers get handed the same one. Widening it to `stat -c '%d:%i'` did not help
   either: Docker Desktop runs every container inside one shared overlay VM, and both
   sides report `63:1247463` for genuinely separate containers. It is now a probe with no
   comparison plus a comment saying why, because an assertion that cannot hold reads as
   enforced and is not. `HOST` and `PID1` carry the claim and are decisive: a different
   hostname and a different PID 1 mean a different mount namespace, so a different tree
   by construction rather than by inode arithmetic. **Fixed and verified passing
   individually** — so a clean-environment run is 416/417, failing only on (1).

**A real model has now run against all of it, and every change fired.** With a working
key, `anthropic/claude-sonnet-5` through OpenRouter took the `shipped-filter` issue to a
credited **Tier 2** pull request in 95 seconds for **$0.064**:

```
base  exit=1 symptom_matched=true      <- red twice (7c), was one draw
base  exit=1 symptom_matched=true
fix   exit=0 symptom_matched=false     <- symptom GONE, three times (7c)
fix   exit=0 symptom_matched=false
fix   exit=0 symptom_matched=false
regression clean                       <- the second arm (7d), on both commits
tier 2, confidence 98/103
```

The agent put the symptom on the failing path unprompted by anything but the rewritten
`prompts/repro.md`, which is the +8 that could not have been scored before. `node --test`
executed on base and on fix inside a sealed container, which had never happened against a
real agent's commit. 98/103 under `scoring: 2`; the old scale's best was 80/85.

Hand-rendering the prompts caught one defect no test could before any of that: the first
draft of 7a described the snapshot's world, which is not built.

**What the first two attempts found was a model, not a prompt.**
`moonshotai/kimi-k2-thinking` failed reproducibly, 2/2, by ending turns *inside its own
reasoning* — once leaking its next call as text (`<|tool_call_begin|>functions.read`),
once stopping mid-sentence while planning the commit. The second attempt had explored the
repository, driven the browser, seen the bug live and written the reproduction; it simply
never reached `git_commit`.

The engine held correctly both times — no false PR, an honest Tier 3 — but its *diagnosis*
was ours and it was wrong: "the agent handed over a commit the repository already had",
an accusation of idleness against a model that had done nearly everything.
`stopped: 'malformed_tool_call'` now names it, on the narrow signal that produced it
(reasoning present, content empty, no tool call), with a negative control so an honest
prose refusal is still a real ending. `probeToolCalling` cannot cover this: it is one
turn, and the model makes structured calls perfectly well for seven of them first.
