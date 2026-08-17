// The dashboard's routes (M6f), and the approval that gates onboarding (M6b).
//
// A `Route` rather than a server: `sse.ts` owns the socket, this owns the answers. That
// split is what keeps the SSE module drivable by a test with no database — the property
// `test/sse.test.ts` depends on — while letting these routes hold a `pg.Client`.
//
// Everything here is READ-ONLY except one POST, and that asymmetry is the design. The
// dashboard renders projections that can be rebuilt from the log; the single write is a
// human approving a recipe, which ADR-0013 calls "the only control there is on a stored
// command we will execute". A dashboard that could start runs, edit evidence or retry
// phases would be a second producer, and ADR-0009 has one.

import type pg from 'pg';
import { confidence } from './confidence.js';
import { fold } from './fold.js';
import { listInstallations, loadInstallation } from './installations.js';
import { listRuns, readRunRow, readUsage } from './readmodel.js';
import { loadRecipe, parseRecipe, saveRecipe } from './recipe.js';
import { readRun } from './store.js';
import type { Route } from './sse.js';
import { escapeHtml, evidencePage, landingPage, onboardPage, repositoriesPage, runsPage } from './web.js';

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
  client: pg.Client;
  /** Injected so a test can drive the surface without a GitHub App registered. */
  installUrl?: string;
}): Route {
  const { client } = options;
  const install = options.installUrl ?? installUrl();

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

    if (method === 'GET' && (path === '/' || path === '')) return html(landingPage(install));

    if (method === 'GET' && path === '/repos') {
      const installations = await listInstallations(client);
      const runs = await listRuns(client);
      const rows = await Promise.all(
        installations.map(async (installation) => ({
          installation,
          hasRecipe: (await loadRecipe(client, installation.repo)) !== null,
          runs: runs.filter((run) => run.repo === installation.repo).length,
        })),
      );
      return html(repositoriesPage(rows));
    }

    if (method === 'GET' && path === '/runs') {
      const repo = query.get('repo') ?? undefined;
      return html(runsPage(await listRuns(client, repo), repo));
    }

    if (method === 'GET' && path === '/api/runs') {
      return json(await listRuns(client, query.get('repo') ?? undefined));
    }

    const run = /^\/runs\/([^/]+)$/.exec(path);
    if (method === 'GET' && run) {
      const runId = decodeURIComponent(run[1]!);
      const row = await readRunRow(client, runId);
      if (!row) return html(`<!doctype html><title>not found</title><p>No such run.</p>`, 404);
      // The page is rendered from the LOG, not from the row. The row is a cache and says
      // so; an evidence view built from a cache would be evidence at one remove, which is
      // the one thing this screen cannot be.
      const events = await readRun(client, runId);
      const state = fold(events);
      return html(
        evidencePage({ row, state, score: confidence(state), usage: await readUsage(client, runId) }),
      );
    }

    const api = /^\/api\/runs\/([^/]+)$/.exec(path);
    if (method === 'GET' && api) {
      const row = await readRunRow(client, decodeURIComponent(api[1]!));
      return row ? json(row) : json({ error: 'no such run' }, 404);
    }

    // ONBOARDING. `owner/repo` has a slash in it, so the repo is the rest of the path.
    const onboard = /^\/repos\/(.+)\/onboard$/.exec(path);
    if (onboard) {
      const repo = decodeURIComponent(onboard[1]!);
      const installation = await loadInstallation(client, repo);
      if (!installation) {
        // ESCAPED. `repo` is a path segment, so this string is whatever a stranger put
        // in a URL — interpolating it raw was a stored-nothing, reflected-everything XSS.
        return html(`<!doctype html><title>not connected</title><p>${escapeHtml(repo)} is not connected.</p>`, 404);
      }

      if (method === 'GET') {
        return html(onboardPage(repo, await loadRecipe(client, repo)));
      }

      // THE ONE WRITE. A human is approving commands the engine will execute verbatim in
      // a sandbox with a package registry reachable, and nothing sandboxes them from that
      // sandbox — the approval IS the control (ADR-0013), which is why this is a POST a
      // person makes and not something a drafting agent can complete on its own.
      const raw = await body();
      try {
        const draft = parseRecipe(JSON.parse(new URLSearchParams(raw).get('recipe') ?? ''));
        await saveRecipe(client, repo, draft);
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
        return html(onboardPage(repo, null, String((error as Error).message ?? error)), 400);
      }
    }

    return null;
  };
}
