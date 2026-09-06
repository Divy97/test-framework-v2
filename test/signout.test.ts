// A surface you can get into and not out of.
//
// The dashboard had no sign-out at all: `/auth/logout` existed, POST-only and correct,
// with nothing anywhere that would ever send it. On a shared or borrowed machine that is
// not a missing nicety — the session is twelve hours long and the only way to end one was
// to know the endpoint and craft the request.
//
// Adding the button surfaced the other half. `sameOrigin` lived inside `dashboardRoutes`,
// and `authRoutes` is chained AHEAD of it, so the logout route never saw the check that a
// comment beside it said was there. A cross-site form could sign somebody out.

import { describe, expect, it, vi } from 'vitest';
import { authRoutes } from '../src/auth-routes.js';
import type { Db } from '../src/store.js';

const db = (writes: { sql: string; params: unknown[] }[]) =>
  ({
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      writes.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 0 };
    }),
  }) as unknown as Db;

const oauth = { clientId: 'id', clientSecret: 'secret', callbackUrl: 'https://plane.test/auth/github/callback' };

const post = (route: ReturnType<typeof authRoutes>, headers: Record<string, string>) =>
  route({
    method: 'POST',
    path: '/auth/logout',
    query: new URLSearchParams(),
    headers: { cookie: 'tf_session=a-live-session', ...headers },
    body: async () => '',
    raw: async () => Buffer.from(''),
  });

const deletes = (writes: { sql: string; params: unknown[] }[]) =>
  writes.filter((w) => w.sql.includes('delete from sessions'));

describe('signing out', () => {
  it('ends the session, clears the cookie, and sends you to the front page', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    const response = await post(authRoutes({ client: db(writes), oauth }), { 'sec-fetch-site': 'same-origin' });

    expect(response?.status).toBe(303);
    expect(response?.headers?.location).toBe('/');
    // The row is deleted, not merely forgotten by the browser: a cookie cleared client-side
    // is a session that still authenticates anyone who kept a copy of the value.
    expect(deletes(writes)).toHaveLength(1);
    expect(deletes(writes)[0]!.params[0]).toBe('a-live-session');
    // And the cookie is expired on the way out, so the browser stops sending it.
    expect(String(response?.headers?.['set-cookie'])).toMatch(/tf_session=/);
    expect(String(response?.headers?.['set-cookie'])).toMatch(/Max-Age=0|Expires=/i);
  });

  it('REFUSES a cross-site logout, and ends nothing', async () => {
    // The bug this file was written for. `sameOrigin` was private to `dashboardRoutes`,
    // which is chained after this one, so any page on the internet could POST a form here
    // and sign a reader out of their own dashboard.
    const writes: { sql: string; params: unknown[] }[] = [];
    const response = await post(authRoutes({ client: db(writes), oauth }), { 'sec-fetch-site': 'cross-site' });

    expect(response?.status).toBe(403);
    expect(deletes(writes)).toEqual([]);
  });

  it('and refuses one whose Origin is not ours, for a browser that sends no Sec-Fetch-Site', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    const response = await post(authRoutes({ client: db(writes), oauth }), {
      origin: 'https://evil.example',
      host: 'plane.test',
    });

    expect(response?.status).toBe(403);
    expect(deletes(writes)).toEqual([]);
  });

  it('accepts one whose Origin IS ours', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    const response = await post(authRoutes({ client: db(writes), oauth }), {
      origin: 'https://plane.test',
      host: 'plane.test',
    });

    expect(response?.status).toBe(303);
    expect(deletes(writes)).toHaveLength(1);
  });

  it('is not a GET, because a link that logs you out is a link anybody can embed', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    const route = authRoutes({ client: db(writes), oauth });
    const response = await route({
      method: 'GET',
      path: '/auth/logout',
      query: new URLSearchParams(),
      headers: { cookie: 'tf_session=a-live-session' },
      body: async () => '',
      raw: async () => Buffer.from(''),
    });

    // Not handled at all — an `<img src="/auth/logout">` on any page must do nothing.
    expect(response).toBeNull();
    expect(deletes(writes)).toEqual([]);
  });
});

// The header's own assertions — who is shown, and the sign-out that is a form rather than a
// link — moved to `test/screens.test.tsx` with the rest of the surface when 10i deleted
// `src/web.ts`. So did the three about what the pairing page tells a stranger to run. What
// stays here is the ROUTE: which methods it accepts, what it deletes, and what it refuses
// cross-site, none of which moved anywhere.
