'use client';

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

  const rows = repos.data;
  const ready = rows.filter((row) => row.onboarded);
  const waiting = rows.filter((row) => !row.onboarded);

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
                <a
                  href={`/repos/${row.repo}`}
                  onClick={(event) => {
                    if (plain(event)) {
                      event.preventDefault();
                      go(`/repos/${row.repo}`);
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
          <p className="hero">
            {ready.length === 0
              ? 'Nothing here can run yet — a repository needs an approved recipe before an issue on it does anything.'
              : `${ready.length} of ${rows.length} ${ready.length === 1 ? 'repository is' : 'repositories are'} onboarded and can take work. The rest are connected and waiting.`}
          </p>
          {ready.length > 0 ? (
            <>
              <h2>Onboarded</h2>
              {register(ready, 'Repositories with an approved recipe')}
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
                  {register(waiting, 'Repositories waiting for a recipe')}
                </details>
              ) : (
                register(waiting, 'Repositories waiting for a recipe')
              )}
            </>
          ) : null}
        </>
      )}
    </>
  );
}
