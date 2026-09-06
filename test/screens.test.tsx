// The screens, as pure functions over data (10i) — what `test/web.test.ts` was.
//
// That file's value came from a rule `src/web.ts` stated and kept: *no I/O; every export
// takes data and returns a string, so the screen that IS the product is unit-testable
// without a database, a browser, or a listening socket. A screen checkable only by starting
// Postgres is a screen nobody checks — and this one is where every claim the engine makes
// finally gets read by a human.*
//
// Moving the front end to React could have deleted that rule silently: a component that
// fetches its own data can only be checked in a browser, and this repository's browser test
// is skipped whenever chromium is absent. So the rendering half of every screen was split
// from the fetching half — `Evidence` from `Run`, `Timeline` from the tail — and this file
// renders those with `renderToStaticMarkup` and asserts on the markup.
//
// TWO PROPERTIES it carries over, and both were load-bearing:
//
//   1. **Escaping.** `web.test.ts` asserted no page ever contained a live `<script>`,
//      which was the strongest injection guard in this suite. React escapes children by
//      default, so the equivalent assertion is that attacker-controlled text — a repository
//      name, an abort reason a reproduction chooses, a transcript's claimed type, a
//      recipe's own commands — arrives as text. The other half of that guard is
//      structural: `test/static.test.ts` asserts nothing in `web/` calls
//      `dangerouslySetInnerHTML`, and that a real Content-Security-Policy is served.
//   2. **The words.** Several sentences here are the product's argument rather than its
//      decoration — the transcript is never called evidence, a refusal is stated as the
//      deliverable, egress is not a seal check — and each has been wrong at least once.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { Evidence as EvidenceData, Me, RepoDetail, RepoRow, RunRow } from '../web/lib/api';
import type { Frame } from '../web/lib/hooks';
import { EVENT_TYPES } from '../src/events.js';
import type {
  AttemptStartedV1,
  FixDiffObservedV1,
  RunEndedV1,
  RunRequestedV1,
  SandboxCreatedV1,
  SandboxSealedV1,
  VerificationAbortedV1,
} from '../src/events.js';
import { EVENT_TYPES as CLIENT_EVENT_TYPES } from '../web/lib/hooks';
import { Chrome } from '../web/components/Chrome';
import { Evidence } from '../web/components/views/Evidence';
import { Environment } from '../web/components/views/Environment';
import { Landing } from '../web/components/views/Landing';
import { Minted } from '../web/components/views/Runners';
import * as Repos from '../web/components/views/Repos';
import * as Runs from '../web/components/views/Runs';
import { Timeline } from '../web/components/Timeline';

const render = (node: React.ReactElement): string => renderToStaticMarkup(node);

const REPRO = {
  command: 'node --test test/cart.test.mjs',
  files: { 'test/cart.test.mjs': 'sha256:repro' },
  applied: ['test/cart.test.mjs'],
  attempt: 1,
};

const base = (over: Partial<EvidenceData['state']> = {}): EvidenceData['state'] => ({
  runId: 'r1',
  status: 'pr_opened',
  currentAttempt: 1,
  reproduced: true,
  reproducedAttempt: 1,
  shownOnBase: true,
  regression: 'clean',
  registeredRepro: REPRO,
  registrations: [REPRO],
  // `attempt` on every row, because `TestRunRecord` requires it — the fold judges each
  // attempt against its own registration, and a fixture without it describes a shape the
  // engine cannot produce. It was absent, and nothing checked, because this file was
  // excluded from the only program that could have.
  testRuns: [
    { attempt: 1, phase: 'base', repeat: 0, commit_sha: '8d41c6b2a09f1234', exit_code: 1, symptom_matched: true, stdout_hash: 'sha256:b0' },
    { attempt: 1, phase: 'fix', repeat: 0, commit_sha: 'aa41c6b2a09f1234', exit_code: 0, symptom_matched: false, stdout_hash: 'sha256:f0' },
  ],
  suiteRuns: [
    { phase: 'base', attempt: 1, command: 'npm test', exit_code: 0, stdout_hash: 'sha256:s0' },
    { phase: 'fix', attempt: 1, command: 'npm test', exit_code: 0, stdout_hash: 'sha256:s1' },
  ],
  fixDiff: { changed_files: ['src/cart.mjs'], diff_hash: 'sha256:diff' },
  aborts: [],
  transcript: [{ n: 1, claimed_type: 'text', raw_hash: 'sha256:msg1', bytes: 402 }],
  pr: { repo: 'acme/widgets', pr_number: 7, head_sha: 'aa41c6' },
  ...over,
});

const evidence = (over: Partial<EvidenceData> = {}): EvidenceData => ({
  row: {
    run_id: 'r1',
    repo: 'acme/widgets',
    issue_number: 41,
    status: 'pr_opened',
    started_at: '2026-09-06T10:00:00.000Z',
    ended_at: '2026-09-06T10:04:00.000Z',
    tier: 2,
    confidence: 90,
    ceiling: 103,
    scoring: 2,
    // `regression` and `last_seq` are columns; `reproduced` and `pr_number` are not, and
    // were in this fixture describing a row the projection has never returned.
    regression: 'clean',
    pr_url: null,
    last_seq: 8,
  },
  state: base(),
  score: {
    scoring: 2,
    tier: 2,
    score: 90,
    ceiling: 103,
    grounds: [{ points: 40, claim: 'the reported symptom was reproduced on the base commit', evidence: ['sha256:b0'] }],
    unmeasured: ['whether the reproduction is independent of the fix'],
  },
  usage: [{ phase: 'repro', turns: 15, input_tokens: 89129, output_tokens: 2820 }],
  compute: [{ sandbox_id: 'sbx-1', phase: 'base', active_cpu_ms: 4200, duration_ms: 61000, egress_bytes: 12288 }],
  forgotten: null,
  ...over,
});

// ---------------------------------------------------------------------------------------

describe('attacker-influenced text arrives as text', () => {
  // Repository names, recipe commands, abort reasons and the agent's own transcript labels
  // are attacker-influenced: `github.ts` says it of the issue body that reaches the prompt,
  // `verify.ts` says it of the abort reason a reproduction can choose, and `run.ts` escapes
  // issue text before it reaches a regex for the same reason.
  const XSS = '<script>alert(1)</script>';

  test('a script tag in a registered command does not become one', () => {
    const html = render(
      <Evidence
        ended
        data={evidence({
          state: base({
            registeredRepro: { ...REPRO, command: `node --test "${XSS}"` },
            registrations: [{ ...REPRO, command: `node --test "${XSS}"` }],
          }),
        })}
      />,
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('an abort reason a reproduction chose cannot close a tag', () => {
    // `verify.ts` names this field as attacker-influenced. The payload is the one that
    // breaks out of an attribute as well as out of an element.
    const html = render(
      <Evidence
        ended
        data={evidence({
          state: base({
            aborts: [
              { attempt: 1, phase: 'base', cause: 'recipe', reason: 'PORT=1 </script><img src=x onerror=alert(1)>' },
            ],
          }),
        })}
      />,
    );
    expect(html).not.toContain('</script>');
    expect(html).not.toContain('<img src=x');
  });

  test("a transcript's claimed type is the agent's own words and is escaped too", () => {
    const html = render(
      <Evidence ended data={evidence({ state: base({ transcript: [{ n: 1, claimed_type: XSS, raw_hash: 'sha256:m', bytes: 1 }] }) })} />,
    );
    expect(html).not.toContain('<script>');
  });

  test('an event payload reaching the timeline is escaped', () => {
    const frames: Frame[] = [
      { run_id: 'r', seq: 1, ts: '2026-09-06T10:00:00.000Z', type: 'REPRO_REGISTERED', payload: { command: XSS } },
    ];
    const html = render(<Timeline frames={frames} ended={false} />);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('the evidence page says what the engine can and cannot claim', () => {
  test('the transcript is testimony, with its count, and is never called evidence', () => {
    // ADR-0006. The fold keeps the transcript out of `artifactHashes` so nothing can reach
    // it as evidence by accident; presenting it under any other word here would undo that
    // in the one place a human actually reads.
    const html = render(<Evidence ended data={evidence()} />);
    expect(html).toContain('Testimony');
    expect(html).toContain('1 message');
    expect(html).toMatch(/input to no verdict/);
    // Scoped to the section, because "the evidence tarball" is a legitimate phrase further
    // down the page and an unscoped grep for the two words near each other reads it as a
    // mislabelled transcript. What must not happen is the transcript being CALLED evidence
    // where it is introduced.
    const testimony = html.slice(html.indexOf('Testimony'), html.indexOf('What this run cost'));
    expect(testimony).not.toMatch(/evidence/i);
  });

  test('a Tier 3 states the refusal as the deliverable, and shows no diff', () => {
    const html = render(
      <Evidence
        ended
        data={evidence({
          score: {
            scoring: 2,
            tier: 3,
            score: 0,
            ceiling: 103,
            grounds: [{ points: 0, claim: 'the run did not reproduce the reported bug', evidence: [] }],
            unmeasured: [],
          },
          state: base({ reproduced: false, reproducedAttempt: null }),
        })}
      />,
    );
    expect(html).toContain('No fix was attempted');
    expect(html).toMatch(/This is the deliverable, not a failure/);
    // The diff is the one thing a refusal must not show: there is no change being offered.
    expect(html).not.toContain('sha256:diff');
  });

  test('a fix that breaks the suite says so above everything else', () => {
    const html = render(<Evidence ended data={evidence({ state: base({ regression: 'broken' }) })} />);
    const warning = html.indexOf('breaks the project');
    const arm = html.indexOf('The reproduction arm');
    expect(warning).toBeGreaterThan(-1);
    // `report.ts` gives it the same position in the pull request, and for the same reason:
    // it is the one thing nobody should have to scroll for.
    expect(warning).toBeLessThan(arm);
  });

  test('a suite that never ran is not reported as a suite that passed', () => {
    const html = render(<Evidence ended data={evidence({ state: base({ regression: 'unknown', suiteRuns: [] }) })} />);
    expect(html).toMatch(/Not knowing is not the same as knowing it is fine/);
  });

  test('egress is not presented as a seal check', () => {
    // This page said the opposite once: it read a non-trivial egress number as a failed
    // seal, when every sealed phase shows kilobytes by construction.
    const html = render(<Evidence ended data={evidence()} />);
    expect(html).toMatch(/Egress is not a seal check/);
    expect(html).toContain('SANDBOX_SEALED');
  });

  test('a measure the platform did not report is a dash, not a zero', () => {
    const html = render(
      <Evidence ended data={evidence({ compute: [{ sandbox_id: 'sbx-1', phase: 'base', active_cpu_ms: null, duration_ms: null, egress_bytes: null }] })} />,
    );
    // IN THE CELL, not on the page. `toContain('—')` passed on the em dash in
    // "{regression} — the project's own test command", so deleting the whole compute table
    // would not have failed it.
    const row = html.slice(html.indexOf('sbx-1'), html.indexOf('</tr>', html.indexOf('sbx-1')));
    expect(row.match(/—/g)).toHaveLength(3);
    expect(row).not.toContain('0ms');
    expect(row).not.toContain('0KB');
  });

  test('confidence names the bytes a reviewer would open, and what was not measured', () => {
    const html = render(<Evidence ended data={evidence()} />);
    expect(html).toContain('sha256:b0');
    expect(html).toContain('Not measured');
    expect(html).toContain('whether the reproduction is independent of the fix');
  });

  test('a verdict is never colour alone', () => {
    // `.pass` and `.fail` are hues. On their own they are invisible to a reader with a
    // colour deficiency, to anyone printing this page, and to a screen reader — and on this
    // page a green 0 beside a red 1 IS the verdict.
    const html = render(<Evidence ended data={evidence()} />);
    expect(html).toContain('passed, ');
    expect(html).toContain('failed, ');
  });
});

describe('a run that has not finished does not report a verdict', () => {
  test('no tier and no confidence while it is still going', () => {
    // The fold's answer is about a FINISHED run. Printing the running total would show a
    // reader Tier 3 for the first three minutes of every successful run — a lie told by a
    // progress bar.
    const html = render(<Evidence ended={false} data={evidence()} />);
    expect(html).not.toContain('Confidence 90');
    expect(html).not.toContain('Not measured');
  });

  test('an empty arm says "not yet", not "never"', () => {
    const html = render(
      <Evidence ended={false} data={evidence({ state: base({ testRuns: [], registeredRepro: null, registrations: [] }) })} />,
    );
    expect(html).toContain('No reproduction registered yet');
    expect(html).not.toContain('was ever registered');
  });

  test('the same page, ended, says "never"', () => {
    const html = render(
      <Evidence ended data={evidence({ state: base({ testRuns: [], registeredRepro: null, registrations: [] }) })} />,
    );
    expect(html).toContain('No reproduction was ever registered');
  });
});

describe('the timeline reports events and decides nothing', () => {
  const frame = (seq: number, type: string, payload: unknown): Frame => ({
    run_id: 'r',
    seq,
    ts: '2026-09-06T10:00:00.000Z',
    type,
    payload,
  });

  // The seal's own assertions live in "the timeline reads the payloads the engine actually
  // writes" below, built from `SandboxSealedV1` rather than from a hand-typed object. The
  // two that stood here were written against the same guess the component made — a flat
  // `dns`/`route` — so they passed while every sealed sandbox in the product rendered as a
  // failure. A fixture invented alongside the code it checks is not a check.

  test('hundreds of agent turns collapse into one row that calls them testimony', () => {
    const frames = Array.from({ length: 40 }, (_, i) => frame(i + 1, 'AGENT_MESSAGE', {}));
    const html = render(<Timeline frames={frames} ended />);
    expect(html).toContain('40');
    expect(html).toMatch(/input to no verdict/);
    // One row, not forty.
    expect(html.split('<li').length - 1).toBe(1);
  });

  test('an unrecognised event is skipped rather than printed as its type', () => {
    const html = render(<Timeline frames={[frame(1, 'SOMETHING_NEW', {})]} ended />);
    expect(html).not.toContain('SOMETHING_NEW');
  });

  test('the last row of a live run is the thing currently happening', () => {
    const html = render(
      <Timeline frames={[frame(1, 'RUN_REQUESTED', {}), frame(2, 'ENV_BUILT', { snapshot: 'snap-1' })]} ended={false} />,
    );
    expect(html).toContain('data-state="doing"');
    expect(html.match(/data-state="doing"/g)?.length).toBe(1);
  });

  test('no row is "doing" once the run has ended', () => {
    const html = render(<Timeline frames={[frame(1, 'RUN_REQUESTED', {})]} ended />);
    expect(html).not.toContain('data-state="doing"');
  });

  test('an empty stream says a worker has not claimed the run, not that nothing happened', () => {
    const html = render(<Timeline frames={[]} ended={false} />);
    expect(html).toMatch(/worker has to claim this run/);
  });
});

describe('the landing page argues without manufacturing proof', () => {
  test('no invented social proof of any kind', () => {
    // A product arguing that a claim without evidence is worth nothing cannot open with one.
    const html = render(<Landing installUrl="https://example.invalid" signIn />);
    expect(html).not.toMatch(/trusted by|customers|testimonial|[0-9,]+\+? (users|teams|developers)/i);
  });

  test('the sign-in link exists only where signing in does', () => {
    // Locally there is no login — one operator, 127.0.0.1 — and offering one would be a
    // button that leads nowhere.
    expect(render(<Landing installUrl="https://x.invalid" signIn={false} />)).not.toContain('/auth/github');
    expect(render(<Landing installUrl="https://x.invalid" signIn />)).toContain('/auth/github');
  });

  test('it is pre-renderable — no hook, no fetch, no window', () => {
    // This is the markup Next writes into `index.html`, which is the one document a
    // crawler, a link preview or a reader with JavaScript disabled ever receives. A hook
    // here would make it an empty shell for all three.
    const html = render(<Landing installUrl="https://x.invalid" signIn />);
    expect(html).toContain('proves the bug existed');
    expect(html).toContain('Install on GitHub');
  });
});

describe('the header offers the way out only where there is one', () => {
  const me = (over: Partial<Me> = {}): Me => ({
    accounts: true,
    signedIn: true,
    login: 'divy97',
    mode: 'plane',
    installUrl: 'https://example.invalid',
    modelKey: { provider: 'openrouter' },
    secrets: { enabled: false },
    github: true,
    forgetting: true,
    ...over,
  });

  test('shows who you are and a sign out, when somebody is signed in', () => {
    const html = render(<Chrome me={me()} path="/runs" go={() => {}} />);
    expect(html).toContain('divy97');
    expect(html).toContain('Sign out');
    expect(html).toContain('action="/auth/logout"');
    // A form, not an anchor, and a real one: `POST` because a link that logs somebody out
    // is a link anybody's page can embed in an `<img>`.
    expect(html).toContain('method="post"');
  });

  test('offers nothing when nobody is', () => {
    // Anonymous on a hosted plane, and every page on a laptop, where there is no login to
    // end. A sign-out button with no session behind it is a control that does nothing.
    const html = render(<Chrome me={me({ signedIn: false, login: null })} path="/runs" go={() => {}} />);
    expect(html).not.toContain('Sign out');
    expect(html).not.toContain('/auth/logout');
  });

  test('a surface with no accounts offers no way out of one', () => {
    const html = render(<Chrome me={me({ accounts: false, login: null })} path="/runs" go={() => {}} />);
    expect(html).not.toContain('/auth/logout');
  });

  test('escapes the login, which came from GitHub rather than from us', () => {
    const html = render(<Chrome me={me({ login: '<script>alert(1)</script>' })} path="/runs" go={() => {}} />);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('the current section is marked, for a reader who cannot see the underline', () => {
    const html = render(<Chrome me={me()} path="/runs" go={() => {}} />);
    expect(html).toContain('aria-current="page"');
    // One, not three.
    expect(html.match(/aria-current="page"/g)?.length).toBe(1);
  });
});

/**
 * The command on the pairing page has to be the whole command.
 *
 * A new operator followed it exactly — clone, `npm ci`, run — and the runner refused,
 * naming four variables it had no way to look up. The two image names and the blob root are
 * things this repository already decides; only the model credential is genuinely the
 * operator's. The answer to the other three lived in a document about setting up a GitHub
 * App, which nothing in the pairing flow pointed at.
 */
describe('what the pairing page tells a stranger to run', () => {
  const minted = { token: 'tfr_x', name: 'laptop', planeUrl: 'https://plane.test' };

  test('builds the images, which a new machine does not have', () => {
    expect(render(<Minted minted={minted} />)).toContain('npm run images');
  });

  test('names the model key, which is the one thing that cannot be defaulted', () => {
    expect(render(<Minted minted={minted} />)).toContain('OPENROUTER_API_KEY');
  });

  test('says the token is on a command line, because that is where shell history comes from', () => {
    expect(render(<Minted minted={minted} />)).toContain('shell history');
  });

  test('the token and the plane URL are in the command, not described', () => {
    const html = render(<Minted minted={minted} />);
    expect(html).toContain('tfr_x');
    expect(html).toContain('https://plane.test');
  });
});

/**
 * Approving is a write with no visible result, and that made a working button look broken.
 *
 * A click that stored something and a click that stored the same thing again were
 * pixel-identical — so the first person to use this pasted a recipe, clicked, saw no
 * change, and reported that nothing happened. The click had worked. The paste had not
 * landed, and an empty recipe was approved for real, with the page unable to say either
 * way. The timestamp moves on every successful write, which is the difference made visible.
 */
describe('the environment screen says what approving did', () => {
  const detail = (over: Partial<RepoDetail> = {}): RepoDetail => ({
    repo: 'acme/widgets',
    account: 'acme',
    connectedAt: '2026-08-01T00:00:00.000Z',
    onboarded: true,
    recipe: { install: 'npm ci', services: [], test: 'npm test' },
    approvedAt: '2026-09-01T18:12:33.928Z',
    proof: null,
    draft: null,
    secrets: { names: [], enabled: false },
    runs: [],
    ...over,
  });
  const me: Me = {
    accounts: true,
    signedIn: true,
    login: 'divy97',
    mode: 'plane',
    installUrl: 'https://x.invalid',
    modelKey: null,
    secrets: { enabled: false },
    github: true,
    forgetting: true,
  };

  test('names when the recipe in force took force', () => {
    const html = render(<Environment repo="acme/widgets" detail={detail()} me={me} onChanged={() => {}} />);
    expect(html).toContain('In force');
    // The moving part: a second approval writes a new timestamp, so the screen changes even
    // when the recipe does not. Rendered as the machine-readable value here because the
    // human phrasing is computed against `Date.now()` in an effect — which is itself the
    // point, since a relative time baked into a pre-rendered document would be a lie about
    // when the image was built.
    expect(html).toContain('2026-09-01T18:12:33.928Z');
  });

  test('says nothing of the sort when no recipe has ever been approved', () => {
    const html = render(
      <Environment
        repo="acme/widgets"
        detail={detail({ recipe: null, approvedAt: null, onboarded: false })}
        me={me}
        onChanged={() => {}}
      />,
    );
    expect(html).not.toContain('In force');
  });

  test('the approval warning is above the box, on every state of the screen', () => {
    // ADR-0013: the person approving IS the control, and a control that is told what it is
    // controlling after it has acted is not one.
    for (const state of [detail(), detail({ recipe: null, approvedAt: null })]) {
      const html = render(<Environment repo="acme/widgets" detail={state} me={me} onChanged={() => {}} />);
      expect(html).toMatch(/you are the control/i);
      expect(html.indexOf('you are the control')).toBeLessThan(html.indexOf('<textarea'));
    }
  });

  test('a draft says an agent wrote it, and an approved recipe wins outright', () => {
    const drafted = render(
      <Environment
        repo="acme/widgets"
        detail={detail({ recipe: null, approvedAt: null, draft: { install: 'pip install -e .', services: [] } })}
        me={me}
        onChanged={() => {}}
      />,
    );
    expect(drafted).toMatch(/pre-filled by an agent, not by a person/);
    expect(drafted).toContain('pip install -e .');

    // Both present: the recipe in force is the one actually in force, and a draft beside it
    // reads as a live second proposal nobody asked for.
    const both = render(
      <Environment
        repo="acme/widgets"
        detail={detail({ draft: { install: 'pip install -e .', services: [] } })}
        me={me}
        onChanged={() => {}}
      />,
    );
    expect(both).not.toContain('pip install -e .');
    expect(both).not.toMatch(/pre-filled by an agent/);
  });

  test('a stored secret is listed by name, and the screen says values do not come back', () => {
    const html = render(
      <Environment
        repo="acme/widgets"
        detail={detail({ secrets: { names: ['STRIPE_KEY'], enabled: false } })}
        me={me}
        onChanged={() => {}}
      />,
    );
    expect(html).toContain('STRIPE_KEY');
    // NOT an alternation over both polarities, which is what stood here — it accepted the
    // copy promising a stored value COULD be shown again. The sentence was rewritten at the
    // same time, because a claim this important should not need a lookahead to read.
    expect(html).toMatch(/a value is\s+never returned/);
    // No control that implies a value can be read back. Adding one is the first step
    // towards writing the route that returns it.
    expect(html).not.toMatch(/reveal|show value|copy value/i);
  });

  test('storing while injection is off says the value is held and not used', () => {
    const html = render(
      <Environment repo="acme/widgets" detail={detail({ secrets: { names: ['A'], enabled: false } })} me={me} onChanged={() => {}} />,
    );
    expect(html).toMatch(/not yet injected into any run/i);
  });

  test('a repository name reaches the screen as text', () => {
    const html = render(
      <Environment repo={'acme/<script>alert(1)</script>'} detail={detail()} me={me} onChanged={() => {}} />,
    );
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});

/**
 * The two places this repository writes down what an event is.
 *
 * `web/` is a separate bundle with a separate toolchain, so it cannot import `src/events.ts`
 * — sixteen strings are not worth dragging the engine into a browser build for. What makes
 * the duplication safe is this file, and until it existed the comments on both copies
 * claimed it did.
 */
describe('the dashboard and the engine agree on what an event is', () => {
  test('the two lists of event types are identical', () => {
    // Not "the client is a subset". An extra name is as wrong as a missing one: it can never
    // match, so it sits in a list looking like coverage — which is exactly what
    // `OBSERVATION_ABORTED` and `RUN_BLOCKED` did while the real `VERIFICATION_ABORTED` was
    // absent and an abort never refreshed the verdict.
    expect([...CLIENT_EVENT_TYPES].sort()).toEqual([...EVENT_TYPES].sort());
  });

  test('every type the log can carry is one the timeline was asked about', () => {
    // A weaker claim than "renders something", deliberately: the timeline SKIPS what it has
    // no sentence for, and that is the right behaviour. What this catches is a type nobody
    // considered — it will be skipped silently, and this says so by name.
    const unhandled = EVENT_TYPES.filter((type) => {
      const html = render(
        <Timeline frames={[{ run_id: 'r', seq: 1, ts: '2026-09-06T10:00:00.000Z', type, payload: {} }]} ended />,
      );
      return !html.includes('<li');
    });
    // `AGENT_MESSAGE` is deliberately absent from the list: it is collapsed into a count,
    // and one on its own is a row. Everything else must produce a row.
    expect(unhandled).toEqual([]);
  });
});

/**
 * THE test the timeline needed and did not have.
 *
 * Its `describe()` reads payload fields by name, and getting a name wrong is silent: the
 * read is `undefined`, the sentence still renders, and it is plausible. Five were wrong at
 * once — including `SANDBOX_SEALED`, whose `dns` and `route` are nested under `probe`, so
 * every correctly sealed sandbox of every run rendered with a red ✗ and the words *"a probe
 * inside it still found: DNS, a route"*. The seal is this product's central claim.
 *
 * The fixtures below are built from `src/events.ts`'s own payload TYPES, so a field that
 * moves is a compile error here before it is a wrong sentence in a browser.
 */
describe('the timeline reads the payloads the engine actually writes', () => {
  const frame = (type: string, payload: unknown): Frame => ({
    run_id: 'r',
    seq: 1,
    ts: '2026-09-06T10:00:00.000Z',
    type,
    payload,
  });

  test('a sealed sandbox is not reported as a leaking one', () => {
    const payload: SandboxSealedV1 = {
      v: 1,
      sandbox_id: 'sbx-1',
      phase: 'base',
      policy: 'deny-all',
      probe: { dns: false, route: false },
    };
    const html = render(<Timeline frames={[frame('SANDBOX_SEALED', payload)]} ended />);
    expect(html).toMatch(/no DNS and no route out/);
    expect(html).not.toContain('data-state="failed"');
    expect(html).not.toMatch(/still found/);
  });

  test('and one that leaked is', () => {
    const payload: SandboxSealedV1 = {
      v: 1,
      sandbox_id: 'sbx-1',
      phase: 'agent',
      policy: 'deny-all',
      probe: { dns: true, route: false },
    };
    const html = render(<Timeline frames={[frame('SANDBOX_SEALED', payload)]} ended />);
    expect(html).toContain('data-state="failed"');
    expect(html).toMatch(/still found: DNS/);
  });

  test('a payload with no probe at all says so, rather than claiming a seal', () => {
    // A log written before the probe existed. "Not recorded" and "it held" are different
    // facts and this page may not conflate them.
    const html = render(<Timeline frames={[frame('SANDBOX_SEALED', { v: 1, policy: 'deny-all' })]} ended />);
    expect(html).toMatch(/No probe was recorded/);
    expect(html).not.toMatch(/no DNS and no route out/);
  });

  test('a run ends with its reason, not with the word "ended"', () => {
    const payload: RunEndedV1 = { v: 1, reason: 'not_reproduced' };
    const html = render(<Timeline frames={[frame('RUN_ENDED', payload)]} ended />);
    // And the refusal is stated as the refusal, not as a failure: the gate holding is the
    // deliverable everywhere else in this product, and the timeline may not be the one
    // place that presents it as something going wrong.
    expect(html).toMatch(/the bug was not reproduced, so no fix was attempted/);
    expect(html).not.toContain('data-state="failed"');
  });

  test('an errored run is marked failed, which the wrong field name made unreachable', () => {
    const html = render(<Timeline frames={[frame('RUN_ENDED', { v: 1, reason: 'error' } as RunEndedV1)]} ended />);
    expect(html).toContain('data-state="failed"');
  });

  test('an attempt is numbered', () => {
    const payload: AttemptStartedV1 = { v: 1, n: 2 };
    expect(render(<Timeline frames={[frame('ATTEMPT_STARTED', payload)]} ended />)).toMatch(/Attempt 2/);
  });

  test('a sandbox names itself, and a request quotes the report', () => {
    const created: SandboxCreatedV1 = { v: 1, sandbox_id: 'sbx-9', image_ref: 'sha256:img' };
    expect(render(<Timeline frames={[frame('SANDBOX_CREATED', created)]} ended />)).toContain('sbx-9');

    const requested: RunRequestedV1 = {
      v: 1,
      source: 'github',
      thread_ref: 'acme/widgets#41',
      raw_text: 'the cart total is wrong for shipped orders',
    };
    expect(render(<Timeline frames={[frame('RUN_REQUESTED', requested)]} ended />)).toContain('the cart total is wrong');
  });

  test('a fix is measured in files, and an abort quotes its reason', () => {
    const diff: FixDiffObservedV1 = {
      v: 1,
      base_sha: 'a',
      fix_sha: 'b',
      changed_files: ['src/cart.mjs', 'package-lock.json'],
      diff_hash: 'sha256:d',
    };
    const measured = render(<Timeline frames={[frame('FIX_DIFF_OBSERVED', diff)]} ended />);
    expect(measured).toMatch(/2<\/b> files changed/);
    expect(measured).toContain('src/cart.mjs');

    const abort: VerificationAbortedV1 = { v: 1, phase: 'base', reason: 'the repro command never exited' };
    const stopped = render(<Timeline frames={[frame('VERIFICATION_ABORTED', abort)]} ended />);
    expect(stopped).toContain('the repro command never exited');
    expect(stopped).toContain('data-state="failed"');
  });
});

describe('the positive controls the negatives need', () => {
  test('a reproduced run DOES show the diff', () => {
    // The other half of "a Tier 3 shows no diff". Without it, `{false && …}` — never
    // rendering the diff at all — passes every assertion in this file.
    const html = render(<Evidence ended data={evidence()} />);
    expect(html).toContain('The diff');
    expect(html).toContain('src/cart.mjs');
    expect(html).toContain('sha256:diff');
  });

  test('and the cost section is absent when there is nothing to bill', () => {
    const html = render(<Evidence ended data={evidence({ usage: [], compute: [] })} />);
    expect(html).not.toContain('What this run cost');
    expect(html).not.toContain('Egress is not a seal check');
  });

  test('a broken suite quotes the run that broke, not a placeholder', () => {
    // The fixture used to set `regression: 'broken'` while every suite run exited 0, so the
    // page read "exits 0 on this one" and nothing noticed. The command, the exit code and
    // the output hash all come from the fold's own row.
    const html = render(
      <Evidence
        ended
        data={evidence({
          state: base({
            regression: 'broken',
            suiteRuns: [
              { attempt: 1, phase: 'base', command: 'npm test', exit_code: 0, stdout_hash: 'sha256:s0' },
              { attempt: 1, phase: 'fix', command: 'npm test', exit_code: 1, stdout_hash: 'sha256:broke' },
            ],
          }),
        })}
      />,
    );
    expect(html).toMatch(/exits 1 on this one/);
    expect(html).toContain('sha256:broke');
    expect(html).not.toMatch(/exits 0 on this one/);
  });
});

describe('the run register, which had a link on every page and no test at all', () => {
  const run = (over: Partial<RunRow> = {}): RunRow => ({
    run_id: '3f1c9a52-7b0e-4d2f-9c41-8a6e5d0b21c7',
    repo: 'acme/widgets',
    issue_number: 41,
    status: 'pr_opened',
    tier: 2,
    confidence: 90,
    ceiling: 103,
    scoring: 2,
    regression: 'clean',
    pr_url: null,
    started_at: '2026-09-06T10:00:00.000Z',
    ended_at: '2026-09-06T10:04:00.000Z',
    last_seq: 8,
    ...over,
  });

  test('a finished run shows its tier, its suite and its confidence', () => {
    const html = render(<Runs.Register rows={[run()]} repo={null} go={() => {}} />);
    expect(html).toContain('90/103');
    expect(html).toMatch(/clean/);
    expect(html).toMatch(/reproduced, but the reproduction/);
  });

  test('a fix that breaks the suite says so on the list, not only on the run', () => {
    // This column existed on the page 10i replaced and was dropped by the replacement: a
    // run whose fix breaks the project's own suite looked exactly like one that does not,
    // on the screen people scan.
    const html = render(<Runs.Register rows={[run({ regression: 'broken' })]} repo={null} go={() => {}} />);
    expect(html).toMatch(/broken by the fix/);
    expect(html).toContain('✗');
  });

  test('a run still going reports no verdict at all', () => {
    const html = render(
      <Runs.Register rows={[run({ status: 'attempting', ended_at: null })]} repo={null} go={() => {}} />,
    );
    expect(html).toMatch(/running/);
    // No tier, no confidence, no suite — the fold has not reached any of them.
    expect(html).not.toContain('90/103');
    expect(html).not.toMatch(/clean/);
  });

  test('an empty list says which emptiness it is', () => {
    expect(render(<Runs.Register rows={[]} repo={null} go={() => {}} />)).toMatch(/No run has been started yet/);
    expect(render(<Runs.Register rows={[]} repo="acme/widgets" go={() => {}} />)).toMatch(
      /No run has been started on acme\/widgets/,
    );
  });
});

describe('the repository register', () => {
  const repo = (over: Partial<RepoRow> = {}): RepoRow => ({
    repo: 'acme/widgets',
    account: 'acme',
    connectedAt: '2026-08-01T00:00:00.000Z',
    onboarded: true,
    runs: 3,
    ...over,
  });
  const me: Me = {
    accounts: true,
    signedIn: true,
    login: 'divy97',
    mode: 'plane',
    installUrl: 'https://example.invalid/install',
    modelKey: null,
    secrets: { enabled: false },
    github: true,
    forgetting: true,
  };

  test('the un-onboarded row is the one that carries the link that resolves it', () => {
    // "Not onboarded yet" is the row's most important column: a run against a repository
    // with no recipe boots nothing and reports a bug that was never shown.
    const html = render(<Repos.Register rows={[repo({ onboarded: false, runs: 0 })]} me={me} go={() => {}} />);
    expect(html).toMatch(/not onboarded yet/);
    expect(html).toContain('/repos/acme/widgets');
  });

  test('the two states are split, not sorted', () => {
    const html = render(
      <Repos.Register rows={[repo(), repo({ repo: 'acme/legacy', onboarded: false })]} me={me} go={() => {}} />,
    );
    expect(html.indexOf('Onboarded')).toBeLessThan(html.indexOf('Connected, not onboarded'));
    // The plural agrees with the total. "1 of 2 repository is onboarded" is what agreeing
    // with the onboarded count produces, and that is what this said.
    expect(html).toMatch(/1 of 2 repositories are onboarded/);
    expect(html).toMatch(/The other is connected and waiting/);
  });

  test('an empty account is offered the install button, not an empty table', () => {
    const html = render(<Repos.Register rows={[]} me={me} go={() => {}} />);
    expect(html).toMatch(/No repositories are connected yet/);
    expect(html).toContain('https://example.invalid/install');
  });

  test('a repository name with a fragment in it cannot truncate the link', () => {
    // GitHub's string, not ours. A `#` ends the path at the fragment and links somewhere
    // else entirely; the separator between owner and name has to survive, because the
    // router matches on it.
    const html = render(<Repos.Register rows={[repo({ repo: 'acme/wid#gets' })]} me={me} go={() => {}} />);
    expect(html).toContain('/repos/acme/wid%23gets');
    expect(html).not.toContain('/repos/acme/wid#gets');
  });
});

/**
 * The sentences that ARE the argument.
 *
 * Each of these has been wrong at least once, and none of them is decoration: ADR-0013's
 * approval warning is the whole basis on which storing shell commands is acceptable, and
 * ADR-0007's amendment forbids presenting a validation refusal as a finding about somebody's
 * project. They were asserted on the rendered page before 10i and on nothing afterwards.
 */
describe('the copy that carries a decision', () => {
  const detail = (over: Partial<RepoDetail> = {}): RepoDetail => ({
    repo: 'acme/widgets',
    account: 'acme',
    connectedAt: '2026-08-01T00:00:00.000Z',
    onboarded: true,
    recipe: { install: 'npm ci', services: [], test: 'npm test' },
    approvedAt: '2026-09-01T18:12:33.928Z',
    proof: null,
    draft: null,
    secrets: { names: [], enabled: false },
    runs: [],
    ...over,
  });
  const me: Me = {
    accounts: true, signedIn: true, login: 'divy97', mode: 'plane',
    installUrl: 'https://x.invalid', modelKey: null,
    secrets: { enabled: false }, github: true, forgetting: true,
  };
  const env = (over: Partial<RepoDetail> = {}) =>
    render(<Environment repo="acme/widgets" detail={detail(over)} me={me} onChanged={() => {}} />);

  test('ADR-0013: what approving actually authorises, in the words the CLI uses', () => {
    const html = env();
    expect(html).toContain('verbatim');
    expect(html).toMatch(/with a package registry reachable/);
    expect(html).toMatch(/Nothing sandboxes them from that sandbox/);
    expect(html).toMatch(/you are the control/i);
  });

  test('ADR-0017: a secret that is stored and not injected says which', () => {
    const html = env({ secrets: { names: ['STRIPE_KEY'], enabled: false } });
    expect(html).toMatch(/nothing worth stealing lives in it/);
    expect(html).toContain('ADR-0017');
    expect(html).toMatch(/not yet injected into any run/i);
  });

  test('and one that IS injected says what that does and does not buy', () => {
    // The other branch, which nothing rendered. A value in a sealed sandbox satisfies a
    // startup check and cannot reach the service it authenticates to — somebody who is not
    // told that stores a real key and files a bug about a timeout.
    const html = env({ secrets: { names: ['STRIPE_KEY'], enabled: true } });
    expect(html).toMatch(/no route out/);
    expect(html).not.toMatch(/not yet injected/i);
  });

  test('10j: configuration goes in the recipe, a credential goes in required', () => {
    const html = env();
    expect(html).toMatch(/Environment variables: configuration here/);
    expect(html).toContain('required');
    expect(html).toMatch(/a <code>blocked<\/code> run/);
    expect(html).toMatch(/not a finding about anybody/);
  });

  test('nothing stored yet says so, rather than showing an empty list', () => {
    expect(env({ secrets: { names: [], enabled: false } })).toMatch(/Nothing is stored for acme\/widgets yet/);
  });
});

describe('the proof of a repository, which is stored as opaque JSON', () => {
  const detail = (proof: unknown): RepoDetail => ({
    repo: 'acme/widgets', account: 'acme', connectedAt: '2026-08-01T00:00:00.000Z',
    onboarded: true, recipe: { install: 'npm ci', services: [], test: 'npm test' },
    approvedAt: '2026-09-01T18:12:33.928Z', proof, draft: null,
    secrets: { names: [], enabled: false }, runs: [],
  });
  const me: Me = {
    accounts: true, signedIn: true, login: 'divy97', mode: 'plane',
    installUrl: 'https://x.invalid', modelKey: null,
    secrets: { enabled: false }, github: true, forgetting: true,
  };
  const proof = (it: unknown) =>
    render(<Environment repo="acme/widgets" detail={detail(it)} me={me} onChanged={() => {}} />);

  test('not proved yet says a proving run is what fills it', () => {
    const html = proof(null);
    expect(html).toMatch(/Not proved yet/);
    expect(html).toMatch(/sealed container that judges a fix/);
  });

  test('ready says both halves: the environment built and the suite passed', () => {
    const html = proof({ state: 'ready', provedAt: 'T', suite: { command: 'npm test', exitCode: 0 } });
    expect(html).toMatch(/Ready\./);
    expect(html).toContain('exit 0');
  });

  test('blocked says no run here can reproduce anything', () => {
    const html = proof({ state: 'blocked', provedAt: 'T', environment: { built: false, failed: 'npm ci exited 127' } });
    expect(html).toMatch(/Blocked\./);
    expect(html).toContain('npm ci exited 127');
    expect(html).toMatch(/no run here can reproduce anything/);
  });

  test('caveats and the things this engine did not check at all are kept apart', () => {
    const html = proof({
      state: 'caveats',
      provedAt: 'T',
      suite: { command: 'npm test', exitCode: 1 },
      caveats: ['the test command `npm test` already fails at this commit (exit 1)'],
      unproved: ['whether your production data shape matches the seed'],
    });
    expect(html).toMatch(/Ready, with caveats/);
    expect(html).toContain('already fails at this commit');
    expect(html).toMatch(/Not checked by this engine at all/);
    expect(html).toContain('whether your production data shape matches the seed');
  });

  test('a proof written by an older engine renders rather than throwing', () => {
    // Stored as opaque JSON and read back the same way. A field that did not exist yet must
    // render as absent — in a bundle, a throw here is a blank page rather than one bad panel.
    expect(() => proof({ state: 'ready' })).not.toThrow();
    expect(() => proof({})).not.toThrow();
    expect(() => proof({ state: 'ready', suite: null, caveats: 'not an array' })).not.toThrow();
  });
});

describe('the skeleton in an empty recipe box', () => {
  test('parses, and stores a recipe that runs nothing', () => {
    // Two traps at once. A COMMENTED skeleton does not parse, so a reader who fills it in
    // is met with a syntax error they were handed — on the one screen whose first act is to
    // tell them they got it wrong. And a plausible `npm install` placeholder is a command
    // this engine would execute verbatim against somebody's repository because it was
    // pre-typed for them.
    const html = render(
      <Environment
        repo="acme/widgets"
        detail={{
          repo: 'acme/widgets', account: 'acme', connectedAt: '2026-08-01T00:00:00.000Z',
          onboarded: false, recipe: null, approvedAt: null, proof: null, draft: null,
          secrets: { names: [], enabled: false }, runs: [],
        }}
        me={{
          accounts: true, signedIn: true, login: 'd', mode: 'plane', installUrl: 'https://x.invalid',
          modelKey: null, secrets: { enabled: false }, github: true, forgetting: true,
        }}
        onChanged={() => {}}
      />,
    );
    const box = html.slice(html.indexOf('<textarea'), html.indexOf('</textarea>'));
    const skeleton = box.slice(box.indexOf('>') + 1).replace(/&quot;/g, '"');
    const parsed = JSON.parse(skeleton) as Record<string, unknown>;
    // Every command empty, `services` an empty list. `parseRecipe` reads `''` as absent, so
    // approving this unchanged stores a recipe that runs nothing at all.
    expect(parsed).toEqual({ install: '', migrate: '', seed: '', services: [], test: '' });
    expect(skeleton).not.toMatch(/npm install|pip install|bundle install/);
  });
});
