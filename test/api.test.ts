// The JSON surface (10i), which is what the dashboard is drawn from once it is a bundle.
//
// Until this milestone every screen was rendered on this side, so "what the UI sees" and
// "what `web.ts` was handed" were the same object and could not disagree. A static bundle
// (ADR-0022) breaks that: the pages now ask over HTTP, and the answer is a contract rather
// than an argument. This file is that contract.
//
// Three properties, and the second is the one that would go wrong silently:
//
//   1. **`/api/me` answers a stranger.** Every other `/api/` GET 401s when nobody is
//      signed in — right for a route returning somebody's data, wrong for the route a
//      page asks BEFORE it knows whether to render an application or a way in.
//   2. **Route order.** `owner/name` carries a slash, so `/api/repos/(.+)` matches
//      `acme/widgets/secrets` as happily as `acme/widgets`. The catch-all read is last on
//      purpose, and nothing in the pattern says so — only its position in the file does,
//      which is exactly the kind of fact an edit breaks without failing anything.
//   3. **Scope.** These routes are the same authorization as the pages they replace: a
//      repository you cannot see is not listed, and asking for it by name gives the same
//      404 an unknown one gives.
//
// The secrets half of the contract — that no route here ever returns a stored value — is
// asserted in `test/secrets.test.ts` against a real database, because a fake that stores
// nothing cannot leak anything.

import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/store.js';
import type { Session } from '../src/auth.js';
import { dashboardRoutes } from '../src/routes.js';
import { demoRunEvents } from '../src/fixtures/demo-run.js';

// The secrets routes refuse to do anything without a key, and one of the tests below is
// about a secrets PUT reaching the secrets route rather than the catch-all read. A fixed
// value: what is under test is which handler answered, not the cryptography, which
// `test/secrets.test.ts` owns.
process.env.PLANE_SECRETS_KEY ??= Buffer.alloc(32, 7).toString('base64');

const SESSION: Session = { id: 's', githubId: 1, login: 'divy97', avatarUrl: '', token: 'ghu' };

/**
 * As `parseRecipe` normalises it, which is what `loadRecipe` hands back.
 *
 * Written out rather than round-tripped through `parseRecipe` here, so a change to what
 * normalisation drops shows up as a failure in this file rather than being absorbed by it.
 */
const RECIPE = { install: 'npm ci', services: [], test: 'npm test' };

/**
 * REAL uuids, because `run_projection.run_id` is a `uuid` column.
 *
 * These were `r-mine` and `r-theirs`, which no query in production can be handed: Postgres
 * refuses to compare a `uuid` with anything else and throws — so every route below was
 * asserted against ids that would have produced a 500 rather than the answer being tested.
 * A fixture the database would reject describes nothing.
 */
const MINE_RUN = '3f1c9a52-7b0e-4d2f-9c41-8a6e5d0b21c7';
const THEIRS_RUN = '9b2e7c14-5d38-4a6f-8e10-2c9f4b7a3d55';

/**
 * A database with two installations, one run on each, and a recipe on `mine/repo`.
 *
 * Parameterised the way `authz.test.ts`'s is, and for the reason recorded there: a fake
 * that ignores `$1` answers every lookup with the first row, which turns "you cannot see
 * this" into a passing test about your own data.
 */
const fakeClient = (writes: { sql: string; params: unknown[] }[] = [], options: { recipe?: unknown } = {}) =>
  ({
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      writes.push({ sql, params });
      const runId = sql.includes('where run_id = $1') ? String(params[0] ?? '') : null;
      const repo = /where repo = \$1/.test(sql) ? String(params[0] ?? '') : null;
      const rows = sql.includes('from events')
        ? // The demo log, re-addressed to whichever run was asked for. A hand-built event
          // stream here would be a second opinion about what a run looks like; this is the
          // fixture `fold`, `confidence` and the browser test are all already built on.
          demoRunEvents.map((event, index) => ({ ...event, run_id: runId ?? MINE_RUN, seq: index + 1 }))
        : sql.includes('from installations')
        ? [
            { repo: 'mine/repo', installation_id: 1, account: 'me', connected_at: new Date(0), removed_at: null },
            { repo: 'theirs/repo', installation_id: 2, account: 'them', connected_at: new Date(0), removed_at: null },
          ].filter((row) => repo === null || row.repo === repo)
        : sql.includes('from recipes')
          ? repo === 'mine/repo'
            ? [{ recipe: options.recipe ?? RECIPE, approved_at: new Date(0), proof: null }]
            : []
          : sql.includes('from recipe_drafts')
            ? []
            : sql.includes('from repo_secrets')
              ? [{ name: 'STRIPE_KEY' }]
              : sql.includes('from run_projection')
                ? [
                    { run_id: MINE_RUN, repo: 'mine/repo', issue_number: 1, status: 'pr_opened', started_at: new Date(0), ended_at: null, tier: 2, score: 98, ceiling: 103, scoring: 2, reproduced: true, pr_number: 7, thread_ref: 'mine/repo#1' },
                    { run_id: THEIRS_RUN, repo: 'theirs/repo', issue_number: 1, status: 'pr_opened', started_at: new Date(0), ended_at: null, tier: 2, score: 98, ceiling: 103, scoring: 2, reproduced: true, pr_number: 8, thread_ref: 'theirs/repo#1' },
                  ].filter((row) => (runId === null || row.run_id === runId) && (repo === null || row.repo === repo))
                : sql.includes('from user_model_keys')
                  ? [{ provider: 'openrouter' }]
                  : // ONE PAIRED MACHINE. This answered `[]`, so "the listing never carries
                    // a token" asserted the absence of a token in an empty list — adding
                    // `token_hash` to what `listRunners` selects would not have failed it,
                    // and the comment beside it said exactly why that would be wrong.
                    sql.includes('from runners')
                    ? [{ id: 'runner-1', installation_id: 1, name: 'build-box', paired_at: new Date(0), last_seen: new Date(0), revoked_at: null, token_hash: 'sha256:secret-hash' }]
                    : [];
      return { rows, rowCount: rows.length };
    }),
  }) as unknown as Db;

type SurfaceOptions = {
  session?: Session | null;
  installations?: number[];
  writes?: { sql: string; params: unknown[] }[];
  /** Absent means the LOCAL surface: one operator, no accounts, sees everything. */
  accounts?: boolean;
  github?: boolean;
  onApproved?: (repo: string) => void;
  recipe?: unknown;
};

const surface = (options: SurfaceOptions = {}) =>
  dashboardRoutes({
    client: fakeClient(options.writes, { ...(options.recipe === undefined ? {} : { recipe: options.recipe }) }),
    installUrl: 'https://example.invalid',
    ...(options.onApproved ? { onApproved: options.onApproved } : {}),
    ...(options.github === false ? {} : { github: { token: async () => 'ghs_x' } }),
    ...(options.accounts === false
      ? {}
      : {
          auth: {
            session: async () => (options.session === undefined ? SESSION : options.session),
            installations: async () => options.installations ?? [1],
          },
        }),
  });

/** Same-origin and JSON by default, because every write here requires both. */
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
    headers: {
      ...(method === 'GET' ? {} : { origin: 'http://127.0.0.1', host: '127.0.0.1', 'content-type': 'application/json' }),
      ...headers,
    },
    body: async () => body,
    raw: async () => Buffer.from(body),
  });

const bodyOf = async (
  route: ReturnType<typeof dashboardRoutes>,
  method: string,
  path: string,
  body = '',
): Promise<{ status: number; json: any }> => {
  const answer = await call(route, method, path, body);
  return { status: answer?.status ?? 0, json: JSON.parse(String(answer?.body ?? 'null')) };
};

const MINE = encodeURIComponent('mine/repo');
const THEIRS = encodeURIComponent('theirs/repo');

// ---------------------------------------------------------------------------------------

describe('/api/me is the one route a stranger may ask', () => {
  it('answers 200 and says so, rather than 401', async () => {
    // A 401 here would make the ordinary state of a first visit — signed out — arrive at
    // the page as a failure, and a page that cannot tell "you are logged out" from "the
    // service is broken" renders the wrong thing for both.
    const { status, json } = await bodyOf(surface({ session: null }), 'GET', '/api/me');
    expect(status).toBe(200);
    expect(json.signedIn).toBe(false);
    expect(json.login).toBeNull();
    // Still enough to draw the door with.
    expect(json.accounts).toBe(true);
    expect(json.installUrl).toBe('https://example.invalid');
  });

  it('does not ask GitHub what you may act on, because it is not asking that', async () => {
    // The most-hit route in the product: every document the bundle serves asks it on load.
    // `visible()` would answer it — and would buy a `GET /user/installations` round trip to
    // read one bit, and would make the whole dashboard fail to render when GitHub is down
    // rather than only the pages that are about repositories. The `/` route records the
    // same distinction; this is the assertion that keeps it.
    let asked = 0;
    const route = dashboardRoutes({
      client: fakeClient(),
      installUrl: 'https://example.invalid',
      auth: {
        session: async () => SESSION,
        installations: async () => {
          asked += 1;
          return [1];
        },
      },
    });
    await bodyOf(route, 'GET', '/api/me');
    expect(asked).toBe(0);
    // The control: a route that IS about repositories still asks.
    await bodyOf(route, 'GET', '/api/repos');
    expect(asked).toBe(1);
  });

  it('names the person, their key and what this deployment can do', async () => {
    const { json } = await bodyOf(surface(), 'GET', '/api/me');
    expect(json.signedIn).toBe(true);
    expect(json.login).toBe('divy97');
    expect(json.modelKey).toEqual({ provider: 'openrouter' });
    expect(json.github).toBe(true);
    expect(json.mode).toBe('plane');
  });

  it('a surface with no accounts is signed in, because it has one operator', async () => {
    // `serve.ts`. Collapsing "no logins configured" to "signed out" puts a sign-in wall in
    // front of a deployment with no login to offer — the exact bug the landing page had,
    // recorded in `routes.ts` at the `/` branch.
    const { json } = await bodyOf(surface({ accounts: false }), 'GET', '/api/me');
    expect(json.accounts).toBe(false);
    expect(json.signedIn).toBe(true);
    expect(json.login).toBeNull();
    // Nobody to bill, so no key to prompt for: `serve.ts` spends the operator's own
    // environment, and `null` here would send them to a settings page that 501s.
    expect(json.modelKey).toBeNull();
  });

  it('says when there is no App, so the page does not draw a button that 501s', async () => {
    const { json } = await bodyOf(surface({ github: false }), 'GET', '/api/me');
    expect(json.github).toBe(false);
  });
});

describe('the repository list is scoped, in JSON as on the page', () => {
  it('lists only what this person may see', async () => {
    const { json } = await bodyOf(surface(), 'GET', '/api/repos');
    expect(json.map((row: any) => row.repo)).toEqual(['mine/repo']);
    expect(json[0].onboarded).toBe(true);
    expect(json[0].runs).toBe(1);
  });

  it('an anonymous request is refused, not redirected', async () => {
    const answer = await call(surface({ session: null }), 'GET', '/api/repos');
    expect(answer?.status).toBe(401);
  });
});

describe('one repository, in one answer', () => {
  it('carries everything the screen needs', async () => {
    const { json } = await bodyOf(surface(), 'GET', `/api/repos/${MINE}`);
    expect(json.repo).toBe('mine/repo');
    expect(json.onboarded).toBe(true);
    expect(json.recipe).toEqual(RECIPE);
    expect(json.secrets.names).toEqual(['STRIPE_KEY']);
    expect(json.runs).toHaveLength(1);
    expect(json.runs[0].run_id).toBe(MINE_RUN);
  });

  it("somebody else's repository is unknown, in the same words an unknown one gets", async () => {
    const theirs = await bodyOf(surface(), 'GET', `/api/repos/${THEIRS}`);
    const nobodys = await bodyOf(surface(), 'GET', `/api/repos/${encodeURIComponent('nobody/repo')}`);
    expect(theirs.status).toBe(404);
    expect(theirs.json).toEqual(nobodys.json);
  });

  it('the draft is sent beside the recipe, never merged into it', async () => {
    // `onboardPage` owns the rule that an approved recipe wins outright — a draft beside
    // the one in force reads as a live second proposal. Deciding it here as well would put
    // that rule in two places, free to disagree.
    const { json } = await bodyOf(surface(), 'GET', `/api/repos/${MINE}`);
    expect(json).toHaveProperty('draft');
    expect(json.draft).toBeNull();
  });
});

describe('the catch-all does not swallow the routes above it', () => {
  // THE ordering test. `/api/repos/(.+)` matches `mine/repo/secrets` as happily as
  // `mine/repo`, and nothing in the pattern prevents it — only the fact that the specific
  // routes are earlier in the file. Move the read up and the highest-privilege write on
  // this surface becomes a 200 that stores nothing.
  it('a secrets PUT still stores, rather than reading a repository named .../secrets', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    const answer = await bodyOf(
      surface({ writes }),
      'PUT',
      `/api/repos/${MINE}/secrets/STRIPE_KEY`,
      JSON.stringify({ value: 'sk_live_x' }),
    );
    expect(answer.status).toBe(200);
    expect(answer.json.stored).toBe('STRIPE_KEY');
    expect(writes.some((write) => /insert into repo_secrets/.test(write.sql))).toBe(true);
  });

  it('a secrets GET still lists names', async () => {
    const { status, json } = await bodyOf(surface(), 'GET', `/api/repos/${MINE}/secrets`);
    expect(status).toBe(200);
    expect(json.names).toEqual(['STRIPE_KEY']);
  });

  it('the issue picker is still the issue picker', async () => {
    const answer = await call(surface({ github: false }), 'GET', `/api/repos/${MINE}/issues`);
    // 501 is the picker answering. A 200 would mean the catch-all read it as a repository.
    expect(answer?.status).toBe(501);
  });

  it('the runners route is not read as a repository called .../runners', async () => {
    // This one was actually wrong when it was written: the block sat below the catch-all,
    // so `GET` fell into the repository read, looked up an installation for
    // `mine/repo/runners`, and answered 404 — while the `POST` beside it worked, because
    // the catch-all only matches `GET`. A half-shadowed route is the shape this describe
    // block exists to catch.
    const { status, json } = await bodyOf(surface(), 'GET', `/api/repos/${MINE}/runners`);
    expect(status).toBe(200);
    expect(json).toHaveProperty('runners');
  });

  it('the recipe route is not read as a repository called .../recipe', async () => {
    const { status, json } = await bodyOf(surface(), 'GET', `/api/repos/${MINE}/recipe`);
    expect(status).toBe(200);
    expect(json).toEqual({ recipe: RECIPE });
  });
});

describe('approving a recipe over JSON is the same write, with the same controls', () => {
  it('stores it, clears the draft and fires the proving run', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    const proved: string[] = [];
    const { status, json } = await bodyOf(
      surface({ writes, onApproved: (repo) => proved.push(repo) }),
      'PUT',
      `/api/repos/${MINE}/recipe`,
      JSON.stringify({ recipe: { install: 'npm ci', services: [], test: 'npm test' } }),
    );
    expect(status).toBe(200);
    expect(json.approved).toBe(true);
    expect(writes.some((write) => /insert into recipes/.test(write.sql))).toBe(true);
    expect(writes.some((write) => /recipe_drafts/.test(write.sql))).toBe(true);
    // AFTER the write, never before: a proof of a recipe that failed to store is a proof
    // of nothing.
    expect(proved).toEqual(['mine/repo']);
  });

  it('a shape parseRecipe refuses is a 400 about the document, not about the project', async () => {
    const { status, json } = await bodyOf(
      surface(),
      'PUT',
      `/api/repos/${MINE}/recipe`,
      JSON.stringify({ recipe: { install: 42 } }),
    );
    expect(status).toBe(400);
    expect(typeof json.error).toBe('string');
  });

  it('a body that is not JSON, and one that is JSON but not an object, both 400', async () => {
    for (const body of ['not json', 'null', '42']) {
      const { status } = await bodyOf(surface(), 'PUT', `/api/repos/${MINE}/recipe`, body);
      expect(status, `body ${body}`).toBe(400);
    }
  });

  it('cross-site, it is refused — this stores commands the engine executes verbatim', async () => {
    // ADR-0013: the origin check and the human are the whole control on this write, and
    // neither is weakened by the envelope being JSON rather than a form.
    const answer = await call(
      surface(),
      'PUT',
      `/api/repos/${MINE}/recipe`,
      JSON.stringify({ recipe: RECIPE }),
      { origin: 'https://evil.invalid', host: '127.0.0.1', 'content-type': 'application/json' },
    );
    expect(answer?.status).toBe(403);
  });

  it('a form-encoded body is refused, whatever sent it', async () => {
    const answer = await call(surface(), 'PUT', `/api/repos/${MINE}/recipe`, 'recipe=%7B%7D', {
      origin: 'http://127.0.0.1',
      host: '127.0.0.1',
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(answer?.status).toBe(415);
  });

  it("somebody else's repository cannot be approved into", async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    const { status } = await bodyOf(
      surface({ writes }),
      'PUT',
      `/api/repos/${THEIRS}/recipe`,
      JSON.stringify({ recipe: RECIPE }),
    );
    expect(status).toBe(404);
    expect(writes.some((write) => /insert into recipes/.test(write.sql))).toBe(false);
  });
});

describe('the evidence view, as JSON, is the same view the page is', () => {
  it('is folded from the log rather than read off the projection', async () => {
    // The row is a cache. An evidence view built from it would be evidence at one remove,
    // which is the one thing this screen cannot be — so the JSON carries the fold, and the
    // read that produces it is the same one the HTML page performs.
    const writes: { sql: string; params: unknown[] }[] = [];
    const { status, json } = await bodyOf(surface({ writes }), 'GET', `/api/runs/${MINE_RUN}/evidence`);
    expect(status).toBe(200);
    expect(json.row.run_id).toBe(MINE_RUN);
    expect(json.state.runId).toBeDefined();
    expect(json.score.scoring).toBe(2);
    expect(writes.some((write) => /from events/.test(write.sql))).toBe(true);
  });

  it('carries the verdict, so a client never folds for itself', async () => {
    // ADR-0009. A page that re-derived "did this reproduce" from the raw events would be a
    // second implementation of what happened, free to disagree with the pull request — the
    // mistake this codebase has already made twice.
    const { json } = await bodyOf(surface(), 'GET', `/api/runs/${MINE_RUN}/evidence`);
    for (const field of ['tier', 'score', 'ceiling', 'grounds', 'unmeasured']) {
      expect(json.score, field).toHaveProperty(field);
    }
    expect(json.state).toHaveProperty('reproduced');
    expect(json.state).toHaveProperty('regression');
  });

  it("somebody else's run is no such run, and says nothing more", async () => {
    const { status, json } = await bodyOf(surface(), 'GET', `/api/runs/${THEIRS_RUN}/evidence`);
    expect(status).toBe(404);
    expect(json).toEqual({ error: 'no such run' });
  });

  it('there is no HTML page left on this surface at all', async () => {
    // `/runs/:id` was a rendered document until 10i deleted `src/web.ts`. It is now a path
    // this route declines, so the static bundle answers it — which is what makes "every
    // route here is `/api/`" a checkable statement rather than a claim in a comment.
    expect(await call(surface(), 'GET', `/runs/${MINE_RUN}`)).toBeNull();
    expect(await call(surface(), 'GET', '/repos')).toBeNull();
    expect(await call(surface(), 'GET', `/repos/${MINE}/onboard`)).toBeNull();
    expect(await call(surface(), 'GET', `/repos/${MINE}/runners`)).toBeNull();
  });
});

describe('destroying a run says so in the envelope it was asked in', () => {
  // `fetch` follows a 303, so the HTML route's redirect means pulling a whole evidence
  // document down as the side effect of a delete. What is asserted here is the ENVELOPE
  // and the gate — `test/forget.test.ts` owns whether the bytes actually go.
  it('answers JSON, not a redirect to a page', async () => {
    const { status, json } = await bodyOf(surface(), 'POST', `/api/runs/${MINE_RUN}/forget`);
    // 501: this surface holds no artifacts, which is the honest answer rather than a
    // pretended deletion. The shape is the point — a 303 here would be the bug.
    expect(status).toBe(501);
    expect(json.error).toMatch(/no artifacts/);
  });

  it("somebody else's run cannot be destroyed, and the refusal is JSON too", async () => {
    const { status, json } = await bodyOf(surface(), 'POST', `/api/runs/${THEIRS_RUN}/forget`);
    expect(status).toBe(404);
    expect(json).toEqual({ error: 'no such run' });
  });

  it('the form route is gone with the form', async () => {
    expect(await call(surface(), 'POST', `/runs/${THEIRS_RUN}/forget`)).toBeNull();
  });
});

describe('pairing a runner hands over the token exactly once', () => {
  it('mints it, and the answer carries the URL the machine has to dial', async () => {
    const { status, json } = await bodyOf(
      surface(),
      'POST',
      `/api/repos/${MINE}/runners`,
      JSON.stringify({ name: 'laptop' }),
    );
    expect(status).toBe(201);
    expect(json.token).toMatch(/^\S+$/);
    expect(json.paired.name).toBe('laptop');
    // The host this was read on. The HTML page printed the literal string
    // `<this service>` here once, served from the host it should have been naming.
    expect(json.planeUrl).toBe('http://127.0.0.1');
  });

  it('a nameless machine is refused', async () => {
    for (const body of [JSON.stringify({}), JSON.stringify({ name: '   ' }), 'null']) {
      const { status } = await bodyOf(surface(), 'POST', `/api/repos/${MINE}/runners`, body);
      expect(status, body).toBe(400);
    }
  });

  it('the listing never carries a token, or the hash of one', async () => {
    const route = surface();
    const paired = await bodyOf(route, 'POST', `/api/repos/${MINE}/runners`, JSON.stringify({ name: 'laptop' }));
    const listed = await bodyOf(route, 'GET', `/api/repos/${MINE}/runners`);
    expect(listed.status).toBe(200);
    // A LISTING WITH SOMETHING IN IT — an empty list cannot demonstrate the absence of a
    // field, and this test asserted exactly that until the fake gained a row.
    expect(listed.json.runners).toHaveLength(1);
    expect(listed.json.runners[0].name).toBe('build-box');
    expect(JSON.stringify(listed.json)).not.toContain(paired.json.token);
    // And not the hash either. `listRunners` selects its columns by name; adding
    // `token_hash` to that list is the one-line change this is here to fail on.
    expect(JSON.stringify(listed.json)).not.toContain('secret-hash');
    expect(listed.json.runners[0]).not.toHaveProperty('token_hash');
  });

  it("a stranger cannot pair a machine against somebody else's repository", async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    const { status } = await bodyOf(
      surface({ writes }),
      'POST',
      `/api/repos/${THEIRS}/runners`,
      JSON.stringify({ name: 'laptop' }),
    );
    expect(status).toBe(404);
    expect(writes.some((write) => /insert into runners/.test(write.sql))).toBe(false);
  });

  it('revoking checks the installation, not just the repository in the path', async () => {
    // Authorizing the repo and then trusting the id from the URL let anyone with access
    // to ANY repository revoke somebody else's machine. `revokeRunner` requires the
    // installation and updates nothing on a mismatch, which arrives here as a 404.
    const writes: { sql: string; params: unknown[] }[] = [];
    const { status } = await bodyOf(surface({ writes }), 'POST', `/api/repos/${MINE}/runners/not-mine/revoke`);
    expect(status).toBe(404);
    const revoke = writes.find((write) => /update runners/.test(write.sql));
    expect(revoke?.params).toContain(1);
  });
});

describe('a finished run is read, not tailed', () => {
  it('answers the log as JSON, with the same authorization the evidence view has', async () => {
    const { status, json } = await bodyOf(surface(), 'GET', `/api/runs/${MINE_RUN}/events`);
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
    expect(json[0]).toHaveProperty('seq');
    expect(json[0]).toHaveProperty('type');
  });

  it("somebody else's log is no such run", async () => {
    const { status, json } = await bodyOf(surface(), 'GET', `/api/runs/${THEIRS_RUN}/events`);
    expect(status).toBe(404);
    expect(json).toEqual({ error: 'no such run' });
  });

  it('is not the evidence route wearing a different name', async () => {
    // The two share authorization and nothing else. If `/events` fell through to the
    // evidence pattern the page would render a fold where it expects a list, and the
    // timeline would silently show nothing.
    const events = await bodyOf(surface(), 'GET', `/api/runs/${MINE_RUN}/events`);
    const evidence = await bodyOf(surface(), 'GET', `/api/runs/${MINE_RUN}/evidence`);
    expect(Array.isArray(events.json)).toBe(true);
    expect(Array.isArray(evidence.json)).toBe(false);
    expect(evidence.json).toHaveProperty('score');
  });
});

describe('a run id that cannot be one is not a database error', () => {
  // `run_projection.run_id` is a `uuid`, so a non-uuid threw inside `readRunRow` and
  // `sse.ts` turned the throw into a 500 carrying the raw Postgres message — which quotes
  // the caller's own path segment back at them. `tailAuthorizer` has guarded this since
  // 10g, eight lines away in a sibling module; these routes had not.
  it.each([
    ['/api/runs/zzz'],
    ['/api/runs/zzz/evidence'],
    ['/api/runs/zzz/events'],
    ["/api/runs/'; drop table events; --/evidence"],
  ])('%s is 404, the same answer a real id nobody owns gets', async (path) => {
    const { status, json } = await bodyOf(surface(), 'GET', path);
    expect(status).toBe(404);
    expect(JSON.stringify(json)).not.toContain('zzz');
    expect(JSON.stringify(json)).not.toContain('drop table');
  });

  it('and the same for the write', async () => {
    const { status } = await bodyOf(surface(), 'POST', '/api/runs/zzz/forget');
    expect(status).toBe(404);
  });
});

describe('a JSON answer says not to sniff it', () => {
  it('is set on every JSON route, the way the static surface sets it on every asset', async () => {
    for (const path of ['/api/me', '/api/repos', `/api/runs/${MINE_RUN}/evidence`]) {
      const answer = await call(surface(), 'GET', path);
      expect(answer?.headers?.['x-content-type-options'], path).toBe('nosniff');
    }
  });
});

describe('a run that has been started but not yet claimed', () => {
  // Where every use of the Start button lands FIRST. `enqueueJob` writes to `jobs` and
  // nothing else — the log's first event comes from the worker that claims it (ADR-0019) —
  // so for a few seconds `run_projection` has no row. Answering 404 there sent people
  // straight to "No such run", with no retry, for a run that was about to start normally.
  const QUEUED = '7c1d3e9a-4b25-4f80-9a3d-6e2b1c8f0417';

  /** A database where the job exists and the projection does not. */
  const queuedSurface = (repo = 'mine/repo') =>
    dashboardRoutes({
      client: {
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          const rows = sql.includes('from installations')
            ? [{ repo: 'mine/repo', installation_id: 1, account: 'me', connected_at: new Date(0), removed_at: null },
               { repo: 'theirs/repo', installation_id: 2, account: 'them', connected_at: new Date(0), removed_at: null }]
            : sql.includes('from run_projection')
              ? []
              : sql.includes('from jobs where run_id')
                ? [{ repo, issue_number: 41 }]
                : [];
          return { rows, rowCount: rows.length };
        }),
      } as unknown as Db,
      installUrl: 'https://example.invalid',
      auth: { session: async () => SESSION, installations: async () => [1] },
    });

  it('is 202 and says so, rather than 404', async () => {
    const { status, json } = await bodyOf(queuedSurface(), 'GET', `/api/runs/${QUEUED}/evidence`);
    expect(status).toBe(202);
    expect(json.queued).toBe(true);
    expect(json.repo).toBe('mine/repo');
    expect(json.issue_number).toBe(41);
  });

  it('but only for a job you may see — everyone else still gets no such run', async () => {
    const { status, json } = await bodyOf(queuedSurface('theirs/repo'), 'GET', `/api/runs/${QUEUED}/evidence`);
    expect(status).toBe(404);
    expect(json).toEqual({ error: 'no such run' });
  });

  it('and a run id belonging to no job at all is still 404', async () => {
    const nothing = dashboardRoutes({
      client: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as Db,
      installUrl: 'https://example.invalid',
      auth: { session: async () => SESSION, installations: async () => [1] },
    });
    const { status } = await bodyOf(nothing, 'GET', `/api/runs/${QUEUED}/evidence`);
    expect(status).toBe(404);
  });
});

// ── what a refusal looks like by the time a page has it (10n) ────────────────
//
// `parse` in `web/lib/api.ts` used to read `error` and drop everything else, so a route
// that answers with our summary AND the provider's own sentence lost the half that says
// what to go and fix. The model-key route is the one that matters: "openrouter refused
// this key" is not actionable, and "Key limit exceeded (total limit)" is.

describe('an error detail reaches the page', () => {
  it('folds detail into the error a caller reads', async () => {
    const answers = [
      {
        body: { error: 'openrouter refused this key, so it has not been saved', detail: 'Key limit exceeded (total limit)' },
        status: 400,
      },
      { body: { error: 'not connected' }, status: 404 },
      { body: { stored: true, provider: 'openrouter', checked: 'the key answered' }, status: 200 },
    ];
    const fetches = vi.fn(async (_url: unknown, _init?: unknown) => {
      const next = answers.shift()!;
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      });
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetches as unknown as typeof globalThis.fetch;
    try {
      const { send } = await import('../web/lib/api.js');

      const refused = await send('PUT', '/api/settings/model-key', { provider: 'openrouter', key: 'k' });
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain('refused this key');
      // The provider's own words, which is the whole point.
      expect(refused.error).toContain('Key limit exceeded');

      // A route with no detail is unchanged — no dangling separator.
      const plain = await send('DELETE', '/api/settings/model-key');
      expect(plain.error).toBe('not connected');

      // And success carries no error at all, detail or otherwise.
      const stored = await send<{ checked: string }>('PUT', '/api/settings/model-key', {});
      expect(stored.ok).toBe(true);
      expect(stored.error).toBeNull();
      expect(stored.data?.checked).toBe('the key answered');
    } finally {
      globalThis.fetch = original;
    }
  });
});
