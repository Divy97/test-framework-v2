'use client';

import { send } from '../lib/api';
import type { Me } from '../lib/api';

/**
 * The header, which is the only navigation this product has.
 *
 * One place, so a page cannot invent a third tab — the same rule `src/web.ts` held. What
 * is new is that the tabs are now buttons over `pushState` rather than links to separate
 * documents, and that has one accessibility consequence worth stating: they are still
 * `<a href>` elements with real URLs, because a middle click, a copied link and a browser
 * that has not run the JavaScript all have to keep working. `go()` is an enhancement on
 * top of a navigation that would have happened anyway.
 */
export function Chrome({ me, path, go }: { me: Me | null; path: string; go: (to: string) => void }) {
  const nav: [string, string][] = [
    ['/repos', 'Repositories'],
    ['/runs', 'Runs'],
    ['/settings', 'Settings'],
  ];
  const here = (to: string) => path === to || path.startsWith(`${to}/`);

  return (
    <header className="top">
      <a
        className="brand"
        href="/repos"
        onClick={(event) => {
          if (plain(event)) {
            event.preventDefault();
            go('/repos');
          }
        }}
      >
        Test Framework v2
      </a>
      <nav aria-label="Sections">
        {nav.map(([to, label]) => (
          <a
            key={to}
            href={to}
            {...(here(to) ? { 'aria-current': 'page' as const } : {})}
            onClick={(event) => {
              if (plain(event)) {
                event.preventDefault();
                go(to);
              }
            }}
          >
            {label}
          </a>
        ))}
      </nav>
      <div className="out">
        {me?.login ? <span className="who">{me.login}</span> : null}
        {me?.accounts && me.signedIn ? (
          <button
            type="button"
            onClick={() => {
              // A POST, because signing out is a state change and a GET that logs you out
              // is a link anybody can put in an image tag. The plane clears the cookie and
              // answers a redirect; the reload is what makes the whole app re-ask
              // `/api/me` rather than keep a stale session in memory.
              void send('POST', '/auth/logout').then(() => window.location.assign('/'));
            }}
          >
            Sign out
          </button>
        ) : null}
      </div>
    </header>
  );
}

/**
 * A click the browser would have handled as a navigation.
 *
 * Modified clicks — new tab, new window, download, a middle click — belong to the browser
 * and intercepting them is the single most common way a single-page app breaks something
 * every user already knows how to do.
 */
export const plain = (event: React.MouseEvent): boolean =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
