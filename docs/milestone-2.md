# Milestone 2 — the verification engine

**Goal:** the engine that turns a claimed fix into evidence, built and tested
without an agent and without a container.

The engine is the moat. It has no hard dependency on Claude Code or Docker, so
it gets built first, against fixtures that include the adversarial cases. When
the Runner arrives in M3 it calls an engine that is already trustworthy —
rather than three unproven layers debugged at once, with no way to tell which
one lied.

## The shape

```ts
verify({ repoPath, baseRef, fixRef, reproCommand, symptomPattern, flakeRuns })
  -> RunEvent[]
```

Executed at the engine's own process boundary (ADR-0006), in order:

1. checkout `baseRef` → run `reproCommand` → capture exit code + stdout → hash
2. checkout `fixRef` → run `reproCommand` → capture, hash
3. re-run the fix phase `flakeRuns` times
4. observe the fix diff: changed file paths + diff hash

It emits fact-events and returns them. It issues no verdict — `reproduced`,
tier, and confidence stay in the fold (ADR-0001, ADR-0004).

### The subtle line: observation vs interpretation

`symptom_matched` is a **fact**. The engine ran a regex against output it
captured itself and recorded what it saw — the same class of act as recording
an exit code. "Tier 1, reproduced" is an **interpretation** and belongs to the
fold.

The test is whether the fold could re-derive it from the log alone. It cannot
re-run a regex over stdout it does not have (the blob store holds the bytes,
the fold is pure). So the observation is recorded; the conclusion drawn from it
is not.

## Event vocabulary changes

Additive, so payloads stay `v: 1`:

| Event | Change | Why |
|---|---|---|
| `TEST_RUN` | add `symptom_matched?: boolean`, `repeat?: number` | anti-gaming symptom check; flake re-run index |
| `REPRO_REGISTERED` | new — `{ command, files, applied }` | anchors the reproduction so both phases provably run the same thing ([ADR-0008](adr/0008-the-reproduction-is-anchored.md)) |
| `FIX_DIFF_OBSERVED` | new — `{ base_sha, fix_sha, changed_files[], diff_hash }` | recorded for the confidence projection |
| `VERIFICATION_ABORTED` | new — `{ phase, reason }` | observation stopped; the events before it are still real |
| `RUN_ENDED` | new — `{ reason }` | `pr_opened` \| `not_reproduced` \| `attempts_exhausted` \| `error` |

`RUN_ENDED` closes the terminal-state gap: `RunStatus` gains `unresolved` — the
Tier 3 outcome (ADR-0007) becomes expressible for the first time — and `errored`
beside it, because "we could not reproduce it" is a finding about the bug while
"the sandbox fell over" is not, and one status for both would let the second
wear the first's clothes.

`VERIFICATION_ABORTED` closes a quieter gap. `verify()` accumulated events and
threw on any failure to observe, so a run that died in the fix phase discarded a
perfectly good base-phase observation and emitted nothing at all — a container
exiting non-zero with an empty channel, indistinguishable from one that never
ran. The engine still throws (a caller must never read "could not look" as
"looked and saw nothing wrong"), but the error now carries what was observed,
closed by this event, and the Runner flushes the blobs and emits the partial
stream before exiting 2.

It is deliberately **not** terminal for the run — an attempt can abort and the
next one can still reach a PR.

### An incomplete observation is not a reproduction

Nothing in the log says how many flake re-runs there should have been, so
`isReproduced`'s "every fix run passed" was really asking "did every run I can
*see* passed" — and the runs it could not see are exactly the ones an agent
would arrange to fail. A repro that goes green once and then hangs was credited
red-then-green off a single run, handing the flake-survival criterion to the
thing it exists to catch.

Disqualifying the attempt on a `base`/`fix` abort was the obvious fix and was
not enough: **a stream can be truncated with no abort at all.** The Runner writes
its events in one loop at the end, and a host that appends them as they arrive —
which the design explicitly anticipates — can die mid-stream. Events are
immutable, so that truncation is permanent, and it carries nothing to give it
away.

So the fold requires the log's own witness instead: `FIX_DIFF_OBSERVED` is
emitted after the flake loop and nowhere else, so its presence in an attempt is
proof that attempt's fix series ran to completion. It needs no faith in event
ordering, and it subsumes the abort case — an attempt that aborted in `base` or
`fix` never reached the diff either. The abort check is kept beside it as
defence in depth.

An abort at phase `diff` or `cleanup` **counts as that witness**. The engine's
phase only advances past `fix` once the flake loop has closed, so reaching
either one is the same proof from the same producer. Requiring the event alone
was a false negative with teeth: the phase is set to `diff` *before* the diff is
computed, so a diff-phase abort can never carry it — and a genuine Tier 1, red
base and every fix run green, was discarded because git could not describe two
unrelated histories. The test that claimed to cover this folded a stream
containing the witness, which the engine cannot produce for a diff abort, so it
passed for the wrong reason.

The same cross-attempt bug lived in the registration: one `REPRO_REGISTERED`
slot meant every attempt's runs were judged against whichever registration came
last, which both credits runs that never executed the repro they are measured by
and destroys an earlier attempt's honest verdict the moment a later attempt
re-registers. Each attempt is now judged against its own.

`RUN_ENDED`'s `reason` is the *stated cause of the process halting* — a
control-flow fact — and the fold derives the outcome from the log rather than
believing it: a stream claiming `pr_opened` with no `PR_OPENED` in it is
`unresolved`, and one claiming `not_reproduced` after a real `PR_OPENED` still
shows the PR. The exception is `errored`, which the fold takes on the producer's
word because an infrastructure failure is unevidenced by construction. Which
conclusions a producer may restate, and why that one asymmetry is safe while
deriving it from the abort record would not be,
is [ADR-0009](adr/0009-what-a-producer-may-write-back.md).

Known gap: `reason` is prose, so the confidence projection cannot branch on it.
A machine-readable `kind` lands with 3c, its only consumer — additive, so the
payload stays `v: 1`.

## Anti-gaming checks

Per Q7 "loose agent, strict judge". Each is executed by the engine; each
contributes evidence the fold reads:

- **Symptom match** — base failure output must match the reported symptom. A
  test that fails for an unrelated reason is not a reproduction.
- **Flake survival** — the fix phase must pass every re-run, not just once.
- ~~**Diff overlap** — the fix diff must touch the path the reproduction
  exercises.~~ **Retired (PR 3a).** Its own adversarial fixture disproved it: a
  fix that weakens the test *and* makes a cosmetic source edit satisfies filename
  overlap exactly as a genuine fix does. Replaced by anchoring the reproduction
  ([ADR-0008](adr/0008-the-reproduction-is-anchored.md)); real diff-coverage needs
  language-specific instrumentation and is deferred.

Without these, a cornered agent writes a test that trivially fails then passes
without ever touching the defect, and the tier means nothing.

## Fixtures

Tiny git repos generated into a temp dir at test setup — not committed as
nested repos. One per case the engine must get right:

1. clean red → green (Tier 1)
2. symptom mismatch — base fails for the wrong reason
3. flaky fix — passes 2 of 3 re-runs
4. gaming attempt — red → green, but the diff never touches the repro path
5. irreproducible — base and fix both pass (Tier 3, no fix attempted)

Cases 2–5 are the point. They are also why the demo app cannot serve as this
fixture: a Next.js app behind a Docker build is too slow and too coarse for
unit-level assertions, and shipping deliberate gaming attempts inside a demo
makes the demo worse. Two artifacts, two purposes —
[SHARED-UNDERSTANDING.md](../SHARED-UNDERSTANDING.md) Q8 updated accordingly.

## Blob store

Content-addressed local directory: `blobs/ab/cd/<rest-of-hash>`. `put(bytes)`
returns the `sha256:` ref that events carry. S3 becomes one adapter later; no
event schema changes when it does.

## PR breakdown

1. **Engine core** — `verify()`, the four phases, the three checks, blob store.
2. **Fixtures + engine tests** — the five cases above.
3. **Vocabulary + projections**, split after the PR 3 design review:
   - **3a** — the reproduction is anchored, not committed (ADR-0008).
   - **3b** — `RUN_ENDED`, `VERIFICATION_ABORTED`, the `unresolved` status.
     Landed after M3.1: the abort path only became worth building once a run
     could die inside a container, where an empty channel is all a caller sees.
     `RUN_ENDED` has no producer yet — the attempt loop that emits it arrives
     with the agent in M3.2, and until then it exists as vocabulary the fold
     understands, exactly as `PR_OPENED` does. Unlike `PR_OPENED` it is not
     inert, so the fold **records** post-end events rather than throwing on
     them: the store enforces unique `(run_id, seq)` and nothing enforces
     terminality at write, and one racing append must not be able to make an
     immutable log permanently unrenderable.
   - **3c** — tier and confidence as pure projections. Landed. Every point cites
     the artifacts a reviewer would open, and the ceiling is **85, not 100**:
     the missing 15 is diff-coverage, which ADR-0008 retired as a filename check
     and which needs instrumentation to rebuild. Scoring it as though measured
     is exactly the vibe ADR-0004 forbids. Tier 2 is deliberately unreachable —
     no event in the vocabulary distinguishes a browser script from a test, so
     the tier arrives when the events for it do.

## Not in this milestone

Docker sandbox · live Claude Code · adapters · SSE · dashboard · the Next.js
demo app.

## Known risks

- **The engine runs arbitrary commands on the host.** That is what it is for,
  and it is exactly what the M3 sandbox exists to contain. Until then it runs
  only against fixtures we generate.
- ~~**No command timeout yet.**~~ Landed: `timeoutMs`, default 120s, and a
  timeout is a failure to observe rather than a recorded result.
- **The timeout kills the shell, not the process group.** Found while building
  the abort fixture, and left open deliberately rather than fixed in passing.
  A repro that spawns a child outlives its own timeout: on the host it leaks,
  and in either mode the survivor keeps executing *while the next phase is being
  judged* — base-phase work still running against the fix checkout. The sandbox
  bounds the blast radius to the container's lifetime, which is why this is a
  known risk rather than an emergency, but it is an evidence-integrity defect
  and needs its own change (spawn detached, kill the group).
