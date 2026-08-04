---
status: accepted
---

# Full event sourcing: the event log is the source of truth

AI agent runs are non-deterministic. Every feature this platform needs — replay,
live streaming, execution timeline, audit trail, evidence reports, confidence
scoring, resuming interrupted runs, analytics — is a view over *what happened*.
Modeling "what happened" as mutable rows loses exactly the information those
features need; modeling it as an immutable event sequence gives them all the
same substrate.

**Decision.** Full event sourcing, not an audit log beside CRUD state:

- There is **no runs table**. Run state exists only as `fold(events)`. "Delete
  the runs table" has the answer: *there is no runs table*.
- **One aggregate: `Run`.** Everything belongs to a run, so ordering is a
  per-run monotonic sequence — trivial to enforce, trivial to reason about.
  Intake does not get its own aggregate: `RUN_REQUESTED {source, thread_ref,
  raw_text}` is the first event *of the run*. A rerun is a brand-new run whose
  first event carries `parent_run_id` — lineage without a second aggregate.
- **Events are versioned facts, never interpretations.** `{"v": 1, "type":
  "TEST_RUN", "phase": "base", "exit_code": 1, "stdout_hash": "sha256:…"}`,
  never `TEST_FAILED_AS_EXPECTED`. Interpretation lives in the fold, so it can
  change later without rewriting history.
- **Events stay small.** Transcripts, diffs, screenshots, stdout go to a
  content-addressed artifact store; events carry `sha256:` references.
- **Projections are explicitly disposable caches**, materialized in Postgres
  (`run_dashboard_projection`, `run_confidence_projection`, …). Deleting them
  causes no data loss; they are rebuilt by replaying the event stream. This is
  the one deliberate impurity: materialization for read performance, honestly
  labeled as cache.

**Costs accepted.** Every feature starts with event design; projections need
rebuild tooling; debugging means reading event streams. We take these costs
because they buy a coherent claim: the system's memory is immutable, complete,
and independently re-derivable.

**Rejected.** CRUD state plus an audit-log table. It is less work, but it
cannot honestly claim rebuildability — and the claim is the point.
