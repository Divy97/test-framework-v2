// The surface (M6f): every screen the product has, as pure functions over data.
//
// The evidence view is what this milestone is for. Every product in this category has a
// landing page and a run list; the screen that is rare is the one showing base red for the
// reported symptom, fix green beside it, every confidence point traceable to a
// content-addressed artifact, and — on a Tier 3 — the gate visibly REFUSING to attempt a
// fix. All of that is already backed by data, so the work here is to add none.
//
// Three rules hold this file to that:
//
//   1. **No dependencies.** This repository hand-rolls its GitHub client, its OpenRouter
//      client and its DevTools driver rather than take a package. A template engine and a
//      CSS framework to print six pages would be the one dependency nobody could defend,
//      and it would be the dependency standing in front of the user.
//   2. **No I/O.** Every export takes data and returns a string, so the screen that IS the
//      product is unit-testable without a database, a browser, or a listening socket. A
//      screen checkable only by starting Postgres is a screen nobody checks — and this one
//      is where every claim the engine makes finally gets read by a human.
//   3. **Everything is escaped.** Repository names, recipe commands, abort reasons and the
//      agent's own transcript labels are attacker-influenced: `github.ts` says it of the
//      issue body that reaches the prompt, `verify.ts` says it of the abort reason a
//      reproduction can choose, and `run.ts` escapes issue text before it reaches a regex
//      for the same reason. One `escapeHtml`, applied at every interpolation, with no
//      exception for a field that "cannot" contain markup.
//
// Nothing here interprets. `fold.ts` decides what happened and `confidence.ts` decides what
// it was worth (ADR-0009); this file renders them and adds no judgement of its own. The
// label maps below name verdicts the fold already reached — they are captions, not a second
// opinion, which is the distinction that has bitten this codebase twice.

import type { Confidence } from './confidence.js';
import type { RunState } from './fold.js';
import type { Installation } from './installations.js';
import type { RunRow } from './projection.js';
import type { Recipe } from './recipe.js';

/**
 * The single escape, used on every value that reaches the document.
 *
 * `'` is in the set even though nothing here quotes an attribute with it. The rule is
 * "escape everything" precisely so that a later edit which does quote with `'` — or an
 * inline handler, or a `srcdoc` — is not a hole; a character class chosen to match today's
 * markup is a hole waiting for tomorrow's.
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * A repository name inside a URL path.
 *
 * `escapeHtml` is the wrong tool for a URL and would silently pass `owner/re po` or a
 * name carrying `#`, which truncates the path at the fragment and links somewhere else.
 * Percent-encoding is the right tool — per segment, so `owner/repo` keeps the separator
 * the route matches on — and the result is escaped afterwards because it still lands in
 * an attribute.
 */
const urlPath = (repo: string): string =>
  escapeHtml(repo.split('/').map(encodeURIComponent).join('/'));

/**
 * The two ways a value becomes a table cell, and both escape.
 *
 * Cells are HTML by the time the table helper sees them, so the discipline has to live at
 * the point of construction. Keeping it to exactly two constructors is what makes "did we
 * escape this one" answerable by reading, rather than by auditing every call site.
 */
const cell = (text: string): string => escapeHtml(text);
const codeCell = (text: string): string => `<code>${escapeHtml(text)}</code>`;

const table = (headers: string[], rows: string[][]): string =>
  `<div class="scroll"><table><thead><tr>${headers
    .map((h) => `<th>${escapeHtml(h)}</th>`)
    .join('')}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;

// Descendant selectors only, and no `>` or `<` anywhere in the sheet: the style block is
// interpolated into the document as text, and a combinator there is a character the parser
// has to be trusted to ignore. Cheaper to not write one.
const STYLE = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#14161a;--muted:#5b6270;--line:#e2e5ea;
--panel:#f7f8fa;--code:#eef0f3;--link:#14459c;--warn-bg:#fff2f2;--warn-line:#c8332e;
--warn-fg:#8a1f1c;--ok:#1c6b3f;--bad:#a32a25;}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--fg:#e6e9ee;--muted:#99a2b0;
--line:#262c35;--panel:#161b22;--code:#1b212a;--link:#87b0ff;--warn-bg:#2b1616;
--warn-line:#e0605a;--warn-fg:#ffb3ae;--ok:#68d391;--bad:#ff8e88;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em}
code{background:var(--code);padding:.1em .35em;border-radius:4px;word-break:break-all}
a{color:var(--link)}
header.top{display:flex;gap:1.25rem;align-items:baseline;flex-wrap:wrap;
padding:.9rem 1.25rem;border-bottom:1px solid var(--line);background:var(--panel)}
header.top .brand{font-weight:700;text-decoration:none;color:var(--fg)}
header.top nav a{margin-right:1rem}
main{max-width:62rem;margin:0 auto;padding:1.5rem 1.25rem 4rem}
h1{font-size:1.5rem;margin:0 0 .35rem}
h2{font-size:1.05rem;margin:2rem 0 .5rem;padding-bottom:.3rem;border-bottom:1px solid var(--line)}
p{margin:.5rem 0}
.muted{color:var(--muted)}
.small{font-size:.86rem}
.scroll{overflow-x:auto;max-width:100%}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid var(--line);
vertical-align:top;white-space:nowrap}
th{color:var(--muted);font-weight:600}
td.wrap{white-space:normal}
.strip{display:flex;flex-wrap:wrap;gap:.5rem;margin:.75rem 0 0}
.chip{background:var(--panel);border:1px solid var(--line);border-radius:999px;
padding:.15rem .7rem;font-size:.82rem}
.chip b{font-weight:600}
.pass{color:var(--ok)}
.fail{color:var(--bad)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;
padding:1rem 1.15rem;margin:1rem 0}
.warning{background:var(--warn-bg);border:1px solid var(--warn-line);
border-left-width:5px;border-radius:8px;padding:1rem 1.15rem;margin:1rem 0;color:var(--warn-fg)}
.warning h2{border:0;margin:0 0 .4rem;color:inherit}
.refusal{border-left-width:5px}
.refusal h2{border:0;margin:0 0 .4rem}
.grounds{list-style:none;padding:0;margin:.5rem 0}
.grounds li{padding:.55rem 0;border-bottom:1px solid var(--line)}
.points{display:inline-block;min-width:3.2rem;font-weight:700}
.refs{margin-top:.3rem}
.refs code{margin-right:.35rem}
.cta{display:inline-block;margin:1.25rem 0;padding:.7rem 1.4rem;border-radius:8px;
background:var(--fg);color:var(--bg);text-decoration:none;font-weight:600}
.hero{font-size:1.1rem;max-width:46rem}
ul.plain{padding-left:1.1rem}
textarea{display:block;width:100%;background:var(--code);color:var(--fg);
border:1px solid var(--line);border-radius:8px;padding:.75rem;
font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86rem}
button{margin-top:.9rem;padding:.6rem 1.3rem;border-radius:8px;border:0;cursor:pointer;
background:var(--fg);color:var(--bg);font-weight:600;font-size:.95rem}
`;

/**
 * The document every page is, header included.
 *
 * One layout rather than a per-page shell because the header is the only navigation this
 * product has, and a page that forgets it is a dead end. `prefers-color-scheme` is handled
 * by redefining tokens, never by defining a colour only inside the media block — a value
 * that exists in one theme is a page that renders unreadable in the other.
 */
export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<!-- An empty data: icon, which is not decoration.
     Chrome requests /favicon.ico on every navigation, the router does not answer it, and
     the 404 lands in the page console as an error. That makes the browser console check
     - the only assertion that catches a page which loaded but is broken - noisy on every
     single page, and a signal that is always red is not a signal. -->
<link rel="icon" href="data:,">
<style>${STYLE}</style>
</head>
<body>
<header class="top">
<a class="brand" href="/">Test Framework</a>
<nav><a href="/">Overview</a><a href="/runs">Runs</a></nav>
</header>
<main>
${body}
</main>
</body>
</html>
`;
}

/**
 * The public page, and one button.
 *
 * The button points at GitHub's own installation screen: GitHub owns choosing an account
 * and picking repositories, and rebuilding that would mean asking for a token — which is
 * the one thing ADR-0012 says is never requested. So the entire onboarding surface here is
 * a link, deliberately.
 */
export function landingPage(installUrl: string): string {
  const body = `<h1>Open an issue. Get back a pull request that proves the bug existed.</h1>
<p class="hero">Test Framework v2 is an event-sourced execution and verification platform.
It is not a coding agent — the model is a replaceable component. What is not replaceable is
the evidence: every claim it makes is a command it executed itself, in a container of its
own, recorded in an append-only log.</p>
<a class="cta" href="${escapeHtml(installUrl)}">Install on GitHub</a>
<h2>What actually happens</h2>
<ul class="plain">
<li><b>Reproduce first, or do not fix.</b> No reproduction, no fix, no partial credit. When
the bug cannot be shown on your base commit, the deliverable is a structured information
request — not a guess with a change attached.</li>
<li><b>Two arms, not one.</b> The reproduction says the reported bug is gone. Your project's
own test suite, executed on both commits, says nothing else went with it.</li>
<li><b>Testimony is not evidence.</b> The agent's transcript is stored and shown, and it is
an input to no verdict. Exit codes and content-addressed output are.</li>
<li><b>Nothing is merged.</b> That is always yours.</li>
</ul>
<h2>What it costs you to find out</h2>
<p>Installing grants the App access to the repositories you pick, and nothing else. No
personal access token is ever requested. The sandbox that runs an agent holds neither our
model key nor your GitHub token — the agent loop runs outside it and ships tool calls in, so
the container needs no network egress at all.</p>`;
  return layout('Test Framework v2', body);
}

/**
 * The repository list, whose real content is the onboarding status.
 *
 * An installed repository with no approved recipe is the state that used to produce the
 * product's worst answer: a run starting with `recipe: null`, booting nothing, and
 * returning a Tier 3 about a bug that was never shown (M6a). So "not onboarded yet" is not
 * a warning decoration — it is the row's most important column, and it carries the link
 * that resolves it.
 */
export function repositoriesPage(
  rows: { installation: Installation; hasRecipe: boolean; runs: number }[],
): string {
  const body =
    `<h1>Repositories</h1>` +
    (rows.length === 0
      ? `<p class="muted">No repositories are connected yet. Install the App on one to
start.</p>`
      : table(
          ['repository', 'account', 'connected', 'runs', 'onboarding'],
          rows.map(({ installation, hasRecipe, runs }) => [
            `<a href="/runs?repo=${urlPath(installation.repo)}">${cell(installation.repo)}</a>`,
            cell(installation.account),
            cell(installation.connectedAt),
            String(runs),
            hasRecipe
              ? `<span class="pass">recipe approved</span>`
              : `<b class="fail">not onboarded yet</b> — ` +
                `<a href="/repos/${urlPath(installation.repo)}/onboard">draft a recipe</a>`,
          ]),
        ));
  return layout('Repositories', body);
}

/**
 * A skeleton that is valid JSON, because the alternative is a trap.
 *
 * The obvious skeleton is a commented one, and JSON has no comments: a reader who fills in
 * the fields and submits gets `parseRecipe`'s refusal for a syntax error they were handed,
 * on the one screen where their first act is to be told they got it wrong. So the guidance
 * lives in the prose beside the box and the box holds something that parses.
 *
 * Empty strings rather than sample commands, and that is the load-bearing half. `parseRecipe`
 * reads `''` as absent, so a skeleton submitted unchanged stores a recipe that runs nothing —
 * whereas a plausible-looking `npm install` placeholder is a command this engine would then
 * execute verbatim against someone's repository because it was pre-typed for them.
 */
const SKELETON = JSON.stringify(
  { install: '', migrate: '', seed: '', services: [], test: '' },
  null,
  2,
);

/**
 * The approval screen (M6b) — the only write in the whole dashboard.
 *
 * Everything else here renders a log that already exists. This stores something, and what it
 * stores is a list of commands the engine will execute verbatim in a sandbox with a package
 * registry reachable. Nothing sandboxes those commands from that sandbox. ADR-0013 does not
 * claim otherwise and neither does this page: the recipe is testimony, drafted by an agent
 * and approved by a human, and **the person approving is the control**. `cli.ts recipe
 * approve` says it in those words to an operator; a browser form that says less to a
 * stranger would be the same decision with the warning removed.
 *
 * There is no field for environment variables, deliberately, and the page says so. M6e blocks
 * that on a security decision and an ADR that do not exist yet — an untrusted agent, partly
 * prompted by text a stranger wrote, holding real credentials, with egress, falsifies the
 * README's "nothing worth stealing lives there", which is the justification the rest of the
 * architecture rests on. A form is the easiest half of that problem and shipping it first
 * would settle the question by accident.
 *
 * `draft` is the other half of ADR-0013's flow (M6b): an agent explored the repository
 * unattended and proposed a starting point, stored in `recipe_drafts` and never in
 * `recipes` itself. It only pre-fills the box — `current` still wins outright when both
 * exist, because an approved recipe is the one actually in force and a draft beside it
 * would be a stale second opinion nobody asked for. Showing it changes what the box
 * contains; it changes nothing about who is the control.
 */
/**
 * What the proving run found (8f), rendered for the human who approved the recipe.
 *
 * Defensive about every field, because `proof` is stored as opaque JSON and read
 * back the same way: a proof written by an older engine has to render as what it is
 * rather than throw on a field that did not exist yet. Everything is escaped — the
 * caveats quote the recipe's own commands and a container's output.
 */
function proofBlock(proof: unknown): string {
  if (proof === null || typeof proof !== 'object') {
    return `<div class="panel"><h2>Not proved yet</h2>
<p class="muted">Approving a recipe starts a proving run: it builds this repository's
environment and runs the project's own test command in the sealed container that judges
a fix. Reload in a minute.</p></div>`;
  }
  const it = proof as {
    state?: unknown;
    commit?: unknown;
    environment?: { built?: unknown; failed?: unknown };
    suite?: { command?: unknown; exitCode?: unknown; failed?: unknown };
    caveats?: unknown;
    unproved?: unknown;
    provedAt?: unknown;
  };
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const headline =
    it.state === 'ready'
      ? '<b class="ok">Ready.</b> The environment built and the project’s own tests pass in the container that judges a fix.'
      : it.state === 'blocked'
        ? '<b class="fail">Blocked.</b> This repository’s environment did not build, so no run here can reproduce anything.'
        : '<b>Ready, with caveats.</b> The environment built. What follows is what a run here will and will not be able to say.';

  const suite =
    it.suite === undefined || it.suite === null
      ? ''
      : `<p>The project’s own test command, run in the sealed container: <code>${escapeHtml(
          String(it.suite.command ?? '',
        ))}</code> — ${
          typeof it.suite.exitCode === 'number'
            ? `exit ${escapeHtml(String(it.suite.exitCode))}`
            : `could not be run (${escapeHtml(String(it.suite.failed ?? 'no reason recorded'))})`
        }.</p>`;

  return `<div class="panel">
<h2>What onboarding proved</h2>
<p>${headline}</p>
${it.environment && it.environment.built === false ? `<p class="fail">${escapeHtml(String(it.environment.failed ?? ''))}</p>` : ''}
${suite}
${
  list(it.caveats).length === 0
    ? ''
    : `<p>Caveats:</p><ul>${list(it.caveats).map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>`
}
${
  list(it.unproved).length === 0
    ? ''
    : `<p class="muted small">Not checked by this engine at all:</p><ul class="muted small">${list(it.unproved)
        .map((c) => `<li>${escapeHtml(c)}</li>`)
        .join('')}</ul>`
}
<p class="muted small">Proved at ${escapeHtml(String(it.provedAt ?? 'an unrecorded time'))}${
    it.commit ? `, on <code>${escapeHtml(String(it.commit).slice(0, 12))}</code>` : ''
  }. Approving a new recipe clears this, because a proof is about the commands it ran.</p>
</div>`;
}

export function onboardPage(
  repo: string,
  current: Recipe | null,
  draft?: unknown,
  error?: string,
  proof?: unknown,
): string {
  const action = `/repos/${urlPath(repo)}/onboard`;

  // What fills the box, in priority order. An approved recipe always wins — it is the
  // one actually in force, and `draft` is stale the moment one exists. Failing that, an
  // unreviewed draft is still worth more than a blank box, PROVIDED it can be printed at
  // all: `draft` arrived as `unknown` off an agent's own words, never through
  // `parseRecipe`, so stringifying it can throw and a draft that cannot even be
  // displayed is worth exactly as much as no draft.
  let prefill = SKELETON;
  let isDraft = false;
  if (current) {
    prefill = JSON.stringify(current, null, 2);
  } else if (draft !== undefined) {
    try {
      prefill = JSON.stringify(draft, null, 2);
      isDraft = true;
    } catch {
      prefill = SKELETON;
    }
  }

  const body =
    `<h1>Onboard ${escapeHtml(repo)}</h1>
<p class="hero">Every repository boots differently and nothing in a repository reliably says
how, so this is asked once and replayed forever. It is stored on our side, keyed by
repository — never as a pull request against your code.</p>` +
    // Only with a recipe in force: there is nothing to prove about a proposal, and
    // proving happens at approval for exactly that reason (8f).
    (current ? proofBlock(proof ?? null) : '') +
    (error
      ? // The refusal is about the document in the box, and the sentence says so first.
        // `parseRecipe` validates shape and nothing else; letting its message arrive bare
        // reads as this system finding something wrong with the project, which is the one
        // presentation ADR-0007's amendment forbids — and here it would not even be true.
        `<div class="warning">
<h2>This recipe was not stored.</h2>
<p>Nothing is wrong with your project. The document below did not validate:</p>
<p><code>${escapeHtml(error)}</code></p>
<p>Correct it and approve again. Nothing was saved, and no run has been started.</p>
</div>`
      : '') +
    (isDraft
      ? // A DIFFERENT concern from the box below: that one states what approving means for
        // any recipe, hand-typed or not. This one says why the box is not empty — nobody
        // read what is in it yet, and "an agent wrote it" is not "a human checked it".
        `<div class="warning">
<h2>This box is pre-filled by an agent, not by a person.</h2>
<p>It explored this repository and proposed what follows — nobody here has reviewed it.
Treat it as a first draft, not a recommendation: check every command, every port and
every service name against what you actually know about this project before you approve
anything below.</p>
</div>`
      : '') +
    `<div class="warning refusal">
<h2>Read this before you approve.</h2>
<p>Every run against this repository will execute these commands <b>verbatim</b>, in the agent
sandbox, with a package registry reachable. Nothing sandboxes them from that sandbox —
<b>you are the control</b>.</p>
<p>An agent drafted this. It is testimony, not a finding: we validate its shape and nothing
about what it does. A service answering its healthcheck is the only thing here the engine
will ever treat as evidence.</p>
</div>
<form method="post" action="${action}">
<p class="small muted">JSON. <code>install</code>, <code>migrate</code>, <code>seed</code> and
<code>test</code> are single commands and each may be left empty; <code>services</code> is a
list of long-lived processes, each with a lowercase <code>name</code>, a
<code>command</code> that stays in the foreground, a <code>port</code>, and optionally a
<code>healthcheck</code> URL the engine polls until it answers. <code>test</code> is your
project's own suite — it is the regression arm, not the reproduction, which the agent
writes.</p>
<textarea name="recipe" rows="20" spellcheck="false" aria-label="recipe">${escapeHtml(prefill)}</textarea>
<button type="submit">${current ? 'Approve this recipe' : 'Approve and store'}</button>
</form>
<h2>Environment variables are not supported yet</h2>
<p>That is a decision, not an omission. Your project almost certainly needs them, and there is
no field for them here because putting them in would break the claim the rest of this system
rests on: the agent sandbox is affordable only because nothing worth stealing lives in it. The
agent is untrusted by construction, its prompt contains text whoever filed the issue wrote,
and it has network egress. Real credentials in there make all three of those facts expensive
at once.</p>
<p>The fix is to pre-warm dependencies into the agent image so a recipe needs no registry at
all, and only then is a value in that container defensible. Until that exists, recipes that
require secrets to boot are recipes this system will report honestly that it could not
run — which is an <code>errored</code> run, never a finding about your bug.</p>`;
  return layout(`Onboard ${repo}`, body);
}

const TIER_MEANING: Record<number, string> = {
  1: 'reproduced by a failing test whose independence is established',
  2: "reproduced, but the reproduction's independence is unverified",
  3: 'not reproduced — no fix was attempted',
};

/**
 * Captions for verdicts the fold already reached, never a re-derivation of them.
 *
 * `regressionOf` in `fold.ts` decides which of the four a run is in, and `confidence.ts`
 * writes the full sentence as a scored ground. This map exists so a table cell can be four
 * words instead of forty, and it must never grow a fifth entry the fold cannot produce.
 */
const REGRESSION_LABEL: Record<RunState['regression'], string> = {
  clean: 'suite clean',
  broken: 'suite BROKEN by the fix',
  already_red: 'suite already red on base',
  unmeasured: 'suite unmeasured',
};

/**
 * The machines paired to a repository, and the one screen that shows a secret (9c).
 *
 * `minted` is present exactly once, on the response to the form that created it. There
 * is nowhere to look it up afterwards and the page says so — the row stores a hash, so
 * "show it again" is not a feature we declined to build, it is a thing that cannot be
 * done. A page that implied otherwise would teach people not to copy it.
 */
export function runnersPage(
  repo: string,
  runners: { id: string; name: string; pairedAt: string; lastSeen: string | null; revokedAt: string | null }[],
  minted?: { token: string; name: string },
): string {
  const when = (value: string | null) => (value === null ? '—' : escapeHtml(value.replace('T', ' ').slice(0, 19)));
  const body =
    `<h1>Runners for ${escapeHtml(repo)}</h1>
<p class="hero">A runner is a machine of yours that takes work from here and runs it. It needs Docker
and a model key; it never receives an inbound connection, so there is no tunnel to keep alive and
nothing to expose. It holds no GitHub credential — it asks for a token per run, and this service
mints one.</p>` +
    (minted
      ? `<div class="panel">
<h2>Pair <code>${escapeHtml(minted.name)}</code> — this token is shown once</h2>
<p>Run this on the machine that will do the work:</p>
<pre class="scroll"><code>ENGINE_PLANE_URL=&lt;this service&gt; \
ENGINE_RUNNER_TOKEN=${escapeHtml(minted.token)} \
npx tf-runner</code></pre>
<p class="muted small">We store a hash of it, not the token, so it cannot be shown again — pair a new
runner if you lose it, and revoke the old one below.</p>
</div>`
      : '') +
    `<h2>Paired machines</h2>` +
    (runners.length === 0
      ? `<p class="muted">None yet. Nothing will run until one is paired.</p>`
      : `<div class="scroll"><table>
<tr><th>name</th><th>paired</th><th>last seen</th><th></th></tr>
${runners
  .map(
    (runner) => `<tr>
<td>${escapeHtml(runner.name)}${runner.revokedAt ? ' <b class="fail">revoked</b>' : ''}</td>
<td>${when(runner.pairedAt)}</td>
<td>${runner.lastSeen === null ? '<span class="muted">never</span>' : when(runner.lastSeen)}</td>
<td>${
      runner.revokedAt
        ? ''
        : `<form method="post" action="/repos/${urlPath(repo)}/runners/${escapeHtml(runner.id)}/revoke">
<button type="submit">Revoke</button></form>`
    }</td>
</tr>`,
  )
  .join('\n')}
</table></div>`) +
    `<h2>Pair another</h2>
<form method="post" action="/repos/${urlPath(repo)}/runners">
<p><input name="name" placeholder="the laptop under the desk" required></p>
<p><button type="submit">Create a runner token</button></p>
</form>
<p class="muted small">Revoking is immediate and keeps the row: whatever that machine already wrote
stays in the log, and a reader asking who wrote it still gets an answer.</p>`;

  return layout(`Runners · ${repo}`, body);
}

export function runsPage(runs: RunRow[], repo?: string): string {
  const heading = repo ? `Runs · ${escapeHtml(repo)}` : 'Runs';
  const body =
    `<h1>${heading}</h1>` +
    (runs.length === 0
      ? `<p class="muted">No runs yet. Label an issue on a connected repository to start
one.</p>`
      : table(
          ['run', 'issue', 'status', 'tier', 'confidence', 'regression', 'started', 'result'],
          runs.map((run) => [
            `<a href="/runs/${encodeURIComponent(run.run_id)}"><code>${escapeHtml(
              run.run_id,
            )}</code></a>`,
            cell(`${run.repo}#${run.issue_number}`),
            cell(run.status),
            `Tier ${run.tier}`,
            // The denominator travels with the number. A bare `80` is unreadable once the
            // grounds change, which is the drift `ceiling` and `scoring` exist to stop.
            cell(`${run.confidence}/${run.ceiling}`),
            run.regression === 'broken'
              ? `<b class="fail">${cell(REGRESSION_LABEL.broken)}</b>`
              : cell(REGRESSION_LABEL[run.regression]),
            cell(run.started_at),
            run.pr_url
              ? `<a href="${escapeHtml(run.pr_url)}">pull request</a>`
              : `<span class="muted">no pull request</span>`,
          ]),
        ));
  return layout(repo ? `Runs — ${repo}` : 'Runs', body);
}

/**
 * The evidence view: the one screen this system can show that nobody else can.
 *
 * Two decisions in here are load-bearing rather than cosmetic.
 *
 * **A Tier 3 shows no change, even when the log holds one.** The gate refusing is the
 * finding (ADR-0007), and a diff rendered beside "no fix was attempted" invites a reader to
 * review a change the engine is explicitly declining to stand behind — which is the exact
 * presentation ADR-0007's amendment forbids. The withholding is therefore keyed on the
 * tier, not on `fixDiff` happening to be null: a fix series that ran and failed to hold
 * produces both a Tier 3 and a diff, and that is the case worth getting right.
 *
 * **Artifact refs render as `<code>`, not as links.** No endpoint serves blobs by ref yet.
 * A link to a 404 claims a check the reader cannot perform, and claiming a check that
 * cannot be performed is the failure this whole project exists to refuse. The ref itself is
 * still the thing a reviewer needs — it is what `cli.ts` takes to print the bytes.
 */
export function evidencePage(input: {
  row: RunRow;
  state: RunState;
  score: Confidence;
  usage: { phase: string; turns: number; input_tokens: number; output_tokens: number }[];
}): string {
  const { row, state, score, usage } = input;
  const refused = score.tier === 3;
  // The credited attempt, taken from the fold and never re-derived — a second definition of
  // "which attempt" is free to disagree with the first, and in this codebase it did.
  const attempt = state.reproducedAttempt;
  const repro =
    state.registrations.filter((r) => r.attempt === attempt).at(-1) ?? state.registeredRepro;

  const sections: string[] = [];

  sections.push(
    `<h1>${escapeHtml(row.repo)}#${row.issue_number}</h1>
<p class="muted small"><code>${escapeHtml(row.run_id)}</code> · started ${escapeHtml(
      row.started_at,
    )}${row.ended_at ? ` · ended ${escapeHtml(row.ended_at)}` : ' · still running'}</p>
<div class="strip">
<span class="chip"><b>status</b> ${escapeHtml(row.status)}</span>
<span class="chip"><b>Tier ${row.tier}</b> ${escapeHtml(TIER_MEANING[row.tier] ?? 'unknown')}</span>
<span class="chip"><b>confidence</b> ${row.confidence}/${row.ceiling} (scoring v${row.scoring})</span>
<span class="chip"><b>${escapeHtml(REGRESSION_LABEL[state.regression])}</b></span>
${
  row.pr_url
    ? `<span class="chip"><a href="${escapeHtml(row.pr_url)}">pull request</a></span>`
    : ''
}
</div>`,
  );

  // BEFORE the evidence, before the score, before anything a reader might stop at. A fix
  // that breaks the project's own suite is the one thing nobody should have to scroll for,
  // and `report.ts` gives it the same position in the pull request for the same reason.
  if (state.regression === 'broken') {
    const broke = state.suiteRuns.filter((r) => r.phase === 'fix' && r.attempt === attempt).at(-1);
    sections.push(
      `<div class="warning">
<h2>This fix breaks the project's own test suite.</h2>
<p><code>${escapeHtml(broke?.command ?? 'the suite')}</code> passed on the base commit and
exits ${broke ? broke.exit_code : 'non-zero'} on this one.</p>
<p>The reproduction below is genuine and the evidence for it holds. What does not hold is
that this change is safe to merge as it stands.${
        broke ? ` Output: <code>${escapeHtml(broke.stdout_hash)}</code>` : ''
      }</p>
</div>`,
    );
  }

  if (refused) {
    sections.push(
      `<div class="warning refusal">
<h2>No fix was attempted.</h2>
<p>The reproduce-first gate held: ${escapeHtml(
        score.grounds[0]?.claim ?? 'the run did not reproduce the reported bug',
      )}.</p>
<p>This is the deliverable, not a failure to produce one. A fix for a bug that was never
shown on the base commit is a guess, and no change is shown here because none is being
offered. The runs below are what was executed to reach that conclusion — the same evidence
a reproduced run is judged on, arriving at the opposite answer.</p>
</div>`,
    );
  }

  sections.push(
    `<h2>The reproduction arm</h2>` +
      (repro
        ? `<p class="small">Registered command: <code>${escapeHtml(repro.command)}</code></p>` +
          (Object.keys(repro.files).length > 0
            ? `<ul class="plain small">${Object.entries(repro.files)
                .map(
                  ([path, ref]) =>
                    `<li><code>${escapeHtml(path)}</code> — <code>${escapeHtml(ref)}</code>${
                      repro.applied.includes(path)
                        ? ' <span class="muted">written by the engine over both checkouts</span>'
                        : ' <span class="muted">a committed path, hashed rather than applied</span>'
                    }</li>`,
                )
                .join('')}</ul>`
            : `<p class="small muted">The registration named no files, so there was nothing to
anchor it to.</p>`)
        : `<p class="muted">No reproduction was ever registered.</p>`) +
      (state.testRuns.length > 0
        ? table(
            ['phase', 'run', 'commit', 'exit', 'symptom in output', 'output'],
            state.testRuns.map((run) => [
              cell(run.phase),
              String(run.repeat ?? 0),
              codeCell(run.commit_sha.slice(0, 12)),
              run.exit_code === 0
                ? `<span class="pass">${run.exit_code}</span>`
                : `<span class="fail">${run.exit_code}${
                    run.signal ? ` (${cell(run.signal)})` : ''
                  }</span>`,
              run.symptom_matched === undefined
                ? `<span class="muted">not observed</span>`
                : run.symptom_matched
                  ? 'yes'
                  : 'no',
              codeCell(run.stdout_hash),
            ]),
          ) +
          `<p class="small muted">Each row is a command the engine executed itself, in a
container of its own, with no network and no agent in it. The symptom column is the anchor
in both directions: present on base ties the failure to the report, and gone from every fix
run is what makes that tie mean something.</p>`
        : `<p class="muted">No phase run was ever recorded.</p>`),
  );

  sections.push(
    `<h2>The regression arm</h2>
<p>${escapeHtml(REGRESSION_LABEL[state.regression])} — the project's own test command,
executed by the engine on both commits.</p>` +
      (state.suiteRuns.length > 0
        ? table(
            ['phase', 'command', 'exit', 'output'],
            state.suiteRuns.map((run) => [
              cell(run.phase),
              codeCell(run.command),
              run.exit_code === 0
                ? `<span class="pass">${run.exit_code}</span>`
                : `<span class="fail">${run.exit_code}${
                    run.signal ? ` (${cell(run.signal)})` : ''
                  }</span>`,
              codeCell(run.stdout_hash),
            ]),
          )
        : `<p class="small muted">The suite was not run on both commits, so no regression
check stands behind this run. Not knowing is not the same as knowing it is fine.</p>`),
  );

  if (!refused && state.fixDiff) {
    sections.push(
      `<h2>The diff</h2>
<ul class="plain small">${state.fixDiff.changed_files
        .map((file) => `<li><code>${escapeHtml(file)}</code></li>`)
        .join('')}</ul>
<p class="small">Full diff: <code>${escapeHtml(state.fixDiff.diff_hash)}</code></p>`,
    );
  }

  sections.push(
    `<h2>Confidence ${score.score}/${score.ceiling}</h2>
<p class="small muted">Every point below names the bytes a reviewer would open to check it.
A point that cannot be checked does not belong here (ADR-0004), which is why this scale
stops short of 100 and says what the missing points were for.</p>
<ul class="grounds">${score.grounds
      .map(
        (ground) =>
          `<li><span class="points">+${ground.points}</span> ${escapeHtml(ground.claim)}` +
          (ground.evidence.length > 0
            ? `<div class="refs small">${ground.evidence
                .map((ref) => `<code>${escapeHtml(ref)}</code>`)
                .join('')}</div>`
            : `<div class="refs small muted">no artifact — the log holds no bytes for this
claim</div>`) +
          `</li>`,
      )
      .join('')}</ul>
<h2>Not measured</h2>
<ul class="plain small">${score.unmeasured
      .map((gap) => `<li>${escapeHtml(gap)}</li>`)
      .join('')}</ul>`,
  );

  if (state.aborts.length > 0) {
    sections.push(
      `<h2>Where observation stopped</h2>` +
        table(
          ['attempt', 'phase', 'cause', 'reason'],
          state.aborts.map((abort) => [
            String(abort.attempt),
            cell(abort.phase),
            cell(abort.cause ?? 'unstated'),
            `<span class="wrap">${cell(abort.reason)}</span>`,
          ]),
        ),
    );
  }

  // TESTIMONY, and the heading says so before the count does (ADR-0006). The transcript is
  // deliberately kept out of `artifactHashes` in the fold so a consumer cannot reach it as
  // evidence by accident; presenting it under any other word here would undo that in the
  // one place a human actually reads.
  sections.push(
    `<h2>Testimony</h2>
<p>The agent's transcript: <b>${state.transcript.length} message${
      state.transcript.length === 1 ? '' : 's'
    }</b>, stored and displayable, and an input to no verdict above. It is what the agent
said, not what the engine saw.</p>` +
      (state.transcript.length > 0
        ? table(
            ['n', 'claimed type', 'bytes', 'raw'],
            state.transcript.map((message) => [
              String(message.n),
              cell(message.claimed_type ?? 'unstated'),
              String(message.bytes),
              codeCell(message.raw_hash),
            ]),
          )
        : ''),
  );

  if (usage.length > 0) {
    sections.push(
      `<h2>What this run cost</h2>` +
        table(
          ['phase', 'turns', 'input tokens', 'output tokens'],
          usage.map((entry) => [
            cell(entry.phase),
            String(entry.turns),
            String(entry.input_tokens),
            String(entry.output_tokens),
          ]),
        ) +
        `<p class="small muted">Recorded beside the log rather than inside it: an event
class describing our own spending would put a fact about us into a log about your bug
(ADR-0006).</p>`,
    );
  }

  return layout(`${row.repo}#${row.issue_number} — evidence`, sections.join('\n'));
}
