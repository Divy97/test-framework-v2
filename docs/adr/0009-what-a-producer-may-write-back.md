---
status: accepted
---

# What a producer may write back into the log

`RUN_ENDED { reason }` forces a question [ADR-0001](0001-why-event-sourcing.md)
leaves open. Its test for whether something belongs in an event is: could the
pure fold re-derive it from the log alone? Applied to the reason enum, the
answer splits it down the middle.

| value | re-derivable by the fold? |
|---|---|
| `error` | No — the process died; only the producer saw it. |
| `attempts_exhausted` | No — the cap is config and appears nowhere in the log. |
| `pr_opened` | Yes — `PR_OPENED` is already there. |
| `not_reproduced` | Yes — it is `!state.reproduced`. |

Half the enum is the fold's own conclusion, written back into the log by a
producer. By ADR-0001's letter it does not belong.

**Decision.** The event records that the run halted and the producer's stated
cause. The fold derives the outcome regardless, and the two are allowed to
disagree in the record.

- **A producer may state a cause it acted on; it may never assert a
  conclusion.** `RUN_ENDED { not_reproduced }` means "I stopped, and what I
  acted on was the reproduce-first gate" — a control-flow act with consequences
  in the world (no fix was attempted). It does not mean "nothing was
  reproduced," and the fold never reads it to answer that. A stream claiming
  `pr_opened` with no `PR_OPENED` in it folds to `unresolved`; one claiming
  `not_reproduced` after a real `PR_OPENED` still shows the PR.
- **Consuming the fold is fine; reimplementing it is not.** The orchestrator
  decides to stop by folding the log and reading `state.reproduced`. What is
  forbidden is a second definition of "reproduced" living in a producer, free
  to diverge from `isReproduced`, in a code path nobody folds.

**The fold takes exactly one thing on trust: `errored`.** An infrastructure
failure is the one outcome that cannot be evidenced from inside the log — the
container is OOM-killed, the channel dies, the process is SIGKILLed, and by
construction no event is written. Untrusted, `errored` cannot exist at all, and
every operational fault renders as `unresolved`: a finding about the bug.
[ADR-0006](0006-testimony-vs-evidence.md) permits this. Its constraint is that
*the agent* cannot write facts; the orchestrator is a trusted writer, and the
agent never becomes one.

**Rejected: deriving `errored` from the abort record**, which is the obvious
alternative and is wrong three times over. An abort is not terminal, so "any
abort ⇒ errored" would mark a run errored when attempt 1 aborted and attempts
2–3 honestly failed to reproduce. Aborts only exist when the engine lived long
enough to write one, so the failures `errored` most wants to name leave none.
And decisively: **an abort is a failure to observe, and the repro can cause
one.** A repro that hangs aborts the run. Derive the status from aborts and the
agent under judgement can flip its own run from `unresolved` to `errored` by
writing a repro that hangs — escaping [ADR-0007](0007-reproduce-first-gate.md)'s
Tier 3 deliverable into an operational excuse. A status the agent can choose is
not a status.

**Consequence.** `state.pr` wins over a stated `error`, so a run that opened a
PR and then had its sandbox fall over reports `pr_opened` and the fault is
visible only in the abort record. Accepted deliberately: the PR is the
deliverable and it exists.
