// Serving the dashboard (10i), and the guard that replaced the one 10i deleted.
//
// `test/web.test.ts` asserted that no page this product renders contains a `<script>` at
// all. It was the strongest injection check in this suite — a real injected tag cannot hide
// behind a legitimate one when there are none — and a React bundle cannot keep it: the
// bundle IS scripts.
//
// What replaces it is two things, both asserted here:
//
//   1. **A Content-Security-Policy with `script-src 'self'` plus a hash per inline block.**
//      An injected `<script>` does not execute, whatever put it in the document. The hashes
//      are computed from the bytes being served rather than written down, because a list
//      maintained by hand is a list that is wrong after the next `next build`.
//   2. **Nothing in `web/` calls `dangerouslySetInnerHTML`.** React escapes children by
//      default; that API is the one way out of it, and its absence is checkable by reading.
//
// The rest is about the two shapes a static server gets wrong: answering a missing asset
// with a page, and answering a machine surface's own 404 with one.

import { readdirSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { policy, staticRoutes, DEFAULT_BUNDLE } from '../src/static.js';

const call = (route: ReturnType<typeof staticRoutes>, path: string, method = 'GET') =>
  route({
    method,
    path,
    query: new URLSearchParams(),
    headers: {},
    body: async () => '',
    raw: async () => Buffer.alloc(0),
  });

/** A bundle on disk, so the route is exercised over real files rather than a fake. */
const bundle = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'bundle-'));
  mkdirSync(join(root, '_next', 'static', 'chunks'), { recursive: true });
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><title>app</title><script src="/_next/static/chunks/a.js"></script>' +
      '<script>self.__next_f=[]</script>',
  );
  writeFileSync(join(root, '_next', 'static', 'chunks', 'a.js'), 'console.log(1)');
  writeFileSync(join(root, '_next', 'static', 'app.css'), 'body{}');
  return root;
};

describe('one document for every page path, and only for a page path', () => {
  it('serves the application for a path no file matches', async () => {
    // A run id cannot be pre-rendered, so `/runs/<uuid>` is not a file and never will be.
    const route = staticRoutes({ root: bundle() });
    for (const path of ['/', '/repos', '/repos/acme/widgets', '/runs', '/runs/2f8c-…', '/settings']) {
      const answer = await call(route, path);
      expect(answer?.status, path).toBe(200);
      expect(answer?.type, path).toMatch(/text\/html/);
      expect(String(answer?.body), path).toContain('<title>app</title>');
    }
  });

  it('a missing asset is 404, never the application', async () => {
    // THE failure this prevents: a chunk removed by a deploy, answered with HTML, arriving
    // at the browser as `Unexpected token <` — an error about JavaScript syntax describing
    // a file that is not there.
    const route = staticRoutes({ root: bundle() });
    for (const path of ['/_next/static/chunks/gone.js', '/favicon.ico', '/whatever.css']) {
      const answer = await call(route, path);
      expect(answer?.status, path).toBe(404);
    }
  });

  it('a machine surface answers for itself, even when it has nothing to say', async () => {
    // These paths belong to routes that ran BEFORE this one. Reaching here means they
    // declined — a mistyped API path, a webhook delivery to the wrong URL — and handing a
    // JSON client 200 bytes of markup is the most confusing way for an API to say "no".
    const route = staticRoutes({ root: bundle() });
    for (const path of ['/api/nothing', '/auth/nothing', '/runner/nothing', '/webhook', '/healthz']) {
      expect(await call(route, path), path).toBeNull();
    }
  });

  it('answers nothing but a read', async () => {
    const route = staticRoutes({ root: bundle() });
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect(await call(route, '/repos', method), method).toBeNull();
    }
  });

  it('the hashed chunks are immutable and the document is not cached at all', async () => {
    const route = staticRoutes({ root: bundle() });
    const chunk = await call(route, '/_next/static/chunks/a.js');
    expect(chunk?.headers?.['cache-control']).toMatch(/immutable/);
    expect(chunk?.type).toMatch(/javascript/);
    // The document names the chunk hashes of the build that produced it. A cached copy from
    // the previous deploy asks for files that no longer exist, and the page comes up blank
    // with a 404 in the console and nothing else to go on.
    const page = await call(route, '/repos');
    expect(page?.headers?.['cache-control']).toBe('no-store');
  });

  it('a deployment with no bundle names the command rather than 404ing', async () => {
    // `serve.ts` on a checkout somebody just cloned. A blank page there reads as a broken
    // service, when what is missing is a build step.
    const route = staticRoutes({ root: join(tmpdir(), 'definitely-not-here') });
    const answer = await call(route, '/repos');
    expect(answer?.status).toBe(503);
    expect(String(answer?.body)).toContain('npm run web:build');
    // And the API is unaffected, which is the sentence that stops somebody debugging the
    // wrong half.
    expect(String(answer?.body)).toMatch(/JSON API and the event stream are unaffected/);
  });
});

describe('the policy is what stops an injected script, now that the pages are scripts', () => {
  it('allows this origin and every inline block it actually serves — and nothing else', () => {
    const html = '<script src="/a.js"></script><script>ONE</script><script>TWO</script>';
    const csp = policy(html);
    for (const inline of ['ONE', 'TWO']) {
      const hash = createHash('sha256').update(inline, 'utf8').digest('base64');
      expect(csp).toContain(`'sha256-${hash}'`);
    }
    expect(csp).toContain("script-src 'self'");
    // `'unsafe-inline'` in script-src is precisely the directive an injected `<script>`
    // needs, and having it is the same as having no script policy at all.
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-eval/);
  });

  it('a script the document does not contain is not allowed by it', () => {
    // The mutation this is really about: a hash list that has drifted from the document
    // allows a script nobody shipped and blocks one they did.
    const csp = policy('<script>ONE</script>');
    const other = createHash('sha256').update('alert(1)', 'utf8').digest('base64');
    expect(csp).not.toContain(other);
  });

  it('closes the directives an injected tag would otherwise reach for', () => {
    const csp = policy('');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    // This page shows somebody's evidence and carries a session cookie.
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('is served on the document, with the other two headers that matter', async () => {
    const answer = await call(staticRoutes({ root: bundle() }), '/repos');
    expect(answer?.headers?.['content-security-policy']).toContain("script-src 'self'");
    expect(answer?.headers?.['x-content-type-options']).toBe('nosniff');
    expect(answer?.headers?.['referrer-policy']).toBe('same-origin');
  });
});

describe('the front end never writes markup it did not build', () => {
  // React escapes children by default. `dangerouslySetInnerHTML` is the one way out, and
  // its absence is the structural half of what `test/web.test.ts`'s "no `<script>` in any
  // page" assertion used to give — the content half is `test/screens.test.tsx`.
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'out'
        ? []
        : entry.isDirectory()
          ? sources(join(dir, entry.name))
          : /\.tsx?$/.test(entry.name)
            ? [join(dir, entry.name)]
            : [],
    );

  it('nothing in web/ calls dangerouslySetInnerHTML', () => {
    const files = sources('web');
    // Without this, a `web/` that failed to resolve would pass by checking nothing.
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('dangerouslySetInnerHTML');
    }
  });

  it('the built document carries the landing page in its own bytes', () => {
    // What a crawler, a link preview, or a reader with JavaScript disabled receives. This
    // bundle is one document for every path, so it would have been entirely reasonable to
    // ship an empty shell and let React fill it — and the one URL anybody ever links to
    // would then have been blank to all three. `app/page.tsx` renders the landing page when
    // there is no `location`, which is the build, and this is what says so.
    let html: string;
    try {
      html = readFileSync(join(DEFAULT_BUNDLE, 'index.html'), 'utf8');
    } catch {
      return void expect(true).toBe(true);
    }
    expect(html).toContain('proves the bug existed');
    expect(html).toContain('Install on GitHub');
    // And the shell around it, which is what makes it a page rather than a fragment.
    expect(html).toContain('<title>');
    expect(html).toContain('lang="en"');
  });

  it('the built document, if one has been built, is covered by its own policy', () => {
    // Only where a build exists, because the suite must not require one. When it does, this
    // is the assertion that the hashing works against the real Next output rather than
    // against the small fixture above — the two have differed before, and would again the
    // first time Next changes how it emits its flight data.
    let html: string;
    try {
      html = readFileSync(join(DEFAULT_BUNDLE, 'index.html'), 'utf8');
    } catch {
      return void expect(true).toBe(true);
    }
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    expect(inline.length).toBeGreaterThan(0);
    const csp = policy(html);
    for (const [, body] of inline) {
      expect(csp).toContain(createHash('sha256').update(body ?? '', 'utf8').digest('base64'));
    }
  });
});
