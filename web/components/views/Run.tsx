'use client';

import { useCallback, useState } from 'react';
import { send, type Evidence as EvidenceData, type Me } from '../../lib/api';
import { useJson, useTail } from '../../lib/hooks';
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
  const [last, setLast] = useState(0);
  const onMeaningful = useCallback(() => {
    const now = Date.now();
    if (now - last < 1200) return;
    setLast(now);
    reload();
  }, [last, reload]);

  const tail = useTail(runId, { onMeaningful });

  if (evidence.loading) return <Loading what="this run" />;
  if (evidence.status === 404) {
    return (
      <div className="nothing">
        <p>No such run.</p>
        <p>
          Either it does not exist, or it belongs to a repository this account cannot see —
          this page gives the same answer to both, so that a stranger guessing ids learns
          nothing about which runs exist.
        </p>
      </div>
    );
  }
  if (!evidence.data) return <Failed error={evidence.error ?? 'unknown'} retry={reload} />;

  const { row, state, score, usage, compute, forgotten } = evidence.data;
  const ended = row.ended_at !== null;
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
        {ended ? (
          <>
            {' '}
            · ended <When iso={row.ended_at} />
          </>
        ) : null}
      </p>

      {!ended ? (
        <p className="live">
          <span className="dot" aria-hidden="true">
            ●
          </span>
          {tail.state === 'retrying' ? (
            <span className="disconnected">Reconnecting to the log…</span>
          ) : (
            <span>Live — {tail.frames.length} events</span>
          )}
        </p>
      ) : null}

      <div className="strip">
        <span className="chip">
          <b>status</b> {row.status.replace(/_/g, ' ')}
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
      <Timeline frames={tail.frames} ended={ended} />
      <RawLog frames={tail.frames} />

      <Evidence data={evidence.data} ended={ended} />

      {me?.forgetting && ended && !forgotten ? <Forget runId={runId} onDone={reload} /> : null}
    </>
  );
}

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
