---
status: accepted
---

# A framework in front, and nothing behind it

The README has said, since milestone 6, that the dashboard uses **no framework and no build
step**, "for the same reason `src/github.ts` speaks HTTP by hand and `src/browser.ts` speaks
the DevTools protocol by hand: a dependency here would be a large surface for a few pages."

That was true and it stopped being enough. This ADR reverses it, says exactly how far the
reversal goes, and — more importantly — names the property the old decision was buying and
what now buys it instead.

## What forced it

Not aesthetics. Milestone 10's whole thesis is *sign in, pick a repository, pick an issue,
press Start* — and by 10h, every part of that existed except the pressing.

`POST /api/runs` was built, authorized, tested and deployed in 10g. The SSE tail
([ADR-0005](0005-sse-over-websockets.md)) had been streaming since milestone 5
and was authorized in 10g. `PUT /api/repos/:repo/secrets/:name` and
`PUT /api/settings/model-key` shipped in 10k. **Nothing in the product called any of them.**
The only way to start a run on the hosted plane was `curl`; the only way to store the model
key that Start requires was `curl`; a run took four minutes and the only way to watch it was
to reload a list.

`src/routes.ts` said so out loud, in a comment on the 412 that Start returns to a person
with no model key:

> `settings` is where the Next.js UI will put the form (10i). There is no such page yet, and
> naming it here is a promise this deployment does not keep.

Three things stood between `src/web.ts` and closing that gap, and none of them is a matter of
taste:

1. **It could not send a `PUT` with a JSON body.** An HTML form sends `GET` or `POST`, form-
   encoded. Every write added in 10k is a JSON `PUT` — deliberately, because
   `routes.ts` refuses a `/api/` write that does not declare JSON, and that refusal is part
   of the CSRF story rather than a formality: the one request shape a browser can send
   cross-site with no preflight is exactly the one no JSON client sends.
2. **It could not consume the tail.** A live run is a stream folded into a view, and a
   function returning a string cannot subscribe to anything.
3. **It could not have scripts at all.** `test/web.test.ts` asserted that no page this
   product renders contains a `<script>` — the strongest injection guard in the suite,
   because a real injected tag cannot hide behind a legitimate one if there are none.

The third is the interesting one, because it means the old design was not merely lacking a
front end: **its security argument depended on not having one.**

## The decision

A Next.js application in `web/`, its own npm project, built with `output: 'export'`.

What that produces is HTML, CSS and JavaScript **and nothing that runs**. There is no Next
server in production, no second process, no second port, no proxy. `src/static.ts` reads the
built bundle into memory at boot and hands it out from the plane's own port.

So the reversal is narrower than it looks. A framework is now in front of the user. Behind
it, nothing changed:

- **The plane is still the only public process.** One address, one certificate, one port.
- **The plane is still the only holder of cookies.** A static bundle cannot read a session,
  which means it cannot be tempted to decide anything with one.
- **The plane is still the only place authorization is decided.** Every `/api/` route asks
  GitHub `GET /user/installations` on the request, exactly as before. The bundle renders
  what it is given and can obtain nothing by rendering differently.
- **The plane still produces no events** ([ADR-0019](0019-who-writes-when-the-runner-is-not-ours.md)).
  Start writes a job; the worker that claims it writes `RUN_REQUESTED`.
- **The verdict still has one author.** The tail streams raw events so the timeline can say
  what happened; every judgement — reproduced, regression, tier, confidence — is re-read
  from `/api/runs/:id/evidence`, which is `fold.ts` and `confidence.ts`. A client that
  folded for itself would be a second implementation of what happened, free to disagree with
  the pull request, which is the mistake [ADR-0009](0009-what-a-producer-may-write-back.md) is about
  and which this codebase has made twice.

A Next **server** would have broken the second and third of those. To render a page it would
have had to read the cookie, and authorization would then live in two codebases in two
languages with two ideas of what a session is. Static export is not a compromise here; it is
the only shape that keeps the sentence true.

## What replaced the `<script>` guard

This is the part that would otherwise have been lost quietly, so it is stated as three
mechanisms, each with the test that holds it:

1. **A Content-Security-Policy computed from the bytes being served.** `script-src 'self'`
   plus a `sha256-` hash for every inline block Next emits — seven of them, carrying the
   flight data. An injected `<script>` does not execute, whatever put it in the document.
   The hashes are read off `index.html` at boot rather than written down, because a hash
   list maintained by hand is wrong after the next `next build`. `'unsafe-inline'` is
   absent from `script-src` and the test asserts its absence: having it would be the same
   as having no script policy at all. (`test/static.test.ts`)
2. **Nothing in `web/` calls `dangerouslySetInnerHTML`.** React escapes children by default;
   that API is the one way out, and its absence is checkable by reading. (`test/static.test.ts`)
3. **The screens are still pure functions over data.** `src/web.ts` had a rule worth more
   than anything else it said — *no I/O; every export takes data and returns a string, so
   the screen that IS the product is testable without a database, a browser, or a listening
   socket* — and React could have deleted it silently, since a component that fetches its
   own data can only be checked in a browser. So the rendering half of each screen was split
   from the fetching half (`Evidence` from `Run`, `Timeline` from the tail) and
   `test/screens.test.tsx` renders those with `renderToStaticMarkup`, asserting both the
   escaping and the words. That file is the direct successor to `test/web.test.ts`.

The browser test (`test/dashboard.browser.test.ts`) carries what only a browser can: that
the policy this repository serves does not block the scripts it also serves, that a
`pushState` path resolves to a view, that the console is silent, and a floor of structural
accessibility — one `main`, one `h1`, a skip link, a real tablist, a label per input.

## One document, and why

A run id cannot be pre-rendered: there is no build-time list of them, and `output: 'export'`
will not emit a dynamic segment without one. Two shapes were available.

Six exported documents plus six rewrite rules in the plane, with a full page load between
screens — or **one document, served for every page path, choosing its view from
`location.pathname`.** The second is one rule in `src/static.ts` instead of six, navigation
without a round trip, and a live run's tail that survives a click to another tab and back.

Its cost is that `index.html` must be worth receiving on its own, because it is what a
crawler, a link preview and a reader with JavaScript disabled get. So `app/page.tsx` renders
the **landing page** when there is no `location` — which is the build — and `index.html`
ships that markup rather than an empty shell. `test/static.test.ts` asserts it.

The one server-side page that survives is the OAuth refusal in `src/auth-routes.ts`. It
cannot join the bundle: a person arrives there mid-redirect from GitHub, on a URL the
bundle's router has no view for, and the one thing that page must survive is the rest of the
front end being broken.

## What it costs, stated plainly

- **A second npm project and a build step.** `web/` has its own `package.json` and lockfile
  so that Next, React and their transitive dependencies exist in exactly one image build and
  no other — the worker and both sandbox images install the root `package.json`, and a
  machine that runs untrusted code has no use for a front-end toolchain. `Dockerfile.plane`
  gained one stage; `npm run web:build` is now part of the check as well as the ship, since
  it is what typechecks `web/`.
- **121 kB of JavaScript on first load**, against zero. For a page whose argument is that
  claims should be cheap to check, that is a real number and it is written here so that it
  is not forgotten. It buys the four screens that did not exist.
- **The suite now needs a build to check the front end end-to-end.** The browser test skips
  without `web/out` and says so by name, in the same words it uses for a missing Chromium —
  because "not built" and "broken" produce the same blank page and only one is a bug.
- **`src/web.ts` is deleted**, and with it 1,390 lines that were, sentence for sentence,
  some of the most carefully written in this repository. Their content is not gone: it was
  carried across into the components, and the assertions that protected it were carried into
  `test/screens.test.tsx` rather than dropped.

## What this does not license

A framework in front is not a framework everywhere. `src/github.ts` still speaks HTTP by
hand, `src/browser.ts` still speaks the DevTools protocol by hand, `src/openrouter.ts` still
speaks its API by hand, and the reason is unchanged: those run inside the images that
execute untrusted code, and every dependency there is supply chain next to somebody else's
repository. The reversal is scoped to bytes a browser downloads and no process of ours ever
executes.
