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
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
// TYPE ONLY, and that is load-bearing. `src/browser.ts` reads `ENGINE_CHROMIUM` into a
// module-level `const` at import time, so a static import here would freeze the default
// `/usr/bin/chromium-browser` before `beforeAll` ever runs. The class is pulled in with a
// dynamic import once the environment is set; the type is erased and costs nothing.
import type { Browser } from '../src/browser.js';
import { demoRunEvents, DEMO_RUN_ID } from '../src/fixtures/demo-run.js';
import { projectRun } from '../src/projection.js';
import { dashboardRoutes } from '../src/routes.js';
import { startStatusServer, type Route, type StatusServer } from '../src/sse.js';

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
 * A `pg.Client` that dispatches on the SQL it is handed.
 *
 * `test/serve.test.ts`'s one-shape fake answers every query with the same rows, which is
 * enough for a service that asks one question. These routes ask seven — installations, the
 * run list, the recipe, the row, the log, the usage — and a fake that answered them all
 * identically would render pages out of the wrong table without failing. So the dispatch is
 * on the query text, and an unrecognised query throws rather than returning `[]`: an empty
 * result renders as "nothing yet", which is a page that passes for a query nobody wrote.
 */
const fixtureClient = (): pg.Client => {
  const answer = (sql: string, params: unknown[]): unknown[] => {
    if (sql.includes('from installations where repo = $1')) {
      return INSTALLATIONS.filter((row) => row.repo === params[0]);
    }
    if (sql.includes('from installations where removed_at is null')) return INSTALLATIONS;
    if (sql.includes('from recipes where repo = $1')) {
      return params[0] === REPO ? [{ recipe: RECIPE }] : [];
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
    if (sql.includes('from run_usage where run_id = $1')) {
      return params[0] === DEMO_RUN_ID ? USAGE : [];
    }
    throw new Error(`the fixture database was asked something nobody wrote: ${sql}`);
  };
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const rows = answer(sql, params);
      return { rows, rowCount: rows.length };
    },
  } as unknown as pg.Client;
};

/**
 * The real routes, plus a favicon.
 *
 * Not decoration. Chrome asks every origin for `/favicon.ico`, the dashboard answers 404,
 * and Chrome writes "Failed to load resource" into the console — which would make the one
 * assertion in this file that can distinguish a rendered page from a broken one fail on
 * every page, for a reason that is not about the page. Answered here, in the test, so the
 * console stays a signal; the gap itself is reported rather than papered over in `src`.
 */
const withFavicon = (routes: Route): Route => async (request) =>
  request.path === '/favicon.ico'
    ? { status: 204, type: 'image/x-icon', body: '' }
    : routes(request);

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
    routes: withFavicon(dashboardRoutes({ client: fixtureClient(), installUrl: INSTALL_URL })),
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
const visit = async (path: string, title: RegExp): Promise<string> => {
  visited.push(path);
  const loaded = await browser!.navigate(`${base}${path}`);
  expect(loaded, `GET ${path} did not render the page it should have`).toMatch(title);
  return loaded;
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
    // running Chrome would fail every test below with "the browser did not come up",
    // twenty seconds at a time, naming the binary rather than the profile.
    const version = execFileSync(LAUNCHER, ['--version'], { encoding: 'utf8' });
    expect(version).toMatch(/chrom/i);
  });

  test('the landing page renders, states the claim, and links where install goes', async () => {
    if (skipped('the landing page')) return;

    const started = Date.now();
    const loaded = await visit('/', /title: Test Framework v2$/);
    const elapsed = Date.now() - started;
    console.log(`navigate('/') took ${elapsed}ms`);

    expect(loaded).toContain('Test Framework v2');
    const page = await browser!.text();
    // The product's one-line claim, as the h1 says it.
    expect(page).toContain('Open an issue. Get back a pull request that proves the bug existed.');
    expect(page).toMatch(/event-sourced execution and verification platform/);

    // The Install link points at the URL that was INJECTED, not at `installUrl()`'s
    // placeholder default — the selector is the assertion, because a selector that matches
    // is an anchor whose href is exactly that string.
    expect(await browser!.text(`a[href="${INSTALL_URL}"]`)).toBe('Install on GitHub');

    // A regression test for `once()`, which used to drop its waiter without resolving, so
    // every `navigate()` fell through to the 30s `CALL_TIMEOUT_MS` and reported success. It
    // is a performance bug that looks like a slow page; a ceiling here is what makes it
    // visible. Generous, because this is a cold browser start plus a first paint.
    expect(elapsed).toBeLessThan(15_000);
  });

  test('a second navigation, on a warm browser, is fast', async () => {
    if (skipped('navigation cost')) return;
    const started = Date.now();
    await visit('/', /title: Test Framework v2$/);
    const elapsed = Date.now() - started;
    console.log(`navigate('/') on a warm browser took ${elapsed}ms`);
    // Nothing about this page is slow. Anything near 30s means `Page.loadEventFired` is
    // being missed again and `Promise.race` is timing out instead of resolving.
    expect(elapsed).toBeLessThan(5_000);
  });

  test('the repository list shows both states, and only one of them carries the fix', async () => {
    if (skipped('the repository list')) return;
    await visit('/repos', /title: Repositories$/);

    const page = await browser!.text();
    expect(page).toContain(REPO);
    expect(page).toContain(UNONBOARDED);
    expect(page).toContain('recipe approved');
    expect(page).toContain('not onboarded yet');

    // The onboarding link is the row's most important column, and it belongs to exactly the
    // repository that needs it. `text()` returns 'missing' for a selector matching nothing,
    // which makes an absent link assertable rather than merely unseen.
    expect(await browser!.text(`a[href="/repos/${UNONBOARDED}/onboard"]`)).toBe('draft a recipe');
    expect(await browser!.text(`a[href="/repos/${REPO}/onboard"]`)).toBe(MISSING);
  });

  test('clicking the onboarding link reaches the approval screen and its warning', async () => {
    if (skipped('the onboarding click-through')) return;
    await visit('/repos', /title: Repositories$/);

    const page = await clickThrough(
      `a[href="/repos/${UNONBOARDED}/onboard"]`,
      /Read this before you approve/,
      `/repos/${UNONBOARDED}/onboard`,
    );

    expect(page).toContain(`Onboard ${UNONBOARDED}`);
    // The approval IS the control (ADR-0013), and the page has to say so to a stranger in
    // the same words `cli.ts` says it to an operator.
    expect(page).toMatch(/execute these commands\s+verbatim/);
    expect(page).toContain('you are the control');
    expect(page).toMatch(/Nothing sandboxes them from that sandbox/);
    // The form is really there and really posts back to the route that answers it.
    // `text()` reads `innerText`, and a `<textarea>`'s value is not rendered text — so the
    // box's contents are `test/web.test.ts`'s to assert and its EXISTENCE is this file's.
    expect(await browser!.text('textarea[name="recipe"]')).not.toBe(MISSING);
    expect(await browser!.text(`form[action="/repos/${UNONBOARDED}/onboard"]`)).not.toBe(MISSING);
    // The button says which of the two states this repository is in.
    expect(await browser!.text('button[type="submit"]')).toBe('Approve and store');
  });

  test('the run list shows the run, and clicking it reaches the evidence page', async () => {
    if (skipped('the run list')) return;
    await visit('/runs', /title: Runs$/);

    const list = await browser!.text();
    expect(list).toContain(DEMO_RUN_ID);
    expect(list).toContain(`${REPO}#41`);
    expect(list).toContain('Tier 1');
    // The denominator travels with the number.
    expect(list).toContain(`${RUN_ROW.confidence}/${RUN_ROW.ceiling}`);

    const evidence = await clickThrough(
      `a[href="/runs/${DEMO_RUN_ID}"]`,
      /The reproduction arm/,
      `/runs/${DEMO_RUN_ID}`,
    );
    expect(evidence).toContain(`${REPO}#41`);
  });

  test('the evidence page shows base red, fix green, the tier and every ground', async () => {
    if (skipped('the evidence page')) return;
    await visit(`/runs/${DEMO_RUN_ID}`, /title: acme\/widgets#41 — evidence$/);
    const page = await browser!.text();

    // The tier, with the sentence that says what it means rather than a bare number.
    expect(page).toContain('Tier 1');
    expect(page).toContain('reproduced by a failing test whose independence is established');

    // The two arms of the reproduction, from the real fold of the real fixture log. Base
    // failed for the reported reason; the fix run passed.
    expect(page).toContain('base');
    expect(page).toContain('fix');
    expect(page).toContain('npm test -- checkout-discount');
    expect(page).toContain('8d41c6b2a09f'); // the base commit, as the table truncates it
    expect(page).toContain('f3a9d1c7e5b2'); // the fix commit
    expect(page).toContain('sha256:5b7a1de2c3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
    expect(page).toContain('sha256:9c8b7a6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b');

    // The regression arm says it was not measured, in the words that refuse to imply it was
    // fine. `unmeasured` is the honest answer for this fixture and the page must not round it.
    expect(page).toContain('suite unmeasured');
    expect(page).toMatch(/Not knowing is not the same as knowing it is fine/);

    // The score, and every ground behind it — with points, and with the bytes.
    expect(page).toContain(`Confidence ${RUN_ROW.confidence}/${RUN_ROW.ceiling}`);
    expect(page).toContain('the reproduction ran red on the base commit');
    expect(page).toContain('every file of the reproduction was written by the engine over both checkouts');
    expect(page).toContain('the fix series ran to completion');
    expect(page).toContain('+45');
    expect(page).toContain('+15');
    expect(page).toContain('Not measured');

    // Testimony is named as testimony, before its count.
    expect(page).toContain('Testimony');
    expect(page).toMatch(/an input to no verdict/);

    // A Tier 1 with a diff shows it; the withholding is Tier 3's, and this is not one.
    expect(page).toContain('src/checkout/discount.ts');

    // The bill lives beside the log, and the page renders it from `run_usage`.
    expect(page).toContain('What this run cost');
    expect(page).toContain('41233');
  });

  test('the evidence page screenshots as a real PNG', async () => {
    if (skipped('the screenshot')) return;
    await visit(`/runs/${DEMO_RUN_ID}`, /title: acme\/widgets#41 — evidence$/);
    const png = await browser!.screenshot();

    // The magic bytes, not just "a buffer came back": `Page.captureScreenshot` returning an
    // empty string still base64-decodes into a Buffer, and a zero-length one would pass any
    // check that only asked whether it existed.
    expect(png.subarray(0, 4).toString('latin1')).toBe('\x89PNG');
    expect(png.length).toBeGreaterThan(5_000);
  });

  test('nothing on any page wrote an error to the browser console', async () => {
    if (skipped('the console')) return;
    // `navigate()` resolves for a 500 exactly as it does for a rendered page, so a check
    // that only reads content cannot tell a served document from a broken one. This can:
    // every failed subresource — a stylesheet, a script, a font, anything the router does
    // not answer — lands here as `[error] Failed to load resource`. Verified by removing
    // the favicon shim above, which turns this red on every page.
    //
    // WHAT IT DOES NOT CATCH, checked rather than assumed: an uncaught JavaScript exception.
    // A page serving `<script>notAFunction()</script>` leaves `console()` reading "nothing
    // logged", because `src/browser.ts` subscribes to `Runtime.consoleAPICalled` and
    // `Log.entryAdded` and not to `Runtime.exceptionThrown`. That is a gap in the tool, not
    // in the dashboard — reported, not worked around, and the reason `visit()` also insists
    // on the title rather than leaning on this alone.
    //
    // Asserted over the whole file because the browser and its log outlive each test; the
    // message names every page that was loaded, so a failure is still actionable.
    const log = browser!.console();
    const noisy = log
      .split('\n')
      .filter((line) => /^\[(error|warning)\]/i.test(line));
    expect(
      noisy,
      `after loading ${visited.join(', ')} the browser logged:\n${log}`,
    ).toEqual([]);
  });

  test('sees an uncaught page exception, which is the bug class the browser exists for', async () => {
    if (skipped('page exceptions')) return;
    // It could NOT see one. `src/browser.ts` subscribed to `Runtime.consoleAPICalled` and
    // `Log.entryAdded` and neither carries an uncaught exception, so a page whose script
    // threw read as a page with nothing to say — `console()` returned `nothing logged`.
    //
    // That is the wrong blind spot to have. ADR-0006's amendment gave the agent a browser
    // to find bugs it cannot find by reading, and a JavaScript error is the most common
    // thing a rendered page gets wrong. It also renders fine: the markup is served, the
    // load event fires, and `navigate()` reports success — so nothing else would notice.
    const thrower = await throwingPage();
    try {
      await browser!.navigate(thrower.url);
      // The exception arrives on its own event, after the load completes.
      await new Promise((done) => setTimeout(done, 400));
      const log = browser!.console();
      expect(log).toMatch(/notAFunction is not defined/);
      expect(log).toMatch(/\[error\]/);
    } finally {
      await thrower.close();
    }
  });
});
