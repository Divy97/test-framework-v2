// The three routes a login is: go, come back, leave.
//
// Separate from `dashboardRoutes` because they answer a different question. Those routes
// ask "may this person act on this repository" and are the product; these establish who
// the person is at all, and nothing else on the surface needs to know how.

import type { Db } from './store.js';
import {
  authorizeUrl,
  clearedCookie,
  cookieValue,
  createSession,
  endSession,
  identify,
  sameState,
  sessionCookie,
  type OAuthConfig,
} from './auth.js';
import { sameOrigin, type Route } from './sse.js';

/** The state cookie lives exactly as long as a login takes. */
const STATE_COOKIE = 'tf_oauth_state';
const stateCookie = (state: string, secure: boolean) =>
  `${STATE_COOKIE}=${state}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`;

const seeOther = (location: string, cookie?: string) => {
  const headers: Record<string, string> = { location };
  if (cookie !== undefined) headers['set-cookie'] = cookie;
  return { status: 303, type: 'text/plain', body: 'go\n', headers };
};

/**
 * A refusal a person can act on, and a stranger learns nothing from.
 *
 * Deliberately one page for every failure — a refused exchange, a state that did not
 * come back, a GitHub that would not answer. Telling somebody at a login screen WHICH
 * of those happened describes our configuration rather than their attempt.
 *
 * THE ONLY HTML THIS SERVICE STILL RENDERS, since 10i moved every screen into `web/`'s
 * static bundle (ADR-0022). It cannot join them, and the reason is the shape of the
 * failure: a person arrives here mid-redirect from GitHub, on a URL the bundle's router
 * has no view for, with a query string carrying the reason. Answering with the
 * application and letting it discover the problem would mean shipping a screen whose only
 * job is to explain a state it cannot be given.
 *
 * So it is written out here, with its own two colours and no stylesheet. Self-contained
 * rather than sharing a layout, because the one thing this page must survive is the rest
 * of the front end being broken.
 */
const escape = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const refused = (why: string) =>
  ({
    status: 400,
    type: 'text/html; charset=utf-8',
    body:
      `<!doctype html><html lang="en"><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Sign-in did not complete</title>` +
      `<style>:root{color-scheme:light dark;--paper:#faf9f6;--ink:#17161a;--muted:#65635c}` +
      `@media(prefers-color-scheme:dark){:root{--paper:#121110;--ink:#eceae3;--muted:#9c978f}}` +
      `body{margin:0;background:var(--paper);color:var(--ink);` +
      `font:400 1.0625rem/1.62 ui-serif,Georgia,serif;padding:4rem 1.5rem;max-width:36rem}` +
      `h1{font-weight:400;letter-spacing:-.02em}p{color:var(--muted)}` +
      `a{display:inline-block;margin-top:1.5rem;padding:.7rem 1.4rem;background:var(--ink);` +
      `color:var(--paper);text-decoration:none;border-radius:4px;` +
      `font:500 .78rem/1 ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase}` +
      `</style>` +
      `<h1>That sign-in did not complete</h1>` +
      `<p>${escape(why)}</p>` +
      `<a href="/auth/github">Try again</a>`,
    headers: { 'set-cookie': clearedCookie() },
  }) as const;

export function authRoutes(options: {
  client: Db;
  oauth: OAuthConfig;
  /** False for a plane on plain http in development; the cookie says so either way. */
  secure?: boolean;
}): Route {
  const { client, oauth } = options;
  const secure = options.secure !== false;

  return async ({ method, path, query, headers }) => {
    if (!path.startsWith('/auth/')) return null;

    if (method === 'GET' && path === '/auth/github') {
      const { url, state } = authorizeUrl(oauth);
      // The state goes in a cookie and comes back in the query. Both halves have to
      // agree, which is what stops an attacker completing their own flow and handing
      // the victim's browser a code that logs them into somebody else's account.
      return seeOther(url, stateCookie(state, secure));
    }

    if (method === 'GET' && path === '/auth/github/callback') {
      const code = query.get('code') ?? '';
      const returned = query.get('state') ?? undefined;
      const expected = cookieValue(headers['cookie'], STATE_COOKIE);
      if (!code) return refused('GitHub sent us back without a code.');
      if (!sameState(returned, expected)) {
        return refused('That sign-in did not start here, so it was not completed.');
      }

      const who = await identify(oauth, code);
      if (!who) return refused('GitHub would not confirm who that was.');

      const id = await createSession(client, who);
      return {
        status: 303,
        type: 'text/plain',
        body: 'signed in\n',
        headers: {
          location: '/repos',
          // Two cookies, and the second one matters: the state cookie has done its job
          // and a login flow that leaves it behind leaves a usable one lying around.
          'set-cookie': sessionCookie(id, { secure }),
        },
      };
    }

    // POST, not GET. A link that logs somebody out is a link anybody's page can embed.
    //
    // And the same-origin check is APPLIED here, which it was not: the comment that used
    // to sit on this line said the check guarding the rest of the surface covered writes,
    // and it does — the rest of the surface. `sameOrigin` lived inside `dashboardRoutes`,
    // and these routes are chained ahead of it, so a cross-site form could sign somebody
    // out. Small stakes as attacks go, and a claim the code was not keeping.
    if (method === 'POST' && path === '/auth/logout') {
      if (!sameOrigin(headers)) {
        return { status: 403, type: 'text/plain', body: 'refused: this looks like a cross-site request.\n' };
      }
      await endSession(client, cookieValue(headers['cookie'], 'tf_session'));
      return {
        status: 303,
        type: 'text/plain',
        body: 'signed out\n',
        headers: { location: '/', 'set-cookie': clearedCookie() },
      };
    }

    return null;
  };
}
