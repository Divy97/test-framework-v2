'use client';

import type { Evidence as EvidenceData } from '../../lib/api';
import { Exit, Yes } from '../bits';

export const TIER_MEANING: Record<number, string> = {
  1: 'reproduced by a failing test whose independence is established',
  2: "reproduced, but the reproduction's independence is unverified",
  3: 'not reproduced — no fix was attempted',
};

export const REGRESSION_LABEL: Record<string, string> = {
  clean: 'the suite passed on both commits',
  broken: "the fix breaks the project's own suite",
  unknown: 'the suite was not run on both commits',
};

/**
 * The verdict, as a PURE FUNCTION of the fold — no fetch, no socket, no clock.
 *
 * `src/web.ts` had a rule that mattered more than anything else it said: *no I/O; every
 * export takes data and returns a string, so the screen that IS the product is testable
 * without a database, a browser, or a listening socket. A screen checkable only by
 * starting Postgres is a screen nobody checks.*
 *
 * Moving to React could have quietly deleted that rule — a component that fetches its own
 * data can only be checked by a browser — so this is the half of the run page that renders
 * a verdict, split out and given nothing but props. `Run` fetches and streams; this
 * decides nothing and displays what it is handed. `test/screens.test.tsx` renders it with
 * `renderToStaticMarkup` and asserts on the markup, exactly as `test/web.test.ts` did.
 *
 * Nothing here interprets. `fold.ts` decides what happened and `confidence.ts` decides what
 * it was worth (ADR-0009); this renders them and adds no judgement of its own. The label
 * maps above name verdicts the fold already reached — they are captions, not a second
 * opinion, which is the distinction that has bitten this codebase twice.
 */
export function Evidence({ data, ended }: { data: EvidenceData; ended: boolean }) {
  const { state, score, usage, compute } = data;
  const refused = score.tier === 3;
  const attempt = state.reproducedAttempt;
  const repro = state.registrations.filter((r) => r.attempt === attempt).at(-1) ?? state.registeredRepro;
  return (
    <>
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

    </>
  );
}

const ms = (value: number | null) => (value === null ? '—' : `${Math.round(value)}ms`);
const kb = (value: number | null) => (value === null ? '—' : `${Math.round(value / 1024)}KB`);

function Cost({ usage, compute }: { usage: EvidenceData['usage']; compute: EvidenceData['compute'] }) {
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

