---
status: accepted
---

# The reproduction is anchored, not committed

ADR-0006 listed four anti-gaming criteria, the last being "the fix diff must
overlap the reproduction path". Milestone 2 built an adversarial fixture for it
and the fixture disproved it: a fix that weakens the test *and* makes a cosmetic
edit to a real source file satisfies filename overlap exactly as a genuine fix
does. Real agents touch source and test in the same commit, so that is the
representative case, not an exotic one.

The instinct to make the check smarter is the wrong one. The defect is upstream
of the check.

**A red-then-green comparison is only evidence if the same thing ran both
times.** If the reproduction changed between the run that proved red and the run
that proved green, the two results are not weak evidence — they are *no*
evidence. Two different tests were run. That is not a heuristic about diffs; it
is a precondition of the comparison, and it was never enforced because the
reproduction lived in the repository where the fix commit could rewrite it.

**Decision.** The reproduction is anchored before either phase runs, and the
anchor is recorded as `REPRO_REGISTERED`:

- **Applied** — the Runner writes the reproduction's bytes over both checkouts.
  Tampering cannot happen: whatever the fix commit says the reproduction is, the
  registered version is what runs. Applied paths must be additive; the Runner
  refuses to write over a committed path, because doing so would put the tree in
  the "describes neither commit" state it refuses everywhere else.
- **Pinned** — the reproduction is a test the repository already contains. The
  Runner cannot prevent a change, so it hashes the path at base and again after
  every run. Tampering becomes a recorded fact rather than an impossibility.
- **Neither** — refused. A reproduction anchored to nothing is one the fix commit
  owns outright.
- Every run re-hashes the reproduction's paths, because the Runner hashes what it
  *wrote*, not what *executed* — a pretest hook or a collection-time plugin can
  rewrite the test before the assertion, and re-runs share a working tree, so a
  mutation during the first run would otherwise govern the rest silently.
- Every hash is of bytes the Runner itself wrote or read (ADR-0006). A
  caller-supplied hash would be testimony wearing an evidence event's shape — and
  the caller, in the sandbox, is the agent being judged.

`pinned` exists because requiring applied files would refuse the most common
real reproduction: a bug that already has a failing test, authored by a
maintainer *before* the fix existed. That is stronger provenance than an
agent-authored artifact, not weaker, and refusing it would route a Tier-1-grade
situation to Tier 3, where ADR-0007 says no fix is attempted. It also keeps the
engine usable on repositories whose tests must be registered in a build manifest
that legitimately differs between commits.

**The ordering invariant.** When the agent authors the reproduction, registration
must happen before the agent sees or writes the fix, and the log must show that
ordering by seq. Without it the party being judged still authored its own judge —
one step earlier. Everything else here is mechanism; this is the guarantee.

**Costs accepted.**

- **This makes gaming harder, not impossible.** The fix commit can still attack
  what the reproduction *invokes*: `conftest.py`, `vitest.config.ts`, `.mocharc`,
  a sourced helper, the `test` script in `package.json`. A fixture demonstrates
  exactly this passing every check, and it is asserted as passing rather than
  hidden.
- **It says nothing about whether the fix is correct.** A fix that swallows an
  exception or special-cases the reproduction's input satisfies every check.
  Closing that needs coverage instrumentation — run the reproduction on the fix,
  collect executed lines, intersect with the diff — which is language-specific
  and deferred.
- **`wrongReasonFailure` becomes more likely, not less.** A reproduction that
  needs a helper only the fix commit provides now exists on base and fails at
  load rather than being absent. Only the symptom check separates that from a
  genuine red.
- **This is a Tier 1 mechanism.** A string-keyed file map cannot carry a
  screenshot baseline, and `TEST_RUN` has only `stdout_hash`, so there is no
  evidence channel for image output. Tier 2 needs both before it is
  representable. Byte-identical script application would also not control
  node_modules, a browser binary, or seed data — for a scripted scenario, "the
  same thing ran" is a larger claim than this ADR delivers.

**Consequences.** ADR-0006's fourth criterion and ADR-0004's overlap input are
retired — once the reproduction is never in the commit, "the fix diff overlaps
the reproduction path" is unsatisfiable by construction, not merely harder. Both
ADRs carry an amendment note pointing here. Until diff-coverage lands, the engine
performs no fix-diff/reproduction-path check at all, and the documents say so.

Tier 1 now means: the same reproduction ran both times, it failed on base with
output matching the reported symptom, and it passed on the fix every time. It
does not mean the fix is correct.

**Rejected.** Making the overlap check smarter — matching directories, or module
paths, or import graphs. Every version answers a question that is downstream of
the real defect, and the fixture that disproved the original check would have
disproved each of them in turn.

**Revisit when** coverage instrumentation makes diff-coverage real, or when Tier 2
forces a binary-capable artifact channel.

---

## Amendment — the reproduction's COMMAND is attacker-controlled (M3.2b)

This ADR anchors what the reproduction is MADE OF: `applied` bytes the engine
writes over both checkouts, `pinned` paths it hashes. That was sufficient while
the reproduction came from a caller. It is not sufficient now the agent authors
it, and the gap is a different class rather than a bigger version of the same one.

A command can read which commit it is running on. The repro agent knows base's
tree exactly — it is the tree in its own clone — so it can write a reproduction
that hashes the tree and fails only when that hash is base's. Red on base, green
on a fix that changes nothing. Every guarantee above still holds while it happens:
the bytes are identical in both phases, the hashes match at every point, no
cross-phase state is used, and repeated runs agree. No abort, no tampering, no
anomaly of any kind — and the sentence three paragraphs up, "Tier 1 now means:
the same reproduction ran both times, it failed on base with output matching the
reported symptom, and it passed on the fix every time", is satisfied in full by a
run that reproduced nothing and fixed nothing.

**The countermeasure is a negative control, not another anchor.** Anchoring
compares the reproduction to itself, and an identity oracle cheats with no byte
out of place. So the engine commits an unrelated file on top of base and runs the
reproduction again: the bug is untouched, so a reproduction OF THE BUG must still
fail. One that turns green has told us what it was reading. It runs only when the
agent wrote the reproduction — a caller-supplied one has no oracle to be — and it
records each draw as `TEST_RUN { phase: 'control' }`. It ENDS NOTHING: see below,
where a control that ended runs turned out to end honest ones.

**What it does not cover — and this section has now overclaimed twice, which is
itself the finding.** Version one said an unpredictable name defeats
pattern-filtering oracles; a pattern filter on the name's SHAPE beat it. Version
two said there was no metadata left to compare; the committer email's domain, the
equality of author-name and subject, and the diff's shape (exactly one added
blank line) each beat it in one line. Both versions reasoned from the previous
defeat instead of stating an invariant. The invariant: **the sham must hold
nothing constant that an oracle can match — content, metadata, diff shape, or the
class of perturbation — and even a perfect sham cannot catch an oracle that keys
on the FIX rather than on base.**

That clause was itself wrong, and this is the third correction to this section.
The residual is NOT fix-keyed-only. Review defeated the control with five oracles
keyed on BASE — the sham's committer TLD (`.example`, a literal in the engine's
source, which is H1 reopened verbatim), the fixed LENGTHS of its author name and
subject, the pure-hex shape of its inserted line, and the fact that its diff is
always a modification and never an add, delete, rename or mode change. One of
them needs no git at all: `grep -rlE "^[0-9a-f]{8,78}$"` finds the sham's own
filler. Each time this section has been rewritten it has generalised from the
last defeat; six successive versions of the sham have been defeated, and the correct conclusion
is not a seventh sham.

**So the control no longer draws a verdict.** It was ending runs, and it convicted
honest reproductions: for any bug whose honest assertion is monotone in file
content — non-empty, minimum size, minimum line count, must-differ-from-template —
both draws satisfy it, and review measured an honest agent accused in 6 of 12
identical runs. A permanent, immutable accusation decided by `randomInt` is worse
than the hole it guards. The control records what it saw as `TEST_RUN
{ phase: 'control' }` and ends nothing. A human reads it; the engine draws
nothing from it.

**What withholds the claim is the tier, not the control.** A run whose
reproduction the agent authored is capped at Tier 2 — reproduced, independence
unverified — rather than Tier 1. That is a statement about what this engine can
demonstrate, and it does not depend on any sham working.

Two things are still open and are recorded here rather than implied away. ADR-0007
defines Tier 1 as "an agent-authored test that fails on the base commit" and Tier
2 as a scripted scenario; this amendment makes an agent-authored test ineligible
for Tier 1 and borrows Tier 2 for a different meaning, so ADR-0007 needs amending
or a new label needs choosing. And the cap moves the tier without moving the
score: review measured a no-op fix at Tier 2, score 80, still reaching the fix
container. Whether the tier is the right lever is undecided.

Diff-coverage is the real answer here too: an identity oracle does not execute
the lines the fix changed, and a reproduction of the bug does. That is the same
instrumentation this ADR already defers, now load-bearing for a second reason.

Fixtures demonstrate the attacks and assert what actually happens to each: three
oracles are asserted as flagged by a green sham, and the collusion oracle is
asserted as SURVIVING — red base, green fix that repaired nothing, control
silent. Asserting a defeated defence as passing is this ADR's own convention, and
an assertion that the control "refuses" would have been the comfortable claim
rather than the true one.
