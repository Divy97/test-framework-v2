// The read model (M6c): one row per run, derived and never authored.
//
// The README's first architectural claim is that there is no runs table and every
// projection is a disposable cache. `run_projection` does not contradict that, and this
// file is why: nothing here decides anything. It reads the fold and the confidence
// projection and flattens them into columns a list view can sort by. Drop the table,
// replay the log, get the same rows back — which is a property with a test rather than a
// sentence in a README.
//
// Two rules hold it to that:
//
//   1. **No new facts.** Every field traces to an event or to a pure projection over
//      events. If a column cannot be recomputed from `events` alone it does not belong
//      here — it belongs in the log, or nowhere.
//   2. **Never throws.** A projection that refuses to render leaves a run permanently
//      invisible, which is worse than rendering the truth plus "this log is malformed"
//      (ADR-0009's reasoning, and `confidence()` already follows it).

import { confidence } from './confidence.js';
import type { RunEvent } from './events.js';
import { fold, type RunState } from './fold.js';

/** One row of `run_projection`. Every field derived; none authored. */
export type RunRow = {
  run_id: string;
  repo: string;
  issue_number: number;
  status: RunState['status'];
  tier: number;
  confidence: number;
  ceiling: number;
  /** Which scale `confidence` is on. A stored score without it is unreadable later. */
  scoring: number;
  regression: RunState['regression'];
  pr_url: string | null;
  started_at: string;
  ended_at: string | null;
  last_seq: number;
};

/**
 * Split `owner/repo#41` — the shape `intake()` writes on every RUN_REQUESTED.
 *
 * Tolerant on purpose. A malformed or absent thread ref must degrade the row rather than
 * lose the run: a run nobody can see is indistinguishable from a run that never
 * happened, and the log is what says which.
 */
export function splitThreadRef(threadRef: string | null): { repo: string; issue: number } {
  const match = /^(.+)#(\d+)$/.exec(threadRef ?? '');
  return match ? { repo: match[1]!, issue: Number(match[2]) } : { repo: '(unknown)', issue: 0 };
}

/**
 * Fold a run's events into its row.
 *
 * `ended_at` is the timestamp of the terminal event rather than "when we wrote the row":
 * the row is a cache, so a rebuild months later has to produce the same value, and
 * `now()` would not. Same reason `started_at` comes off the first event.
 */
export function projectRun(events: RunEvent[]): RunRow | null {
  if (events.length === 0) return null;
  // `fold` THROWS — on a seq gap, on an unknown event type, on a stream that does not
  // begin at 1 — and `fold.ts`'s own comments describe a truncated log as permanent and
  // plausible: a host appending events as they arrive can die mid-stream, and events are
  // immutable, so the gap is forever.
  //
  // Rule 2 of this file says a projection never throws, and letting this one through
  // broke it in the worst place: `rebuildProjection` loops over every run, so ONE
  // malformed historical stream made the rebuild command unusable for every other run —
  // which is exactly the property 6c exists to demonstrate.
  let state: RunState;
  try {
    state = fold(events);
  } catch {
    return null;
  }
  const score = confidence(state);
  const { repo, issue } = splitThreadRef(state.threadRef);
  // The PR url is not in the log — `PR_OPENED` carries the repo and number, which is
  // what a link is built from. Deriving it here rather than storing it keeps the rule
  // that every column is recomputable.
  const pr = state.pr ? `https://github.com/${state.pr.repo}/pull/${state.pr.pr_number}` : null;
  const ended = state.endedReason === null ? null : (events.at(-1)?.ts ?? null);
  return {
    run_id: state.runId,
    repo,
    issue_number: issue,
    status: state.status,
    tier: score.tier,
    confidence: score.score,
    ceiling: score.ceiling,
    scoring: score.scoring,
    regression: state.regression,
    pr_url: pr,
    started_at: events[0]!.ts,
    ended_at: ended,
    last_seq: state.lastSeq,
  };
}
