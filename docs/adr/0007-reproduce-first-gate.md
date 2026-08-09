---
status: accepted
---

# The reproduce-first gate and tiered confidence

A fix for a bug that was never reproduced is a guess with a diff attached.
The platform refuses to guess.

**Decision.** No reproduction, no fix — and the tier of reproduction achieved
*is* the backbone of the confidence score:

- **Tier 1 — Reproduced by failing test.** An agent-authored test that fails
  on the base commit with symptom-matching output and passes on the fix, both
  executed by the Runner ([ADR-0006](0006-testimony-vs-evidence.md)).
  Highest confidence; the PR carries the red→green evidence.
- **Tier 2 — Reproduced by scripted scenario.** A deterministic, re-runnable
  script: browser automation, an API call sequence, a screenshot diff. Weaker
  assertion than a test, still independently re-executable. Medium confidence.
- **Tier 3 — Not reproduced. No fix is attempted.** The run's deliverable is
  a structured info-request posted back to the source thread: what was tried,
  what is missing (exact steps, account state, environment). This is triage
  work with real value — not a failure mode.

**The gate never bends.** No "just try anyway" path exists, including for
demos. A demo of the Tier-3/UNRESOLVED flow is part of the demo script
precisely because refusing to guess is the credibility of every verdict the
system does issue.

Confidence = tier + deterministic evidence quality (symptom match, flake
re-run survival, diff-coverage of the fix against the reproduction path),
computed as a pure projection ([ADR-0004](0004-verification-process-confidence-projection.md)),
every point traceable to a content-addressed artifact.

**Rejected.** Attempting fixes on unreproduced bugs with a lower confidence
label. It converts the confidence score from a measurement into a disclaimer,
and one waved-through guess costs more trust than a hundred honest
UNRESOLVEDs.

---

## Amendment — Tier 1 is not available to a reproduction the agent wrote (M3.2b)

This ADR defines Tier 1 as "**an agent-authored test** that fails on the base
commit … Highest confidence". That was written when the reproduction came from a
caller and the agent merely ran against it. It is no longer true, and the code
now refuses it, so the definition is amended here rather than contradicted
silently from another document.

A reproduction is a COMMAND, and once the agent writes it, the command can test
which commit it is running on instead of whether the bug is present. The repro
agent knows base's tree exactly — it is the tree in its own clone. Red on base,
green on a fix that repairs nothing, with every anchor in
[ADR-0008](0008-the-reproduction-is-anchored.md) satisfied and no anomaly
anywhere in the log. Six versions of a negative control failed to catch it, and
one class provably cannot be caught by any control of that shape.

**So Tier 1 now additionally requires that the engine did not take the
reproduction from the party under judgement.** A caller-supplied reproduction
reaches Tier 1 as before. An agent-authored one lands at Tier 2.

**Tier 2 widens accordingly**, and this is a deliberate reuse rather than an
oversight: it was "reproduced by scripted scenario — weaker assertion than a
test, still independently re-executable", and it becomes **"reproduced, but the
reproduction's independence is unverified"**, of which a scripted scenario is one
case and an agent-authored test is another. Both are re-executable; neither is
known to test the thing it claims to test.

Tier 3 is unchanged.

**Revisit when** diff-coverage instrumentation exists. Showing that the lines the
fix changed are the lines the reproduction exercises is what separates a
reproduction of the bug from a test of the commit's identity — an identity oracle
executes none of them. At that point an agent-authored reproduction can earn Tier
1 again, on evidence rather than on trust.
