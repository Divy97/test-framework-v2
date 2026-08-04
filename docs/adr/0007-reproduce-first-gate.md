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
