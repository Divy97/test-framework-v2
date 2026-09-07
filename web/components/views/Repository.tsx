'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Me, RepoDetail } from '../../lib/api';
import { useJson } from '../../lib/hooks';
import { Failed, Loading, Tabs, When } from '../bits';
import { Environment } from './Environment';
import { Runners } from './Runners';
import { Start } from './Start';

type Tab = 'start' | 'environment' | 'runners';

/**
 * One repository, and the four things a person does with it.
 *
 * Stacked on one page these buried the one they came for — the picker that starts a run
 * sat below a JSON textarea twenty rows tall. So this is a tablist, and it is the full ARIA
 * pattern rather than styled buttons (see `Tabs` in `components/bits.tsx`).
 *
 * The selected tab is the URL fragment, so "look at this repository's environment" is a
 * link somebody can send, and Back moves between tabs the way a reader expects.
 */
export function Repository({ repo, me, go }: { repo: string; me: Me | null; go: (to: string) => void }) {
  const detail = useJson<RepoDetail>(`/api/repos/${encodeURIComponent(repo)}`);
  const [tab, setTab] = useState<Tab>('start');

  // BEFORE THE PAINT. Read in an ordinary effect, `/repos/x#environment` rendered the Start
  // tab first — mounting it and firing its `GET …/issues` — and then switched. A layout
  // effect runs before the browser draws, so the tab in the URL is the first one seen.
  const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;
  useBeforePaint(() => {
    const fromHash = () => {
      const hash = window.location.hash.replace('#', '');
      setTab(hash === 'environment' || hash === 'runners' ? hash : 'start');
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [repo]);

  const tabs = useRef<HTMLDivElement>(null);
  const choose = (next: Tab) => {
    setTab(next);
    // A tab changed from somewhere OTHER than the tablist — the "Write its recipe" link in
    // Start's blocker — unmounts the thing that was just activated, and focus falls to
    // `<body>`. Moving it to the now-selected tab is where a reader would expect to be.
    requestAnimationFrame(() => tabs.current?.querySelector<HTMLElement>('[aria-selected=true]')?.focus());
    // `replaceState`, not `pushState`: a tab is a view of the same page, and pushing one
    // entry per tab makes Back walk the tabs instead of leaving the repository.
    window.history.replaceState(null, '', `${window.location.pathname}#${next}`);
  };

  if (detail.loading) return <><h1>{repo}</h1><Loading what={repo} /></>;
  if (detail.status === 404) {
    return (
      <>
        <h1>Not connected</h1>
      <div className="nothing">
        <p>{repo} is not connected.</p>
        <p>
          Either the App is not installed on it, or this account cannot see it — the same
          answer to both, so that a stranger probing names learns nothing about which
          repositories this service knows.
        </p>
      </div>
      </>
    );
  }
  if (!detail.data) return <><h1>{repo}</h1><Failed error={detail.error ?? 'unknown'} retry={detail.reload} /></>;

  const data = detail.data;

  return (
    <>
      <p className="crumb">
        <a
          href="/repos"
          onClick={(event) => {
            if (!event.metaKey && !event.ctrlKey && event.button === 0) {
              event.preventDefault();
              go('/repos');
            }
          }}
        >
          Repositories
        </a>
      </p>
      <h1>{repo}</h1>
      <p className="muted small">
        {data.account} · connected <When iso={data.connectedAt} /> ·{' '}
        {data.onboarded ? (
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
      </p>

      <div ref={tabs}>
      <Tabs<Tab>
        label={`What to do with ${repo}`}
        current={tab}
        onChange={choose}
        tabs={[
          { id: 'start', label: 'Start a run', count: data.runs.length || undefined },
          { id: 'environment', label: 'Environment', count: data.secrets.names.length || undefined },
          { id: 'runners', label: 'Runners' },
        ]}
      >
        {tab === 'start' ? <Start repo={repo} detail={data} me={me} go={go} /> : null}
        {tab === 'environment' ? (
          <Environment repo={repo} detail={data} me={me} onChanged={detail.reload} />
        ) : null}
        {tab === 'runners' ? <Runners repo={repo} /> : null}
      </Tabs>
      </div>
    </>
  );
}
