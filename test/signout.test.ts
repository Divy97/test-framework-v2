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
// stays here of the DASHBOARD is the route: which methods it accepts, what it deletes, and
// what it refuses cross-site, none of which moved anywhere.
//
// What follows has nothing to do with either, and was deleted with them by accident — a
// slice taken to the end of the file rather than to the end of the block it meant to
// remove. Seven tests about `readRunnerConfig` went with it, and every one of them is the
// only coverage its behaviour has: the two image defaults, the blob root,
// `ENGINE_EXECUTOR: 'fly'` being refused rather than silently picking a substrate, and the
// Vercel credential triple having to arrive together. `DEFAULT_IMAGE`,
// `DEFAULT_AGENT_IMAGE` and `DEFAULT_BLOB_ROOT` were referenced by no test at all in the
// interval. Restored verbatim.

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

describe('which substrate a runner uses, and what that costs it to say', () => {
  const base = {
    ENGINE_PLANE_URL: 'https://plane.test',
    ENGINE_RUNNER_TOKEN: 'tfr_x',
    OPENROUTER_API_KEY: 'sk-x',
  };
  const read = async (env: Record<string, string>) =>
    (await import('../src/runner-main.js')).readRunnerConfig({ ...base, ...env } as NodeJS.ProcessEnv);

  it('is Docker unless told otherwise, and asks a Docker runner for nothing extra', async () => {
    const config = await read({});
    expect(config.executor).toBe('docker');
    // The point of validating inside the branch: a laptop must never be asked for a
    // Vercel token it will never use.
    expect(config.vercel).toBeUndefined();
  });

  it('refuses a substrate it does not have, rather than defaulting to one', async () => {
    // A typo must not silently pick a substrate — in either direction. `fly` reads as a
    // reasonable guess and would otherwise have run every phase on this laptop.
    await expect(read({ ENGINE_EXECUTOR: 'fly' })).rejects.toThrow(/docker or vercel/);
  });

  it('a Vercel runner needs image REFERENCES, because local tags mean nothing there', async () => {
    // `npm run images` builds `test-framework-v2-sandbox:latest` on this machine. The
    // platform cannot pull that, and the failure without this check is a sandbox that
    // will not create — twenty minutes into a run, reading like an outage.
    await expect(read({ ENGINE_EXECUTOR: 'vercel' })).rejects.toThrow(/registry references/);
  });

  it('and all three credentials or none, never a partial set', async () => {
    const images = { ENGINE_IMAGE: 'vcr.example/sandbox@sha256:aa', ENGINE_AGENT_IMAGE: 'vcr.example/agent@sha256:bb' };
    // A partial set is the shape that silently falls back to a `vercel login` the machine
    // does not have. Refused where an operator is looking.
    await expect(read({ ENGINE_EXECUTOR: 'vercel', ...images, VERCEL_TOKEN: 't' })).rejects.toThrow(/together/);

    // None is legitimate: that is the spike's shape, a developer with a CLI session.
    const cli = await read({ ENGINE_EXECUTOR: 'vercel', ...images });
    expect(cli.vercel?.credentials).toEqual({});
    expect(cli.vercel?.region).toBe('iad1');

    // And all three is the worker's shape.
    const worker = await read({
      ENGINE_EXECUTOR: 'vercel',
      ...images,
      VERCEL_TOKEN: 't',
      VERCEL_TEAM_ID: 'team',
      VERCEL_PROJECT_ID: 'proj',
      ENGINE_VERCEL_REGION: 'sin1',
    });
    expect(worker.vercel).toEqual({
      region: 'sin1',
      credentials: { token: 't', teamId: 'team', projectId: 'proj' },
    });
  });
});

