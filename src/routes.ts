// The dashboard's routes (M6f), and the approval that gates onboarding (M6b).
//
// A `Route` rather than a server: `sse.ts` owns the socket, this owns the answers. That
// split is what keeps the SSE module drivable by a test with no database — the property
// `test/sse.test.ts` depends on — while letting these routes hold a `Db`.
//
// Everything here is READ-ONLY except one POST, and that asymmetry is the design. The
// dashboard renders projections that can be rebuilt from the log; the single write is a
// human approving a recipe, which ADR-0013 calls "the only control there is on a stored
// command we will execute". A dashboard that could start runs, edit evidence or retry
// phases would be a second producer, and ADR-0009 has one.

import { confidence } from './confidence.js';
import { clearDraft, loadDraft } from './drafts.js';
import { fold } from './fold.js';
import { listInstallations, loadInstallation } from './installations.js';
import { listRuns, readRunRow, readUsage } from './readmodel.js';
import { loadProof, loadRecipe, parseRecipe, saveRecipe } from './recipe.js';
import { readRun, type Db } from './store.js';
import type { Route } from './sse.js';
import type { Session } from './auth.js';
import { forgetRun, tombstoneFor } from './forget.js';
import { listRunners, pairRunner, revokeRunner } from './plane.js';
import {
  escapeHtml,
  evidencePage,
  landingPage,
  onboardPage,
  repositoriesPage,
  runnersPage,
  runsPage,
  type Mode,
} from './web.js';

/**
 * Is this state-changing request coming from our own page?
 *
 * The one POST here stores a recipe — **arbitrary shell commands the engine later
 * executes verbatim** in a sandbox with a package registry reachable. Without this check
 * it was a textbook CSRF, and binding to `127.0.0.1` bought nothing: the same-origin
 * policy stops another page READING our response, never stops it sending the request, and
 * `application/x-www-form-urlencoded` is a CORS "simple" content type so no preflight
 * ever happens. Any page the operator visited could have silently stored a recipe, and
 * the next run on that repository would have executed it.
 *
 * Worse than the execution: it defeats the claim onboarding rests on. ADR-0013 says the
 * approval "is the only control there is on a stored command we will execute" — and a
 * forged POST is a stored command no human approved.
 *
 * `Sec-Fetch-Site` is the primary check because every current browser sends it and it
 * cannot be set by script. `Origin` is the fallback for anything older. A request with
 * NEITHER is not a browser — curl, the CLI, a test — and cannot be cross-site forged,
 * because forging one already requires code execution on the machine.
 */
const sameOrigin = (headers: Record<string, string | string[] | undefined>): boolean => {
  const one = (name: string): string | undefined => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const site = one('sec-fetch-site');
  if (site !== undefined) return site === 'same-origin' || site === 'none';
  const origin = one('origin');
  if (origin === undefined) return true;
  const host = one('host');
  try {
    return host !== undefined && new URL(origin).host === host;
  } catch {
    return false;
  }
};

const html = (body: string, status = 200) => ({ status, type: 'text/html; charset=utf-8', body });
const json = (body: unknown, status = 200) => ({
  status,
  type: 'application/json',
  body: JSON.stringify(body, null, 2),
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
}): Route {
  const { client } = options;
  const install = options.installUrl ?? installUrl();

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

  /** Send a browser to log in; tell an API client plainly. */
  const anonymous = (path: string) =>
    path.startsWith('/api/')
      ? json({ error: 'not signed in' }, 401)
      : { status: 302, type: 'text/plain', body: 'sign in\n', headers: { location: '/auth/github' } };

  return async ({ method, path, query, body, headers }) => {
    if (method !== 'GET' && method !== 'POST') return null;
    // Before any routing, so a route added later cannot forget it. Every GET here is a
    // projection that can be rebuilt from the log; the writes are what need a human.
    if (method === 'POST' && !sameOrigin(headers)) {
      return {
        status: 403,
        type: 'text/plain',
        body:
          'refused: this looks like a cross-site request.\n\n' +
          'Approving a recipe stores commands this engine executes verbatim, so it is only\n' +
          'accepted from its own page (ADR-0013: the approval is the control).\n',
      };
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
      // The sign-in link exists only where signing in does. Locally there is no login —
      // one operator, 127.0.0.1 — and offering one would be a button that leads nowhere.
      return html(landingPage(install, { signIn: options.auth !== undefined }));
    }

    if (method === 'GET' && path === '/repos') {
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
      return html(repositoriesPage(rows, options.mode ?? 'plane'));
    }

    if (method === 'GET' && (path === '/runs' || path === '/api/runs')) {
      const who = await visible(headers);
      if (who === 'anonymous') return anonymous(path);
      const repo = query.get('repo') ?? undefined;
      // Scoped by REPOSITORY rather than by a query the caller controls: a `?repo=`
      // naming somebody else's project must return nothing, not their run list.
      const runs = (await listRuns(client, repo)).filter(
        (run) => who === null || who.repos.has(run.repo),
      );
      return path === '/api/runs' ? json(runs) : html(runsPage(runs, repo, options.mode ?? 'plane'));
    }

    const run = /^\/runs\/([^/]+)$/.exec(path);
    if (method === 'GET' && run) {
      const runId = decodeURIComponent(run[1]!);
      const who = await visible(headers);
      if (who === 'anonymous') return anonymous(path);
      const row = await readRunRow(client, runId);
      // The same answer for "no such run" and "not yours". A run id is a uuid, so this
      // costs a legitimate user nothing and tells a stranger nothing about what exists.
      if (!row || (who !== null && !who.repos.has(row.repo))) {
        return html(`<!doctype html><title>not found</title><p>No such run.</p>`, 404);
      }
      // The page is rendered from the LOG, not from the row. The row is a cache and says
      // so; an evidence view built from a cache would be evidence at one remove, which is
      // the one thing this screen cannot be.
      const events = await readRun(client, runId);
      const state = fold(events);
      return html(
        evidencePage({
          row,
          state,
          score: confidence(state),
          usage: await readUsage(client, runId),
          forgotten: await tombstoneFor(client, runId),
        }),
      );
    }

    // FORGETTING (9e). A POST, behind the same origin check every write here gets, and
    // behind the same authorization the run's own page gets — deleting somebody's
    // evidence is not a lesser thing to be allowed to do than reading it.
    const forgetting = /^\/runs\/([^/]+)\/forget$/.exec(path);
    if (method === 'POST' && forgetting) {
      const runId = decodeURIComponent(forgetting[1]!);
      const who = await visible(headers);
      if (who === 'anonymous') return anonymous(path);
      const row = await readRunRow(client, runId);
      if (!row || (who !== null && !who.repos.has(row.repo))) {
        return html(`<!doctype html><title>not found</title><p>No such run.</p>`, 404);
      }
      if (!options.blobRoot) {
        return html(`<!doctype html><title>not here</title><p>This surface stores no artifacts.</p>`, 501);
      }
      await forgetRun(client, {
        runId,
        // Named, because "who asked" is the only part of a deletion anybody can audit
        // afterwards — the bytes are gone by definition.
        requestedBy: who === null ? 'the local operator' : who.session.login,
        blobRoot: options.blobRoot,
      });
      return {
        status: 303,
        type: 'text/plain',
        body: 'forgotten\n',
        headers: { location: `/runs/${encodeURIComponent(runId)}` },
      };
    }

    const api = /^\/api\/runs\/([^/]+)$/.exec(path);
    if (method === 'GET' && api) {
      const who = await visible(headers);
      if (who === 'anonymous') return anonymous(path);
      const row = await readRunRow(client, decodeURIComponent(api[1]!));
      return row && (who === null || who.repos.has(row.repo))
        ? json(row)
        : json({ error: 'no such run' }, 404);
    }

    // RUNNERS (9c). The pairing token is minted here, and it is minted *because* a human
    // is authenticated: one login for a person, one credential for a machine, and the
    // second is a consequence of the first rather than a second thing to remember.
    const runners = /^\/repos\/(.+)\/runners$/.exec(path);
    const revoking = /^\/repos\/(.+)\/runners\/([^/]+)\/revoke$/.exec(path);
    if (runners || revoking) {
      const repo = decodeURIComponent((revoking ?? runners)![1]!);
      const who = await visible(headers);
      if (who === 'anonymous') return anonymous(path);
      if (who !== null && !who.repos.has(repo)) {
        return html(`<!doctype html><title>not connected</title><p>${escapeHtml(repo)} is not connected.</p>`, 404);
      }
      const installation = await loadInstallation(client, repo);
      if (!installation) {
        return html(`<!doctype html><title>not connected</title><p>${escapeHtml(repo)} is not connected.</p>`, 404);
      }

      if (method === 'POST' && revoking) {
        // The installation, not just the repository in the path. Authorizing the repo
        // and then trusting the runner id from the URL let anyone with access to ANY
        // repository revoke somebody else's runner — the id was never checked against
        // the installation being viewed. `revokeRunner` now requires the installation
        // and updates nothing on a mismatch.
        const revoked = await revokeRunner(
          client,
          decodeURIComponent(revoking[2]!),
          installation.installationId,
        );
        if (!revoked) {
          // The same answer a runner that does not exist gets. A revoke that quietly
          // reported success for somebody else's machine would be the bug wearing a
          // redirect.
          return html(`<!doctype html><title>not found</title><p>No such runner.</p>`, 404);
        }
        return {
          status: 303,
          type: 'text/plain',
          body: 'revoked\n',
          headers: { location: `/repos/${encodeURIComponent(repo)}/runners` },
        };
      }

      if (method === 'POST' && runners) {
        const name = new URLSearchParams(await body()).get('name')?.trim();
        if (!name) return html(runnersPage(repo, await listRunners(client, installation.installationId)), 400);
        const { token } = await pairRunner(client, { installationId: installation.installationId, name });
        // Rendered rather than redirected, because the token exists in exactly one
        // response and a 303 would throw it away on the way to the page that cannot
        // show it again.
        return html(
          runnersPage(repo, await listRunners(client, installation.installationId), {
            token,
            name,
            // The URL the operator is READING this on, which is the one their runner has
            // to dial. It used to print the literal string `<this service>`, on a page
            // served from the host it should have been naming.
            planeUrl: origin(headers),
          }),
        );
      }

      if (method === 'GET' && runners) {
        return html(runnersPage(repo, await listRunners(client, installation.installationId)));
      }
    }

    // ONBOARDING. `owner/repo` has a slash in it, so the repo is the rest of the path.
    const onboard = /^\/repos\/(.+)\/onboard$/.exec(path);
    if (onboard) {
      const repo = decodeURIComponent(onboard[1]!);
      // BEFORE the installation lookup, and before the body is read. This is the write
      // that stores commands the engine executes verbatim, so the question "may you"
      // comes first and is answered by GitHub, not by us (ADR-0013, ADR-0019).
      const who = await visible(headers);
      if (who === 'anonymous') return anonymous(path);
      if (who !== null && !who.repos.has(repo)) {
        // 404 rather than 403: a stranger probing repository names learns nothing about
        // which ones this service knows.
        return html(`<!doctype html><title>not connected</title><p>${escapeHtml(repo)} is not connected.</p>`, 404);
      }
      const installation = await loadInstallation(client, repo);
      if (!installation) {
        // ESCAPED. `repo` is a path segment, so this string is whatever a stranger put
        // in a URL — interpolating it raw was a stored-nothing, reflected-everything XSS.
        return html(`<!doctype html><title>not connected</title><p>${escapeHtml(repo)} is not connected.</p>`, 404);
      }

      if (method === 'GET') {
        // `loadDraft` even when a recipe already exists: `onboardPage` is the one that
        // decides `current` wins, and computing that here would be a second copy of a
        // rule that already lives in one place.
        const [recipe, draft, proof] = await Promise.all([
          loadRecipe(client, repo),
          loadDraft(client, repo),
          loadProof(client, repo),
        ]);
        return html(onboardPage(repo, recipe, draft?.draft, undefined, proof, options.mode ?? 'plane'));
      }

      // THE ONE WRITE. A human is approving commands the engine will execute verbatim in
      // a sandbox with a package registry reachable, and nothing sandboxes them from that
      // sandbox — the approval IS the control (ADR-0013), which is why this is a POST a
      // person makes and not something a drafting agent can complete on its own.
      const raw = await body();
      try {
        const draft = parseRecipe(JSON.parse(new URLSearchParams(raw).get('recipe') ?? ''));
        await saveRecipe(client, repo, draft);
        // Best-effort, and after the write it can never invalidate: the draft row is
        // advisory (`recipe_drafts`'s own comment says losing it costs nothing but a
        // re-draft), so a failure here must not turn a successful approval into an error
        // response. Cleared rather than left behind because a stale draft shown beside the
        // recipe now actually in force reads as a second, live proposal.
        await clearDraft(client, repo).catch(() => {});
        // AFTER the write, never before: proving is about the commands now in force,
        // and a proof of something that failed to store would be a proof of nothing.
        options.onApproved?.(repo);
        // 303 with a Location, so a refresh re-renders the recipe rather than re-posting
        // it. Without the header this was a status code pretending to be a redirect.
        return {
          status: 303,
          type: 'text/plain',
          body: 'stored\n',
          headers: { location: `/repos/${encodeURIComponent(repo)}/onboard` },
        };
      } catch (error) {
        // Rendered back with the message, never swallowed: `parseRecipe` refuses a shape
        // that would fail later inside a container, where it reads as the user's project
        // being broken rather than as their recipe being wrong.
        return html(onboardPage(repo, null, undefined, String((error as Error).message ?? error)), 400);
      }
    }

    return null;
  };
}
