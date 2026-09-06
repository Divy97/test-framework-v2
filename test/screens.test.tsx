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
import type { Evidence as EvidenceData, Frame } from '../web/lib/api';
import { Evidence } from '../web/components/views/Evidence';
import { Landing } from '../web/components/views/Landing';
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
  testRuns: [
    { phase: 'base', repeat: 0, commit_sha: '8d41c6b2a09f1234', exit_code: 1, symptom_matched: true, stdout_hash: 'sha256:b0' },
    { phase: 'fix', repeat: 0, commit_sha: 'aa41c6b2a09f1234', exit_code: 0, symptom_matched: false, stdout_hash: 'sha256:f0' },
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
    reproduced: true,
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
      { seq: 1, ts: '2026-09-06T10:00:00.000Z', type: 'REPRO_REGISTERED', payload: { command: XSS } },
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
    expect(html).toContain('—');
    expect(html).not.toContain('0ms');
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
    seq,
    ts: '2026-09-06T10:00:00.000Z',
    type,
    payload,
  });

  test('a sealed sandbox says what the probe INSIDE it found', () => {
    const html = render(
      <Timeline frames={[frame(1, 'SANDBOX_SEALED', { policy: 'deny-all', dns: false, route: false })]} ended />,
    );
    expect(html).toMatch(/probe inside it found no DNS and no route out/);
  });

  test('a seal that did not hold is marked failed, and names what got through', () => {
    const html = render(
      <Timeline frames={[frame(1, 'SANDBOX_SEALED', { policy: 'deny-all', dns: true, route: false })]} ended />,
    );
    expect(html).toContain('data-state="failed"');
    expect(html).toContain('DNS');
  });

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
