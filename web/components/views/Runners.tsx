'use client';

import { useState } from 'react';
import { send, type Runner } from '../../lib/api';
import { useJson } from '../../lib/hooks';
import { Failed, Loading, Said, When } from '../bits';

/**
 * The machines allowed to take work for this repository (9c).
 *
 * A pairing token is a credential for a machine that will execute somebody's recipe, and it
 * exists in exactly one response. The HTML page had to RENDER rather than redirect for that
 * reason; here the answer carries it and the screen keeps it until the reader navigates
 * away, with no pretence that it can be found again.
 *
 * On the hosted plane most people will never open this: the worker is ours and is paired by
 * an operator script. It is here because retiring the page that had it would have deleted a
 * working feature from anyone running the engine on their own hardware, which is the
 * deployment ADR-0019 is written about.
 */
export function Runners({ repo }: { repo: string }) {
  const listing = useJson<{ runners: Runner[]; planeUrl: string }>(
    `/api/repos/${encodeURIComponent(repo)}/runners`,
  );
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<{ token: string; name: string; planeUrl: string } | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);

  if (listing.loading) return <Loading what="runners" />;
  if (!listing.data) return <Failed error={listing.error ?? 'unknown'} retry={listing.reload} />;

  const { runners, planeUrl } = listing.data;

  return (
    <>
      <p className="hero">
        A runner dials out to this service, receives no inbound connection, and asks for a
        short-lived token per run. Pairing one hands over a credential once.
      </p>

      {minted ? (
        <div className="panel">
          <h2>This is the only time this token is shown.</h2>
          <p>
            Nothing stores it in a form anything can read back — the database holds a hash.
            Put it in the runner&rsquo;s environment now; if you lose it, revoke this machine
            and pair another.
          </p>
          <div className="log">
            <div>
              <span className="seq">1</span>
              <span>ENGINE_PLANE_URL={minted.planeUrl}</span>
            </div>
            <div>
              <span className="seq">2</span>
              <span>ENGINE_RUNNER_TOKEN={minted.token}</span>
            </div>
          </div>
        </div>
      ) : null}

      {runners.length > 0 ? (
        <div className="scroll">
          <table>
            <caption>Machines paired to this installation</caption>
            <thead>
              <tr>
                <th scope="col">name</th>
                <th scope="col">paired</th>
                <th scope="col">last seen</th>
                <th scope="col">state</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {runners.map((runner) => (
                <tr key={runner.id}>
                  <td>{runner.name}</td>
                  <td>
                    <When iso={runner.pairedAt} />
                  </td>
                  <td>{runner.lastSeen ? <When iso={runner.lastSeen} /> : <span className="muted">never</span>}</td>
                  <td>
                    {runner.revokedAt ? (
                      <span className="fail">
                        <span className="mark" aria-hidden="true">
                          ✗
                        </span>
                        revoked
                      </span>
                    ) : (
                      <span className="pass">
                        <span className="mark" aria-hidden="true">
                          ✓
                        </span>
                        active
                      </span>
                    )}
                  </td>
                  <td>
                    {runner.revokedAt ? null : (
                      <button
                        type="button"
                        className="quiet small"
                        onClick={() => {
                          void send(
                            'POST',
                            `/api/repos/${encodeURIComponent(repo)}/runners/${encodeURIComponent(runner.id)}/revoke`,
                          ).then((answer) => {
                            setSaid(
                              answer.ok
                                ? { ok: true, text: `${runner.name} revoked.` }
                                : { ok: false, text: answer.error ?? 'that failed' },
                            );
                            if (answer.ok) listing.reload();
                          });
                        }}
                      >
                        Revoke <span className="sr">{runner.name}</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="nothing">
          <p>No machine is paired to this repository.</p>
          <p>
            On this deployment that may be correct — the hosted worker is paired once by an
            operator and takes work for every installation.
          </p>
        </div>
      )}

      <h2>Pair a machine</h2>
      <div className="field">
        <label htmlFor="runner-name">A name you will recognise</label>
        <input
          id="runner-name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="build-box"
          autoComplete="off"
        />
        <p className="hint">
          It will dial <code>{planeUrl}</code>.
        </p>
      </div>
      <button
        type="button"
        disabled={name.trim() === '' || busy}
        onClick={() => {
          setBusy(true);
          void send<{ token: string; paired: Runner; planeUrl: string }>(
            'POST',
            `/api/repos/${encodeURIComponent(repo)}/runners`,
            { name: name.trim() },
          ).then((answer) => {
            setBusy(false);
            if (answer.ok && answer.data) {
              setMinted({ token: answer.data.token, name: answer.data.paired.name, planeUrl: answer.data.planeUrl });
              setName('');
              setSaid({ ok: true, text: `${answer.data.paired.name} paired. Its token is above.` });
              listing.reload();
              return;
            }
            setSaid({ ok: false, text: answer.error ?? 'that failed' });
          });
        }}
      >
        {busy ? 'Pairing…' : 'Pair a machine'}
      </button>
      <Said said={said} />
    </>
  );
}
