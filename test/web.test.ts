// The screens (M6f), and whether they can be trusted with someone else's text.
//
// Two things are being asserted here, and only one of them is about layout.
//
// The first is that the evidence view says what milestone 6 promises it says: base red for
// the reported symptom and fix green beside it, every confidence ground with its points and
// the bytes behind them, the regression arm, and — on a Tier 3 — the gate VISIBLY refusing,
// with no change shown. The Tier 3 fixture below carries a real `fixDiff` on purpose: a
// page that hides the diff only because the field is null has proved nothing, and a fix
// series that ran and failed to hold is exactly the run that produces both.
//
// The second is escaping. Repository names, recipe commands, abort reasons and transcript
// labels all originate outside this system, and the evidence view interpolates every one of
// them. `github.ts` calls the issue body attacker-influenced text and `verify.ts` says the
// same of an abort reason a reproduction can choose — so a `<script>` in any of them
// reaching the document is not a rendering bug, it is the dashboard executing code on
// behalf of whoever filed the issue.

import { describe, expect, test } from 'vitest';
import { confidence } from '../src/confidence.js';
import type { RunState } from '../src/fold.js';
import type { Installation } from '../src/installations.js';
import type { RunRow } from '../src/projection.js';
import { parseRecipe, type Recipe } from '../src/recipe.js';
import {
  escapeHtml,
  evidencePage,
  landingPage,
  layout,
  onboardPage,
  repositoriesPage,
  runsPage,
} from '../src/web.js';

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/**
 * A document, not a fragment. Every route returns one of these straight to a browser, so a
 * page missing `<!doctype>` renders in quirks mode and a page with two `<title>`s is a page
 * whose tab label depends on the parser.
 */
const expectWellFormed = (html: string): void => {
  expect(html.startsWith('<!doctype html>')).toBe(true);
  expect(count(html, '<title>')).toBe(1);
  expect(count(html, '</title>')).toBe(1);
  expect(count(html, '<html')).toBe(1);
  expect(count(html, '</html>')).toBe(1);
  expect(count(html, '<body')).toBe(1);
  expect(count(html, '</body>')).toBe(1);
  expect(html.trimEnd().endsWith('</html>')).toBe(true);
};

/**
 * Every field of `RunState`, written out once.
 *
 * Spread over rather than built by folding events: the point of these functions being pure
 * is that a screen can be checked without a log, a database or a container, and reaching
 * for `fold()` here would quietly make this suite depend on the producer again.
 */
const EMPTY: RunState = {
  runId: 'run-0000',
  status: 'requested',
  source: 'github',
  threadRef: 'acme/widgets#41',
  currentAttempt: 0,
  testRuns: [],
  suiteRuns: [],
  regression: 'unmeasured',
  registeredRepro: null,
  registrations: [],
  reproduced: false,
  reproducedAttempt: null,
  shownOnBase: false,
  shownAttempts: [],
  env: null,
  fixDiff: null,
  completedAttempts: [],
  transcript: [],
  agent: null,
  handedOver: null,
  handovers: [],
  reproAuthoredByAgent: false,
  pr: null,
  aborts: [],
  afterEnd: [],
  endedReason: null,
  artifactHashes: [],
  lastSeq: 0,
};

const REPRO = {
  attempt: 1,
  command: 'node --test test/repro.test.mjs',
  files: { 'test/repro.test.mjs': 'sha256:repro0001' as const },
  applied: ['test/repro.test.mjs'],
  // The agent wrote it, so git had nothing at base. A reproduction the repository
  // already contained lists it here instead (8d) and applies nothing.
  committed: [],
};

const baseRun = (repeat: number) => ({
  attempt: 1,
  phase: 'base' as const,
  commit_sha: 'base000000000000',
  exit_code: 1,
  stdout_hash: `sha256:base${repeat}` as const,
  duration_ms: 900,
  symptom_matched: true,
  repeat,
  repro_hashes: { 'test/repro.test.mjs': 'sha256:repro0001' as const },
});

const fixRun = (repeat: number, exit = 0) => ({
  attempt: 1,
  phase: 'fix' as const,
  commit_sha: 'fix0000000000000',
  exit_code: exit,
  stdout_hash: `sha256:fix${repeat}` as const,
  duration_ms: 800,
  symptom_matched: false,
  repeat,
  repro_hashes: { 'test/repro.test.mjs': 'sha256:repro0001' as const },
});

/** Reproduced, agent-authored, suite clean on both commits: the ordinary good run. */
const TIER_2: RunState = {
  ...EMPTY,
  runId: 'run-tier2',
  status: 'pr_opened',
  currentAttempt: 1,
  registeredRepro: REPRO,
  registrations: [REPRO],
  testRuns: [baseRun(1), baseRun(2), fixRun(1), fixRun(2), fixRun(3)],
  suiteRuns: [
    {
      attempt: 1,
      phase: 'base',
      command: 'npm test',
      exit_code: 0,
      stdout_hash: 'sha256:suitebase',
      duration_ms: 4000,
    },
    {
      attempt: 1,
      phase: 'fix',
      command: 'npm test',
      exit_code: 0,
      stdout_hash: 'sha256:suitefix',
      duration_ms: 4100,
    },
  ],
  regression: 'clean',
  reproduced: true,
  reproducedAttempt: 1,
  shownOnBase: true,
  shownAttempts: [1],
  completedAttempts: [1],
  fixDiff: { changed_files: ['src/orders.ts'], diff_hash: 'sha256:fixdiff01' },
  reproAuthoredByAgent: true,
  handedOver: 'fix0000000000000',
  handovers: [{ attempt: 1, kind: 'fix', commit: 'fix0000000000000' }],
  transcript: [
    { n: 1, claimed_type: 'text', raw_hash: 'sha256:msg1', bytes: 402 },
    { n: 2, claimed_type: 'tool_use', raw_hash: 'sha256:msg2', bytes: 118 },
  ],
  pr: { repo: 'acme/widgets', pr_number: 12, head_sha: 'fix0000000000000' },
  endedReason: 'pr_opened',
  lastSeq: 24,
};

/**
 * A run where the bug WAS shown and the fix did not hold every time.
 *
 * Tier 3 with a real diff in the log, which is the case that makes withholding it a
 * decision rather than an accident of empty data.
 */
const TIER_3: RunState = {
  ...EMPTY,
  runId: 'run-tier3',
  status: 'unresolved',
  currentAttempt: 1,
  registeredRepro: REPRO,
  registrations: [REPRO],
  testRuns: [baseRun(1), baseRun(2), fixRun(1), fixRun(2), fixRun(3, 1)],
  regression: 'unmeasured',
  shownOnBase: true,
  shownAttempts: [1],
  completedAttempts: [1],
  fixDiff: { changed_files: ['src/orders.ts'], diff_hash: 'sha256:withheld01' },
  transcript: [{ n: 1, claimed_type: 'text', raw_hash: 'sha256:msg1', bytes: 402 }],
  endedReason: 'not_reproduced',
  lastSeq: 19,
};

/** The row the read model would have stored for a state, so the two never disagree here. */
const rowFor = (state: RunState, repo = 'acme/widgets', issue = 41): RunRow => {
  const score = confidence(state);
  return {
    run_id: state.runId,
    repo,
    issue_number: issue,
    status: state.status,
    tier: score.tier,
    confidence: score.score,
    ceiling: score.ceiling,
    scoring: score.scoring,
    regression: state.regression,
    pr_url: state.pr ? `https://github.com/${state.pr.repo}/pull/${state.pr.pr_number}` : null,
    started_at: '2026-08-13T09:00:00.000Z',
    ended_at: state.endedReason === null ? null : '2026-08-13T09:14:00.000Z',
    last_seq: state.lastSeq,
  };
};

const page = (
  state: RunState,
  options: { repo?: string; forgotten?: { requestedBy: string; forgottenAt: string; removed: number } } = {},
) => {
  const { forgotten } = options;
  const row = rowFor(state, options.repo);
  return evidencePage({
    row,
    state,
    score: confidence(state),
    usage: [],
    ...(forgotten === undefined ? {} : { forgotten }),
  });
};

const installation = (repo: string): Installation => ({
  repo,
  installationId: 5551234,
  account: repo.split('/')[0]!,
  connectedAt: '2026-08-01T10:00:00.000Z',
  removedAt: null,
});

describe('escaping is the whole defence, so it is applied at every interpolation', () => {
  const XSS = 'acme/<script>alert(1)</script>';

  test('a script tag in a repository name reaches the page as text', () => {
    for (const html of [
      runsPage([rowFor(TIER_2, XSS)]),
      repositoriesPage([{ installation: installation(XSS), hasRecipe: true, runs: 3 }]),
      page(TIER_2, { repo: XSS }),
    ]) {
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expectWellFormed(html);
    }
  });

  test('a quote in a repository name cannot break out of the href it lands in', () => {
    // The repository name reaches an attribute on the repositories page — the onboarding
    // link is built from it — so `escapeHtml` alone is not the whole answer there and the
    // path is percent-encoded first. Both halves are asserted: no attribute is opened, and
    // the link still points at this repository.
    const breakout = 'acme/x" onmouseover="alert(1)';
    const html = repositoriesPage([
      { installation: installation(breakout), hasRecipe: false, runs: 0 },
    ]);
    expect(html).not.toContain('onmouseover="');
    // The raw quote, wherever it landed. Nothing in the document may carry the name with its
    // `"` intact — not the link text, not the href, not a title attribute added later.
    expect(html).not.toContain('acme/x" ');
    expect(html).toContain('/repos/acme/x%22%20onmouseover%3D%22alert(1)/onboard');
    expectWellFormed(html);
  });

  test('an issue title quoted back by the agent cannot break out either', () => {
    // The issue text this system holds is not a title field — it reaches the page through
    // what the agent and the engine wrote about it: the registered command, the abort
    // reason `verify.ts` names as attacker-influenced, and the transcript's claimed type.
    // Every one of them is a string a stranger can steer.
    const html = page({
      ...TIER_3,
      registrations: [{ ...REPRO, command: 'node --test "<script>alert(1)</script>"' }],
      registeredRepro: { ...REPRO, command: 'node --test "<script>alert(1)</script>"' },
      aborts: [
        {
          attempt: 1,
          phase: 'fix',
          reason: 'recipe step 2 failed: PORT=1 </script><img src=x onerror=alert(1)>',
          cause: 'environment',
        },
      ],
      transcript: [
        { n: 1, claimed_type: '<img src=x onerror=alert(1)>', raw_hash: 'sha256:m1', bytes: 9 },
      ],
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expectWellFormed(html);
  });

  test('escapeHtml covers the five characters, ampersand first', () => {
    // `&` first or `<` becomes `&amp;lt;` and the page prints the escape rather than
    // applying it — the classic double-escape that looks like a cosmetic bug and is a hole.
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });
});

describe('a Tier 3 shows the gate refusing, and no change', () => {
  const html = page(TIER_3);

  test('it says no fix was attempted, and why', () => {
    expect(confidence(TIER_3).tier).toBe(3);
    expect(html).toContain('No fix was attempted.');
    // The reason, not merely the refusal. "We could not reproduce it" puts the work back on
    // the reporter with no direction; which clause failed is what a follow-up would change.
    expect(html).toContain('the fix passed 2 of 3 runs: a flake is not a fix');
  });

  test('it renders no diff section, even though this log holds a diff', () => {
    expect(TIER_3.fixDiff).not.toBeNull();
    expect(html).not.toContain('<h2>The diff</h2>');
    expect(html).not.toContain('sha256:withheld01');
    expect(html).not.toContain('src/orders.ts');
    // And the same state rendered as a reproduced run WOULD show it, which is what makes
    // the assertion above about the tier rather than about the fixture.
    expect(page(TIER_2)).toContain('<h2>The diff</h2>');
  });

  test('the runs that produced the refusal are still shown', () => {
    // A refusal a reader cannot audit is an assertion. The evidence is the same evidence a
    // reproduced run is judged on; it arrives at the opposite answer.
    expect(html).toContain('sha256:base1');
    expect(html).toContain('sha256:fix3');
    expectWellFormed(html);
  });
});

describe('a Tier 2 shows base red, fix green, and every point behind the number', () => {
  const score = confidence(TIER_2);
  const html = page(TIER_2);

  test('the fixture is the tier the cap produces for an agent-authored reproduction', () => {
    expect(score.tier).toBe(2);
    expect(html).toContain(`Confidence ${score.score}/${score.ceiling}`);
  });

  test('both base draws and all three fix runs appear with their exit codes and hashes', () => {
    for (const run of TIER_2.testRuns) expect(html).toContain(escapeHtml(run.stdout_hash));
    // Counted inside the reproduction arm only. The regression arm has `base` and `fix` rows
    // of its own — a whole-page count would pass on the suite's rows while the reproduction
    // table was empty, which is the exact thing being asserted.
    const arm = html.slice(
      html.indexOf('<h2>The reproduction arm</h2>'),
      html.indexOf('<h2>The regression arm</h2>'),
    );
    expect(count(arm, '<td>base</td>')).toBe(2);
    expect(count(arm, '<td>fix</td>')).toBe(3);
    // Red on base and green on the fix, as numbers rather than as a word for them.
    expect(html).toContain('<span class="fail">1</span>');
    expect(html).toContain('<span class="pass">0</span>');
    // The symptom column, which is what ties the failure to the report in both directions.
    expect(html).toContain('symptom in output');
  });

  test('every ground is rendered with its points and its artifacts', () => {
    expect(score.grounds.length).toBeGreaterThan(4);
    for (const ground of score.grounds) {
      expect(html).toContain(
        `<span class="points">+${ground.points}</span> ${escapeHtml(ground.claim)}`,
      );
      for (const ref of ground.evidence) expect(html).toContain(`<code>${ref}</code>`);
    }
  });

  test('what the number does not account for is listed, not implied', () => {
    expect(html).toContain('<h2>Not measured</h2>');
    for (const gap of score.unmeasured) expect(html).toContain(escapeHtml(gap));
  });

  test('the regression arm is shown as its own section', () => {
    expect(html).toContain('<h2>The regression arm</h2>');
    expect(html).toContain('suite clean');
    expect(html).toContain('sha256:suitebase');
    expect(html).toContain('sha256:suitefix');
  });

  test('the transcript is testimony, with its count, and is never called evidence', () => {
    // ADR-0006. The fold keeps the transcript out of `artifactHashes` so nothing can reach
    // it as evidence by accident; presenting it under any other word here would undo that
    // in the one place a human actually reads.
    expect(html).toContain('<h2>Testimony</h2>');
    expect(html).toContain('<b>2 messages</b>');
    expect(html).toContain('an input to no verdict');
    expect(html).not.toMatch(/transcript[^<]*evidence/i);
  });

  test('the cost of the run appears when there is one, and not otherwise', () => {
    expect(html).not.toContain('What this run cost');
    const billed = evidencePage({
      row: rowFor(TIER_2),
      state: TIER_2,
      score,
      usage: [{ phase: 'repro', turns: 9, input_tokens: 48211, output_tokens: 3120 }],
    });
    expect(billed).toContain('What this run cost');
    expect(billed).toContain('48211');
    expectWellFormed(billed);
  });
});

describe('a broken suite is the first thing on the page', () => {
  const broken: RunState = {
    ...TIER_2,
    regression: 'broken',
    suiteRuns: [
      TIER_2.suiteRuns[0]!,
      { ...TIER_2.suiteRuns[1]!, exit_code: 1, stdout_hash: 'sha256:suitered' },
    ],
  };
  const html = page(broken);

  test('it is stated as a warning, naming the command and the exit code', () => {
    expect(html).toContain("This fix breaks the project's own test suite.");
    expect(html).toContain('<code>npm test</code>');
    expect(html).toContain('exits 1 on this one');
    expect(html).toContain('sha256:suitered');
  });

  test('nothing a reader might stop at precedes it', () => {
    // `report.ts` gives it the same position in the pull request, for the same reason: a
    // change that breaks the build is the one finding nobody should have to scroll for.
    const warning = html.indexOf('class="warning"');
    expect(warning).toBeGreaterThan(-1);
    expect(warning).toBeLessThan(html.indexOf('<h2>The reproduction arm</h2>'));
    expect(warning).toBeLessThan(html.indexOf('<h2>Confidence'));
    expect(warning).toBeLessThan(html.indexOf('<h2>The diff</h2>'));
  });

  test('the run list flags it too, since that is where a reader chooses what to open', () => {
    const list = runsPage([rowFor(broken)]);
    expect(list).toContain('suite BROKEN by the fix');
    expectWellFormed(list);
  });
});

describe('the repositories page is about onboarding status', () => {
  const html = repositoriesPage([
    { installation: installation('acme/widgets'), hasRecipe: true, runs: 7 },
    { installation: installation('acme/fresh'), hasRecipe: false, runs: 0 },
  ]);

  test('an approved recipe and a missing one do not read the same', () => {
    expect(html).toContain('recipe approved');
    expect(html).toContain('not onboarded yet');
  });

  test('only the un-onboarded repository carries the link that resolves it', () => {
    // The state that used to produce this product's worst answer: an issue on a repository
    // with no recipe started a run, booted nothing, and returned a Tier 3 about a bug that
    // was never shown. The row has to offer the way out, not just name the problem.
    expect(html).toContain('/repos/acme/fresh/onboard');
    expect(html).not.toContain('/repos/acme/widgets/onboard');
  });

  test('no repositories is a sentence, not an empty table', () => {
    const empty = repositoriesPage([]);
    expect(empty).toContain('No repositories are connected yet');
    expect(empty).not.toContain('<table>');
    expectWellFormed(empty);
  });
});

describe('the run list', () => {
  test('carries status, tier, both halves of the score, regression and a link', () => {
    const html = runsPage([rowFor(TIER_2), rowFor(TIER_3)]);
    const two = confidence(TIER_2);
    expect(html).toContain(`${two.score}/${two.ceiling}`);
    expect(html).toContain('Tier 2');
    expect(html).toContain('Tier 3');
    // Labelled for a reader, with the stored value still on the element — the property
    // is that the run list carries its status, not that it prints a database enum.
    expect(html).toContain('PR opened');
    expect(html).toContain('title=\"pr_opened\"');
    expect(html).toContain('/runs/run-tier2');
    expect(html).toContain('/runs/run-tier3');
    expectWellFormed(html);
  });

  test('a repository filter names the repository it is filtered to', () => {
    const html = runsPage([rowFor(TIER_2)], 'acme/widgets');
    expect(html).toContain('Runs · acme/widgets');
    expectWellFormed(html);
  });

  test('no runs is a sentence, not an empty table', () => {
    const empty = runsPage([]);
    expect(empty).toContain('No runs yet');
    expect(empty).not.toContain('<table>');
    expectWellFormed(empty);
  });
});

describe('the onboarding screen is the only write, and its copy carries the weight', () => {
  const RECIPE: Recipe = {
    install: 'npm ci',
    services: [{ name: 'web', command: 'node server.mjs', port: 8080, healthcheck: 'http://127.0.0.1:8080/healthz' }],
    test: 'npm test',
  };

  test('it states what approving actually does, in ADR-0013 s terms', () => {
    // The same three sentences `cli.ts recipe approve` prints to an operator. A browser form
    // that said less to a stranger would be the same decision with the warning removed.
    const html = onboardPage('acme/widgets', null);
    expect(html).toContain('verbatim');
    expect(html).toContain('with a package registry reachable');
    expect(html).toContain('Nothing sandboxes them from that sandbox');
    expect(html).toContain('you are the control');
    expectWellFormed(html);
  });

  test('an existing recipe round-trips into the textarea', () => {
    const html = onboardPage('acme/widgets', RECIPE);
    expect(html).toContain(escapeHtml(JSON.stringify(RECIPE, null, 2)));
    expect(html).toContain('<form method="post" action="/repos/acme/widgets/onboard">');
    expect(html).toContain('name="recipe"');
    expect(html).toContain('type="submit"');
    expectWellFormed(html);
  });

  test('the empty skeleton parses, and stores a recipe that runs nothing', () => {
    // JSON has no comments, so a commented skeleton is a syntax error handed to the reader
    // on the one screen whose first act would then be to tell them they got it wrong. And
    // the placeholders are empty rather than plausible: `parseRecipe` reads `''` as absent,
    // so submitting it unchanged runs nothing — a pre-typed `npm install` would be a command
    // this engine executes verbatim because we filled it in for them.
    const html = onboardPage('acme/widgets', null);
    const box = /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(html);
    expect(box).not.toBeNull();
    const raw = box![1]!
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&');
    expect(parseRecipe(JSON.parse(raw))).toEqual({ services: [] });
  });

  test('a recipe in force with no proof yet says so, rather than saying nothing', () => {
    // 8f. The gap this fills: between pressing approve and the proving run finishing,
    // the page used to look identical to a repository nobody had ever checked. Silence
    // there reads as "fine".
    const html = onboardPage('acme/widgets', RECIPE, undefined, undefined, null);
    expect(html).toContain('Not proved yet');
    expect(html).toContain('sealed container');
    // And a repository with no recipe has nothing to prove, so it gets no block at all.
    expect(onboardPage('acme/widgets', null)).not.toContain('Not proved yet');
    expectWellFormed(html);
  });

  test('a proof renders as what a run here will and will not be able to say', () => {
    const html = onboardPage('acme/widgets', RECIPE, undefined, undefined, {
      state: 'ready_with_caveats',
      commit: 'a'.repeat(40),
      environment: { built: true },
      suite: { command: 'npm test', exitCode: 1, output: 'not ok 3' },
      caveats: ['the test command `npm test` already fails at this commit (exit 1)'],
      unproved: ['the single-test invocation: nothing here has executed one'],
      provedAt: '2026-08-29T10:00:00.000Z',
    });
    expect(html).toContain('Ready, with caveats');
    expect(html).toContain('exit 1');
    expect(html).toContain('already fails at this commit');
    // The engine's own gaps are kept APART from the repository's. Collapsing them
    // would tell someone their project is missing something that is ours.
    expect(html).toContain('Not checked by this engine at all');
    expect(html).toContain('the single-test invocation');
    expectWellFormed(html);
  });

  test('a blocked repository says nothing else could be checked', () => {
    const html = onboardPage('acme/widgets', RECIPE, undefined, undefined, {
      state: 'blocked',
      commit: 'b'.repeat(40),
      environment: { built: false, failed: 'recipe step install failed: exit 127' },
      caveats: ['nothing else could be checked'],
      unproved: [],
      provedAt: '2026-08-29T10:00:00.000Z',
    });
    expect(html).toContain('Blocked.');
    expect(html).toContain('exit 127');
    expectWellFormed(html);
  });

  test('a proof from an older engine renders rather than throwing', () => {
    // Stored as opaque JSON and read back the same way, deliberately: a proof written
    // before a field existed is still the best thing anyone has about that repository,
    // and throwing on it would take the whole onboarding page down with it.
    const html = onboardPage('acme/widgets', RECIPE, undefined, undefined, { state: 'ready' });
    expect(html).toContain('Ready.');
    expectWellFormed(html);
  });

  test('a caveat cannot smuggle markup out of a container into the page', () => {
    // Caveats quote the recipe's own commands and a container's OUTPUT, which is
    // whatever the repository under onboarding printed. Same rule as every other
    // string on this surface.
    const html = onboardPage('acme/widgets', RECIPE, undefined, undefined, {
      state: 'ready_with_caveats',
      environment: { built: true },
      caveats: ['<img src=x onerror="alert(1)">'],
      unproved: [],
      provedAt: 'T',
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
    expectWellFormed(html);
  });

  test('a refusal reads as the recipe being wrong, never the project', () => {
    // `parseRecipe`'s message arriving bare would read as this system finding something wrong
    // with someone's repository — the one presentation ADR-0007's amendment forbids, and here
    // it would not even be true.
    const html = onboardPage('acme/widgets', null, undefined, 'service web needs a port');
    expect(html).toContain('This recipe was not stored.');
    expect(html).toContain('Nothing is wrong with your project');
    expect(html).toContain('service web needs a port');
    expect(html).toContain('Nothing was saved, and no run has been started');
    expect(onboardPage('acme/widgets', null)).not.toContain('This recipe was not stored.');
  });

  test('there is no field for a secret, and the page says why', () => {
    // M6e is blocked on a security decision and an ADR that do not exist. A form is the
    // easiest half of that problem, and shipping it would settle the question by accident.
    const html = onboardPage('acme/widgets', RECIPE);
    expect(html).not.toMatch(/<input/i);
    // Every named field the form submits, and there is exactly one. Scoped to the form
    // because `<meta name="viewport">` is a name too and has nothing to do with this.
    const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
    expect([...form.matchAll(/name="([^"]*)"/g)].map((m) => m[1])).toEqual(['recipe']);
    expect(form).not.toMatch(/env|secret|token|password|credential/i);
    expect(html).toContain('Environment variables are not supported yet');
    expect(html).toContain('nothing worth stealing lives in it');
  });

  test('a script tag in the repository name or the error cannot break out', () => {
    const html = onboardPage(
      'acme/<script>alert(1)</script>',
      null,
      undefined,
      'recipe.install must be a string </textarea><script>alert(2)</script>',
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('</textarea><');
    expect(count(html, '<textarea')).toBe(1);
    expect(count(html, '</textarea>')).toBe(1);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expectWellFormed(html);
  });
});

describe('an unreviewed draft, pre-filled by an agent nobody has checked (M6b)', () => {
  const DRAFT = { install: 'yarn install', services: [{ name: 'api', command: 'yarn start', port: 3000 }] };

  test('a draft pre-fills the box and is labelled as unreviewed', () => {
    const html = onboardPage('acme/widgets', null, DRAFT);
    expect(html).toContain(escapeHtml(JSON.stringify(DRAFT, null, 2)));
    // Distinct copy from "Read this before you approve" — this box exists to say why the
    // one below is not empty, not to restate what approving means.
    expect(html).toContain('This box is pre-filled by an agent, not by a person.');
    expect(html).toContain('Read this before you approve.');
    expectWellFormed(html);
  });

  test('an approved recipe wins outright, even with a draft sitting beside it', () => {
    const RECIPE: Recipe = { install: 'npm ci', services: [], test: 'npm test' };
    const html = onboardPage('acme/widgets', RECIPE, DRAFT);
    expect(html).toContain(escapeHtml(JSON.stringify(RECIPE, null, 2)));
    expect(html).not.toContain(escapeHtml(JSON.stringify(DRAFT, null, 2)));
    // No "unreviewed" callout either — a draft that lost has no business being labelled.
    expect(html).not.toContain('This box is pre-filled by an agent, not by a person.');
    expectWellFormed(html);
  });

  test('neither a recipe nor a draft still falls back to the empty skeleton', () => {
    const withNoArgs = onboardPage('acme/widgets', null);
    const withUndefinedDraft = onboardPage('acme/widgets', null, undefined);
    expect(withNoArgs).toEqual(withUndefinedDraft);
    expect(withNoArgs).not.toContain('This box is pre-filled by an agent, not by a person.');
    const box = /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(withNoArgs);
    expect(parseRecipe(JSON.parse(box![1]!.replaceAll('&quot;', '"')))).toEqual({ services: [] });
  });

  test('a draft that cannot even be stringified falls back to the skeleton rather than breaking the page', () => {
    // `draft` is `unknown` — an agent's own words, never run through `parseRecipe` — so a
    // circular structure or a BigInt is a real possibility, and `JSON.stringify` throws on
    // both. A draft that cannot be displayed is worth exactly as much as no draft.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const html = onboardPage('acme/widgets', null, circular);
    expect(html).not.toContain('This box is pre-filled by an agent, not by a person.');
    const box = /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(html);
    expect(parseRecipe(JSON.parse(box![1]!.replaceAll('&quot;', '"')))).toEqual({ services: [] });
    expectWellFormed(html);
  });

  test('a script tag inside the draft cannot break out of the textarea', () => {
    const html = onboardPage('acme/widgets', null, {
      install: '</textarea><script>alert(1)</script>',
      services: [],
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('</textarea><');
    expect(count(html, '<textarea')).toBe(1);
    expect(count(html, '</textarea>')).toBe(1);
    expectWellFormed(html);
  });
});

describe('every page is a document a browser can render', () => {
  test('each route returns one complete, well-formed HTML document', () => {
    for (const html of [
      layout('A title', '<p>body</p>'),
      landingPage('https://github.com/apps/test-framework/installations/new'),
      repositoriesPage([{ installation: installation('acme/widgets'), hasRecipe: true, runs: 1 }]),
      onboardPage('acme/widgets', null),
      runsPage([rowFor(TIER_2)]),
      page(TIER_2),
      page(TIER_3),
    ]) {
      expectWellFormed(html);
      // Both themes are defined, and the dark one only redefines tokens — a colour whose
      // sole definition sits inside the media block is a page unreadable in the other theme.
      expect(html).toContain('prefers-color-scheme:dark');
      // The header is the only navigation this product has.
      expect(html).toContain('href="/runs"');
    }
  });

  test('a forgotten run says so first, and does not hide the dead references', () => {
    // 9e. Destroyed on request and gone missing look identical from the outside — one is
    // a promise kept and the other is a bug — so the page has to say which, above the
    // verdict, before a reader meets a hash that resolves to nothing.
    const html = page(TIER_2, {
      forgotten: { requestedBy: 'divy97', forgottenAt: '2026-08-30T10:00:00.000Z', removed: 3 },
    });
    expect(html).toContain('deleted, on request');
    expect(html).toContain('divy97');
    expect(html).toContain('3 artifact(s)');
    expect(html).toContain('The log was not edited');
    // The refs are still on the page. Hiding them would be the edit we just refused to
    // make, one layer up.
    expect(html).toContain('sha256:');
    expectWellFormed(html);
  });

  test('and a run nobody forgot carries no tombstone at all', () => {
    expect(page(TIER_2)).not.toContain('deleted, on request');
  });

  test('a returning user has a way in, and only where there is one', () => {
    // Found by clicking it. The App was already installed, so "Install on GitHub" sent
    // the browser to the installation's own settings page — the right answer from
    // GitHub, and a dead end for somebody who just wanted to look at their runs. The
    // landing page had no other door.
    const hosted = landingPage('https://github.com/apps/x/installations/new', { signIn: true });
    expect(hosted).toContain('href="/auth/github"');
    expect(hosted).toContain('Sign in');
    // And it says why the other button did not work, because the person who clicked it
    // is the person reading this.
    expect(hosted).toContain('existing installation');

    // Locally there is no login: one operator on 127.0.0.1, and a sign-in link would be
    // a button that leads nowhere.
    const local = landingPage('https://github.com/apps/x/installations/new');
    expect(local).not.toContain('/auth/github');
    expectWellFormed(hosted);
    expectWellFormed(local);
  });

  test('the landing page offers exactly one install button, pointed at GitHub', () => {
    // GitHub owns the install screen. Rebuilding it would mean asking for a token, which
    // ADR-0012 says is never requested.
    const url = 'https://github.com/apps/test-framework/installations/new';
    const html = landingPage(url);
    expect(count(html, `href="${url}"`)).toBe(1);
    expect(html).toContain('class="cta"');
  });
});
