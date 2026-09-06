'use client';

import { useEffect, useRef, useState } from 'react';
import type { Me } from '../lib/api';
import { useJson, usePath } from '../lib/hooks';
import { Chrome } from '../components/Chrome';
import { Landing } from '../components/views/Landing';
import { Repos } from '../components/views/Repos';
import { Repository } from '../components/views/Repository';
import { Run } from '../components/views/Run';
import { Runs } from '../components/views/Runs';
import { Settings } from '../components/views/Settings';

/**
 * The whole application, and the only document the plane serves for a page path.
 *
 * A dynamic segment cannot be pre-rendered without a build-time list of the ids in it, and
 * there is no such list for runs. So rather than six exported documents and six rewrite
 * rules in the plane, this is ONE document with the view chosen from `location.pathname` —
 * which also means navigation between screens is a `pushState` rather than a round trip,
 * and a live run's tail survives a click to another tab and back.
 *
 * At BUILD time there is no `location`, and `usePath` answers `null` for exactly that
 * moment. What is rendered then is the landing page — deliberately, because `index.html` is
 * what a crawler, a link preview and a reader with no JavaScript receive, and an empty shell
 * would be what they got if this rendered a spinner instead.
 */
export default function App() {
  const { path, go } = usePath();
  const me = useJson<Me>('/api/me');
  const main = useRef<HTMLElement>(null);
  const [announced, setAnnounced] = useState('');

  // FOCUS, on every navigation that is not the first. A `pushState` router changes the
  // whole page and moves nothing: a screen-reader user is left where they were, in a
  // document that is now something else, with no announcement that anything happened.
  const first = useRef(true);
  useEffect(() => {
    if (path === null) return;
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus();
    setAnnounced(title(path));
  }, [path]);

  useEffect(() => {
    if (path !== null) document.title = `${title(path)} — Test Framework v2`;
  }, [path]);

  // Before the browser has told us where we are, and at build time. The landing page is
  // the honest thing to render for both.
  if (path === null || path === '/' || path === '') {
    if (me.data?.signedIn) {
      // Signed in and looking at the front door. The server route used to answer this with
      // a 302; here it is a replace, so Back does not bounce off the redirect.
      if (typeof window !== 'undefined') window.history.replaceState(null, '', '/repos');
      return <Shell me={me.data} path="/repos" go={go} main={main} announced={announced}><Repos me={me.data} go={go} /></Shell>;
    }
    return (
      <div className="landing">
        <main>
          <Landing installUrl={me.data?.installUrl ?? 'https://github.com/settings/apps/new'} signIn={me.data?.accounts ?? false} />
        </main>
      </div>
    );
  }

  // Signed out, anywhere but the front door. Every `/api/` route below would answer 401,
  // and rendering six of those as six error panels is a worse way of saying "sign in".
  if (me.data && !me.data.signedIn) {
    return (
      <Shell me={me.data} path={path} go={go} main={main} announced={announced}>
        <h1>Sign in</h1>
        <div className="nothing">
          <p>This page is about repositories a GitHub account can see, and there is no account here yet.</p>
          <p className="calls">
            <a className="cta" href="/auth/github">
              Sign in with GitHub
            </a>
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell me={me.data} path={path} go={go} main={main} announced={announced}>
      <View path={path} me={me.data} go={go} onChanged={me.reload} />
    </Shell>
  );
}

/**
 * Which screen this path is.
 *
 * Matched here rather than by a router, because there are six of them and a table of six
 * regular expressions is smaller and more legible than any library that would match them.
 */
function View({
  path,
  me,
  go,
  onChanged,
}: {
  path: string;
  me: Me | null;
  go: (to: string) => void;
  onChanged: () => void;
}) {
  const run = /^\/runs\/([^/]+)$/.exec(path);
  if (run) return <Run runId={decodeURIComponent(run[1]!)} me={me} />;
  if (path === '/runs') {
    const repo = new URLSearchParams(window.location.search).get('repo');
    return <Runs repo={repo} go={go} />;
  }
  // `owner/name` has a slash in it, so the repository is the rest of the path.
  const repo = /^\/repos\/(.+)$/.exec(path);
  if (repo) return <Repository repo={decodeURIComponent(repo[1]!)} me={me} go={go} />;
  if (path === '/repos') return <Repos me={me} go={go} />;
  if (path === '/settings') return <Settings me={me} onChanged={onChanged} />;
  return (
    <div className="nothing">
      <p>There is no page at {path}.</p>
      <p>
        <a href="/repos">Your repositories</a> is probably where you meant to be.
      </p>
    </div>
  );
}

const title = (path: string): string =>
  /^\/runs\/[^/]+$/.test(path) ? 'Run'
  : path === '/runs' ? 'Runs'
  : /^\/repos\/.+$/.test(path) ? decodeURIComponent(path.slice('/repos/'.length))
  : path === '/repos' ? 'Repositories'
  : path === '/settings' ? 'Settings'
  : 'Not found';

function Shell({
  me,
  path,
  go,
  main,
  announced,
  children,
}: {
  me: Me | null;
  path: string;
  go: (to: string) => void;
  main: React.RefObject<HTMLElement | null>;
  announced: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <a className="skip" href="#main">
        Skip to the page
      </a>
      <Chrome me={me} path={path} go={go} />
      {/* The announcement for a `pushState` navigation, which the browser makes none of.
          Separate from the heading so that moving focus and saying where you are do not
          have to be the same act — a focused <main> is announced as a region, not as a
          page change. */}
      <p className="sr" role="status" aria-live="polite">
        {announced}
      </p>
      <main id="main" ref={main} tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
