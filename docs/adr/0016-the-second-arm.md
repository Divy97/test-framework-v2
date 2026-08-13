# ADR-0016: The second arm — the project's own suite, on both commits

**Status:** accepted
**Amends:** [ADR-0004](0004-verification-process-confidence-projection.md), [ADR-0008](0008-the-reproduction-is-anchored.md)

## Context

Everything the engine measured was one question: *did this change repair the reported
bug?* Red on base, green on the fix, same bytes both times, three re-runs against a
flake. That question was measured well.

The other question a maintainer asks — *did it break anything else?* — was measured
nowhere. `Recipe.test` existed, was quoted in the agent's prompt as *"the project's own
test command is `X`. It passes on this commit"*, and appeared in exactly one place in
`src/`: that sentence. Nothing had ever executed it. So the engine asserted a result it
had never observed, to the party it then judged.

The consequence was not subtle. A fix that turned the reproduction green and forty other
tests red earned every ground in the confidence score, reached Tier 2 at 80/85, and
opened a pull request whose five mandatory sections were silent about it. The document
this project calls its product was missing the fact its reader most needs.

## Decision

**Run the project's own test command on both commits, as a distinct fact class.**

`SUITE_RUN { phase, command, exit_code, stdout_hash, duration_ms }` — executed by the
engine at its own process boundary, like every other fact (ADR-0006). The fold derives
`regression` from it, with four values rather than two:

| | meaning |
|---|---|
| `clean` | green on base, green on the fix |
| `broken` | green on base, red on the fix — **this change breaks something else** |
| `already_red` | red on base too, so nothing here is attributable to the fix |
| `unmeasured` | no suite ran on both commits: no test command, or the run stopped first |

Three things follow, and each one is a decision rather than an implementation detail.

**A separate event class, not another `TEST_RUN.phase`.** Every fold filter that decides
credit keys on `phase === 'base' | 'fix'`. A new phase value would enter the
reproduction's credit path by default and have to be excluded at each site by hand — the
mistake `control` avoided by being explicit. A different kind of observation gets a
different fact class.

**The applied reproduction leaves the tree while the suite runs.** Real suites discover
test files: `node --test` walks the tree, `pytest` collects, `go test ./...` compiles
everything. A reproduction that is a test file — the ordinary case — is therefore picked
up by the project's own suite, which then fails on base for the very reason the
reproduction exists. The baseline would be red on every honest run and `regression`
would report `already_red` forever: a check that says "cannot tell" in all cases, reading
as caution and behaving as a bug. So the applied paths are removed, the suite runs, and
they are put back in a `finally`. Pinned paths stay — those are committed, part of the
project, and legitimately the suite's business.

It is removed *after* the reproduction has run rather than before, because the
reproduction's verdict is what the whole system rests on and a suite with side effects
must not run ahead of it.

**A red suite never ends a run, and never blames the repository.** `already_red` is a
first-class value for the same reason Tier 3 is: a project that arrived with failing
tests on its worst day must not be told that state is its fix's fault, and refusing to
proceed would refuse most real repositories. `broken` does not end the run either — the
bug *was* shown and it *was* repaired. What is withheld is the claim that the change is
safe, and that is withheld loudly: the ground scores zero and the pull request leads with
a warning banner, before the bug, before the evidence, before the tier.

## Consequences

`confidence()` gains a ground worth 10, a `ceiling` field, and **`scoring: 2`**. The
version bump is not bookkeeping: `80/85` recorded against version 1 — in
[ADR-0015](0015-the-model-is-behind-an-adapter.md)'s account of the first real run, and
in the README — remains a true statement about that run under that scale, and the version
is the only thing telling a reader which scale a number is on. It was left at `1` through
the whole of this change and caught afterwards, while re-reading ADR-0015, which is
precisely the drift the field exists to prevent.

The ceiling stops being 85 and stops landing on 100. That is deliberate: rescaling the existing grounds to
preserve a round denominator would change what each of them claims in order to make a
number prettier, and `scoring` is the field that makes versions comparable. The literal
`85` was written out in `report.ts` twice, in `cli.ts`, in `confidence.ts`'s own doc
comments and in the README — and `scripts/real-run.mts` was already reading a `ceiling`
that did not exist, printing `80/undefined`. One derived number, one place.

The prompt now states the baseline it observed instead of asserting a result: the suite
passed on base, or was already failing on base and will not be attributed to the fix, or
does not exist. Telling an agent not to break something already broken is how a
pre-existing failure becomes the agent's problem, and then ours.

**What this does not do.** It says nothing about a repository with no test command, which
is `unmeasured` and reported as such. It cannot distinguish a suite that is red for a
flake from one that is red for the fix — it runs each side once, unlike the reproduction,
because a full suite is expensive and the arm is context for a human rather than a gate.
And it is worth nothing on a repository whose suite cannot run in the phase container at
all, which today is any repository with installed dependencies — see the README's honest
limitations, and the test that pins it.
