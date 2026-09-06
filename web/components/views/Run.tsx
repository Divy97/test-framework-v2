'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isOver, send, type Evidence as EvidenceData, type Me } from '../../lib/api';
import { useJson, useTail, type Frame } from '../../lib/hooks';
import { Failed, Loading, Said, When } from '../bits';
import { RawLog, Timeline } from '../Timeline';
import { Evidence, REGRESSION_LABEL, TIER_MEANING } from './Evidence';

/**
 * One run — live while it runs, evidence when it is done, and the same page throughout.
 *
 * Two pages would have been the obvious build and the wrong one. A person who presses
 * Start watches this screen for four minutes and then reads the verdict on it; sending
 * them somewhere else at the end would throw away the context they just acquired, and
 * would need a redirect that fires exactly once and never on a reload.
 *
 * The division of labour is the important part, and it is the same one `routes.ts` states:
 *
 *   - **The tail is for liveness.** Raw events, in order, resumable by seq. It drives the
 *     timeline and the log, both of which report what happened.
 *   - **The fold is for truth.** Reproduced, regression, tier, confidence and every ground
 *     come from `/api/runs/:id/evidence` and are re-read when an event lands that could
 *     have moved them. Deriving any of it here would be a second opinion about a run,
 *     racing the pull request to the answer (ADR-0009).
 */
export function Run({ runId, me }: { runId: string; me: Me | null }) {
  const evidence = useJson<EvidenceData>(`/api/runs/${encodeURIComponent(runId)}/evidence`);
  const reload = evidence.reload;
  // Throttled, because the events that matter can arrive in bursts — three `TEST_RUN`
  // frames land within a second of each other — and three identical folds of the same log
  // is two round trips for an answer that did not change between them.
  //
  // A ref rather than state, for two reasons. It does not re-render the page fifteen times
  // per run to store a number nothing displays; and it is read at the moment the frame
  // arrives rather than from a closure, so two events in one tick cannot both see the old
  // value and both refetch — which is exactly the burst this exists to collapse.
  const last = useRef(0);
  const onMeaningful = useCallback(
    (final: boolean) => {
      const now = Date.now();
      // NEVER the last one. Everything else can wait 1.2 seconds for the next fold; the
      // event that says the run is over cannot, because nothing arrives after it to carry
      // the deferred read — the page would sit on "the run is still going" until somebody
      // reloaded it, for a run that had already opened a pull request.
      if (!final && now - last.current < 1200) return;
      last.current = now;
      reload();
    },
    [reload],
  );

  // THE LOG, ALWAYS READ ONCE, and streamed on top of it only while the run is going.
  //
  // The first shape of this was "stream a live run, read a finished one", switching on the
  // fold's status, and it was wrong in three ways at once:
  //
  //   1. `fold.ts` sets `pr_opened` on the `PR_OPENED` event, which comes BEFORE
  //      `RUN_ENDED`. So the stream closed one event early on every successful run and the
  //      snapshot that replaced it could be taken before the ending landed — the timeline
  //      permanently missing the run's last rows.
  //   2. At the moment of the switch there was nothing to show: the stream's frames were
  //      dropped and the read had not answered, so a run that had just finished with
  //      hundreds of events rendered "waiting for the first event".
  //   3. If that read failed, `frames` stayed empty forever with no error and no retry —
  //      exactly what `lib/api.ts` says must never happen.
  //
  // So the read is unconditional and the two are MERGED by `seq`. The snapshot is the
  // history, the stream is what comes next, and duplicates are free because the log is
  // append-only and a seq identifies a row.
  const stored = useJson<Frame[]>(`/api/runs/${encodeURIComponent(runId)}/events`);
  const live = useTail(logEnded(stored.data, evidence.data) ? null : runId, { onMeaningful });
  const frames = merge(stored.data ?? [], live.frames);
  // TWO QUESTIONS, and collapsing them into one was wrong in both directions.
  //
  //   `ended`   — may this page show a verdict? The FOLD's answer. `fold.ts` reaches a
  //               terminal status at `PR_OPENED`, and that is correct: the run has a tier
  //               and a confidence from that moment, and a log that was truncated before
  //               `RUN_ENDED` still has a verdict a reader is entitled to.
  //   `closing` — may the stream be shut? Only once the LOG has ended. `RUN_ENDED` comes
  //               after `PR_OPENED`, so closing on the fold's status drops the run's last
  //               events on every successful run.
  //
  // One flag did both: keyed to the fold it lost the ending, keyed to the log it hid the
  // verdict of every run whose log has no `RUN_ENDED` — which is every fixture in this
  // repository and every run recorded before that event existed.
  const ended = isOver(stateOf(evidence.data), evidence.data?.row.ended_at ?? null);
  const closing = frames.some((frame) => frame.type === 'RUN_ENDED') || evidence.data?.row.ended_at != null;

  if (evidence.loading) return <><h1>Run</h1><Loading what="this run" /></>;
  if (evidence.status === 202) return <Queued runId={runId} reload={evidence.reload} />;
  if (evidence.status === 404) {
    return (
      <>
        <h1>No such run</h1>
      <div className="nothing">
        <p>No such run.</p>
        <p>
          Either it does not exist, or it belongs to a repository this account cannot see —
          this page gives the same answer to both, so that a stranger guessing ids learns
          nothing about which runs exist.
        </p>
      </div>
      </>
    );
  }
  if (!evidence.data) return <><h1>Run</h1><Failed error={evidence.error ?? 'unknown'} retry={reload} /></>;

  const { row, state, score, usage, compute, forgotten } = evidence.data;
  // The most recent thing that happened, for the live region — one short sentence rather
  // than a list. `SANDBOX_SEALED` and `TEST_RUN` are the two a person actually waits for.
  const latest = SAID[frames.at(-1)?.type ?? ''];
  const refused = score.tier === 3;
  const attempt = state.reproducedAttempt;
  const repro = state.registrations.filter((r) => r.attempt === attempt).at(-1) ?? state.registeredRepro;

  return (
    <>
      <p className="crumb">
        <a href={`/runs?repo=${encodeURIComponent(row.repo)}`}>{row.repo}</a>
      </p>
      <h1>
        {row.repo}#{row.issue_number}
      </h1>
      <p className="muted small">
        <code className="hash">{row.run_id}</code> · started <When iso={row.started_at} />
        {/* `row.ended_at`, not `ended`. The two differ: `ended` is the fold's answer and is
            true for a `pr_opened` run whose projection never recorded a timestamp, and
            printing "· ended —" for one says less than saying nothing. */}
        {row.ended_at ? (
          <>
            {' '}
            · ended <When iso={row.ended_at} />
          </>
        ) : null}
      </p>

      {/* One live region for the whole run, and only a SUMMARY inside it. The timeline
          itself must not be one: a run emits hundreds of frames and announcing each is
          worse than announcing none. This changes a handful of times and says the thing a
          reader who cannot see the list actually needs — how far along it is, and what just
          happened. */}
      <p className="live" role="status" aria-live="polite">
        {!closing ? (
          <>
            <span className="dot" aria-hidden="true">
              ●
            </span>
            {live.state === 'lost' ? (
              <span className="disconnected">
                The connection to the log closed. <a href="/auth/github">Signing in again</a> may
                be what this needs; reloading will say for certain.
              </span>
            ) : live.state === 'retrying' ? (
              <span className="disconnected">Reconnecting to the log…</span>
            ) : (
              <span>
                Live — {frames.length} event{frames.length === 1 ? '' : 's'}
                {latest ? `. Latest: ${latest}` : ''}
              </span>
            )}
          </>
        ) : null}
      </p>

      <div className="strip">
        {/* `state.status`, not `row.status`. The row is a cache; the fold is current. Both
            were on this page at once, so a projection that had not caught up printed
            "status attempting" beside the tier and confidence of a finished run. */}
        <span className="chip">
          <b>status</b> {state.status.replace(/_/g, ' ')}
        </span>
        {ended ? (
          <>
            <span className="chip">
              <b>Tier {score.tier}</b> {TIER_MEANING[score.tier] ?? 'unknown'}
            </span>
            <span className="chip">
              <b>confidence</b> {score.score}/{score.ceiling} (scoring v{score.scoring})
            </span>
            <span className="chip">
              <b>{REGRESSION_LABEL[state.regression] ?? state.regression}</b>
            </span>
          </>
        ) : (
          // NOT a tier, and not a confidence. Both are the fold's answer about a finished
          // run; printing the running total would show a reader a Tier 3 for the first
          // three minutes of every successful run, which is a lie told by a progress bar.
          <span className="chip">
            <b>verdict</b> not yet — the run is still going
          </span>
        )}
        {row.pr_url ? (
          <span className="chip">
            <a href={row.pr_url}>pull request</a>
          </span>
        ) : null}
      </div>

      {forgotten ? (
        <div className="warning">
          <h2>The evidence for this run was deleted, on request.</h2>
          <p>
            {forgotten.removed} artifact(s) were destroyed at{' '}
            {forgotten.forgottenAt.replace('T', ' ').slice(0, 19)}, asked for by <code>{forgotten.requestedBy}</code>.
          </p>
          <p>
            <b>The log was not edited.</b> Every event below says exactly what it said
            before, including the <code>sha256:</code> references — those now point at bytes
            that no longer exist, which is what deleting them means. Artifacts still cited by
            another run were kept: content addressing makes identical bytes one file, and
            removing them would have broken a run nobody asked to forget.
          </p>
        </div>
      ) : null}

      <h2>What happened</h2>
      {stored.error && frames.length === 0 ? (
        <Failed error={stored.error} retry={stored.reload} />
      ) : (
        <>
          <Timeline frames={frames} ended={closing} />
          <RawLog frames={frames} />
        </>
      )}

      <Evidence data={evidence.data} ended={ended} />

      {me?.forgetting && ended && !forgotten ? <Forget runId={runId} onDone={reload} /> : null}
    </>
  );
}

/**
 * Between pressing Start and a worker picking the job up.
 *
 * `enqueueJob` writes to `jobs`; the log's first event comes from the worker that claims it
 * (ADR-0019), so for a few seconds there is a run id with nothing behind it. The page used
 * to render "No such run" here — the same answer somebody else's run gets — with no retry,
 * which is where every single use of the Start button landed first.
 *
 * A poll rather than a tail, because there is no stream to open yet: the tail is per run and
 * the run has no events. Two seconds is slower than a worker's long-poll and far cheaper
 * than a socket held open on the chance that one exists.
 */
function Queued({ runId, reload }: { runId: string; reload: () => void }) {
  useEffect(() => {
    const timer = setInterval(reload, 2000);
    return () => clearInterval(timer);
  }, [reload]);
  return (
    <>
      <h1>Waiting for a worker</h1>
      <p className="live" role="status" aria-live="polite">
        <span className="dot" aria-hidden="true">
          ●
        </span>
        <span>Queued — no machine has claimed this run yet</span>
      </p>
      <p className="hero">
        The run exists and is on the queue. Nothing is written to its log until a worker takes
        it, which is why there is nothing to show here yet — the plane dispatches work and
        never produces events itself.
      </p>
      <p className="muted small">
        This page is checking every couple of seconds and will fill in on its own.{' '}
        <code className="hash">{runId}</code>
      </p>
    </>
  );
}

/**
 * Two views of one append-only log, as one list.
 *
 * `seq` identifies a row, so a duplicate is free to drop and order is total. Neither source
 * is authoritative on its own: the snapshot is everything up to the moment it was taken, and
 * the stream is everything from whenever it connected.
 */
/**
 * What to say, out loud, about the newest event.
 *
 * Only the ones worth interrupting for. `AGENT_MESSAGE` is most of a run by volume and
 * saying "the agent said something" three hundred times is the failure mode a live region
 * has, not a feature.
 */
const SAID: Record<string, string> = {
  RUN_REQUESTED: 'the run was requested',
  ENV_BUILT: 'the environment was built',
  SANDBOX_SEALED: 'a sandbox was sealed',
  ATTEMPT_STARTED: 'a new attempt started',
  REPRO_REGISTERED: 'a reproduction was registered',
  TEST_RUN: 'the reproduction ran',
  SUITE_RUN: "the project's own suite ran",
  FIX_DIFF_OBSERVED: 'the fix was measured',
  VERIFICATION_ABORTED: 'observation stopped',
  PR_OPENED: 'a pull request was opened',
  RUN_ENDED: 'the run ended',
};

const merge = (stored: Frame[], live: Frame[]): Frame[] => {
  const bySeq = new Map<number, Frame>();
  for (const frame of stored) bySeq.set(frame.seq, frame);
  for (const frame of live) bySeq.set(frame.seq, frame);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
};

/**
 * Whether to open a stream at all, decided before either source has been merged.
 *
 * Deliberately conservative: anything short of proof that the run has ended opens the
 * stream. A stream opened on a finished run costs one connection that closes on the next
 * render; a stream NOT opened on a live one is a page that never updates.
 */
/** The fold's status, or a non-terminal placeholder while the fold has not arrived. */
const stateOf = (evidence: EvidenceData | null): string => evidence?.state.status ?? 'requested';

const logEnded = (stored: Frame[] | null, evidence: EvidenceData | null): boolean =>
  (stored ?? []).some((frame) => frame.type === 'RUN_ENDED') || evidence?.row.ended_at != null;

/**
 * Destroying this run's artifacts (9e).
 *
 * Behind a typed confirmation rather than a `confirm()`, because this is irreversible and
 * the bytes are the product. What is destroyed and what is not is stated before the button
 * is reachable, not in a dialog that appears after it is pressed.
 */
function Forget({ runId, onDone }: { runId: string; onDone: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <>
      <h2>Destroy the evidence for this run</h2>
      <p className="small">
        Every artifact this run produced is deleted from storage. <b>The log is not edited</b>{' '}
        — the events keep saying what they said, including the <code>sha256:</code>{' '}
        references, which then point at bytes that no longer exist. Artifacts cited by
        another run are kept, because identical bytes are one file and removing them would
        break a run nobody asked to forget.
      </p>
      <div className="field">
        <label htmlFor="forget-confirm">
          Type <code>forget</code> to enable the button
        </label>
        <input
          id="forget-confirm"
          type="text"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          aria-describedby="forget-hint"
        />
        <p className="hint" id="forget-hint">
          There is no undo, and no copy.
        </p>
      </div>
      <button
        type="button"
        className="quiet"
        disabled={typed !== 'forget' || busy}
        onClick={() => {
          setBusy(true);
          void send<{ forgotten: boolean; removed: number }>('POST', `/api/runs/${encodeURIComponent(runId)}/forget`).then(
            (answer) => {
              setBusy(false);
              setSaid(
                answer.ok
                  ? { ok: true, text: `${answer.data?.removed ?? 0} artifact(s) destroyed.` }
                  : { ok: false, text: answer.error ?? 'that failed' },
              );
              if (answer.ok) onDone();
            },
          );
        }}
      >
        {busy ? 'Destroying…' : 'Destroy the artifacts'}
      </button>
      <Said said={said} />
    </>
  );
}
