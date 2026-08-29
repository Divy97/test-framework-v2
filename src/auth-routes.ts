// The three routes a login is: go, come back, leave.
//
// Separate from `dashboardRoutes` because they answer a different question. Those routes
// ask "may this person act on this repository" and are the product; these establish who
// the person is at all, and nothing else on the surface needs to know how.

import type pg from 'pg';
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
import type { Route } from './sse.js';
import { escapeHtml, layout } from './web.js';

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
 */
const refused = (why: string) =>
  ({
    status: 400,
    type: 'text/html; charset=utf-8',
    body: layout(
      'Sign-in did not complete',
      `<h1>That sign-in did not complete</h1>
<p>${escapeHtml(why)}</p>
<p><a class="cta" href="/auth/github">Try again</a></p>`,
    ),
    headers: { 'set-cookie': clearedCookie() },
  }) as const;

export function authRoutes(options: {
  client: pg.Client;
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

    // POST, not GET. A link that logs somebody out is a link anybody's page can embed,
    // and the same-origin check that guards the rest of this surface only runs on
    // writes. Small stakes, one word to get right.
    if (method === 'POST' && path === '/auth/logout') {
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
