'use client';

import { useState } from 'react';
import type { Me, RepoRow } from '../../lib/api';
import { useJson } from '../../lib/hooks';
import { Failed, Loading, When } from '../bits';
import { plain } from '../Chrome';

/**
 * The repository list, whose real content is the onboarding status.
 *
 * An installed repository with no approved recipe is the state that used to produce the
 * product's worst answer: a run starting with `recipe: null`, booting nothing, and
 * returning a Tier 3 about a bug that was never shown. So "not onboarded yet" is not a
 * warning decoration — it is the row's most important column, and it carries the link that
 * resolves it.
 *
 * SPLIT, not sorted. An account can have hundreds of repositories connected and one
 * onboarded, and a single list buries the only row that can do anything — which is exactly
 * what happened here at 176 of 177.
 */
export function Repos({ me, go }: { me: Me | null; go: (to: string) => void }) {
  const repos = useJson<RepoRow[]>('/api/repos');
  // The heading FIRST, on every state. A loading or failed view that returns in place of
  // the page leaves the document with no `h1` — and on the failure path the first heading
  // becomes `Failed`'s `h2`, so the page starts at level two.
  if (repos.loading) return <><h1>Repositories</h1><Loading what="your repositories" /></>;
  if (!repos.data) return <><h1>Repositories</h1><Failed error={repos.error ?? 'unknown'} retry={repos.reload} /></>;

  return <Register rows={repos.data} me={me} go={go} />;
}

/**
 * The two registers, as a pure function of the rows.
 *
 * Split out for the reason `Evidence` was split from `Run` — a component that fetches its
 * own data can only be checked in a browser, and the browser test skips without chromium or
 * a built bundle.
 */
export function Register({ rows, me, go }: { rows: RepoRow[]; me: Me | null; go: (to: string) => void }) {
  // A FILTER, because the honest instruction used to be "use your browser's find" (10n).
  // Granting the App access to a whole account is the ordinary case — this one has 177
  // repositories and onboards them one at a time — and the list is the first screen after
  // signing in. Client-side over rows already fetched, the same shape `Start` uses for
  // issues; there is no second request and nothing to debounce.
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const shown = needle === '' ? rows : rows.filter((row) => row.repo.toLowerCase().includes(needle));
  const ready = shown.filter((row) => row.onboarded);
  const waiting = shown.filter((row) => !row.onboarded);
  const total = { ready: rows.filter((row) => row.onboarded).length };

  // The caption carries the COUNT, which the `<h2>` above it does not. A caption that
  // repeats its own heading is read twice by a screen reader and is noise on the page.
  const register = (of: RepoRow[], caption: string) => (
    <div className="scroll">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">repository</th>
            <th scope="col">account</th>
            <th scope="col">connected</th>
            <th scope="col" className="num">runs</th>
            <th scope="col">onboarding</th>
          </tr>
        </thead>
        <tbody>
          {of.map((row) => (
            <tr key={row.repo}>
              <td>
                {/* ENCODED PER SEGMENT. `owner/name` keeps its separator — the router
                    matches on it — but everything else is escaped, because a repository name
                    is GitHub's string and not ours: a `#` truncates the path at the fragment
                    and links somewhere else, and a quote used to be able to break out of the
                    attribute entirely. React closes the second; this closes the first. */}
                <a
                  href={href(row.repo)}
                  onClick={(event) => {
                    if (plain(event)) {
                      event.preventDefault();
                      go(href(row.repo));
                    }
                  }}
                >
                  {row.repo}
                </a>
              </td>
              <td className="muted">{row.account}</td>
              <td className="muted">
                <When iso={row.connectedAt} />
              </td>
              <td className="num">{row.runs === 0 ? <span className="muted">&mdash;</span> : row.runs}</td>
              <td>
                {row.onboarded ? (
                  <span className="pass">
                    <span className="mark" aria-hidden="true">
                      ✓
                    </span>
                    recipe approved
                  </span>
                ) : (
                  <span className="fail">
                    <span className="mark" aria-hidden="true">
                      ✗
                    </span>
                    not onboarded yet
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <h1>Repositories</h1>
      {rows.length === 0 ? (
        <div className="nothing">
          <p>No repositories are connected yet.</p>
          <p>
            Install the App on one to start. It grants access to the repositories you pick and
            nothing else.
          </p>
          {me?.installUrl ? (
            <p className="calls">
              <a className="cta" href={me.installUrl}>
                Install on GitHub
              </a>
            </p>
          ) : null}
        </div>
      ) : (
        <>
          {/* THE KEY, ASKED HERE (10n). It is needed for drafting and for every run, and
              it used to be discovered at step eight of fifteen as a button that would not
              press — on a repository the reader had already committed to. This is the
              first screen after signing in, and thirty seconds spent here removes a detour
              from the middle of the flow. Not a blocker: a reader who wants to look around
              first is not stopped. */}
          {me?.accounts && me.modelKey === null ? (
            <div className="notice">
              <p>
                <b>You have not stored a model key.</b> Drafting a recipe and starting a run
                both spend the key of whoever asks for them, so nothing here can start until
                there is one. It takes about thirty seconds.
              </p>
              <p className="calls">
                <a className="cta" href="/settings">
                  Store a model key
                </a>
              </p>
            </div>
          ) : null}
          {rows.length > 12 ? (
            <p className="field">
              <label htmlFor="repo-filter">Find a repository</label>
              <input
                id="repo-filter"
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="owner/name"
                autoComplete="off"
              />
              {needle === '' ? null : (
                <span className="hint" role="status">
                  {shown.length === 0
                    ? `Nothing matches “${filter.trim()}”.`
                    : `${shown.length} of ${rows.length} match “${filter.trim()}”.`}
                </span>
              )}
            </p>
          ) : null}
          <p className="hero">
            {total.ready === 0
              ? 'Nothing here can run yet — a repository needs an approved recipe before an issue on it does anything.'
              : // The plural agrees with the TOTAL, not with the onboarded count — "1 of 2
                // repository is onboarded" is what the other way round produces, and it is
                // the sentence at the top of the first screen anybody sees.
                // Counted over ALL rows, never the filtered ones: this is the top-line
                // fact about the account, and a filter that quietly rewrote it would make
                // typing into a search box look like repositories being onboarded.
                `${total.ready} of ${rows.length} ${rows.length === 1 ? 'repository is' : 'repositories are'} onboarded and can take work. ${
                  rows.length - total.ready === 1 ? 'The other is' : 'The rest are'
                } connected and waiting.`}
          </p>
          {ready.length > 0 ? (
            <>
              <h2>Onboarded</h2>
              {register(ready, `${ready.length} with an approved recipe, and able to take work`)}
            </>
          ) : null}
          {waiting.length > 0 ? (
            <>
              <h2>Connected, not onboarded</h2>
              {waiting.length > 12 ? (
                <details>
                  <summary>
                    {waiting.length} repositories — expand to onboard one, then use your
                    browser&rsquo;s find to locate it
                  </summary>
                  {register(waiting, `${waiting.length} connected, each waiting for a recipe`)}
                </details>
              ) : (
                register(waiting, `${waiting.length} connected, each waiting for a recipe`)
              )}
            </>
          ) : null}
        </>
      )}
    </>
  );
}

/** `owner/repo` in a URL path: each segment encoded, the separator kept. */
const href = (repo: string): string => `/repos/${repo.split('/').map(encodeURIComponent).join('/')}`;
