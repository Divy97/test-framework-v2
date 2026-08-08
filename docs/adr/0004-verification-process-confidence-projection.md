---
status: accepted
---

# Verification is a process; confidence is a projection

A projection with side effects is a contradiction. The system splits what
colloquially gets called "verification" into two components with opposite
natures:

**Verification (active process).** Executed by the Runner at its own process
boundary: checkout base → run the reproduction → checkout fix → run the
reproduction → flake re-runs → hash every output. It has side effects and
emits **fact-events**:

```json
{"v": 1, "type": "TEST_RUN", "phase": "base", "exit_code": 1,
 "stdout_hash": "sha256:…", "duration_ms": 4312}
```

Facts, not interpretations — the event says what happened, never what it
means (`TEST_RUN {exit_code: 1}`, not `TEST_FAILED_AS_EXPECTED`).

**Confidence score (pure projection).** A fold over the fact-events. It
assigns meaning: did the base-phase failure match the reported symptom, did
the fix-phase pass survive flake re-runs, does the fix diff overlap the
reproduction path, which verification tier was reached. Zero side effects,
recomputable at any time, and — like every projection — disposable and
rebuildable from the log.

**Consequences.**

- Every point of the confidence score is traceable to a content-addressed
  artifact. No vibes, no LLM-judge-only scores.
- Scoring logic can improve after the fact: re-fold old runs under a new
  scoring version without touching history.
- The verdict a run displays is exactly as trustworthy as the facts beneath
  it — which is the point of [ADR-0006](0006-testimony-vs-evidence.md).

**Amended by [ADR-0008](0008-the-reproduction-is-anchored.md).** The
diff-overlap input is retired — it was disproved by an adversarial fixture
before it was ever built. Until diff-coverage replaces it, confidence has no
fix-diff/reproduction-path component, and the reproduction's anchor takes its
place as an input.
