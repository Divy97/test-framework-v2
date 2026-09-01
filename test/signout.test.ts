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
import { layout } from '../src/web.js';
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

describe('the header offers the way out only where there is one', () => {
  it('shows who you are and a sign out, when somebody is signed in', () => {
    const html = layout('Runs', '<p>body</p>', { who: 'divy97' });

    expect(html).toContain('divy97');
    expect(html).toContain('Sign out');
    expect(html).toContain('action="/auth/logout"');
    // A form, not an anchor.
    expect(html).toContain('method="post"');
  });

  it('offers nothing when nobody is', () => {
    // Anonymous on a hosted plane, and every page on a laptop, where there is no login
    // to end. A sign-out button with no session behind it is a control that does nothing.
    const html = layout('Runs', '<p>body</p>');

    expect(html).not.toContain('Sign out');
    expect(html).not.toContain('/auth/logout');
  });

  it('escapes the login, which came from GitHub rather than from us', () => {
    const html = layout('Runs', '<p>body</p>', { who: '<script>alert(1)</script>' });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

/**
 * The command on the pairing page has to be the whole command.
 *
 * A new operator followed it exactly — clone, `npm ci`, run — and the runner refused,
 * naming four variables it had no way to look up. The two image names and the blob root
 * are things this repository already decides; only the model credential is genuinely the
 * operator's. The answer to the other three lived in a document about setting up a GitHub
 * App, which nothing in the pairing flow points at.
 */
describe('what the pairing page tells a stranger to run', () => {
  it('builds the images, which a new machine does not have', async () => {
    const { runnersPage } = await import('../src/web.js');
    const html = runnersPage('acme/checkout', [], {
      token: 'tfr_x',
      name: 'laptop',
      planeUrl: 'https://plane.test',
    });

    expect(html).toContain('npm run images');
  });

  it('names the model key, which is the one thing that cannot be defaulted', async () => {
    const { runnersPage } = await import('../src/web.js');
    const html = runnersPage('acme/checkout', [], {
      token: 'tfr_x',
      name: 'laptop',
      planeUrl: 'https://plane.test',
    });

    expect(html).toContain('OPENROUTER_API_KEY');
  });

  it('says the token is on a command line, because that is where shell history comes from', async () => {
    const { runnersPage } = await import('../src/web.js');
    const html = runnersPage('acme/checkout', [], {
      token: 'tfr_x',
      name: 'laptop',
      planeUrl: 'https://plane.test',
    });

    expect(html).toContain('shell history');
  });
});

describe('a runner defaults everything this repository already decides', () => {
  it('needs only the plane, the token and a model key', async () => {
    const { readRunnerConfig, DEFAULT_IMAGE, DEFAULT_AGENT_IMAGE, DEFAULT_BLOB_ROOT } =
      await import('../src/runner-main.js');

    const config = readRunnerConfig({
      ENGINE_PLANE_URL: 'https://plane.test',
      ENGINE_RUNNER_TOKEN: 'tfr_x',
      OPENROUTER_API_KEY: 'sk-x',
    } as NodeJS.ProcessEnv);

    expect(config.image).toBe(DEFAULT_IMAGE);
    expect(config.agentImage).toBe(DEFAULT_AGENT_IMAGE);
    expect(config.blobRoot).toBe(DEFAULT_BLOB_ROOT);
  });

  it('still refuses without a model key, which is nobody else s to supply', async () => {
    const { readRunnerConfig } = await import('../src/runner-main.js');

    expect(() =>
      readRunnerConfig({
        ENGINE_PLANE_URL: 'https://plane.test',
        ENGINE_RUNNER_TOKEN: 'tfr_x',
      } as NodeJS.ProcessEnv),
    ).toThrow(/OPENROUTER_API_KEY/);
  });

  it('and an override still overrides, for a machine with its own images', async () => {
    const { readRunnerConfig } = await import('../src/runner-main.js');

    const config = readRunnerConfig({
      ENGINE_PLANE_URL: 'https://plane.test',
      ENGINE_RUNNER_TOKEN: 'tfr_x',
      OPENROUTER_API_KEY: 'sk-x',
      ENGINE_IMAGE: 'mine:1',
      ENGINE_BLOB_ROOT: '/mnt/evidence',
    } as NodeJS.ProcessEnv);

    expect(config.image).toBe('mine:1');
    expect(config.blobRoot).toBe('/mnt/evidence');
  });
});
