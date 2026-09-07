// The dashboard's routes (M6f), and the approval that gates onboarding (M6b).
//
// A `Route` rather than a server: `sse.ts` owns the socket, this owns the answers. That
// split is what keeps the SSE module drivable by a test with no database — the property
// `test/sse.test.ts` depends on — while letting these routes hold a `Db`.
//
// Everything here is a projection except a handful of writes, and each write is a
// decision a person makes: approving a recipe (ADR-0013's "the only control there is on a
// stored command we will execute"), pairing or revoking a runner, destroying a run's
// artifacts — and, since M10, starting a run. Starting one is a write to `jobs`, the same
// act a webhook delivery performed in M9; the log's first event still comes from the
// worker (ADR-0019), so this surface dispatches and never produces. A dashboard that could
// edit evidence or retry a phase would be a second producer, and ADR-0009 has one.

import { confidence } from './confidence.js';
import { clearDraft, loadDraft } from './drafts.js';
import { fold } from './fold.js';
import { intake, listOpenIssues, readIssue, type Fetcher } from './github.js';
import { listInstallations, loadInstallation } from './installations.js';
import { listRuns, readCompute, readRunRow, readUsage } from './readmodel.js';
import { ENV_NAME, loadStored, loadRecipe, parseRecipe, saveRecipe } from './recipe.js';
import { PROVIDERS } from './loop.js';
import {
  deleteModelKey,
  deleteRepoSecret,
  hasModelKey,
  listRepoSecretNames,
  MAX_SECRET_CHARS,
  putModelKey,
  putRepoSecret,
  secretsEnabled,
} from './secrets.js';
import { readRun, type Db } from './store.js';
import { sameOrigin, type Route } from './sse.js';
import type { Session } from './auth.js';
import { forgetRun, tombstoneFor } from './forget.js';
import { enqueueJob, listRunners, openJobFor, pairRunner, revokeRunner } from './plane.js';

/**
 * WHERE the engine runs, which changes what this surface may promise.
 *
 * `local` is `serve.ts`: one operator, containers on this machine, and installing a
 * repository starts a drafting run that fills the recipe box for them.
 *
 * `plane` is the hosted control plane, which holds no model key and runs no containers by
 * design (ADR-0011, ADR-0019) — work goes to a paired runner. Nothing drafts there yet, so
 * a screen that offers "draft a recipe" is offering something that will not happen.
 *
 * Explicit rather than inferred from whether login is configured. Those are two different
 * questions, and conflating them is exactly the bug the landing page had.
 *
 * It lived in `src/web.ts` until 10i, which deleted that file. It is not a rendering
 * concern and never was: it is what a deployment can do, reported to the UI by `/api/me`.
 */
export type Mode = 'local' | 'plane';


const json = (body: unknown, status = 200) => ({
  status,
  type: 'application/json',
  body: JSON.stringify(body, null, 2),
  // `nosniff`, and it is the one header this surface and `src/static.ts` disagreed about —
  // on the surface that carries secret NAMES and repository data, which is the wrong way
  // round. Not exploitable against a modern browser; it costs nothing and the alternative
  // is two answers to "does this service set it" depending on which route you asked.
  headers: { 'x-content-type-options': 'nosniff' } as Record<string, string>,
});

/**
 * Where the Install button points.
 *
 * GitHub owns the install screen and we do not rebuild it (M6f). The slug is an operator
 * setting because it is decided when the App is registered, which has not happened —
 * so the default is a placeholder that is obviously one rather than a plausible dead
 * link.
 */
export const installUrl = (env: NodeJS.ProcessEnv = process.env): string =>
  env.GITHUB_APP_SLUG
    ? `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`
    : 'https://github.com/settings/apps/new';

export function dashboardRoutes(options: {
  client: Db;
  /** Injected so a test can drive the surface without a GitHub App registered. */
  installUrl?: string;
  /**
   * Called after a recipe is stored, to prove the repository actually runs (8f).
   *
   * A callback rather than the work itself, for the same reason `draftForRepo` lives
   * in `serve.ts`: proving needs a clone, a token and the images, and none of those
   * belong to the surface that renders HTML. Fired and not awaited — it takes
   * minutes and the human who just pressed approve is owed a response now, not when
   * two containers have finished.
   */
  onApproved?: (repo: string) => void;
  /**
   * Where the engine runs, which decides what these pages may promise — see `Mode`.
   *
   * Defaults to `plane`, the more restricted one: a deployment that forgot to say
   * offers less than it can, rather than promising drafting that will never happen.
   */
  mode?: Mode;
  /**
   * Where artifacts live, when this surface is the one holding them (9e). Absent, the
   * forget route answers 501 rather than pretending to delete something.
   */
  blobRoot?: string;
  /**
   * Who is asking, and what they may act on (9c). Absent, this is the LOCAL surface:
   * one operator, bound to 127.0.0.1, and the origin check is the whole control — which
   * is what ADR-0013 has always described and what `serve.ts` still runs.
   *
   * Present, this is the hosted plane, and the difference is not cosmetic. The one write
   * here stores shell commands the engine executes verbatim; unauthenticated on a public
   * address, it is remote code execution on somebody's runner. So every page is scoped
   * to the installations GitHub says this person may see, and the write is refused
   * outright for anything else.
   */
  auth?: {
    session: (headers: Record<string, string | string[] | undefined>) => Promise<Session | null>;
    installations: (session: Session) => Promise<number[]>;
  };
  /**
   * How this surface reads GitHub on a person's behalf (M10). The issue picker and the run
   * it starts both need an installation token, and the App key that mints one lives in the
   * plane — never here, never in a runner (ADR-0012). Absent, both routes answer 501: the
   * local surface has no App, and a page that pretended otherwise would list nothing and
   * say nothing about why.
   */
  github?: { token: (installationId: number) => Promise<string>; api?: string; fetch?: Fetcher };
}): Route {
  const { client } = options;
  const install = options.installUrl ?? installUrl();

  /** Lowercased: a media type is case-insensitive, and `Application/JSON` is JSON. */
  const contentType = (headers: Record<string, string | string[] | undefined>): string => {
    const value = headers['content-type'];
    return ((Array.isArray(value) ? value[0] : value) ?? '').toLowerCase();
  };

  /**
   * The repositories this request may see, or `null` for "everything" in local mode.
   *
   * Derived from GitHub's answer each time rather than cached: an installation list held
   * anywhere of ours is correct until somebody is removed from an org and confidently
   * wrong afterwards.
   */
  /**
   * Where this page is being served from, for a command an operator will paste elsewhere.
   *
   * `x-forwarded-proto` because the plane sits behind a TLS terminator that speaks plain
   * HTTP to it: trusting the socket would print `http://` for an `https://` deployment,
   * and a runner dialling that gets a redirect it does not follow.
   */
  const origin = (headers: Record<string, string | string[] | undefined>): string => {
    const first = (value: string | string[] | undefined) =>
      (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim();
    const host = first(headers['host']) ?? '127.0.0.1';
    const proto = first(headers['x-forwarded-proto']) ?? (host.startsWith('127.0.0.1') || host.startsWith('localhost') ? 'http' : 'https');
    return `${proto}://${host}`;
  };

/**
 * A run id, or nothing.
 *
 * `run_projection.run_id` is a `uuid` column, and Postgres refuses to compare one with
 * anything else — so `/api/runs/zzz/evidence` threw, and `sse.ts` turned the throw into a
 * **500 carrying the raw Postgres message**, which quotes the caller's own path segment
 * back at them. `tailAuthorizer` has guarded exactly this since 10g, eight lines away in a
 * sibling module; these routes did not.
 *
 * 404 is the right answer and the one every other "no such run" gives, so a stranger
 * probing ids learns the same nothing either way.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const visible = async (
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ session: Session; repos: Set<string> } | null | 'anonymous'> => {
    if (!options.auth) return null;
    const session = await options.auth.session(headers);
    if (!session) return 'anonymous';
    const allowed = new Set(await options.auth.installations(session));
    const installations = await listInstallations(client);
    return {
      session,
      repos: new Set(installations.filter((i) => allowed.has(i.installationId)).map((i) => i.repo)),
    };
  };

  /**
   * The chrome for a page: what this deployment can promise, and who is looking at it.
   *
   * `visible()` already asked both questions to decide whether to render at all, so the
   * answer is here — the alternative was every page re-deriving a login it was handed.
   */
  const chrome = (seen: Awaited<ReturnType<typeof visible>>) => ({
    mode: options.mode ?? ('plane' as const),
    ...(seen !== null && seen !== 'anonymous' ? { who: seen.session.login } : {}),
  });


  /** Send a browser to log in; tell an API client plainly. */
  const anonymous = (path: string) =>
    path.startsWith('/api/')
      ? json({ error: 'not signed in' }, 401)
      : { status: 302, type: 'text/plain', body: 'sign in\n', headers: { location: '/auth/github' } };

  return async ({ method, path, query, body, headers }) => {
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) return null;
    // Before any routing, so a route added later cannot forget it. Every GET here is a
    // projection that can be rebuilt from the log; the writes are what need a human.
    if (method !== 'GET' && !sameOrigin(headers)) {
      return {
        status: 403,
        type: 'text/plain',
        body:
          'refused: this looks like a cross-site request.\n\n' +
          'Approving a recipe stores commands this engine executes verbatim, and storing a\n' +
          'secret hands this service a credential — so a write is only accepted from its own\n' +
          'page (ADR-0013: the approval is the control).\n',
      };
    }
    // A JSON write has to say it is one. `sameOrigin` above is the control; this makes
    // sure a `/api/` route never parses a body that arrived as a form, whatever sent it —
    // the one request shape a browser can send with no preflight is exactly the one no
    // JSON client sends. 415, because the body is the wrong kind rather than forbidden.
    //
    // `DELETE` is absent because it carries no body. It is still covered by the check
    // above, and a cross-site `DELETE` cannot leave a browser without a preflight at all.
    if (
      (method === 'POST' || method === 'PUT') &&
      path.startsWith('/api/') &&
      !contentType(headers).startsWith('application/json')
    ) {
      return json({ error: 'send application/json' }, 415);
    }

    if (method === 'GET' && (path === '/' || path === '')) {
      // Whether this is SOMEBODY, not what they own — and the difference is the reason
      // this is `auth.session()` rather than the `visible()` every other route calls.
      //
      // `visible()` also asks GitHub `GET /user/installations` and queries `installations`,
      // because the routes below need to know which repositories to show. This one needs
      // one bit. Buying the full authorization answer to read that bit would put two
      // GitHub round-trips on the front door — one here, one on the `/repos` this
      // redirects to — on the most-hit route in the product, which until now did no I/O
      // at all. It would also make the landing page fail when GitHub is down: a signed-in
      // user would be bounced to `/repos` and told they have no repositories, which is
      // what an empty installations list renders and is not true.
      //
      // What was wrong before was `signIn: options.auth !== undefined`, which answers
      // "does signing in exist on this deployment" — still the right answer for the link,
      // and the wrong one for "is this person logged out". The session check answers that.
      const session = options.auth ? await options.auth.session(headers) : null;
      if (session) {
        return { status: 302, type: 'text/plain', body: 'signed in\n', headers: { location: '/repos' } };
      }
      // Signed out: `null`, so the static bundle answers with the landing page (10i).
      //
      // The redirect above is the reason this route still exists at all now that the
      // pages are a bundle. The bundle COULD make the same decision — it asks `/api/me`
      // on load — but it would paint the landing page first and replace it a moment
      // later, so every signed-in visitor to the front door would see a marketing page
      // flash past. A 302 decided here, where the cookie already is, has no such moment.
      return null;
    }

    // ── WHO IS ASKING (10i) ──────────────────────────────────────────────────────
    //
    // The one route that answers 200 for a stranger. Every other `/api/` GET 401s when
    // nobody is signed in, and that is right for a route returning somebody's data — but
    // this one exists to be asked BEFORE anything is known, by a page that has to decide
    // whether to render an application or a way in. A 401 here would make "signed out",
    // the ordinary state of a first visit, arrive as a failure.
    //
    // It exists at all because the UI is a static bundle (ADR-0022): there is no render
    // on this side that could read the cookie and decide, so the decision the `/` route
    // above makes server-side has to be askable over HTTP.
    //
    // Every field is about the DEPLOYMENT or the person, never about a repository. What
    // this surface can promise differs between `serve.ts` and the plane — drafting,
    // logins, an App to read issues with, injection — and a page that assumed the hosted
    // answer would offer a local operator buttons that 501.
    if (method === 'GET' && path === '/api/me') {
      // `auth.session()`, NOT `visible()`, and it is the same distinction the `/` route
      // records above — which this got wrong on the first write.
      //
      // `visible()` answers "what may you act on", which means asking GitHub
      // `GET /user/installations` and querying `installations`. This route needs one bit:
      // is there somebody. Every document the bundle serves asks this on load, so buying
      // the full authorization answer here would put a GitHub round-trip on the most-hit
      // route in the product — and would make the whole dashboard fail to render when
      // GitHub is down, rather than failing only the pages that are actually about
      // repositories.
      const session = options.auth ? await options.auth.session(headers) : null;
      // A surface with no accounts is the LOCAL one — one operator, no login — and it is
      // signed in by construction. Collapsing that to `signedIn: false` would put a
      // sign-in wall in front of a deployment that has no login to offer.
      const signedIn = options.auth === undefined || session !== null;
      return json({
        accounts: options.auth !== undefined,
        signedIn,
        login: session?.login ?? null,
        mode: options.mode ?? 'plane',
        installUrl: install,
        // Absent where there are no accounts, because there is nobody to bill: `serve.ts`
        // spends the operator's own environment. `null` would read as "you have not set
        // one", which is a prompt to visit a settings page that cannot store it.
        modelKey: session ? await hasModelKey(client, session.githubId) : null,
        secrets: { enabled: secretsEnabled() },
        // Whether the issue picker and Start can work at all. Both 501 without an App,
        // and a page that renders them anyway is a button whose only outcome is an error.
        github: options.github !== undefined,
        // Whether anything can destroy an artifact here (9e). The forget control is a
        // 501 on a surface holding no blobs, and offering it there promises a deletion
        // this deployment cannot perform.
        forgetting: options.blobRoot !== undefined,
      });
    }

    if (method === 'GET' && path === '/api/repos') {
      const who = await visible(headers);
      if (who === 'anonymous') return anonymous(path);
      const installations = (await listInstallations(client)).filter(
        (installation) => who === null || who.repos.has(installation.repo),
      );
      const runs = await listRuns(client);
      const rows = await Promise.all(
        installations.map(async (installation) => ({
          installation,
          hasRecipe: (await loadRecipe(client, installation.repo)) !== null,
          runs: runs.filter((run) => run.repo === installation.repo).length,
        })),
      );
      return json(
        rows.map(({ installation, hasRecipe, runs: count }) => ({
          repo: installation.repo,
          account: installation.account,
          connectedAt: installation.connectedAt,
          onboarded: hasRecipe,
          runs: count,
        })),
      );
    }

    if (method === 'GET' && path === '/api/runs') {
      const who = await visible(headers);
      if (who === 'anonymous') return anonymous(path);
      const repo = query.get('repo') ?? undefined;
      // Scoped by REPOSITORY rather than by a query the caller controls: a `?repo=`
      // naming somebody else's project must return nothing, not their run list.
      const runs = (await listRuns(client, repo)).filter(
        (run) => who === null || who.repos.has(run.repo),
      );
      return json(runs);
    }

    // ── THE LOG, READ RATHER THAN TAILED (10i) ───────────────────────────────────
    //
    // `GET /runs/:id/events` is the SSE tail (ADR-0005) and stays exactly what it is. This
    // is the same rows for a run that has ALREADY ENDED, and it exists because the tail is
    // the wrong tool for one: `tailRun` polls `seq > $2` every 250ms for as long as the
    // client is connected, and the dashboard passes no `until`, so an evidence page left
    // open in a tab would poll a log that cannot gain another row, four times a second,
    // forever.
    //
    // So the page streams a live run and reads a finished one. Same authorization as the
    // evidence view — deciding it twice is how the two come to disagree.
    const log = /^\/api\/runs\/([^/]+)\/events$/.exec(path);
    if (method === 'GET' && log) {
      const runId = decodeURIComponent(log[1]!);
      if (!UUID.test(runId)) return json({ error: 'no such run' }, 404);
      const who = await visible(headers);
      if (who === 'anonymous') return anonymous(path);
      const row = await readRunRow(client, runId);
      if (!row || (who !== null && !who.repos.has(row.repo))) return json({ error: 'no such run' }, 404);
      return json(await readRun(client, runId));
    }

    const run = /^\/api\/runs\/([^/]+)\/evidence$/.exec(path);
    if (method === 'GET' && run) {
      const runId = decodeURIComponent(run[1]!);
      if (!UUID.test(runId)) return json({ error: 'no such run' }, 404);
      const who = await visible(headers);
      if (who === 'anonymous') return anonymous(path);
      const row = await readRunRow(client, runId);
      if (!row) {
        // QUEUED, not missing — and the difference is the first thing a person sees after
        // pressing Start. `enqueueJob` writes a row to `jobs` and nothing else; the log's
        // first event, and therefore the projection, comes from the worker that claims it
        // (ADR-0019). For the seconds between, `run_projection` has nothing, and answering
        // 404 sent everybody who used the button straight to "No such run" — a dead end,
        // with no retry, for a run that was about to start perfectly normally.
        //
        // Authorized the way everything else here is: the job carries the repository, and a
        // caller who may not see it gets the ordinary 404.
        const { rows } = await client.query(
          'select repo, issue_number from jobs where run_id = $1',
          [runId],
        );
        const job = rows[0] as { repo: string; issue_number: number | null } | undefined;
        if (!job || (who !== null && !who.repos.has(job.repo))) return json({ error: 'no such run' }, 404);
        // 202: the request is fine and the thing is not ready yet. The page polls this and
        // says a worker has not claimed it, which is true and is what is happening.
        return json({ queued: true, repo: job.repo, issue_number: job.issue_number }, 202);
      }
      // The same answer for "no such run" and "not yours". A run id is a uuid, so this
      // costs a legitimate user nothing and tells a stranger nothing about what exists.
      if (who !== null && !who.repos.has(row.repo)) return json({ error: 'no such run' }, 404);
      // The view is built from the LOG, not from the row. The row is a cache and says so;
      // an evidence view built from a cache would be evidence at one remove, which is the
      // one thing this screen cannot be.
      const events = await readRun(client, runId);
      const state = fold(events);
      const view = {
        row,
        state,
        score: confidence(state),
        usage: await readUsage(client, runId),
        compute: await readCompute(client, runId),
        forgotten: await tombstoneFor(client, runId),
      };
      // The FOLD on the wire, not the events. A client that folded for itself would be a
      // second implementation of what happened, free to disagree with `report.ts` and the
      // pull request about whether a run reproduced — which is the mistake ADR-0009 is
      // about and which this codebase has made twice. The tail streams raw events for
      // liveness; the verdict has one author.
      return json(view);
    }

    // FORGETTING (9e). A POST, behind the same origin check every write here gets, and
    // behind the same authorization the run's own page gets — deleting somebody's
    // evidence is not a lesser thing to be allowed to do than reading it.
    const forgetting = /^\/api\/runs\/([^/]+)\/forget$/.exec(path);
    if (method === 'POST' && forgetting) {
      const runId = decodeURIComponent(forgetting[1]!);
      if (!UUID.test(runId)) return json({ error: 'no such run' }, 404);
      const who = await visible(headers);
      if (who === 'anonymous') return anonymous(path);
      const row = await readRunRow(client, runId);
      if (!row || (who !== null && !who.repos.has(row.repo))) return json({ error: 'no such run' }, 404);
      if (!options.blobRoot) return json({ error: 'this surface stores no artifacts' }, 501);
      await forgetRun(client, {
        runId,
        // Named, because "who asked" is the only part of a deletion anybody can audit
        // afterwards — the bytes are gone by definition.
        requestedBy: who === null ? 'the local operator' : who.session.login,
        blobRoot: options.blobRoot,
      });
      // The count, because it is the only thing about a deletion anybody can check
      // afterwards — the bytes are gone by definition, and `requestedBy` above is the
      // only other part of it that survives.
      const tombstone = await tombstoneFor(client, runId);
      return json({ forgotten: true, removed: tombstone?.removed ?? 0 });
    }

    // ── SECRETS (M10, ADR-0017) ──────────────────────────────────────────────────
    //
    // Three routes and none of them returns a value. `GET` answers with names, `PUT`
    // takes one in, `DELETE` removes one; there is no fourth verb.
    //
    // What stops a value coming back is a convention, and it is worth saying so rather
    // than overstating it: `src/secrets.ts` DOES export readers — `repoSecrets`, `modelKey`
    // and `open` — and nothing but this file's import list keeps them out of a response.
    // The mechanism is the test, which stores a recognisable value and greps every
    // response this surface can produce for it.
    //
    // Storing is allowed while injection is not (`ENGINE_SECRETS_ENABLED`), and that is
    // deliberate rather than an oversight: the injection guard is 10l's and it has to be
    // executed against a real sealed sandbox before any credential goes near a run. What
    // the pages must therefore say — and do — is that a value stored today is held and
    // not used. The `enabled` flag below is what they say it from.
    const secrets = /^\/api\/repos\/(.+?)\/secrets(?:\/([^/]+))?$/.exec(path);
    if (secrets && (method === 'GET' || method === 'PUT' || method === 'DELETE')) {
      const repo = decodeURIComponent(secrets[1]!);
      const name = secrets[2] === undefined ? null : decodeURIComponent(secrets[2]);
      const who = await visible(headers);
      if (who === 'anonymous') return anonymous(path);
      // The same 404 for "not yours" and "no such repository", for the same reason the
      // issue picker gives: a stranger probing names learns nothing.
      if (who !== null && !who.repos.has(repo)) return json({ error: 'not connected' }, 404);
      if (!(await loadInstallation(client, repo))) return json({ error: 'not connected' }, 404);

      if (method === 'GET') {
        if (name !== null) return json({ error: 'a stored value is never returned' }, 405);
        return json({ names: await listRepoSecretNames(client, repo), enabled: secretsEnabled() });
      }
      if (name === null) return json({ error: 'name the variable: /secrets/NAME' }, 404);
      // The same name rule a recipe's `required` obeys, because these two lists are read
      // against each other: a secret stored under a name no recipe can ask for is a value
      // this service holds and can never use.
      if (!ENV_NAME.test(name)) return json({ error: `\`${name}\` is not an environment variable name` }, 400);

      if (method === 'DELETE') {
        return (await deleteRepoSecret(client, repo, name))
          ? json({ deleted: name })
          : json({ error: 'no such secret' }, 404);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await body());
      } catch {
        return json({ error: 'the body is not JSON' }, 400);
      }
      const value = (parsed as { value?: unknown } | null)?.value;
      // An empty value is refused rather than stored. `missingRequired` treats `''` as
      // missing, so storing one would produce a name that is listed as present and still
      // blocks the run — the worst of both answers.
      if (typeof value !== 'string' || value === '') {
        return json({ error: 'send { "value": "…" } with a non-empty value' }, 400);
      }
      if (value.length > MAX_SECRET_CHARS) return json({ error: 'that value is too long to be a credential' }, 413);
      await putRepoSecret(client, repo, name, value, who === null ? 'the local operator' : who.session.login);
      // 200 with the name, never the value — an echo here is the one place a credential
      // could slip back out through a route that was written not to return one.
      return json({ stored: name, enabled: secretsEnabled() });
    }

    // ── THE MODEL KEY (M10) ──────────────────────────────────────────────────────
    //
    // One per person. A run started from the button spends the key of whoever pressed it,
    // which is why this is on `/api/settings` and not under a repository: the key follows
    // the human, and two people connected to the same repository pay separately.
    if (path === '/api/settings/model-key' && (method === 'GET' || method === 'PUT' || method === 'DELETE')) {
      const who = await visible(headers);
      if (who === 'anonymous') return anonymous(path);
      // A deployment with no login has no "whoever pressed it" to bill, and `serve.ts`
      // takes its key from the operator's own environment. Saying so is better than
      // storing a row under a user nobody can sign in as.
      if (who === null) return json({ error: 'this surface has no accounts; set a key in the environment' }, 501);
      const githubId = who.session.githubId;

      if (method === 'GET') return json(await hasModelKey(client, githubId));
      if (method === 'DELETE') {
        return (await deleteModelKey(client, githubId)) ? json({ deleted: true }) : json({ error: 'no key' }, 404);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await body());
      } catch {
        return json({ error: 'the body is not JSON' }, 400);
      }
      const asked = (parsed ?? {}) as { provider?: unknown; key?: unknown };
      const provider = typeof asked.provider === 'string' ? asked.provider : 'openrouter';
      const key = asked.key;
      if (!(PROVIDERS as string[]).includes(provider)) {
        return json({ error: `provider must be one of ${PROVIDERS.join(', ')}` }, 400);
      }
      if (typeof key !== 'string' || key === '') return json({ error: 'send { "key": "…" }' }, 400);
      if (key.length > MAX_SECRET_CHARS) return json({ error: 'that value is too long to be a key' }, 413);
      await putModelKey(client, githubId, provider, key);
      return json({ stored: true, provider });
    }

    // THE ISSUE PICKER (M10). Authorized like every other page — may you see this
    // repository — and then GitHub is asked, on every request, what is open there.
    const issues = /^\/api\/repos\/(.+)\/issues$/.exec(path);
    if (method === 'GET' && issues) {
      const repo = decodeURIComponent(issues[1]!);
      const who = await visible(headers);
      if (who === 'anonymous') return anonymous(path);
      // 404 and the same words for "not yours" and "unknown": a stranger probing names
      // learns nothing about which repositories this service knows.
      if (who !== null && !who.repos.has(repo)) return json({ error: 'not connected' }, 404);
      const installation = await loadInstallation(client, repo);
      if (!installation) return json({ error: 'not connected' }, 404);
      if (!options.github) return json({ error: 'this surface has no GitHub App' }, 501);
      // A whole number from 1, or 1. `Infinity` and `1e300` are numbers too, and GitHub
      // answers them with a 422 that would surface here as our 500.
      const asked = Number(query.get('page') ?? '1');
      const page = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, 1_000) : 1;
      const token = await options.github.token(installation.installationId);
      return json(await listOpenIssues(options.github, token, repo, page));
    }

    // ── RUNNERS, AS JSON (10i) ───────────────────────────────────────────────────
    //
    // The screen `runnersPage` rendered, for a UI that is not a form. Pairing is the
    // interesting one: the token exists in exactly one response and can never be shown
    // again, which is why the HTML version RENDERED rather than redirected. A JSON
    // answer carries it the same way and is the more honest shape for it — there is no
    // page here that could be mistaken for somewhere to find it later.
    //
    // Behind the same origin check and the same authorization as every write on this
    // surface. A pairing token is a credential for a machine that will execute somebody's
    // recipe, so `may you see this repository` is asked by GitHub first, as always.
    const apiRunners = /^\/api\/repos\/(.+?)\/runners(?:\/([^/]+)\/revoke)?$/.exec(path);
    if (apiRunners && (method === 'GET' || method === 'POST')) {
      const repo = decodeURIComponent(apiRunners[1]!);
      const revoke = apiRunners[2] === undefined ? null : decodeURIComponent(apiRunners[2]);
      const who = await visible(headers);
      if (who === 'anonymous') return anonymous(path);
      if (who !== null && !who.repos.has(repo)) return json({ error: 'not connected' }, 404);
      const installation = await loadInstallation(client, repo);
      if (!installation) return json({ error: 'not connected' }, 404);

      if (revoke !== null) {
        if (method !== 'POST') return json({ error: 'POST to revoke' }, 405);
        // The INSTALLATION, not just the repository in the path. Authorizing the repo and
        // then trusting the id from the URL let anyone with access to any repository
        // revoke somebody else's machine — the bug the HTML route records above.
        return (await revokeRunner(client, revoke, installation.installationId))
          ? json({ revoked: revoke })
          : json({ error: 'no such runner' }, 404);
      }
      if (method === 'GET') {
        return json({
          runners: await listRunners(client, installation.installationId),
          // The URL the operator is READING this on, which is the one their runner has to
          // dial. The HTML page printed the literal string `<this service>` here once,
          // served from the host it should have been naming.
          planeUrl: origin(headers),
        });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await body());
      } catch {
        return json({ error: 'the body is not JSON' }, 400);
      }
      const name = typeof (parsed as { name?: unknown } | null)?.name === 'string'
        ? (parsed as { name: string }).name.trim()
        : '';
      if (!name) return json({ error: 'send { "name": "…" }' }, 400);
      const { token, runner } = await pairRunner(client, {
        installationId: installation.installationId,
        name,
      });
      // ONCE. Nothing stores this in a form we can read back, and no route returns it
      // again — the same property the secrets routes have, arrived at from the other
      // direction: there, a value goes in and never comes out; here, one comes out and
      // is never asked for.
      return json({ paired: runner, token, planeUrl: origin(headers) }, 201);
    }

    // ── APPROVING A RECIPE, AS JSON (10i) ────────────────────────────────────────
    //
    // The same write the form below performs, and deliberately not a second one: it
    // parses with `parseRecipe`, stores with `saveRecipe`, clears the draft and fires
    // `onApproved`, in that order and for the reasons recorded there. What differs is
    // only the envelope — a `PUT` with a JSON body, which is what a page that is not a
    // form can send.
    //
    // Everything ADR-0013 says about the form applies here unchanged. This stores shell
    // commands the engine later executes verbatim in a sandbox with a package registry
    // reachable, and nothing sandboxes them from that sandbox. The controls that make
    // that acceptable are the origin check at the top of this function and the human who
    // pressed the button; neither is weakened by the content type, and a JSON route that
    // skipped either would be the same decision with the control removed.
    //
    // BEFORE the catch-all below, whose `(.+)` would otherwise swallow `…/recipe` and
    // answer a repository named `acme/widgets/recipe` does not exist.
    const recipeRoute = /^\/api\/repos\/(.+)\/recipe$/.exec(path);
    if (recipeRoute && (method === 'PUT' || method === 'GET')) {
      const repo = decodeURIComponent(recipeRoute[1]!);
      const who = await visible(headers);
      if (who === 'anonymous') return anonymous(path);
      if (who !== null && !who.repos.has(repo)) return json({ error: 'not connected' }, 404);
      if (!(await loadInstallation(client, repo))) return json({ error: 'not connected' }, 404);
      if (method === 'GET') return json({ recipe: await loadRecipe(client, repo) });

      let parsed: unknown;
      try {
        parsed = JSON.parse(await body());
      } catch {
        return json({ error: 'the body is not JSON' }, 400);
      }
      // `{ recipe: … }` rather than the recipe at the top level, so this body has room to
      // gain a field — and so `null` and `42`, both of which parse, cannot reach
      // `parseRecipe` as a recipe-shaped thing they are not.
      const asked = (parsed ?? {}) as { recipe?: unknown };
      try {
        const draft = parseRecipe(asked.recipe);
        await saveRecipe(client, repo, draft);
        await clearDraft(client, repo).catch(() => {});
        options.onApproved?.(repo);
        // The timestamp, because it is the only thing that distinguishes a click that
        // stored something from a click that changed nothing — the gap `onboardPage`
        // records as having convinced the first person to use it that the button was
        // broken, while an empty recipe had in fact been approved for real.
        return json({ approved: true, approvedAt: (await loadStored(client, repo))?.approvedAt ?? null });
      } catch (error) {
        // 400 with the message, never swallowed, and the framing is the page's: what
        // failed is the document, not the project. `parseRecipe` validates shape and
        // nothing about what the commands do, and a refusal presented as a finding about
        // somebody's repository is the one presentation ADR-0007's amendment forbids.
        return json({ error: String((error as Error).message ?? error) }, 400);
      }
    }

    // ── ONE REPOSITORY (10i) ─────────────────────────────────────────────────────
    //
    // LAST of the `/api/repos/` routes, and the order is load-bearing rather than tidy.
    // `owner/name` contains a slash, so this pattern's `(.+)` matches
    // `acme/widgets/secrets` and `acme/widgets/issues` just as happily as the repository
    // itself. The specific routes are above and have already returned by the time this
    // is reached; moving it up would shadow the secrets write — the highest-privilege
    // route on this surface — with a read that answers 200.
    //
    // Everything the repository's screen needs, in one answer. Four round trips to draw
    // one page is four chances to render a recipe beside a proof of a different one.
    const repoDetail = /^\/api\/repos\/(.+)$/.exec(path);
    if (method === 'GET' && repoDetail) {
      const repo = decodeURIComponent(repoDetail[1]!);
      const who = await visible(headers);
      if (who === 'anonymous') return anonymous(path);
      // The same 404 and the same words the issue picker and the secrets routes give,
      // for the same reason: a stranger probing names learns nothing about which
      // repositories this service knows.
      if (who !== null && !who.repos.has(repo)) return json({ error: 'not connected' }, 404);
      const installation = await loadInstallation(client, repo);
      if (!installation) return json({ error: 'not connected' }, 404);
      const [recipe, stored, draft, names, runs] = await Promise.all([
        loadRecipe(client, repo),
        loadStored(client, repo),
        loadDraft(client, repo),
        listRepoSecretNames(client, repo),
        listRuns(client, repo),
      ]);
      return json({
        repo,
        account: installation.account,
        connectedAt: installation.connectedAt,
        onboarded: recipe !== null,
        recipe,
        approvedAt: stored?.approvedAt ?? null,
        proof: stored?.proof ?? null,
        // Sent beside the recipe rather than merged into it, and the consumer decides.
        // `onboardPage` documents the rule — an approved recipe wins outright, because a
        // draft beside the one in force reads as a live second proposal — and deciding it
        // here would put that rule in two places.
        draft: draft?.draft ?? null,
        secrets: { names, enabled: secretsEnabled() },
        runs,
      });
    }

    // THE BUTTON (M10). Starting a run is a write to `jobs`: dispatch, not the log. The
    // worker that claims the job writes `RUN_REQUESTED` as seq 1, exactly as it did when
    // a webhook delivery put the job there, so the plane still produces nothing
    // (ADR-0019). What changed is who decides a run should exist — a person, who has a
    // model key and an opinion about the repository's environment, which are the two
    // things a webhook could never supply.
    if (method === 'POST' && path === '/api/runs') {
      const who = await visible(headers);
      if (who === 'anonymous') return anonymous(path);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await body());
      } catch {
        return json({ error: 'the body is not JSON' }, 400);
      }
      // `null` parses. So does `42`. Neither has a `repo`, and reading one off them is
      // a throw that would arrive as a 500 where every other bad body is a 400.
      if (typeof parsed !== 'object' || parsed === null) {
        return json({ error: 'send { "repo": "owner/name", "issue_number": N }' }, 400);
      }
      const asked = parsed as { repo?: unknown; issue_number?: unknown };
      const repo = typeof asked.repo === 'string' ? asked.repo : null;
      const issueNumber =
        typeof asked.issue_number === 'number' && Number.isInteger(asked.issue_number) && asked.issue_number > 0
          ? asked.issue_number
          : null;
      if (repo === null || issueNumber === null) {
        return json({ error: 'send { "repo": "owner/name", "issue_number": N }' }, 400);
      }
      // BEFORE the installation lookup and before GitHub is asked anything about the
      // issue: the question "may you" comes first, and is answered by GitHub, not by us.
      if (who !== null && !who.repos.has(repo)) return json({ error: 'not connected' }, 404);
      const installation = await loadInstallation(client, repo);
      if (!installation) return json({ error: 'not connected' }, 404);
      if (!options.github) return json({ error: 'this surface has no GitHub App' }, 501);
      // The onboarding gate, the same one the webhook path applied (M6a): a repository
      // with no recipe gets an answer, not a run that reproduces nothing and reports it as
      // a finding about the bug.
      if ((await loadRecipe(client, repo)) === null) {
        return json({ error: 'not onboarded', onboard: `/repos/${encodeURIComponent(repo)}/onboard` }, 409);
      }
      // WHO PAYS (M10). A run spends the key of whoever pressed Start, so a person
      // without one gets an answer here rather than a job that a worker claims, cannot
      // drive, and ends `errored` — a failure about our configuration wearing the shape
      // of a finding about their bug. 412: the request is fine, a precondition is not.
      //
      // Only where there are accounts. The local surface has one operator and takes its
      // key from the environment, which is what every run before the button did.
      if (who !== null && (await hasModelKey(client, who.session.githubId)) === null) {
        // `settings` is where the Next.js UI will put the form (10i). There is no such
        // page yet, and naming it here is a promise this deployment does not keep — so
        // the answer says what is missing and how to supply it, in words that are true
        // of the surface that exists.
        return json({ error: 'no model key', how: 'PUT /api/settings/model-key' }, 412);
      }
      const open = await openJobFor(client, repo, issueNumber);
      if (open !== null) return json({ error: 'a run for this issue is already under way', run_id: open }, 409);
      const token = await options.github.token(installation.installationId);
      const issue = await readIssue(options.github, token, repo, issueNumber);
      if (!issue) return json({ error: 'no such issue' }, 404);
      // Through `intake()`, so what a run starts from has ONE author. A hand-built
      // `IssueIntake` here would be a second definition of what a report is, free to
      // drift from the webhook's the day either changes.
      const mapped = intake('issues', {
        action: 'opened',
        issue: { number: issue.number, title: issue.title, body: issue.body, html_url: issue.html_url },
        repository: { full_name: repo },
        installation: { id: installation.installationId },
      });
      if (!mapped || mapped.kind !== 'issue') return json({ error: 'the issue could not be read as a report' }, 502);
      const runId = await enqueueJob(client, {
        installationId: installation.installationId,
        repo,
        intake: {
          ...mapped,
          event: { ...mapped.event, ...(who === null ? {} : { requested_by: who.session.login }) },
        },
        ...(who === null ? {} : { requestedBy: who.session.githubId }),
        issueNumber,
      });
      return json({ run_id: runId }, 202);
    }

    const api = /^\/api\/runs\/([^/]+)$/.exec(path);
    if (method === 'GET' && api) {
      const who = await visible(headers);
      if (who === 'anonymous') return anonymous(path);
      const runId = decodeURIComponent(api[1]!);
      if (!UUID.test(runId)) return json({ error: 'no such run' }, 404);
      const row = await readRunRow(client, runId);
      return row && (who === null || who.repos.has(row.repo))
        ? json(row)
        : json({ error: 'no such run' }, 404);
    }

    // The HTML surface that used to live here — the landing page, the repository list, the
    // run list, the evidence page, the onboarding form, the runners form — is gone (10i).
    // Every one of them is now a screen in `web/`, drawn from the JSON above and served as
    // a static bundle by `src/static.ts`. `src/web.ts` is deleted; ADR-0022 records the
    // reversal of the README's no-framework decision and what did not move with it.
    //
    // What that means for this function: EVERY route here is now `/api/`, and the
    // `anonymous()` helper's non-API branch is unreachable. It is kept anyway, because the
    // day a non-API route comes back is the day somebody wants a redirect rather than a
    // 401 for it, and rediscovering that is worse than carrying four lines.

    return null;
  };
}
