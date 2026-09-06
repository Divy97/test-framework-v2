// The dashboard, served (10i, ADR-0022).
//
// `web/` is a Next.js application built with `output: 'export'`, which means it is HTML,
// CSS and JavaScript and nothing that runs. This module hands those bytes out from the
// plane's own port, and that is the whole of the "same origin, behind the plane" decision:
// there is no second process, no proxy, and no place a session could be read but here.
//
// Three things it does that a static file server would not, each because of something
// specific to this deployment:
//
//   1. **One document for every page path.** A run id cannot be pre-rendered, so the
//      bundle is a single document that picks its view from `location.pathname`. Every
//      page path therefore resolves to `index.html` — but ONLY page paths: a miss under
//      `/_next/` is a 404, because answering a missing chunk with HTML makes the browser
//      report a syntax error in a file that was never there.
//   2. **Reserved prefixes never fall through.** `/api/`, `/auth/`, `/webhook`, `/runner/`
//      have already been offered to the routes before this one. If they got here they are
//      a miss inside a machine surface, and an API client that asked for a route that does
//      not exist must get a 404, not a page.
//   3. **A Content-Security-Policy computed from the bytes being served.** `web.ts` was
//      guarded by `test/web.test.ts` asserting that no page contained a `<script>` at all
//      — the strongest injection check in this suite, and one a React bundle cannot keep.
//      What replaces it is a real CSP with `script-src 'self'` plus a hash for each inline
//      block Next emits, so an injected `<script>` does not execute even if one is ever
//      rendered. The hashes are read off `index.html` at boot rather than written down,
//      because a hash list maintained by hand is a hash list that is wrong after the next
//      `next build`.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Route } from './sse.js';

/**
 * Where the built bundle is, relative to this file.
 *
 * `dist/static.js` sits where `src/static.ts` did — the same arrangement `Dockerfile.plane`
 * already relies on for `db/` — so one path works from source and from the image.
 */
export const DEFAULT_BUNDLE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'out');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/**
 * Paths this module must never answer with a page.
 *
 * Everything here belongs to a route that ran before this one. Reaching this module means
 * that route did not match — a mistyped API path, a webhook delivery to the wrong URL —
 * and the honest answer is that there is nothing there. Serving the dashboard instead
 * gives a JSON client a 200 full of markup, which is the single most confusing way for an
 * API to say "no such route".
 */
const RESERVED = ['/api/', '/auth/', '/runner/', '/webhook', '/healthz'];

type Bundle = { files: Map<string, Buffer>; index: Buffer; csp: string };

/**
 * Read the whole bundle into memory once.
 *
 * It is a few hundred kilobytes of immutable, content-hashed files that every visitor
 * needs, and it cannot change without a redeploy. Reading it per request would be an open
 * and a stat on the hot path for no property that matters — and reading it once is also
 * what makes the traversal question disappear: a request path is a MAP KEY here, not a
 * filesystem path, so there is nothing for `..` to escape from.
 */
function load(root: string): Bundle | null {
  const files = new Map<string, Buffer>();
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, `${prefix}/${entry}`);
      else files.set(`${prefix}/${entry}`, readFileSync(full));
    }
  };
  try {
    if (!statSync(root).isDirectory()) return null;
    walk(root, '');
  } catch {
    // No bundle. `serve.ts` on a laptop that has never run `npm run web:build` is a valid
    // state, and the caller renders a page saying so rather than 500ing on every request.
    return null;
  }
  const index = files.get('/index.html');
  if (!index) return null;
  return { files, index, csp: policy(index.toString('utf8')) };
}

/**
 * The policy, with a hash for every inline script in the document.
 *
 * Next's App Router emits its flight data as inline `<script>` blocks — seven of them in
 * this build — so `script-src 'self'` alone would produce a blank page. The alternative to
 * hashing them is `'unsafe-inline'`, which is the same as having no script policy at all:
 * it is precisely the directive an injected `<script>` needs.
 *
 * Nonces are the usual answer and are not available here, because a nonce has to differ
 * per response and these bytes are written once at build time.
 */
export function policy(html: string): string {
  const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (match) => `'sha256-${createHash('sha256').update(match[1] ?? '', 'utf8').digest('base64')}'`,
  );
  return [
    "default-src 'none'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    // `'unsafe-inline'` for STYLE, and it is worth being explicit about why it is not the
    // same concession. React writes element styles through the CSSOM at runtime, which no
    // CSP directive governs, and Next's own `data-precedence` machinery reorders style
    // elements. What an attacker gets from inline CSS is exfiltration by selector, which
    // `connect-src 'self'` and `img-src` below already close.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    // The API and the SSE tail, both of which are this origin. Nothing here talks to
    // anywhere else, so anything that tries is a bug or an injection.
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    // The dashboard shows somebody's evidence and carries a session cookie. There is no
    // reason for it to be inside anybody's iframe.
    "frame-ancestors 'none'",
  ].join('; ');
}

export function staticRoutes(options: { root?: string } = {}): Route {
  const root = options.root ?? DEFAULT_BUNDLE;
  const bundle = load(root);

  type Answer = { status: number; type: string; body: string | Buffer; headers?: Record<string, string> };

  const page = (body: Buffer, csp: string): Answer => ({
    status: 200,
    type: 'text/html; charset=utf-8',
    body,
    headers: {
      // NO CACHE on the document, and this is not conservatism. It names the hashed chunk
      // files of the build that produced it; a cached copy from the previous deploy asks
      // for chunks that no longer exist, and the page comes up blank with a 404 in the
      // console and nothing else to go on.
      'cache-control': 'no-store',
      'content-security-policy': csp,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
    },
  });

  return async ({ method, path }): Promise<Answer | null> => {
    if (method !== 'GET' && method !== 'HEAD') return null;
    if (RESERVED.some((prefix) => path === prefix || path.startsWith(prefix))) return null;

    if (!bundle) {
      // A deployment with no bundle. Explicit, and naming the command — a blank page or a
      // 404 here reads as the service being broken, when what is missing is a build step.
      return {
        status: 503,
        type: 'text/html; charset=utf-8',
        body:
          `<!doctype html><html lang="en"><title>no dashboard</title>` +
          `<h1>The dashboard has not been built.</h1>` +
          `<p>This process serves <code>web/</code>&rsquo;s static export and there is nothing at ` +
          `<code>${root.replace(/[<>&]/g, '')}</code>. Build it with:</p>` +
          `<pre>npm run web:build</pre>` +
          `<p>The JSON API and the event stream are unaffected and answering normally.</p>`,
        headers: { 'cache-control': 'no-store' },
      };
    }

    const file = bundle.files.get(path === '/' ? '/index.html' : path);
    if (file) {
      const ext = extname(path === '/' ? '/index.html' : path);
      if (ext === '.html') return page(file, bundle.csp);
      return {
        status: 200,
        type: TYPES[ext] ?? 'application/octet-stream',
        body: file,
        headers: {
          // Everything under `_next/static` carries a content hash in its NAME, so a
          // change is a different URL and this can never serve a stale one. Anything else
          // in the bundle is revalidated, because its name says nothing about its content.
          'cache-control': path.startsWith('/_next/static/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
          'x-content-type-options': 'nosniff',
        },
      };
    }

    // A miss with a file extension is a MISSING FILE, not a page. Falling through to the
    // document here is how a deleted chunk arrives at the browser as `Unexpected token <`
    // — an error about JavaScript syntax describing a 404.
    if (extname(path) !== '' || path.startsWith('/_next/')) {
      return { status: 404, type: 'text/plain', body: 'not found\n' };
    }

    // Everything else is a page path, and the bundle decides which page.
    return page(bundle.index, bundle.csp);
  };
}
