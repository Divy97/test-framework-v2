'use client';

import { isOver, type RunRow } from '../../lib/api';
import { useJson } from '../../lib/hooks';
import { Failed, Loading, ShortId, When } from '../bits';
import { plain } from '../Chrome';

const TIER_MEANING: Record<number, string> = {
  1: 'reproduced by a failing test whose independence is established',
  2: "reproduced, but the reproduction's independence is unverified",
  3: 'not reproduced — no fix was attempted',
};

/**
 * Every run, newest first.
 *
 * A register rather than a feed: one row per run, the columns a person compares runs on,
 * and no summarising. A run that is still going says so and links to the page that shows
 * it happening — which until 10i was a link to a page that showed nothing until it ended.
 */
export function Runs({ repo, go }: { repo: string | null; go: (to: string) => void }) {
  const runs = useJson<RunRow[]>(repo ? `/api/runs?repo=${encodeURIComponent(repo)}` : '/api/runs');
  const heading = <h1>{repo ? `Runs on ${repo}` : 'Runs'}</h1>;
  if (runs.loading) return <>{heading}<Loading what="runs" /></>;
  if (!runs.data) return <>{heading}<Failed error={runs.error ?? 'unknown'} retry={runs.reload} /></>;

  const rows = runs.data;
  return (
    <>
      {heading}
      {rows.length === 0 ? (
        <div className="nothing">
          <p>{repo ? `No run has been started on ${repo}.` : 'No run has been started yet.'}</p>
          <p>Open a repository and pick an issue to start one.</p>
        </div>
      ) : (
        <div className="scroll">
          <table>
            <caption>
              {rows.length} run{rows.length === 1 ? '' : 's'}, newest first. Tier 1 is
              reproduced with an independent test, Tier 2 reproduced, Tier 3 not reproduced —
              so no fix was attempted.
            </caption>
            <thead>
              <tr>
                <th scope="col">run</th>
                <th scope="col">repository</th>
                <th scope="col">issue</th>
                <th scope="col">started</th>
                <th scope="col">status</th>
                <th scope="col">tier</th>
                <th scope="col" className="num">confidence</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((run) => (
                <tr key={run.run_id}>
                  <td>
                    <a
                      href={`/runs/${run.run_id}`}
                      onClick={(event) => {
                        if (plain(event)) {
                          event.preventDefault();
                          go(`/runs/${run.run_id}`);
                        }
                      }}
                    >
                      <ShortId id={run.run_id} />
                    </a>
                  </td>
                  <td>{run.repo}</td>
                  <td>#{run.issue_number}</td>
                  <td>
                    <When iso={run.started_at} />
                  </td>
                  <td>
                    {!isOver(run.status, run.ended_at) ? (
                      <span className="pending">
                        <span className="mark" aria-hidden="true">
                          ●
                        </span>
                        running
                      </span>
                    ) : (
                      run.status.replace(/_/g, ' ')
                    )}
                  </td>
                  <td>
                    {isOver(run.status, run.ended_at) ? (
                      <>
                        {run.tier}
                        {/* The meaning was in a `title` only — unreachable by keyboard,
                            unreliable in a screen reader, invisible on touch. */}
                        <span className="sr">: {TIER_MEANING[run.tier] ?? 'unknown'}</span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="num">
                    {isOver(run.status, run.ended_at) ? `${run.confidence}/${run.ceiling}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
