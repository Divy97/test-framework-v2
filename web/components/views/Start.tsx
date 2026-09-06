'use client';

import { useMemo, useState } from 'react';
import { send, type Issue, type Me, type RepoDetail } from '../../lib/api';
import { useJson } from '../../lib/hooks';
import { Failed, Loading, Said, When } from '../bits';

/**
 * Pick an issue. Press Start.
 *
 * This is the screen milestone 10 exists for and the one it did not have. `POST /api/runs`
 * has been built, authorized and tested since 10g and nothing in the product called it —
 * the only way to start a run on the hosted plane was `curl`, which is not a product.
 *
 * Everything that can stop a run is answered BEFORE the button, in the words the API would
 * have used afterwards. A person who presses Start and gets a 412 has learned something
 * they could have been told while they were choosing; a disabled button with a sentence
 * beside it is the same information delivered in time to act on.
 */
export function Start({
  repo,
  detail,
  me,
  go,
}: {
  repo: string;
  detail: RepoDetail;
  me: Me | null;
  go: (to: string) => void;
}) {
  const [page, setPage] = useState(1);
  const issues = useJson<Issue[]>(me?.github ? `/api/repos/${encodeURIComponent(repo)}/issues?page=${page}` : null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);

  const open = detail.runs.find((run) => run.ended_at === null);
  // Every reason Start cannot happen, in the order the API checks them, so the sentence a
  // person reads here is the sentence they would have got back.
  const blocker =
    !me?.github
      ? { text: 'This deployment has no GitHub App, so it cannot read issues or start a run.', fix: null }
      : !detail.onboarded
        ? {
            text: 'This repository has no approved recipe. A run against it would boot nothing and report a bug that was never shown.',
            fix: { label: 'Write its recipe', to: '#environment' },
          }
        : me.accounts && me.modelKey === null
          ? {
              text: 'A run spends the model key of whoever starts it, and this account has not stored one.',
              fix: { label: 'Store a key', to: '/settings' },
            }
          : open
            ? {
                text: `A run for ${repo}#${open.issue_number} is already under way. One at a time per repository.`,
                fix: { label: 'Watch it', to: `/runs/${open.run_id}` },
              }
            : null;

  const shown = useMemo(() => {
    const rows = issues.data ?? [];
    const needle = filter.trim().toLowerCase();
    if (needle === '') return rows;
    // Number or text, because "the one about the cart" and "#412" are both how people
    // remember an issue. Client-side over the page already fetched: GitHub's own search is
    // a different endpoint with different rate limits, and offering a box that silently
    // only searched thirty rows would be worse than one that says it does.
    return rows.filter(
      (issue) => issue.title.toLowerCase().includes(needle) || String(issue.number).includes(needle),
    );
  }, [issues.data, filter]);

  const start = () => {
    if (chosen === null) return;
    setBusy(true);
    setSaid(null);
    void send<{ run_id: string }>('POST', '/api/runs', { repo, issue_number: chosen }).then((answer) => {
      setBusy(false);
      if (answer.status === 202 && answer.data) {
        // Straight to the run. The page it lands on is live from its first event, which is
        // the whole reason Start and the timeline shipped together.
        go(`/runs/${answer.data.run_id}`);
        return;
      }
      setSaid({ ok: false, text: answer.error ?? `the service answered ${answer.status}` });
    });
  };

  return (
    <>
      {blocker ? (
        <div className="warning" role="status">
          <h2>Not yet.</h2>
          <p>{blocker.text}</p>
          {blocker.fix ? (
            <p>
              <a href={blocker.fix.to}>{blocker.fix.label}</a>
            </p>
          ) : null}
        </div>
      ) : (
        <p className="hero">
          Pick the issue to work on. The engine clones this repository into a microVM with no
          route out, replays the recipe, reproduces the bug on your base commit before it
          tries anything, and opens a pull request only if it can show the fix works.
        </p>
      )}

      {!me?.github ? null : issues.loading ? (
        <Loading what="open issues" />
      ) : issues.error ? (
        <Failed error={issues.error} retry={issues.reload} />
      ) : (issues.data ?? []).length === 0 ? (
        <div className="nothing">
          <p>No open issues on {repo}.</p>
          <p>Open one on GitHub and it will appear here — this list is asked of GitHub on every load, never cached.</p>
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="issue-filter">Filter these {issues.data?.length} issues</label>
            <input
              id="issue-filter"
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="title or number"
              aria-describedby="issue-filter-hint"
            />
            <p className="hint" id="issue-filter-hint">
              Filters the page below, which is what GitHub returned for page {page}. It does
              not search the whole repository.
            </p>
          </div>

          <fieldset className="bare">
            <legend className="sr">Choose an issue to run against</legend>
            <ul className="issues">
              {shown.map((issue) => (
                <li key={issue.number}>
                  <label>
                    <input
                      type="radio"
                      name="issue"
                      value={issue.number}
                      checked={chosen === issue.number}
                      onChange={() => setChosen(issue.number)}
                      disabled={blocker !== null}
                    />
                    <span className="title">{issue.title}</span>
                    <span className="meta">#{issue.number}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          {shown.length === 0 ? (
            <p className="muted small" role="status">
              Nothing on this page matches &ldquo;{filter}&rdquo;.
            </p>
          ) : null}

          <div className="row">
            <button type="button" disabled={chosen === null || blocker !== null || busy} onClick={start}>
              {busy ? 'Starting…' : 'Start a run'}
            </button>
            {page > 1 ? (
              <button type="button" className="quiet small" onClick={() => setPage(page - 1)}>
                Previous page
              </button>
            ) : null}
            {(issues.data ?? []).length >= 30 ? (
              <button type="button" className="quiet small" onClick={() => setPage(page + 1)}>
                Next page
              </button>
            ) : null}
          </div>
          <Said said={said} />
          {chosen !== null && blocker === null ? (
            <p className="muted small">
              This will spend your model key and create microVMs that are billed by the
              second. Every one of them is destroyed when the run ends.
            </p>
          ) : null}
        </>
      )}

      {detail.runs.length > 0 ? (
        <>
          <h2>Recent runs on this repository</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">issue</th>
                  <th scope="col">started</th>
                  <th scope="col">status</th>
                  <th scope="col">tier</th>
                </tr>
              </thead>
              <tbody>
                {detail.runs.slice(0, 5).map((run) => (
                  <tr key={run.run_id}>
                    <td>
                      <a href={`/runs/${run.run_id}`}>#{run.issue_number}</a>
                    </td>
                    <td>
                      <When iso={run.started_at} />
                    </td>
                    <td>{run.ended_at === null ? <span className="pending">running</span> : run.status.replace(/_/g, ' ')}</td>
                    <td>{run.ended_at === null ? '—' : run.tier}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </>
  );
}
