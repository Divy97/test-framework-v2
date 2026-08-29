// An issue in, a pull request out — with a local bare repo where GitHub would be.
//
// This is 5e's done-when minus GitHub: "an issue opened on the demo repository
// produces a PR on the same repository with no human step between them, and no
// container ever held the token." Every step is real — the HMAC, the token mint, the
// clone, the containers, the push, the PR body, the comment — except that the remote
// is a bare repository on disk and the API is a `fetch` that records.
//
// What that leaves untested is whether GitHub accepts any of it. Named, not implied:
// the live test at the end of `github.test.ts` is skipped and says so.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { RunEvent } from '../src/events.js';
import { confidence } from '../src/confidence.js';
import { intake, startWebhookReceiver, type IssueIntake } from '../src/github.js';

/**
 * `intake()` for an issue delivery, narrowed.
 *
 * It returns a union since M6a — installation deliveries carry no issue — and
 * `runFromIssue` takes the issue arm specifically. Narrowing here rather than casting at
 * each call site means a delivery that stops mapping to an issue fails loudly, in the
 * test, rather than being asserted into the right shape.
 */
const issueIntake = (payload: unknown): IssueIntake => {
  const mapped = intake('issues', payload);
  if (!mapped || mapped.kind !== 'issue') throw new Error('the delivery did not map to an issue');
  return mapped;
};
import { runFromIssue, symptomFrom } from '../src/run.js';
import { call, fakeModel, type FakeModel } from './fixtures/model.js';
import { cleanupFixtures, demoRecipe, demoRepo } from './fixtures/repo.js';
import { get } from '../src/blobs.js';
import type { ArtifactRef } from '../src/events.js';

const IMAGE = 'test-framework-v2-sandbox:test';
const SECRET = 'a-webhook-secret';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const dirs: string[] = [];
const models: FakeModel[] = [];

afterEach(async () => {
  for (const model of models.splice(0)) await model.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  cleanupFixtures();
});

const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const hostBlobs = () => {
  const dir = temp('engine-runblobs-');
  writeFileSync(join(dir, '.evidence-store'), '');
  return dir;
};

const dockerAvailable = () => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** The issue as GitHub would deliver it. */
const delivery = (body: string) => ({
  action: 'opened',
  issue: { number: 41, title: 'The orders page title is misspelled', body, html_url: 'https://github.com/o/r/issues/41' },
  repository: { full_name: 'o/r', default_branch: 'main' },
  installation: { id: 987654 },
});

/** A bare repository, standing in for GitHub. Cloned from and pushed to for real. */
function bareRemote(source: string): string {
  const bare = temp('engine-remote-');
  execFileSync('git', ['clone', '--quiet', '--bare', source, join(bare, 'repo.git')]);
  return join(bare, 'repo.git');
}

describe('the receiver, over HTTP, as GitHub would call it', () => {
  test('a signed issue becomes an intake and an unsigned one becomes a 401', async () => {
    const seen: unknown[] = [];
    const receiver = await startWebhookReceiver({ secret: SECRET, onIntake: (i) => void seen.push(i) });
    try {
      const url = `http://127.0.0.1:${receiver.port}/`;
      const body = JSON.stringify(delivery('It says "Ordres" instead of "Orders".'));
      const sign = (text: string) => `sha256=${createHmac('sha256', SECRET).update(text).digest('hex')}`;

      const good = await fetch(url, {
        method: 'POST',
        headers: { 'x-github-event': 'issues', 'x-hub-signature-256': sign(body), 'content-type': 'application/json' },
        body,
      });
      expect(good.status).toBe(202);
      await good.text();

      // Unsigned, wrongly signed, and signed for a DIFFERENT body — the third being
      // the one a replay would use.
      const attempts: Record<string, string>[] = [
        { 'x-github-event': 'issues' },
        { 'x-github-event': 'issues', 'x-hub-signature-256': 'sha256=deadbeef' },
        { 'x-github-event': 'issues', 'x-hub-signature-256': sign('{}') },
      ];
      for (const headers of attempts) {
        const bad = await fetch(url, { method: 'POST', headers, body });
        expect(bad.status).toBe(401);
        await bad.text();
      }

      // A trigger we do not act on is ACCEPTED, not refused: GitHub retries a
      // non-2xx, and retrying a `push` forever is worse than saying so once.
      const ignored = await fetch(url, {
        method: 'POST',
        headers: { 'x-github-event': 'push', 'x-hub-signature-256': sign(body), 'content-type': 'application/json' },
        body,
      });
      expect(ignored.status).toBe(202);
      expect(await ignored.text()).toMatch(/not a trigger/);

      const notPost = await fetch(url);
      expect(notPost.status).toBe(405);
      await notPost.text();

      // Exactly one intake, from the one authentic delivery.
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ repo: 'o/r', issueNumber: 41, installationId: 987654 });
    } finally {
      await receiver.close();
    }
  });
});

describe('the symptom pattern comes from the report, and is escaped', () => {
  test('a quoted string wins, and regex metacharacters cannot survive', () => {
    // The base phase's output has to MATCH the reported symptom, and before any agent
    // has read anything the report is all there is.
    expect(symptomFrom('It says "Ordres" instead of "Orders".')).toBe('Ordres');
    // An issue is attacker-influenced text. An unescaped `(` from a bug report would
    // be a regex someone else wrote, and `new RegExp` on it would throw inside the
    // container — an operational failure caused by a bug report.
    expect(symptomFrom('the total is `(wrong)` here')).toBe('\\(wrong\\)');
    expect(() => new RegExp(symptomFrom('a [b(c'))).not.toThrow();
    expect(symptomFrom('')).toBe('');
  });

  test('an ordinary report yields its title, not one word out of the middle', () => {
    // The defect the first real webhook-driven run exposed. This used to return the
    // longest word over five characters, so the issue below derived `"everything"` — and
    // the engine then refused a genuinely correct reproduction (`Expected 2 shipped
    // orders, got 4`) because that output contains no such word. `not_reproduced`, on a
    // real bug that had been shown.
    const issue =
      'The shipped filter returns everything\n\n' +
      '/api/orders?status=shipped returns every order, including pending ones.';
    expect(symptomFrom(issue)).toBe('The shipped filter returns everything');
    expect(symptomFrom(issue)).not.toBe('everything');
  });

  test('a one-word anchor is refused, because it would match almost any output', () => {
    // The deeper problem, and the reason this is not just about ergonomics: ADR-0008
    // wants the output to prove THIS bug failed rather than some other thing. A common
    // word matches unrelated prose, so a weak anchor is a broken gate even when the
    // agent satisfies it.
    const symptom = symptomFrom('Orders page is broken\n\nthe totals look wrong sometimes');
    expect(symptom.split(' ').length).toBeGreaterThan(1);
  });

  test('a title too short to anchor anything falls through to the body', () => {
    expect(symptomFrom('Bug\n\nthe orders total is wrong for order 3')).toBe(
      'the orders total is wrong for order 3',
    );
  });

  test('a very long title is cut at a word boundary, never mid-word', () => {
    const long = `the export button does nothing at all when I click it ${'and again '.repeat(12)}`;
    const symptom = symptomFrom(long);
    expect(symptom.length).toBeLessThanOrEqual(100);
    // The property is that the cut lands ON a boundary — the next character in the
    // original is a space or the end. Asserting a particular last word instead would be
    // asserting the fixture, since "…and again and" ends at a boundary perfectly well.
    expect(long.startsWith(symptom)).toBe(true);
    expect([' ', undefined]).toContain(long[symptom.length]);
  });
});

describe.skipIf(!dockerAvailable())('an issue produces a pull request, with no human step', () => {
  test('the whole path: clone, containers, push, PR body, comment', async () => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '.'], { cwd: process.cwd() });
    const fixture = demoRepo();
    const remotePath = bareRemote(fixture.repo);
    const blobs = hostBlobs();

    // The API, recorded. Nothing here talks to github.com.
    const calls: { url: string; body: unknown }[] = [];
    const recorder = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      calls.push({ url: target, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (target.endsWith('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'ghs_minted' }), { status: 201 });
      }
      if (target.endsWith('/pulls')) {
        return new Response(
          JSON.stringify({ number: 7, head: { sha: 'f'.repeat(40) }, html_url: 'https://github.com/o/r/pull/7' }),
          { status: 201 },
        );
      }
      return new Response('{}', { status: 201 });
    }) as typeof fetch;

    // A scripted agent that actually does the job: writes a failing unit test over
    // the demo's page template, registers it, and then fixes the heading.
    // A test over the page TEMPLATE, not over the source text. It runs with no
    // browser, no service and no network — which is what makes it something a sealed
    // phase container can judge.
    const repro =
      "import assert from 'node:assert/strict';\n" +
      "import { test } from 'node:test';\n" +
      "import { page } from '../page.mjs';\n" +
      "test('the orders heading is spelled correctly', () => {\n" +
      "  assert.match(page([]), /<h1>Orders<\\/h1>/, 'Ordres: the heading is misspelled');\n" +
      '});\n';
    const model = await fakeModel([
      { content: [call('write', { path: 'test/heading.test.mjs', content: repro })], stop_reason: 'tool_use' },
      {
        content: [
          call(
            'write',
            {
              path: '.engine/repro.json',
              content: JSON.stringify({
                command: 'node --test test/heading.test.mjs',
                files: ['test/heading.test.mjs', '.engine/repro.json'],
              }),
            },
            'toolu_w2',
          ),
        ],
        stop_reason: 'tool_use',
      },
      { content: [call('git_commit', { message: 'test: reproduce the heading' }, 'toolu_c1')], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'reproduced' }], stop_reason: 'end_turn' },
      // The FIX agent, in a container spawned only after the base phase went red.
      {
        content: [
          call('edit', { path: 'page.mjs', old_string: '<h1>Ordres</h1>', new_string: '<h1>Orders</h1>' }, 'toolu_e'),
        ],
        stop_reason: 'tool_use',
      },
      { content: [call('git_commit', { message: 'fix: spell the orders heading' }, 'toolu_c2')], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'fixed' }], stop_reason: 'end_turn' },
    ]);
    models.push(model);

    const events: RunEvent[] = [];
    const mapped = issueIntake(delivery('It says "Ordres" instead of "Orders".'));
    const result = await runFromIssue({
      intake: mapped,
      app: { appId: '123456', privateKeyPem: PEM, api: 'https://api.test.invalid', fetch: recorder },
      recipe: null,
      image: IMAGE,
      blobRoot: blobs,
      append: async (event) => void events.push(event),
      remote: () => remotePath,
      flakeRuns: 2,
      loop: { provider: 'anthropic', apiKey: 'sk-ant-not-a-real-key', baseURL: model.baseURL, timeoutMs: 300_000 },
    });

    // THE VERDICT. Red on base for the reported reason, green on the fix every time,
    // the series vouched for — and Tier 2, because the party under judgement wrote
    // the reproduction.
    expect(result.state.reproduced).toBe(true);
    expect(result.state.reproAuthoredByAgent).toBe(true);
    expect(result.state.testRuns.filter((r) => r.phase === 'fix')).toHaveLength(3);
    expect(result.state.status).toBe('pr_opened');

    // THE ORDER, proved by seq rather than asserted: the reproduction was registered
    // before the fix agent said its first word (ADR-0008).
    const seqOf = (type: string) => events.findIndex((e) => e.type === type);
    const registered = seqOf('REPRO_REGISTERED');
    const handovers = events.filter((e) => e.type === 'AGENT_HANDED_OVER');
    expect(registered).toBeGreaterThan(-1);
    expect(events.findIndex((e, i) => i > registered && e.type === 'AGENT_MESSAGE')).toBeGreaterThan(registered);
    expect(handovers.map((e) => (e.payload as { kind: string }).kind)).toEqual(['repro', 'fix']);

    // WHAT THE FIX AGENT WAS TOLD, out of the requests the model actually received.
    //
    // It had the command and never the failure. Its first act was therefore always to
    // re-run the command to discover something the engine had already observed and
    // hashed — and if the sandbox and the phase container disagree, the failure it finds
    // is not the failure it is judged on. This asserts the observed bytes crossed.
    const prompts = model.requests
      .flatMap((request) => (request.messages as { content: unknown }[] | undefined) ?? [])
      .map((message) => JSON.stringify(message.content));
    const fixPrompt = prompts.find((text) => text.includes('You are fixing a reported bug'));
    expect(fixPrompt).toBeDefined();
    // The assertion message the repro prints on base, quoted back from the blob store.
    expect(fixPrompt).toContain('Ordres: the heading is misspelled');
    // And the suite baseline, so "do not break it" is a statement about something known.
    expect(fixPrompt).toMatch(/node --test/);

    // THE REGRESSION ARM, absent here on purpose: this run passes `recipe: null`, so
    // there is no test command and nothing to compare. `unmeasured` is the honest answer
    // and it must not read as a pass — the recipe-bearing run below is where `clean` is
    // asserted.
    expect(result.state.suiteRuns).toEqual([]);
    expect(result.state.regression).toBe('unmeasured');

    // THE PUSH happened, against the real remote, on a branch we created.
    const branches = execFileSync('git', ['-C', remotePath, 'for-each-ref', '--format=%(refname:short)'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    expect(branches.some((b) => b.startsWith('engine/run-'))).toBe(true);
    // And the pushed commit is the one that was verified, not merely the latest.
    const pushed = execFileSync(
      'git',
      ['-C', remotePath, 'rev-parse', branches.find((b) => b.startsWith('engine/run-'))!],
      { encoding: 'utf8' },
    ).trim();
    expect(pushed).toBe(result.state.handedOver);
    expect(result.state.testRuns.find((r) => r.phase === 'fix')!.commit_sha).toBe(pushed);

    // THE PULL REQUEST, with its five mandatory sections and its evidence.
    const pr = calls.find((c) => c.url.endsWith('/pulls'))!.body as { title: string; body: string; head: string };
    for (const heading of ['## The bug', '## The failing test', '## Base red, fix green', '## The diff', '## The tier']) {
      expect(pr.body).toContain(heading);
    }
    expect(pr.title).toMatch(/^fix: /);
    expect(pr.body).toContain('node --test test/heading.test.mjs');
    expect(pr.body).toContain('page.mjs'); // the file the fix touched
    expect(pr.body).toMatch(/\*\*Tier 2\*\*/);
    expect(pr.body).toContain('Merging is always human.');
    expect(result.prUrl).toBe('https://github.com/o/r/pull/7');

    // THE COMMENT, on the issue, naming the PR.
    const comment = calls.find((c) => c.url.includes('/issues/41/comments'))!.body as { body: string };
    expect(comment.body).toContain('Opened #7');
    expect(comment.body).toContain('Nothing has been merged.');

    // THE TOKEN was minted more than once — the clone, the push, the comment — because
    // a run can outlive an hour and ADR-0012 says the mint is a function, not a value.
    expect(calls.filter((c) => c.url.endsWith('/access_tokens')).length).toBeGreaterThanOrEqual(2);
    // And it never reached a container. The only writers of the token are this file's
    // git invocations; nothing in the event log carries it, and no blob does either.
    const log = JSON.stringify(events);
    expect(log).not.toContain('ghs_minted');
    expect(existsSync(join(blobs, '.evidence-store'))).toBe(true);
  }, 900_000);
});

describe.skipIf(!dockerAvailable())('the gate holds in public, on the two bugs that must not produce a fix', () => {
  // `demo/README.md` claims an expected outcome for each of its four seeded bugs.
  // Two of them are exercised elsewhere; these are the other two, and they are the
  // ones that matter most — a claim in a README with no run behind it is exactly what
  // this project refuses everywhere else.
  //
  // Both must end in a Tier 3 deliverable and NO fix. ADR-0007: "the gate never
  // bends", and a demo of the Tier-3 flow is part of the demo script "precisely
  // because refusing to guess is the credibility of every verdict the system does
  // issue."

  const runIssue = async (options: {
    title: string;
    body: string;
    turns: Parameters<typeof fakeModel>[0];
    /** What TRIAGE answers (8e). `ENOUGH` by default, which posts nothing. */
    triage?: string;
    /** An id minted elsewhere (9d), as the control plane does. */
    runId?: string;
  }) => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '.'], { cwd: process.cwd() });
    const fixture = demoRepo();
    const blobs = hostBlobs();
    const calls: { url: string; body: unknown }[] = [];
    const recorder = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      calls.push({ url: target, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (target.endsWith('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'ghs_minted' }), { status: 201 });
      }
      return new Response('{}', { status: 201 });
    }) as typeof fetch;
    const model = await fakeModel(
      options.turns,
      options.triage === undefined ? {} : { answer: options.triage },
    );
    models.push(model);
    const events: RunEvent[] = [];
    const mapped = issueIntake({ ...delivery(options.body), issue: { ...delivery(options.body).issue, title: options.title } });
    const result = await runFromIssue({
      intake: mapped,
      app: { appId: '123456', privateKeyPem: PEM, api: 'https://api.test.invalid', fetch: recorder },
      recipe: null,
      image: IMAGE,
      blobRoot: blobs,
      // 9d: the caller's id, because hosted it is the PLANE that mints one — before any
      // runner sees the work, which is what makes "may you append to this run" a
      // question anyone can answer. An engine that quietly generated its own would have
      // every event of every hosted run refused.
      ...(options.runId === undefined ? {} : { runId: options.runId }),
      append: async (event) => void events.push(event),
      remote: () => bareRemote(fixture.repo),
      flakeRuns: 0,
      loop: { provider: 'anthropic', apiKey: 'sk-ant-not-a-real-key', baseURL: model.baseURL, timeoutMs: 300_000 },
    });
    return { result, events, calls };
  };

  test('export-button: nothing to reproduce, so a structured info-request and no fix', async () => {
    // There is no Export button and there never was. The agent looks, finds nothing,
    // and commits nothing — which is what `prompts/repro.md` tells it to do when it
    // genuinely cannot reproduce something.
    const { result, calls } = await runIssue({
      title: 'Export on the orders page does nothing',
      body: 'Sometimes when I click Export on the orders page nothing happens. It worked last week.',
      turns: [
        { content: [call('grep', { pattern: 'Export' })], stop_reason: 'tool_use' },
        { content: [call('glob', { pattern: '*.mjs' }, 'toolu_g')], stop_reason: 'tool_use' },
        {
          content: [
            { type: 'text', text: 'There is no Export control anywhere in this project. I cannot reproduce this and am committing nothing.' },
          ],
          stop_reason: 'end_turn',
        },
      ],
    });

    // No fix, no PR, and the run is UNRESOLVED rather than errored — "we could not
    // reproduce it" is a deliverable, not a fault.
    expect(result.state.reproduced).toBe(false);
    expect(result.state.shownOnBase).toBe(false);
    expect(result.state.pr).toBeNull();
    expect(result.prUrl).toBeUndefined();
    expect(result.state.status).toBe('unresolved');
    expect(confidence(result.state).tier).toBe(3);

    // The deliverable is the comment, and it has to be a structured info-request
    // rather than an apology — a comment that says only "could not reproduce" puts
    // the work back on the reporter with no direction.
    const comment = calls.find((c) => c.url.includes('/comments'))!.body as { body: string };
    expect(comment.body).toContain('**no fix was attempted**');
    expect(comment.body).toMatch(/label it again to start a new run/);
    expect(comment.body).not.toMatch(/sorry|apolog/i);

    // 8c, end to end: this used to assert the four-item checklist, and the checklist
    // was the defect. The agent said in its own words which fact it lacked — there is
    // no Export control in this project at all — and that sentence was thrown away
    // while the reporter got the same list everyone else got. It is quoted now, and
    // quoted as an account rather than as a finding.
    expect(comment.body).toContain('> There is no Export control anywhere in this project');
    expect(comment.body).toMatch(/not a finding: nothing here checked it/);
    expect(comment.body).not.toMatch(/1\. The exact steps/);
  }, 900_000);

  test('a missing fact is asked about at t=0, while the run is still going', async () => {
    // 8e, end to end. The reporter is at the keyboard the moment they file, and
    // nowhere near it twenty minutes later — so the question that would rescue this
    // run has to be asked BEFORE the sandbox, not after the verdict.
    //
    // It never gates. This run still goes all the way to its Tier 3, and the comment
    // count is what proves both halves: the question at the start, the verdict at
    // the end, and the run in between unaffected by either.
    const MINTED = 'c0ffee00-1111-4222-8333-444455556666';
    const { result, calls, events } = await runIssue({
      title: 'Export does nothing',
      body: 'I click export and nothing happens.',
      triage: 'Which account was signed in when you clicked export?',
      runId: MINTED,
      turns: [
        {
          content: [
            {
              type: 'text',
              text: 'There is no Export control anywhere in this project. I cannot reproduce this and am committing nothing.',
            },
          ],
          stop_reason: 'end_turn',
        },
      ],
    });

    const comments = calls.filter((c) => c.url.includes('/comments'));
    expect(comments).toHaveLength(2);

    const asked = comments[0]!.body as { body: string };
    expect(asked.body).toContain('A run has started on this');
    expect(asked.body).toContain('> Which account was signed in when you clicked export?');
    // Where it came from, so the reporter can weigh it. A question with no
    // provenance reads as a bot demanding homework.
    expect(asked.body).toContain('came from a model reading your report');

    // And the run was not waiting on it.
    expect(result.state.status).toBe('unresolved');
    expect(result.state.pr).toBeNull();

    // 9d: every event carries the id the CALLER minted. Hosted, that id comes from the
    // plane with the job, and the plane authorizes appends by it — an engine that
    // generated its own would have every event of every hosted run refused, and the
    // failure would look like an authorization bug rather than a plumbing one.
    expect(result.runId).toBe(MINTED);
    expect(events.every((e) => e.run_id === MINTED)).toBe(true);
  }, 900_000);

  test('total-rounding: a reproduction that passes on base shuts the gate, and no fix agent is spawned', async () => {
    // Order 3 genuinely totals what it says, so an honest reproduction of the report
    // is GREEN on base. The control shape: the tempting fix is a rounding change that
    // alters nothing, and a run that credited it would have learned nothing.
    const repro =
      "import assert from 'node:assert/strict';\n" +
      "import { test } from 'node:test';\n" +
      "import { page } from '../page.mjs';\n" +
      "test('order 3 shows the right total', () => {\n" +
      "  assert.match(page([{ id: 3, customer: 'Alan', status: 'shipped', cents: 999 }]), /\\$9\\.99/);\n" +
      '});\n';

    const { result, events, calls } = await runIssue({
      title: 'The order total is wrong for order 3',
      body: 'The order total shown on the orders page is wrong for order 3.',
      turns: [
        { content: [call('write', { path: 'test/total.test.mjs', content: repro })], stop_reason: 'tool_use' },
        {
          content: [
            call(
              'write',
              {
                path: '.engine/repro.json',
                content: JSON.stringify({
                  command: 'node --test test/total.test.mjs',
                  files: ['test/total.test.mjs', '.engine/repro.json'],
                }),
              },
              'toolu_w2',
            ),
          ],
          stop_reason: 'tool_use',
        },
        { content: [call('git_commit', { message: 'test: the order 3 total' }, 'toolu_c')], stop_reason: 'tool_use' },
        { content: [{ type: 'text', text: 'registered' }], stop_reason: 'end_turn' },
      ],
    });

    // The reproduction WAS registered and the base container DID run it — so this is
    // the gate closing on evidence, not on the agent having failed to produce
    // anything.
    expect(result.state.registeredRepro?.command).toBe('node --test test/total.test.mjs');
    const base = result.state.testRuns.find((r) => r.phase === 'base');
    expect(base).toBeDefined();
    expect(base!.exit_code).toBe(0);

    // Green on base means the bug was never shown. No fix is attempted, and the log
    // proves it by ABSENCE: no fix container ran, and the run stopped for that reason.
    expect(result.state.shownOnBase).toBe(false);
    expect(result.state.reproduced).toBe(false);
    expect(events.some((e) => e.type === 'TEST_RUN' && (e.payload as { phase: string }).phase === 'fix')).toBe(false);
    expect(result.state.handovers.some((h) => h.kind === 'fix')).toBe(false);
    expect(result.state.endedReason).toBe('not_reproduced');
    expect(result.state.pr).toBeNull();
    expect(confidence(result.state).tier).toBe(3);

    // And the reason is recorded as a CAUSE of stopping, never as a verdict — the
    // fold derives `reproduced` from the runs regardless of what the producer claimed
    // (ADR-0009).
    const comment = calls.find((c) => c.url.includes('/comments'))!.body as { body: string };
    expect(comment.body).toContain('**no fix was attempted**');
  }, 900_000);
});

describe.skipIf(!dockerAvailable())('shipped-filter: an API bug the agent needs the database to see', () => {
  test('found against the running service, proved by a test that needs neither', async () => {
    // The fourth seeded bug, and the one whose shape the recipe exists for: it is
    // invisible without a booted backend and seeded data. So the agent boots nothing
    // itself — the recipe already did — queries the live endpoint, sees four orders
    // where two were asked for, and then commits a reproduction that runs in a sealed
    // container with no service and no network at all.
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '.'], { cwd: process.cwd() });
    const fixture = demoRepo();
    const remotePath = bareRemote(fixture.repo);
    const blobs = hostBlobs();
    const port = 8095;

    const calls: { url: string; body: unknown }[] = [];
    const recorder = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      calls.push({ url: target, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (target.endsWith('/access_tokens')) return new Response(JSON.stringify({ token: 'ghs_minted' }), { status: 201 });
      if (target.endsWith('/pulls')) {
        return new Response(
          JSON.stringify({ number: 9, head: { sha: 'a'.repeat(40) }, html_url: 'https://github.com/o/r/pull/9' }),
          { status: 201 },
        );
      }
      return new Response('{}', { status: 201 });
    }) as typeof fetch;

    // SQLite is a file, so the reproduction migrates and seeds itself. That is what
    // makes an API bug provable by an exit code in a container with nothing running.
    const repro =
      "import assert from 'node:assert/strict';\n" +
      "import { test } from 'node:test';\n" +
      "import { migrate, open, seed } from '../db.mjs';\n" +
      "import { selectOrders } from '../orders.mjs';\n" +
      "test('status=shipped returns only shipped orders', () => {\n" +
      '  migrate();\n  seed();\n  const db = open();\n' +
      "  const rows = selectOrders(db, 'shipped');\n  db.close();\n" +
      "  assert.deepEqual(rows.map((r) => r.status), ['shipped', 'shipped'],\n" +
      "    'status=shipped returns every order, including pending ones');\n" +
      '});\n';

    const model = await fakeModel([
      { content: [call('shell_create', { name: 'probe' })], stop_reason: 'tool_use' },
      {
        content: [
          call(
            'shell_write',
            {
              name: 'probe',
              input: `node -e "fetch('http://127.0.0.1:${port}/api/orders?status=shipped').then(r=>r.json()).then(d=>console.log('COUNT:'+d.orders.length))"`,
            },
            'toolu_probe',
          ),
        ],
        stop_reason: 'tool_use',
      },
      { content: [call('write', { path: 'test/filter.test.mjs', content: repro }, 'toolu_w1')], stop_reason: 'tool_use' },
      {
        content: [
          call(
            'write',
            {
              path: '.engine/repro.json',
              content: JSON.stringify({
                command: 'node --test test/filter.test.mjs',
                files: ['test/filter.test.mjs', '.engine/repro.json'],
              }),
            },
            'toolu_w2',
          ),
        ],
        stop_reason: 'tool_use',
      },
      { content: [call('git_commit', { message: 'test: the shipped filter' }, 'toolu_c1')], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'reproduced against the running API' }], stop_reason: 'end_turn' },
      // The fix agent, spawned only after the base phase went red.
      {
        content: [
          call(
            'edit',
            {
              path: 'orders.mjs',
              old_string: "return db.prepare('select id, customer, status, cents from orders order by id').all();",
              new_string:
                "if (!status) return db.prepare('select id, customer, status, cents from orders order by id').all();\n" +
                "  return db.prepare('select id, customer, status, cents from orders where status = ? order by id').all(status);",
            },
            'toolu_e',
          ),
        ],
        stop_reason: 'tool_use',
      },
      { content: [call('git_commit', { message: 'fix: honour the status filter' }, 'toolu_c2')], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'fixed' }], stop_reason: 'end_turn' },
    ]);
    models.push(model);

    const events: RunEvent[] = [];
    const body = '/api/orders?status=shipped returns every order, including pending ones.';
    const mapped = issueIntake({
      ...delivery(body),
      issue: { ...delivery(body).issue, title: 'The shipped filter returns everything' },
    });
    const result = await runFromIssue({
      intake: mapped,
      app: { appId: '123456', privateKeyPem: PEM, api: 'https://api.test.invalid', fetch: recorder },
      recipe: demoRecipe(port),
      image: IMAGE,
      blobRoot: blobs,
      append: async (event) => void events.push(event),
      remote: () => remotePath,
      flakeRuns: 2,
      symptomPattern: 'status=shipped returns every order',
      loop: { provider: 'anthropic', apiKey: 'sk-ant-not-a-real-key', baseURL: model.baseURL, timeoutMs: 300_000 },
    });

    // The environment was stood up and OBSERVED — this is the only run in the suite
    // that drives a recipe through the whole issue-to-PR path.
    expect(events.some((e) => e.type === 'ENV_READY')).toBe(true);

    // The agent saw the bug live: four orders where two were asked for.
    const said = await Promise.all(
      events
        .filter((e) => e.type === 'AGENT_MESSAGE')
        .map((e) => get(blobs, (e.payload as { raw_hash: ArtifactRef }).raw_hash)),
    );
    const results = said
      .map((b) => JSON.parse(b.toString()) as { ok?: boolean; output?: string })
      .filter((line) => typeof line.ok === 'boolean')
      .map((line) => line.output ?? '')
      .join('\n');
    expect(results).toMatch(/COUNT:4/);

    // And the judge proved it with neither a service nor a network: red on base for
    // the reported symptom, green on the fix every time.
    expect(result.state.registeredRepro?.command).toBe('node --test test/filter.test.mjs');
    const base = result.state.testRuns.find((r) => r.phase === 'base')!;
    expect(base.exit_code).not.toBe(0);
    expect(base.symptom_matched).toBe(true);
    expect(result.state.testRuns.filter((r) => r.phase === 'fix')).toHaveLength(3);
    // And red on base MORE THAN ONCE, so the failure is not one lucky draw.
    expect(result.state.testRuns.filter((r) => r.phase === 'base')).toHaveLength(2);
    expect(result.state.testRuns.filter((r) => r.phase === 'base').every((r) => r.exit_code !== 0)).toBe(true);
    expect(result.state.reproduced).toBe(true);
    expect(result.state.fixDiff?.changed_files).toContain('orders.mjs');
    expect(result.prUrl).toBe('https://github.com/o/r/pull/9');

    // THE REGRESSION ARM, end to end and in a sealed container: this is the one run in
    // the suite with a recipe, so `node --test` is what the engine executes on both
    // commits. The demo's own tests pass on the buggy tree by design (`demo/test/
    // orders.test.mjs` says so in its own comments), which is exactly what makes a
    // green-to-red transition attributable to a fix.
    expect(result.state.suiteRuns.map((r) => [r.phase, r.exit_code])).toEqual([
      ['base', 0],
      ['fix', 0],
    ]);
    expect(result.state.regression).toBe('clean');
    const pr = calls.find((c) => c.url.endsWith('/pulls'))!.body as { body: string };
    expect(pr.body).toContain("the project's own test suite passed on the base commit and passed again");
    // And no warning banner, because nothing broke.
    expect(pr.body).not.toContain('breaks the project');
  }, 900_000);
});
