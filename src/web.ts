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
/** The only navigation this product has. One place, so a page cannot invent a third tab. */
const NAV: [string, string][] = [
  ['/repos', 'Repositories'],
  ['/runs', 'Runs'],
];

const STYLE = `
/*
 * A FORENSIC REGISTER, not a dashboard, and the typography carries the argument.
 *
 * This product's one claim is evidence over testimony (ADR-0006): a verdict is a command
 * it executed, recorded in an append-only log, and an agent's account of itself is stored
 * and believed about nothing. So the type splits the same way the domain does — a serif
 * for what PEOPLE wrote (headings, prose, explanation) and a monospace for every machine
 * fact (ids, commands, exit codes, digests, timestamps). You can tell at a glance which
 * you are reading, which is the distinction the whole engine exists to hold.
 *
 * Paper and ink, warm rather than blue-black, because everything else in this category is
 * blue-black. Colour is rationed: hairlines and neutrals carry structure, and saturation
 * is spent only on a verdict.
 */
:root{
  color-scheme:light dark;
  --paper:#faf9f6; --ink:#17161a; --muted:#6d6b63; --rule:#e4e1d9; --rule-strong:#d3cfc4;
  --panel:#f3f1eb; --code:#eeebe3; --link:#1f4b8f;
  --ok:#2c6e49; --bad:#9b2c2c;
  --warn-bg:#fdf5ed; --warn-line:#b4553a; --warn-fg:#7c3a24;
  --serif:"Newsreader",ui-serif,Georgia,Cambria,"Times New Roman",serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){:root{
  --paper:#121110; --ink:#eceae3; --muted:#96918a; --rule:#292722; --rule-strong:#3a372f;
  --panel:#1a1815; --code:#1e1c18; --link:#b3ccff;
  --ok:#7fc79b; --bad:#e89b94;
  --warn-bg:#231a14; --warn-line:#c4693f; --warn-fg:#f0c3a8;
}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);
  font:400 1.0625rem/1.62 var(--serif);
  font-optical-sizing:auto;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
::selection{background:var(--ink);color:var(--paper)}

/* Machine facts. Tabular figures so a column of numbers reads as a column. */
code,pre,kbd,samp,th,td,input,textarea,button,nav,.mono,.chip,.points{
  font-family:var(--mono);font-variant-numeric:tabular-nums}
code{background:var(--code);padding:.1em .34em;border-radius:3px;font-size:.855em;
  overflow-wrap:anywhere;border:1px solid var(--rule)}
/* A digest or a token has no word boundaries to break on; prose does. */
code.hash{word-break:break-all}
/* In a table an id is already in a mono column — a second box around it is noise. */
td a code,td code{background:none;border:0;padding:0}
pre{margin:0;font-size:.8125rem;line-height:1.6}
pre code{background:none;border:0;padding:0;word-break:normal}

a{color:var(--link);text-decoration-thickness:1px;text-underline-offset:.18em}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:2px solid var(--link);outline-offset:2px;border-radius:2px}

/* ---- chrome ---- */
header.top{display:flex;gap:2rem;align-items:baseline;flex-wrap:wrap;
  padding:1.05rem 2rem;border-bottom:1px solid var(--rule);background:var(--paper);
  position:sticky;top:0;z-index:5;backdrop-filter:saturate(140%) blur(6px)}
header.top .brand{font-family:var(--serif);font-size:1.15rem;font-weight:500;
  letter-spacing:-.01em;text-decoration:none;color:var(--ink)}
header.top nav{display:flex;gap:1.5rem;font-size:.7rem;text-transform:uppercase;
  letter-spacing:.14em}
header.top nav a{color:var(--muted);text-decoration:none;padding-bottom:.15rem;
  border-bottom:1px solid transparent}
header.top nav a:hover{color:var(--ink);border-bottom-color:var(--rule-strong)}
header.top nav a[aria-current=page]{color:var(--ink);border-bottom-color:var(--ink)}
/* The way out sits at the far end, away from the way further in. */
header.top .out{margin-left:auto;display:flex;gap:.85rem;align-items:baseline}
header.top .who{font-family:var(--mono);font-size:.7rem;text-transform:uppercase;
  letter-spacing:.12em;color:var(--muted)}
header.top .out button{margin-top:0;padding:.32rem .8rem;font-size:.66rem;letter-spacing:.12em}
main{max-width:74rem;margin:0 auto;padding:3rem 2rem 6rem}

/* ---- type ---- */
h1{font-size:clamp(1.9rem,1.4rem + 1.6vw,2.6rem);font-weight:400;letter-spacing:-.021em;
  line-height:1.12;margin:0 0 .6rem}
/* Section labels, printed-register style. The HTML text is untouched — this is CSS. */
h2{font-family:var(--mono);font-size:.7rem;font-weight:500;text-transform:uppercase;
  letter-spacing:.15em;color:var(--muted);margin:3rem 0 .9rem;padding-bottom:.55rem;
  border-bottom:1px solid var(--rule)}
h2:first-child{margin-top:0}
p{margin:.65rem 0;max-width:46rem}
.hero{font-size:1.2rem;line-height:1.58;max-width:44rem;color:var(--ink)}
.muted{color:var(--muted)}
.small{font-size:.855rem;line-height:1.55}
p.muted.small{font-size:.9rem;line-height:1.6;max-width:44rem}
ul.plain{padding-left:1.15rem;max-width:46rem}
ul.plain li{margin:.4rem 0}

/* ---- tables: a register, hairlines only, no stripes ---- */
.scroll{overflow-x:auto;max-width:100%;
  /* A fade at the edge, so a cut-off column looks cut off rather than finished. */
  mask-image:linear-gradient(to right,#000 calc(100% - 2.5rem),transparent)}
.scroll:hover{mask-image:none}
table{border-collapse:collapse;width:100%;font-size:.8125rem}
th,td{text-align:left;padding:.7rem .85rem;vertical-align:baseline;white-space:nowrap}
th{font-size:.66rem;font-weight:500;text-transform:uppercase;letter-spacing:.12em;
  color:var(--muted);border-bottom:1px solid var(--rule-strong);
  position:sticky;top:0;background:var(--paper)}
td{border-bottom:1px solid var(--rule)}
tbody tr:hover td{background:var(--panel)}
td:first-child,th:first-child{padding-left:0}
td:last-child,th:last-child{padding-right:0}
td.wrap{white-space:normal;font-family:var(--serif);font-size:.95rem;max-width:32rem}
th.num,td.num{text-align:right}

/* ---- verdict ---- */
.pass{color:var(--ok);font-weight:500}
.fail{color:var(--bad);font-weight:500}
b.fail,b.pass{font-weight:600}

/* ---- containers ---- */
.panel{background:var(--panel);border:1px solid var(--rule);border-radius:6px;
  padding:1.35rem 1.5rem;margin:1.35rem 0}
.panel h2{margin-top:0}
.warning{background:var(--warn-bg);border:1px solid var(--warn-line);border-left-width:3px;
  border-radius:6px;padding:1.35rem 1.5rem;margin:1.35rem 0;color:var(--warn-fg)}
.warning h2,.refusal h2{border:0;margin:0 0 .5rem;padding:0;color:inherit;
  font-family:var(--serif);font-size:1.15rem;font-weight:500;text-transform:none;
  letter-spacing:-.01em}
.warning a{color:inherit;text-decoration-thickness:2px}
.refusal{border-left-width:3px}

/* ---- evidence list ---- */
.grounds{list-style:none;padding:0;margin:.5rem 0}
.grounds li{padding:.85rem 0;border-bottom:1px solid var(--rule);display:flex;gap:1rem;
  align-items:baseline;flex-wrap:wrap}
.grounds li:last-child{border-bottom:0}
.points{display:inline-block;min-width:3.4rem;font-weight:600;font-size:.8125rem;
  color:var(--muted);flex:none}
.refs{margin-top:.35rem;flex-basis:100%}
.refs code{margin-right:.35rem;font-size:.72rem}

/* ---- chips: a metadata strip, not buttons ---- */
.strip{display:flex;flex-wrap:wrap;gap:0;margin:1rem 0 0;
  border-top:1px solid var(--rule);border-bottom:1px solid var(--rule)}
.chip{padding:.6rem 1.1rem .6rem 0;margin-right:1.1rem;font-size:.72rem;
  text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}
.chip b{font-weight:600;text-transform:none;letter-spacing:0;color:var(--ink);
  font-size:.8125rem}

/* ---- actions ---- */
.calls{display:flex;gap:.85rem;align-items:center;flex-wrap:wrap;margin:2rem 0}
.cta{display:inline-block;padding:.72rem 1.5rem;border-radius:4px;background:var(--ink);
  color:var(--paper);text-decoration:none;font-family:var(--mono);font-size:.775rem;
  font-weight:500;text-transform:uppercase;letter-spacing:.1em;
  transition:transform .12s ease,opacity .12s ease}
.cta:hover{opacity:.88;transform:translateY(-1px)}
.cta.secondary{background:transparent;color:var(--ink);
  box-shadow:inset 0 0 0 1px var(--rule-strong)}
.calls .cta{margin:0}
button{margin-top:1rem;padding:.68rem 1.4rem;border-radius:4px;border:0;cursor:pointer;
  background:var(--ink);color:var(--paper);font-size:.775rem;font-weight:500;
  text-transform:uppercase;letter-spacing:.1em}
button:hover{opacity:.88}
button.quiet{background:transparent;color:var(--muted);
  box-shadow:inset 0 0 0 1px var(--rule-strong);margin-top:0}
button.quiet:hover{color:var(--bad);box-shadow:inset 0 0 0 1px var(--bad);opacity:1}

/* ---- forms ---- */
textarea{display:block;width:100%;background:var(--code);color:var(--ink);
  border:1px solid var(--rule-strong);border-radius:6px;padding:1rem;
  font-size:.8125rem;line-height:1.6;resize:vertical}
textarea:focus{border-color:var(--link)}
input[type=text],input:not([type]){background:var(--code);color:var(--ink);
  border:1px solid var(--rule-strong);border-radius:4px;padding:.6rem .75rem;
  font-size:.8125rem;min-width:18rem;max-width:100%}

/* ---- the fold over a long register ---- */
details{margin:.5rem 0 0}
summary{font-family:var(--mono);font-size:.72rem;letter-spacing:.04em;color:var(--muted);
  cursor:pointer;padding:.7rem 0;border-bottom:1px solid var(--rule);list-style:none;
  display:flex;gap:.6rem;align-items:baseline}
summary::-webkit-details-marker{display:none}
summary::before{content:"+";font-weight:600;color:var(--ink)}
details[open] summary::before{content:"\\2212"}
summary:hover{color:var(--ink)}
details[open] summary{margin-bottom:.5rem}

/* ---- an empty state that looks deliberate ---- */
.nothing{border:1px dashed var(--rule-strong);border-radius:6px;padding:2.5rem 1.75rem;
  margin:1.25rem 0;text-align:left;background:transparent}
.nothing p{margin:0;max-width:40rem;color:var(--muted)}
.nothing p + p{margin-top:.7rem}
.in-force{font-family:var(--mono);font-size:.78rem;letter-spacing:.02em;color:var(--muted);
  margin:1.35rem 0 0;padding:.7rem 0 0;border-top:1px solid var(--rule)}

@media (max-width:40rem){
  header.top{padding:.9rem 1.15rem;gap:1rem}
  main{padding:2rem 1.15rem 4rem}
  .strip{display:block}
}

/* ---- the landing page, which has a different job from every other page ----
 * Every other page here is an instrument: dense, tabular, for somebody already inside.
 * This one has to persuade somebody outside, and looking like a README is its own kind of
 * claim — that nobody cared. So it gets the furniture a product page has: a nav with a
 * way in, a hero with room around it, sections with rhythm, and a footer.
 *
 * What it does NOT get is invented social proof. No logo wall, no "trusted by", no user
 * count. This product's entire argument is that a claim without evidence is worth
 * nothing, and a fabricated testimonial on the front of it would be the loudest possible
 * admission that we do not believe that. What stands in for proof is a REAL verdict,
 * rendered from the same code that renders the real ones.
 */
.eyebrow{font-family:var(--mono);font-size:.68rem;text-transform:uppercase;
  letter-spacing:.2em;color:var(--muted);margin:0 0 1.4rem}
.landing main{max-width:none;padding:0}
.hero-band{padding:5.5rem 2rem 4.5rem;border-bottom:1px solid var(--rule);
  /* A faint drafting grid. Atmosphere from geometry rather than from an image, so there
   * is nothing to load and nothing to go stale. */
  background-image:linear-gradient(var(--rule) 1px,transparent 1px),
    linear-gradient(90deg,var(--rule) 1px,transparent 1px);
  background-size:100% 5.5rem,5.5rem 100%;background-position:-1px -1px}
.hero-band > div,.band > div{max-width:74rem;margin:0 auto}
h1.display{font-size:clamp(2.5rem,1.6rem + 3.6vw,4.6rem);line-height:1.03;
  letter-spacing:-.028em;max-width:34ch;margin:0 0 1.4rem}
.lede{font-size:clamp(1.1rem,1rem + .4vw,1.35rem);line-height:1.55;max-width:64ch;
  color:var(--muted)}
.lede b{color:var(--ink);font-weight:600}
.band{padding:4.5rem 2rem;border-bottom:1px solid var(--rule)}
.band:last-of-type{border-bottom:0}
.band-head{font-family:var(--mono);font-size:.68rem;text-transform:uppercase;
  letter-spacing:.2em;color:var(--muted);margin:0 0 2rem}

/* The specimen: an actual verdict, not a picture of one. */
.specimen{border:1px solid var(--rule-strong);border-radius:8px;overflow:hidden;
  background:var(--panel);max-width:52rem}
.specimen-bar{display:flex;gap:.9rem;align-items:baseline;padding:.8rem 1.2rem;
  border-bottom:1px solid var(--rule);font-family:var(--mono);font-size:.7rem;
  text-transform:uppercase;letter-spacing:.12em;color:var(--muted);background:var(--paper)}
.specimen-body{padding:1.5rem 1.2rem}
.verdict{font-family:var(--mono);font-size:.8125rem;line-height:2}
.verdict .n{color:var(--muted);display:inline-block;min-width:3.6rem}

/* Numbered steps, and the numbers are the point: the order is the argument. */
.steps{display:grid;gap:0;counter-reset:step;max-width:56rem}
.step{display:grid;grid-template-columns:3.2rem 1fr;gap:1.2rem;padding:1.5rem 0;
  border-top:1px solid var(--rule)}
.step:last-child{border-bottom:1px solid var(--rule)}
.step::before{counter-increment:step;content:counter(step,decimal-leading-zero);
  font-family:var(--mono);font-size:.75rem;color:var(--muted);letter-spacing:.08em}
.step h3{margin:0 0 .35rem;font-size:1.15rem;font-weight:500;letter-spacing:-.01em}
.step p{margin:0;color:var(--muted);font-size:1rem}

.cards{display:grid;gap:1px;background:var(--rule);
  grid-template-columns:repeat(auto-fit,minmax(17rem,1fr));border:1px solid var(--rule)}
.card{background:var(--paper);padding:1.6rem 1.5rem}
.card h3{margin:0 0 .5rem;font-size:1.1rem;font-weight:500;letter-spacing:-.01em}
.card p{margin:0;color:var(--muted);font-size:.97rem}

footer.foot{padding:2.5rem 2rem 4rem;border-top:1px solid var(--rule)}
footer.foot > div{max-width:74rem;margin:0 auto;display:flex;gap:1.5rem;
  flex-wrap:wrap;align-items:baseline;justify-content:space-between}
footer.foot p{margin:0;font-family:var(--mono);font-size:.72rem;color:var(--muted);
  letter-spacing:.04em;max-width:52ch}

@media (max-width:40rem){
  .hero-band{padding:3.5rem 1.15rem 3rem;background-size:100% 4rem,4rem 100%}
  .band{padding:3rem 1.15rem}
  footer.foot{padding:2rem 1.15rem 3rem}
  .step{grid-template-columns:2.4rem 1fr;gap:.8rem}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

/**
 * The document every page is, header included.
 *
 * One layout rather than a per-page shell because the header is the only navigation this
 * product has, and a page that forgets it is a dead end. `prefers-color-scheme` is handled
 * by redefining tokens, never by defining a colour only inside the media block — a value
 * that exists in one theme is a page that renders unreadable in the other.
 */
export function layout(
  title: string,
  body: string,
  options: { current?: string; shell?: 'landing'; who?: string } = {},
): string {
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
<!-- Two families, and the split is the domain's: a serif for what people wrote, a
     monospace for every machine fact. Preconnected because they are on the critical path
     for first paint, and each face names a real fallback so a blocked or slow font
     degrades to something with the same job rather than to Times at 15px. -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,300..600&family=JetBrains+Mono:wght@400;500;600&display=swap">
<style>${STYLE}</style>
</head>
<body${options.shell === 'landing' ? ' class="landing"' : ''}>
<header class="top">
<a class="brand" href="/">Test&nbsp;Framework</a>
<nav>${NAV.map(([href, label]) => {
    // `aria-current` rather than styling alone: a sighted reader gets the rule under the
    // word, a screen reader gets told which page this is, and both come from one fact.
    const here = options.current === href;
    return `<a href="${href}"${here ? ' aria-current="page"' : ''}>${label}</a>`;
  }).join('')}</nav>${
    // A signed-in surface with no way out is a surface you cannot leave on a shared
    // machine. A POST because a link that logs you out is a link anybody's page can
    // embed, and `/auth/logout` checks the origin for the same reason.
    options.who
      ? `<form class="out" method="post" action="/auth/logout">
<span class="who">${escapeHtml(options.who)}</span><button class="quiet" type="submit">Sign out</button>
</form>`
      : ''
  }
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
export function landingPage(installUrl: string, options: { signIn?: boolean } = {}): string {
  // The one page whose job is persuasion rather than instrumentation, and it has to look
  // like somebody cared — because looking like a README is itself a claim about how much
  // anyone did. What it must not do is manufacture proof: no logo wall, no invented user
  // count. A product arguing that a claim without evidence is worth nothing cannot open
  // with one. So the demo is a REAL verdict, rendered by the same code path as the real
  // ones, and the only numbers on the page are the ones the engine actually produces.
  const body =
    `<section class="hero-band"><div>
<p class="eyebrow">Event-sourced verification engine</p>
<h1 class="display">Open an issue. Get back a pull request that proves the bug existed.</h1>
<p class="lede">Not a coding agent — the model is a replaceable component. What is not
replaceable is the evidence: <b>every claim it makes is a command it executed itself</b>, in a
container of its own, recorded in an append-only log.</p>
<p class="calls"><a class="cta" href="${escapeHtml(installUrl)}">Install on GitHub</a>${
      options.signIn ? '<a class="cta secondary" href="/auth/github">Sign in</a>' : ''
    }</p>${
      options.signIn
        ? `<p class="muted small">Already installed it? GitHub sends the install button to your
existing installation’s settings, which is the right answer and not a way in — signing in is.</p>`
        : ''
    }
</div></section>

<section class="band"><div>
<p class="band-head">What comes back</p>
<div class="specimen">
<div class="specimen-bar"><span>run 7f3a91c4</span><span>acme/checkout#41</span>
<span class="pass">Tier 2</span></div>
<div class="specimen-body">
<p class="verdict">
<span class="n">+40</span> the reported symptom was reproduced on the base commit<br>
<span class="n">+30</span> a failing test the agent wrote, passing after the fix<br>
<span class="n">+20</span> your own suite ran green on both commits<br>
<span class="n">&nbsp;&nbsp;+0</span> <span class="muted">the agent said it was confident</span><br>
<span class="n">90/103</span> <b>evidence, not testimony</b>
</p>
</div>
</div>
<p class="muted small">Every line is an exit code from a container this engine started. The
agent’s own account of itself scores nothing, and is stored anyway so you can read it.</p>
</div></section>

<section class="band"><div>
<p class="band-head">How it works</p>
<div class="steps">
<div class="step"><div><h3>You label an issue</h3>
<p>A GitHub App you install on the repositories you pick. No personal access token is ever
requested.</p></div></div>
<div class="step"><div><h3>It reproduces the bug first</h3>
<p>On your base commit, in a sealed container with no network. No reproduction means no fix
attempt — you get a structured information request instead of a guess.</p></div></div>
<div class="step"><div><h3>It fixes, then proves it twice</h3>
<p>The reproduction says the reported bug is gone. Your project’s own suite, run on both
commits, says nothing else went with it.</p></div></div>
<div class="step"><div><h3>You get a pull request and the log behind it</h3>
<p>Every command, exit code and artifact, content-addressed and replayable. Nothing is ever
merged for you.</p></div></div>
</div>
</div></section>

<section class="band"><div>
<p class="band-head">The rules it will not bend</p>
<div class="cards">
<div class="card"><h3>Reproduce first, or do not fix</h3>
<p>No reproduction, no fix, no partial credit. A bug that cannot be shown is a question, and
the answer is a question back.</p></div>
<div class="card"><h3>Two arms, not one</h3>
<p>One test passing proves one test passes. Your whole suite on both commits is what says the
fix cost you nothing.</p></div>
<div class="card"><h3>Testimony is not evidence</h3>
<p>The agent’s transcript is stored and shown, and it is an input to no verdict. Exit codes
and content-addressed output are.</p></div>
<div class="card"><h3>Nothing is merged</h3>
<p>It opens a pull request. Every decision after that is yours, and the evidence is there to
make it with.</p></div>
</div>
</div></section>

<section class="band"><div>
<p class="band-head">What it costs you to find out</p>
<p>Installing grants the App access to the repositories you pick, and nothing else. The
sandbox that runs an agent holds neither our model key nor your GitHub token — the agent loop
runs outside it and ships tool calls in, so the container needs no network egress at all.</p>
<p>The machine that runs your code is yours. It dials out, receives no inbound connection, and
asks for a short-lived token per run.</p>
</div></section>

<footer class="foot"><div>
<p>Test Framework v2 — an event-sourced execution and verification platform.</p>
<p>Evidence over testimony. Reproduce first. Nothing merged.</p>
</div></footer>`;
  return layout('Test Framework v2', body, { shell: 'landing' });
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
/**
 * WHERE the engine runs, which changes what these pages may promise.
 *
 * `local` is `serve.ts`: one operator, containers on this machine, and installing a
 * repository starts a drafting run that fills the recipe box for them.
 *
 * `plane` is the hosted control plane, which holds no model key and runs no containers
 * by design (ADR-0011, ADR-0019) — work goes to a paired runner. Nothing drafts there
 * yet, so a page that says "draft a recipe" is offering something that will not happen.
 *
 * Explicit rather than inferred from whether login is configured. Those are two different
 * questions, and conflating them is exactly the bug the landing page had.
 */
export type Mode = 'local' | 'plane';

/**
 * What the shell around a page needs to know, as one argument rather than four.
 *
 * `mode` and `who` are both about the CHROME — what this deployment can promise, and
 * whether there is somebody to offer a way out to — not about the page's subject. Passing
 * them positionally had `onboardPage` at six parameters before this one, which is the
 * point at which a call site stops being readable.
 */
/** Spread into `layout`'s options, so an absent login stays absent rather than undefined. */
const who = (chrome: Chrome) => (chrome.who === undefined ? {} : { who: chrome.who });

export type Chrome = {
  mode?: Mode;
  /** The signed-in login. Absent means anonymous, or a local surface with no login at all. */
  who?: string;
};

export function repositoriesPage(
  rows: { installation: Installation; hasRecipe: boolean; runs: number }[],
  chrome: Chrome = {},
): string {
  // SPLIT, not sorted. An account can have hundreds of repositories connected and one
  // onboarded, and a single list buries the only row that can do anything — which is
  // exactly what happened here at 176 of 177. The onboarding column is documented above
  // as the row's most important fact, and a list that hides it is not showing it.
  const ready = rows.filter((row) => row.hasRecipe);
  const waiting = rows.filter((row) => !row.hasRecipe);
  const mode = chrome.mode ?? 'plane';
  const verb = mode === 'local' ? 'draft a recipe' : 'write a recipe';

  // NO SCRIPT, and that is a decision rather than a limitation. A client-side filter was
  // the obvious answer to a long list, and `test/web.test.ts` asserts these pages contain
  // no `<script>` at all — the strongest injection guard in the suite, because a real
  // injected tag cannot hide behind a legitimate one if there are none. `<details>` and
  // the browser's own find solve the same problem with no script and no request.
  const register = (of: typeof rows) =>
    `<div class="scroll"><table>
<thead><tr>${['repository', 'account', 'connected', 'runs', 'onboarding']
      .map((head) => `<th${head === 'runs' ? ' class="num"' : ''}>${head}</th>`)
      .join('')}</tr></thead>
<tbody>${of
      .map(
        ({ installation, hasRecipe, runs }) =>
          `<tr><td><a href="/runs?repo=${urlPath(installation.repo)}">${cell(installation.repo)}</a></td>` +
          `<td class="muted">${cell(installation.account)}</td>` +
          `<td class="muted">${when(installation.connectedAt)}</td>` +
          `<td class="num">${runs === 0 ? '<span class="muted">&mdash;</span>' : String(runs)}</td>` +
          `<td>${
            hasRecipe
              ? `<span class="pass">recipe approved</span>`
              : `<b class="fail">not onboarded yet</b> — ` +
                `<a href="/repos/${urlPath(installation.repo)}/onboard">${verb}</a>`
          }</td></tr>`,
      )
      .join('')}</tbody></table></div>`;

  const body =
    `<h1>Repositories</h1>` +
    (rows.length === 0
      ? `<div class="nothing"><p>No repositories are connected yet.</p>
<p>Install the App on one to start. It grants access to the repositories you pick and
nothing else.</p></div>`
      : `<p class="hero">${
          ready.length === 0
            ? `Nothing here can run yet — a repository needs an approved recipe before an issue
on it does anything.`
            : `${ready.length} of ${rows.length} ${ready.length === 1 ? 'repository is' : 'repositories are'}
onboarded and can take work. The rest are connected and waiting.`
        }</p>` +
        (ready.length > 0
          ? `<h2>Onboarded</h2>${register(ready)}`
          : '') +
        (waiting.length > 0
          ? `<h2>Connected, not onboarded</h2>` +
            // Collapsed when there are enough of them to bury something. Open otherwise,
            // because a fold over four rows is ceremony.
            (waiting.length > 12
              ? `<details><summary>${waiting.length} repositories &mdash; expand to onboard one, then use your
browser's find to locate it</summary>${register(waiting)}</details>`
              : register(waiting))
          : ''));
  return layout('Repositories', body, { current: '/repos', ...who(chrome) });
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

/**
 * What this repository has a value for, and whether a run would receive it (M10).
 *
 * Names, never values — there is no route that returns one. And the second sentence is
 * load-bearing rather than decorative: a secret injected into a sandbox with no route out
 * satisfies a startup check and a suite that reads `process.env`, and cannot make a live
 * third-party call. Somebody who is not told that stores a real key and files a bug about
 * a timeout.
 */
const secretsBlock = (repo: string, secrets?: { names: string[]; enabled: boolean }): string => {
  if (!secrets) return '';
  const list = secrets.names.length
    ? `<ul class="names">${secrets.names.map((name) => `<li><code>${escapeHtml(name)}</code></li>`).join('')}</ul>`
    : `<p class="muted">Nothing is stored for ${escapeHtml(repo)} yet.</p>`;
  return `<h2>Stored secrets</h2>
${list}
${
  secrets.enabled
    ? `<p>These are injected into runs on this deployment. The sandbox they land in has no route
out, so a value here satisfies a startup check and a suite that reads it — it cannot reach the
service it authenticates to, and that is the point.</p>`
    : `<p class="warning-inline"><b>Stored, and not yet injected into any run.</b> The agent
sandbox is affordable only because nothing worth stealing lives in it — the agent is untrusted
by construction, its prompt contains text whoever filed the issue wrote, and until the sandbox
is sealed it has network egress. Injection is enabled per deployment once the executor has been
shown to close that route before the agent's first turn (ADR-0017). Configuration in the
recipe's <code>env</code> is injected today; these are not.</p>`
}`;
};

export function onboardPage(
  repo: string,
  current: Recipe | null,
  draft?: unknown,
  error?: string,
  stored?: { proof?: unknown; approvedAt?: string | null } | null,
  chrome: Chrome = {},
  secrets?: { names: string[]; enabled: boolean },
): string {
  const mode = chrome.mode ?? 'plane';
  const proof = stored?.proof ?? undefined;
  const approvedAt = stored?.approvedAt ?? undefined;
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
    // Says whose words are in the box. On the plane nothing drafts, so the skeleton is a
    // skeleton and the person reading this is the author — telling them an agent wrote it
    // would be false, and leaving them waiting for a draft that is never coming is worse.
    (!current && !isDraft && mode === 'plane'
      ? `<div class="panel">
<h2>Nothing drafted this — the box is yours to fill.</h2>
<p>Drafting reads your project and proposes a recipe, and it runs where the containers run.
This service holds no model key and runs nothing itself (<a href="/">why</a>), so on a hosted
plane there is no drafting yet: write the commands that install, boot and test your project,
and approve them.</p>
<p class="muted small">Running the engine on your own machine does draft, and this page shows
that draft when there is one.</p>
</div>`
      : '') +
    // WHAT APPROVING DID, which the page could not previously say.
    //
    // Approving 303s back here and re-renders the recipe it already showed, so a click
    // that stored something and a click that changed nothing look the same. That is not a
    // cosmetic gap: the first person to use this pasted a recipe, clicked, saw an
    // identical page, and reasonably concluded the button was broken — when in fact the
    // paste had not landed and the empty recipe had been approved for real. The timestamp
    // moves on every successful write, which is the difference made visible.
    (current && approvedAt
      ? `<p class="in-force"><span class="pass">In force</span> since ${when(approvedAt)}
— this is what every run against ${escapeHtml(repo)} will execute.</p>`
      : '') +
    `<div class="warning refusal">
<h2>Read this before you approve.</h2>
<p>Every run against this repository will execute these commands <b>verbatim</b>, in the agent
sandbox, with a package registry reachable. Nothing sandboxes them from that sandbox —
<b>you are the control</b>.</p>
<p>${
      isDraft
        ? `An agent drafted this. It is testimony, not a finding: we validate its shape and
nothing about what it does.`
        : `Whoever wrote this box is the only review it has had: we validate its shape and
nothing about what it does.`
    } A service answering its healthcheck is the only thing here the engine will ever treat as
evidence.</p>
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
<h2>Environment variables: configuration here, secrets not yet</h2>
<p>A recipe carries its own configuration in an <code>env</code> field — a port, a
<code>DATABASE_URL</code> pointing at a database one of the services above starts,
<code>NODE_ENV</code>. Those are values that are worthless outside the sandbox, and every
command in the recipe runs with them.</p>
<p>A value that <em>authenticates to something outside the sandbox</em> is a different thing,
and it never goes in the recipe. Name it in <code>required</code> instead: the name is public,
the value is not, and a run that cannot find one stops before any container starts and says
which name it was missing — a <code>blocked</code> run, which is not a finding about anybody's
bug and does not pretend to be one.</p>` +
    secretsBlock(repo, secrets) +
    `<p class="small muted">Values are sealed with AES-256-GCM and bound to this repository, so
a ciphertext lifted from the database opens nowhere else. Nothing here, and no other page, can
show you one again once it is stored.</p>`;
  return layout(`Onboard ${repo}`, body, { current: '/repos', ...who(chrome) });
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
/**
 * A timestamp a person can scan, from one a machine wrote.
 *
 * `2026-08-20T13:40:11.596Z` is precise and unreadable, and a column of them is a wall.
 * The full value stays in `title`, so precision is one hover away and nothing is lost —
 * the shortened form is for finding the row, not for citing it.
 */
const when = (iso: string): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return cell(iso);
  const day = at.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return `<span title="${escapeHtml(iso)}">${escapeHtml(`${day} ${time}`)}</span>`;
};

/**
 * The head of a run id, which is what people actually read and say out loud.
 *
 * The whole id is the link's href and its `title`; showing all 36 characters spent half
 * the table on a value nobody compares by eye.
 */
const shortId = (id: string): string =>
  `<span title="${escapeHtml(id)}">${escapeHtml(id.slice(0, 8))}</span>`;

/** `pr_opened` is a value in a database, not a word. */
const STATUS_LABEL: Record<string, string> = {
  pr_opened: 'PR opened',
  information_requested: 'information requested',
  refused: 'refused',
  running: 'running',
  errored: 'errored',
  forgotten: 'forgotten',
};

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
  minted?: { token: string; name: string; planeUrl: string },
  chrome: Chrome = {},
): string {
  const seen = (value: string | null) => (value === null ? '—' : when(value));
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
<pre class="scroll"><code>git clone https://github.com/Divy97/test-framework-v2
cd test-framework-v2 &amp;&amp; npm ci
npm run images   <span class="muted"># builds the two sandbox images. Several minutes, once.</span>

export OPENROUTER_API_KEY=...   <span class="muted"># your own; this machine spends it, we never see it</span>
ENGINE_PLANE_URL=${escapeHtml(minted.planeUrl)} \
ENGINE_RUNNER_TOKEN=${escapeHtml(minted.token)} \
npm run runner</code></pre>
<p class="muted small">We store a hash of it, not the token, so it cannot be shown again — pair a new
runner if you lose it, and revoke the old one below.</p>
<p class="muted small">The runner is this repository, run from a checkout. There is no package to
install: an <code>npx &lt;name&gt;</code> here would fetch whatever the npm registry has under that name
and execute it on your machine, with the token above already in its environment.</p>
<p class="muted small">It needs Docker running and a model key of your own. Everything else has a
default — the two image names are what <code>npm run images</code> builds, and evidence is written to
<code>./.evidence-store</code> in the checkout.</p>
<p class="muted small"><b>The token is on a command line.</b> That puts it in your shell history and,
while the runner is running, in the output of <code>ps</code>. If that matters where you are running
this, put it in an environment file the shell reads instead, and revoke this one if it has been
somewhere it should not.</p>
</div>`
      : '') +
    `<h2>Paired machines</h2>` +
    (runners.length === 0
      ? `<div class="nothing"><p>No machines paired.</p>
<p>Nothing will run until one is.</p></div>`
      : `<div class="scroll"><table>
<tr><th>name</th><th>paired</th><th>last seen</th><th></th></tr>
${runners
  .map(
    (runner) => `<tr>
<td>${escapeHtml(runner.name)}${runner.revokedAt ? ' <b class="fail">revoked</b>' : ''}</td>
<td>${seen(runner.pairedAt)}</td>
<td>${runner.lastSeen === null ? '<span class="muted">never</span>' : seen(runner.lastSeen)}</td>
<td>${
      runner.revokedAt
        ? ''
        : `<form method="post" action="/repos/${urlPath(repo)}/runners/${escapeHtml(runner.id)}/revoke">
<button class="quiet" type="submit">Revoke</button></form>`
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

  return layout(`Runners · ${repo}`, body, { current: '/repos', ...who(chrome) });
}

export function runsPage(runs: RunRow[], repo?: string, chrome: Chrome = {}): string {
  const mode = chrome.mode ?? 'plane';
  const heading = repo ? `Runs · ${escapeHtml(repo)}` : 'Runs';
  // What is ACTUALLY required, in order. This used to say only "label an issue", which
  // is the last step of three: label one before the rest and the delivery is accepted,
  // logged as `not onboarded — nothing queued`, and nothing appears here to say why.
  const nothingYet =
    mode === 'local'
      ? `<div class="nothing"><p>No runs yet.</p>
<p>Approve a recipe for a connected repository, then open or label an issue on it.</p></div>`
      : `<div class="nothing"><p>No runs yet. A run needs three things:</p>
<p>A runner paired <em>and running</em> on a machine of yours. An approved recipe for the
repository. An issue opened or labelled on it.</p>
<p>Labelling one before the first two is accepted, and then quietly does nothing.</p></div>`;
  const body =
    `<h1>${heading}</h1>` +
    (runs.length === 0
      ? nothingYet
      : table(
          ['run', 'issue', 'status', 'tier', 'confidence', 'regression', 'started', 'result'],
          runs.map((run) => [
            `<a href="/runs/${encodeURIComponent(run.run_id)}">${shortId(run.run_id)}</a>`,
            cell(repo ? `#${run.issue_number}` : `${run.repo}#${run.issue_number}`),
            // Labelled, with the stored value still on the element: the column is read by
            // people, and `pr_opened` is a value in a database rather than a word.
            `<span title="${escapeHtml(run.status)}">${cell(STATUS_LABEL[run.status] ?? run.status)}</span>`,
            `Tier ${run.tier}`,
            // The denominator travels with the number. A bare `80` is unreadable once the
            // grounds change, which is the drift `ceiling` and `scoring` exist to stop.
            cell(`${run.confidence}/${run.ceiling}`),
            run.regression === 'broken'
              ? `<b class="fail">${cell(REGRESSION_LABEL.broken)}</b>`
              : cell(REGRESSION_LABEL[run.regression]),
            when(run.started_at),
            run.pr_url
              ? `<a href="${escapeHtml(run.pr_url)}">pull request</a>`
              : `<span class="muted">none</span>`,
          ]),
        ));
  return layout(repo ? `Runs — ${repo}` : 'Runs', body, { current: '/runs', ...who(chrome) });
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
  /**
   * Present when this run's artifacts were destroyed on request (9e).
   *
   * Rendered FIRST, above the verdict, because every hash below it is about to be a
   * reference that resolves to nothing — and a reader who meets those without being
   * told will read a kept promise as a broken system.
   */
  forgotten?: { requestedBy: string; forgottenAt: string; removed: number } | null;
}): string {
  const { row, state, score, usage } = input;
  const refused = score.tier === 3;
  // The credited attempt, taken from the fold and never re-derived — a second definition of
  // "which attempt" is free to disagree with the first, and in this codebase it did.
  const attempt = state.reproducedAttempt;
  const repro =
    state.registrations.filter((r) => r.attempt === attempt).at(-1) ?? state.registeredRepro;

  const sections: string[] = [];

  if (input.forgotten) {
    // The distinction this page exists to preserve: destroyed on request is not the
    // same as missing. One is a promise kept and the other is a bug, and they look
    // identical from the outside unless somebody says which.
    sections.push(
      `<div class="warning">
<h2>The evidence for this run was deleted, on request.</h2>
<p>${escapeHtml(input.forgotten.removed.toString())} artifact(s) were destroyed at
${escapeHtml(input.forgotten.forgottenAt.replace('T', ' ').slice(0, 19))}, asked for by
<code>${escapeHtml(input.forgotten.requestedBy)}</code>.</p>
<p><b>The log was not edited.</b> Every event below says exactly what it said before, including
the <code>sha256:</code> references — those now point at bytes that no longer exist, which is what
deleting them means. Artifacts still cited by another run were kept: content addressing makes
identical bytes one file, and removing them would have broken a run nobody asked to forget.</p>
</div>`,
    );
  }

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

  return layout(`${row.repo}#${row.issue_number} — evidence`, sections.join('\n'), { current: '/runs' });
}
