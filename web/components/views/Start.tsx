'use client';

import { useMemo, useState } from 'react';
import { isOver, send, type Issue, type Me, type RepoDetail } from '../../lib/api';
import { useJson } from '../../lib/hooks';
import { Failed, Loading, Said, When } from '../bits';
import { missingNames } from '../../lib/required';

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

  const open = detail.runs.find((run) => !isOver(run.status, run.ended_at));
  // Every reason Start cannot happen, in the order the API checks them, so the sentence a
  // person reads here is the sentence they would have got back.
  const missing = missingNames(detail.recipe, detail.secrets.names);
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
          : // MISSING SECRETS (10n), and this list is why the omission mattered. The comment
            // above it says every reason a run can be refused is answered BEFORE the
            // button, in the words the API would use — and this was the one that was not.
            // The recipe NAMES what it needs, nothing compared that to what was stored,
            // and `missingRequired` in `src/run.ts` stopped the run correctly: after the
            // person had chosen an issue, pressed Start, and waited. A blocked run whose
            // cause was on screen the whole time.
            missing.length > 0
            ? {
                text:
                  `The recipe for ${repo} requires ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not ` +
                  `stored. A run would stop before booting your project rather than report a bug it could not see.`,
                fix: { label: missing.length === 1 ? 'Store it' : 'Store them', to: '#environment' },
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

  /**
   * Turning a page forgets what was chosen on the last one.
   *
   * `chosen` survived `setPage`, so selecting #5 on page one and clicking Next left the
   * radio gone, the Start button enabled, and Start running an issue that was no longer on
   * screen. The number is what the button sends; the radio is only how it was picked.
   */
  const turn = (to: number) => {
    setChosen(null);
    setSaid(null);
    setPage(to);
  };

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
        // `id`, so the disabled button can point at it, and NO `role="status"`: this is a
        // static explanation, not an update, and announcing the whole heading-and-paragraph
        // every time `detail` reloads is an interruption nobody asked for.
        <div className="warning" id="why-not">
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
        // TWO different empty states, because they were one and the wrong one stranded
        // people. "Next page" is offered whenever a page is full, so paging past the end
        // returned `[]` — and this branch replaced the whole control block INCLUDING
        // "Previous page", leaving somebody on page 2 reading "no open issues" about a
        // repository with thirty of them, and no way back.
        <div className="nothing">
          {page > 1 ? (
            <>
              <p>There is nothing on page {page}.</p>
              <p>
                <button type="button" className="quiet small" onClick={() => turn(page - 1)}>
                  Back to page {page - 1}
                </button>
              </p>
            </>
          ) : (
            <>
              <p>No open issues on {repo}.</p>
              <p>
                Open one on GitHub and it will appear here — this list is asked of GitHub on
                every load, never cached.
              </p>
            </>
          )}
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
          {/* Always in the tree, text toggled — a live region mounted together with its
              content announces nothing, which is the rule `bits.tsx` states and this was
              breaking on every keystroke that filtered everything out. */}
          <p className="muted small" role="status" aria-live="polite">
            {shown.length === 0 ? `Nothing on this page matches “${filter}”.` : ''}
          </p>

          <div className="row">
            {/* `aria-describedby`, because `disabled` removes the button from the tab order
                and announces only "unavailable". The four reasons are computed above and
                rendered beside it — visually. This is what associates them. */}
            <button
              type="button"
              disabled={chosen === null || blocker !== null || busy}
              {...(blocker ? { 'aria-describedby': 'why-not' } : {})}
              onClick={start}
            >
              {busy ? 'Starting…' : 'Start a run'}
            </button>
            {page > 1 ? (
              <button type="button" className="quiet small" onClick={() => turn(page - 1)}>
                Previous page
              </button>
            ) : null}
            {(issues.data ?? []).length >= 30 ? (
              <button type="button" className="quiet small" onClick={() => turn(page + 1)}>
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
                    <td>
                      {isOver(run.status, run.ended_at) ? (
                        run.status.replace(/_/g, ' ')
                      ) : (
                        <span className="pending">
                          <span className="mark" aria-hidden="true">
                            ●
                          </span>
                          running
                        </span>
                      )}
                    </td>
                    <td>{isOver(run.status, run.ended_at) ? run.tier : '—'}</td>
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
