'use client';

import { useCallback, useState } from 'react';
import { send, type Evidence, type Me } from '../../lib/api';
import { useJson, useTail } from '../../lib/hooks';
import { Exit, Failed, Loading, Said, When, Yes } from '../bits';
import { RawLog, Timeline } from '../Timeline';

const TIER_MEANING: Record<number, string> = {
  1: 'reproduced by a failing test whose independence is established',
  2: "reproduced, but the reproduction's independence is unverified",
  3: 'not reproduced — no fix was attempted',
};

const REGRESSION_LABEL: Record<string, string> = {
  clean: 'the suite passed on both commits',
  broken: "the fix breaks the project's own suite",
  unknown: 'the suite was not run on both commits',
};

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
  const evidence = useJson<Evidence>(`/api/runs/${encodeURIComponent(runId)}/evidence`);
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

      {ended && state.regression === 'broken' ? (
        <div className="warning">
          <h2>This fix breaks the project&rsquo;s own test suite.</h2>
          {(() => {
            const broke = state.suiteRuns.filter((r) => r.phase === 'fix' && r.attempt === attempt).at(-1)
              ?? state.suiteRuns.filter((r) => r.phase === 'fix').at(-1);
            return (
              <>
                <p>
                  <code>{broke?.command ?? 'the suite'}</code> passed on the base commit and
                  exits {broke ? broke.exit_code : 'non-zero'} on this one.
                </p>
                <p>
                  The reproduction below is genuine and the evidence for it holds. What does
                  not hold is that this change is safe to merge as it stands.
                  {broke ? (
                    <>
                      {' '}
                      Output: <code>{broke.stdout_hash}</code>
                    </>
                  ) : null}
                </p>
              </>
            );
          })()}
        </div>
      ) : null}

      {ended && refused ? (
        <div className="warning refusal">
          <h2>No fix was attempted.</h2>
          <p>
            The reproduce-first gate held: {score.grounds[0]?.claim ?? 'the run did not reproduce the reported bug'}.
          </p>
          <p>
            This is the deliverable, not a failure to produce one. A fix for a bug that was
            never shown on the base commit is a guess, and no change is shown here because
            none is being offered. The runs below are what was executed to reach that
            conclusion — the same evidence a reproduced run is judged on, arriving at the
            opposite answer.
          </p>
        </div>
      ) : null}

      <h2>The reproduction arm</h2>
      {repro ? (
        <>
          <p className="small">
            Registered command: <code>{repro.command}</code>
          </p>
          {Object.keys(repro.files).length > 0 ? (
            <ul className="plain small">
              {Object.entries(repro.files).map(([path, ref]) => (
                <li key={path}>
                  <code>{path}</code> — <code>{ref}</code>{' '}
                  <span className="muted">
                    {repro.applied.includes(path)
                      ? 'written by the engine over both checkouts'
                      : 'a committed path, hashed rather than applied'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">
              The registration named no files, so there was nothing to anchor it to.
            </p>
          )}
        </>
      ) : (
        <p className="muted">
          {ended ? 'No reproduction was ever registered.' : 'No reproduction registered yet.'}
        </p>
      )}
      {state.testRuns.length > 0 ? (
        <>
          <div className="scroll">
            <table>
              <caption>Every execution of the reproduction, by the engine, on either commit</caption>
              <thead>
                <tr>
                  <th scope="col">phase</th>
                  <th scope="col">run</th>
                  <th scope="col">commit</th>
                  <th scope="col">exit</th>
                  <th scope="col">symptom in output</th>
                  <th scope="col">output</th>
                </tr>
              </thead>
              <tbody>
                {state.testRuns.map((run, index) => (
                  <tr key={index}>
                    <td>{run.phase}</td>
                    <td>{run.repeat ?? 0}</td>
                    <td>
                      <code>{run.commit_sha.slice(0, 12)}</code>
                    </td>
                    <td>
                      <Exit code={run.exit_code} signal={run.signal} />
                    </td>
                    <td>
                      <Yes value={run.symptom_matched} />
                    </td>
                    <td>
                      <code>{run.stdout_hash}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">
            Each row is a command the engine executed itself, in a container of its own, with
            no network and no agent in it. The symptom column is the anchor in both
            directions: present on base ties the failure to the report, and gone from every
            fix run is what makes that tie mean something.
          </p>
        </>
      ) : (
        <p className="muted">{ended ? 'No phase run was ever recorded.' : 'Nothing has been run yet.'}</p>
      )}

      <h2>The regression arm</h2>
      <p>
        {REGRESSION_LABEL[state.regression] ?? state.regression} — the project&rsquo;s own test
        command, executed by the engine on both commits.
      </p>
      {state.suiteRuns.length > 0 ? (
        <div className="scroll">
          <table>
            <caption>The project&rsquo;s own suite, on both commits</caption>
            <thead>
              <tr>
                <th scope="col">phase</th>
                <th scope="col">command</th>
                <th scope="col">exit</th>
                <th scope="col">output</th>
              </tr>
            </thead>
            <tbody>
              {state.suiteRuns.map((run, index) => (
                <tr key={index}>
                  <td>{run.phase}</td>
                  <td>
                    <code>{run.command}</code>
                  </td>
                  <td>
                    <Exit code={run.exit_code} signal={run.signal} />
                  </td>
                  <td>
                    <code>{run.stdout_hash}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="small muted">
          The suite was not run on both commits, so no regression check stands behind this
          run. Not knowing is not the same as knowing it is fine.
        </p>
      )}

      {!refused && state.fixDiff ? (
        <>
          <h2>The diff</h2>
          <ul className="plain small">
            {state.fixDiff.changed_files.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
          <p className="small">
            Full diff: <code>{state.fixDiff.diff_hash}</code>
          </p>
        </>
      ) : null}

      {ended ? (
        <>
          <h2>
            Confidence {score.score}/{score.ceiling}
          </h2>
          <p className="small muted">
            Every point below names the bytes a reviewer would open to check it. A point that
            cannot be checked does not belong here (ADR-0004), which is why this scale stops
            short of 100 and says what the missing points were for.
          </p>
          <ul className="grounds">
            {score.grounds.map((ground, index) => (
              <li key={index}>
                <span className="points">+{ground.points}</span>
                <span>{ground.claim}</span>
                {ground.evidence.length > 0 ? (
                  <div className="refs small">
                    {ground.evidence.map((ref) => (
                      <code key={ref}>{ref}</code>
                    ))}
                  </div>
                ) : (
                  <div className="refs small muted">no artifact — the log holds no bytes for this claim</div>
                )}
              </li>
            ))}
          </ul>
          <h2>Not measured</h2>
          <ul className="plain small">
            {score.unmeasured.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </>
      ) : null}

      {state.aborts.length > 0 ? (
        <>
          <h2>Where observation stopped</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">attempt</th>
                  <th scope="col">phase</th>
                  <th scope="col">cause</th>
                  <th scope="col">reason</th>
                </tr>
              </thead>
              <tbody>
                {state.aborts.map((abort, index) => (
                  <tr key={index}>
                    <td>{abort.attempt}</td>
                    <td>{abort.phase}</td>
                    <td>{abort.cause ?? 'unstated'}</td>
                    <td className="wrap">{abort.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <h2>Testimony</h2>
      <p>
        The agent&rsquo;s transcript: <b>{state.transcript.length} message{state.transcript.length === 1 ? '' : 's'}</b>,
        stored and displayable, and an input to no verdict above. It is what the agent said,
        not what the engine saw.
      </p>
      {state.transcript.length > 0 ? (
        <details>
          <summary>The transcript&rsquo;s index — {state.transcript.length} messages, by hash</summary>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">n</th>
                  <th scope="col">claimed type</th>
                  <th scope="col">bytes</th>
                  <th scope="col">raw</th>
                </tr>
              </thead>
              <tbody>
                {state.transcript.map((message) => (
                  <tr key={message.n}>
                    <td>{message.n}</td>
                    <td>{message.claimed_type ?? 'unstated'}</td>
                    <td className="num">{message.bytes}</td>
                    <td>
                      <code>{message.raw_hash}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      {usage.length > 0 || compute.length > 0 ? <Cost usage={usage} compute={compute} /> : null}

      {me?.forgetting && ended && !forgotten ? <Forget runId={runId} onDone={reload} /> : null}
    </>
  );
}

const ms = (value: number | null) => (value === null ? '—' : `${Math.round(value)}ms`);
const kb = (value: number | null) => (value === null ? '—' : `${Math.round(value / 1024)}KB`);

function Cost({ usage, compute }: { usage: Evidence['usage']; compute: Evidence['compute'] }) {
  return (
    <>
      <h2>What this run cost</h2>
      {usage.length > 0 ? (
        <>
          <h3>The model</h3>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">phase</th>
                  <th scope="col" className="num">turns</th>
                  <th scope="col" className="num">input tokens</th>
                  <th scope="col" className="num">output tokens</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((entry, index) => (
                  <tr key={index}>
                    <td>{entry.phase}</td>
                    <td className="num">{entry.turns}</td>
                    <td className="num">{entry.input_tokens}</td>
                    <td className="num">{entry.output_tokens}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {compute.length > 0 ? (
        <>
          <h3>The machines</h3>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">phase</th>
                  <th scope="col">sandbox</th>
                  <th scope="col" className="num">active cpu</th>
                  <th scope="col" className="num">wall clock</th>
                  <th scope="col" className="num">egress</th>
                </tr>
              </thead>
              <tbody>
                {compute.map((entry) => (
                  <tr key={entry.sandbox_id}>
                    <td>{entry.phase}</td>
                    <td>{entry.sandbox_id}</td>
                    <td className="num">{ms(entry.active_cpu_ms)}</td>
                    <td className="num">{ms(entry.duration_ms)}</td>
                    <td className="num">{kb(entry.egress_bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">
            One row per sandbox, because a run creates two agents and keying on the phase
            would keep the second and lose the first. <strong>Egress is not a seal check</strong>{' '}
            — every phase above was sealed <code>deny-all</code> and every one of them shows
            kilobytes, because the number counts bytes leaving the machine at all: this
            engine&rsquo;s own reads of the transcript, the evidence tarball and the handover
            bundle, and whatever a blocked connection managed to send to the proxy that
            terminates it. Whether a sandbox could reach the internet is answered by{' '}
            <code>SANDBOX_SEALED</code>, which records what a probe <em>inside</em> it found.
          </p>
        </>
      ) : null}
      <p className="small muted">
        Recorded beside the log rather than inside it: an event class describing our own
        spending would put a fact about us into a log about your bug (ADR-0006).
      </p>
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
