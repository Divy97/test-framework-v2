'use client';

import { useEffect, useRef, useState } from 'react';
import type { Me } from '../lib/api';
import { useJson, usePath } from '../lib/hooks';
import { Loading } from '../components/bits';
import { Boundary } from '../components/Boundary';
import { Chrome } from '../components/Chrome';
import { Landing, LandingFooter } from '../components/views/Landing';
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
  const { path, search, go } = usePath();
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
    // The PATH is in the announcement, not just the title, because two consecutive runs are
    // both called "Run" — and an identical string produces no DOM mutation, so the live
    // region says nothing at all. Navigating run → run was silent.
    setAnnounced(`${title(path)}. ${path}`);
  }, [path]);

  useEffect(() => {
    if (path !== null) document.title = `${title(path)} — Test Framework v2`;
  }, [path]);

  // The front door of a surface that is showing the application on it. `replace`, not
  // `push`, so Back leaves rather than bouncing off a redirect.
  const signedInAtTheDoor = (path === '/' || path === '') && me.data?.signedIn === true;
  useEffect(() => {
    if (signedInAtTheDoor) window.history.replaceState(null, '', '/repos');
  }, [signedInAtTheDoor]);

  // Before the browser has told us where we are, and at build time. The landing page is
  // the honest thing to render for both.
  const atTheDoor = path === null || path === '/' || path === '';
  if (atTheDoor) {
    if (me.data?.signedIn) {
      // Signed in and looking at the front door. The plane's own `/` route already 302s a
      // signed-in visitor to `/repos`, so this is the case it cannot catch: a surface with
      // no accounts, where `visible()` answers "the local operator" and there is no cookie
      // to have redirected on. The URL is corrected in an effect below, never in render —
      // a `replaceState` during render is a side effect in a function React is free to
      // call twice.
      return (
        <Shell me={me.data} path="/repos" go={go} main={main} announced={announced}>
          <Repos me={me.data} go={go} />
        </Shell>
      );
    }
    return (
      <div className="landing">
        <a className="skip" href="#main">
          Skip to the page
        </a>
        <main id="main">
          <Landing
            installUrl={me.data?.installUrl ?? 'https://github.com/settings/apps/new'}
            signIn={me.data?.accounts ?? false}
          />
        </main>
        {/* OUTSIDE `main`: a `contentinfo` landmark nested inside one is either flagged or
            dropped entirely, depending on the browser's mapping. */}
        <LandingFooter />
      </div>
    );
  }

  // BEFORE ANY VIEW, because a view fetches on mount and the answer decides whether it may.
  //
  // `me.data` is null on the first render, so without this the signed-out case rendered the
  // application for one tick — long enough for `Repos` to mount and fire `GET /api/repos`,
  // which 401s. Harmless to the page and not harmless in general: a doomed request on every
  // page load by every signed-out visitor, and four `401` lines in the console of a product
  // whose browser test uses a clean console as its load-bearing signal.
  if (me.loading) return <Shell me={null} path={path} go={go} main={main} announced={announced}><Loading what="your account" /></Shell>;

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
      <View path={path} search={search} me={me.data} go={go} onChanged={me.reload} />
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
  path: raw,
  search,
  me,
  go,
  onChanged,
}: {
  path: string;
  search: string;
  me: Me | null;
  go: (to: string) => void;
  onChanged: () => void;
}) {
  // A TRAILING SLASH is the same page. `static.ts` serves the document for `/repos/`, and
  // then nothing here matched it — `/^\/repos\/(.+)$/` needs a character after the slash and
  // `path === '/repos'` is false — so the app answered its own "there is no page at" for a
  // URL a person can produce by typing.
  const path = raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;

  const run = /^\/runs\/([^/]+)$/.exec(path);
  if (run) return <Run runId={decode(run[1]!)} me={me} />;
  if (path === '/runs') return <Runs repo={new URLSearchParams(search).get('repo')} go={go} />;
  // `owner/name` has a slash in it, so the repository is the rest of the path.
  const repo = /^\/repos\/(.+)$/.exec(path);
  if (repo) return <Repository repo={decode(repo[1]!)} me={me} go={go} />;
  if (path === '/repos') return <Repos me={me} go={go} />;
  if (path === '/settings') return <Settings me={me} onChanged={onChanged} />;
  return (
    <>
      <h1>Not found</h1>
      <div className="nothing">
        <p>There is no page at {path}.</p>
        <p>
          <a href="/repos">Your repositories</a> is probably where you meant to be.
        </p>
      </div>
    </>
  );
}

/**
 * Percent-decoding that cannot take the application down.
 *
 * `decodeURIComponent('100%')` throws `URIError: URI malformed`, and a throw in a render
 * path unmounts the whole tree: a blank page for a URL somebody typed a stray `%` into.
 * A name that will not decode is passed through as it was written, which then simply fails
 * to match a repository and renders the ordinary "not connected".
 */
const decode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * The page's name, for the tab and for the announcement.
 *
 * `decode`, not `decodeURIComponent`: this is called from `App`'s own effects, which sit
 * ABOVE the error boundary, so a `URIError` here is not a broken screen — it is the whole
 * application unmounted, for a URL containing a stray `%`.
 */
const title = (path: string): string =>
  /^\/runs\/[^/]+$/.test(path) ? 'Run'
  : path === '/runs' ? 'Runs'
  : /^\/repos\/.+$/.test(path) ? decode(path.slice('/repos/'.length))
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
        {/* INSIDE the shell, not around it. A screen that throws should leave the header,
            the navigation and the way out standing — a boundary around the whole document
            would replace the one thing that lets somebody go somewhere else. */}
        {/* KEYED ON THE PATH, so navigating away clears it. Without the key the same
            element position is reused across a `pushState`, `state.failed` survives, and
            one run whose payload this build cannot draw wedges every other screen in the
            application behind the error card until a full reload. */}
        <Boundary key={path}>{children}</Boundary>
      </main>
    </>
  );
}
