/**
 * A STATIC EXPORT, and that is the whole architectural claim of 10i (ADR-0022).
 *
 * `output: 'export'` means `next build` produces HTML, CSS and JavaScript and nothing
 * that runs. There is no Node process here in production, no second port, no proxy, and
 * no place for a session to be read but the plane — which is the property the milestone
 * asked for in the words "the plane stays the only public process, the only holder of
 * cookies, and the only place authorization is decided". A Next server would have made
 * that a promise rather than a fact: it would have had to read the cookie to render, and
 * authorization would then live in two codebases.
 *
 * The cost is that a dynamic segment cannot be pre-rendered — there is no build-time list
 * of run ids. So this ships ONE document and the plane serves it for every page path
 * (`src/static.ts`), with the view chosen from `location.pathname` at runtime.
 * `index.html` is pre-rendered as the landing page, so the one URL a crawler or a link
 * preview ever fetches carries real markup rather than an empty shell.
 */
export default {
  // This repository has a lockfile of its own AND one at the root, and Next picks the
  // outer one by default — which makes the traced root the whole engine. Named, so the
  // build cannot start depending on where it was invoked from.
  outputFileTracingRoot: import.meta.dirname,
  output: 'export',
  images: { unoptimized: true },
  // Nothing here is generated per-request, so a trailing slash is a second URL for the
  // same document. The plane's own routes have never had one.
  trailingSlash: false,
};
