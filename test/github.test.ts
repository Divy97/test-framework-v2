// GitHub, in and out (ADR-0012), tested against recorded payloads and the
// documented JWT shape.
//
// **No App is registered**, so the live install is skipped with the reason stated
// (see the skipped test at the end). Everything up to that boundary is real: the
// HMAC is computed the way GitHub computes it, the JWT is verified against the
// public half of a key generated here, and the token and PR paths run against a
// `fetch` that records what was sent. What is NOT tested is that GitHub accepts
// any of it, and nothing here pretends otherwise.

import { generateKeyPairSync, createHmac, createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  appJwt,
  authConfig,
  repoUrl,
  commentOnIssue,
  installationToken,
  intake,
  openPullRequest,
  readJwt,
  verifyWebhook,
} from '../src/github.js';
import { issueComment, pullRequestBody, pullRequestTitle } from '../src/report.js';
import { fold } from '../src/fold.js';
import type { RunEvent } from '../src/events.js';

const SECRET = 'a-webhook-secret';

/** A real `issues` delivery, trimmed to the fields the receiver reads. */
const opened = {
  action: 'opened',
  issue: {
    number: 41,
    title: 'The orders page title is misspelled',
    body: 'It says "Ordres" instead of "Orders".',
    html_url: 'https://github.com/o/r/issues/41',
  },
  repository: { full_name: 'o/r', default_branch: 'main' },
  installation: { id: 987654 },
  sender: { login: 'someone' },
};

const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

describe('the receiver authenticates before it does anything else', () => {
  test('a correct signature passes and a tampered body does not', () => {
    const body = JSON.stringify(opened);
    expect(verifyWebhook(SECRET, body, sign(body))).toBe(true);
    expect(verifyWebhook(SECRET, `${body} `, sign(body))).toBe(false);
    expect(verifyWebhook('a-different-secret', body, sign(body))).toBe(false);
  });

  test('a malformed or missing signature is refused rather than thrown on', () => {
    const body = JSON.stringify(opened);
    // A length mismatch must not reach `timingSafeEqual`, which throws on unequal
    // buffers — a receiver that 500s on a short forgery tells an attacker which
    // guesses were the right shape.
    expect(verifyWebhook(SECRET, body, 'sha256=short')).toBe(false);
    expect(verifyWebhook(SECRET, body, '')).toBe(false);
    expect(verifyWebhook(SECRET, body, undefined)).toBe(false);
  });
});

describe('intake maps exactly two triggers and refuses the rest', () => {
  test('an opened issue becomes RUN_REQUESTED with the thread to answer on', () => {
    const result = intake('issues', opened)!;
    // The discriminant, asserted first. `intake()` maps installation deliveries too since
    // M6a, and those carry no issue — so every field below is only reachable once the arm
    // is established, and a test that skipped this would be casting rather than checking.
    expect(result.kind).toBe('issue');
    if (result.kind !== 'issue') throw new Error('unreachable');
    expect(result.event).toEqual({
      v: 1,
      source: 'github_issue',
      thread_ref: 'o/r#41',
      raw_text: 'The orders page title is misspelled\n\nIt says "Ordres" instead of "Orders".',
    });
    // The installation id is what AUTHORISES (the signature only authenticates), so
    // it has to survive intake or the next step has nothing to mint a token from.
    expect(result.installationId).toBe(987654);
    expect(result.repo).toBe('o/r');
    expect(result.issueNumber).toBe(41);
  });

  test('a labelled issue is the second trigger, and the title carries the report', () => {
    // Real reports very often put the whole symptom in the title and leave the body
    // empty, so both halves are kept and an empty body must not produce a run whose
    // prompt is blank.
    const labelled = { ...opened, action: 'labeled', issue: { ...opened.issue, body: null } };
    const mapped = intake('issues', labelled)!;
    if (mapped.kind !== 'issue') throw new Error('a labelled issue must map to an issue');
    expect(mapped.event.raw_text).toBe('The orders page title is misspelled');
  });

  test('everything else is nothing, including plausible near-misses', () => {
    expect(intake('issues', { ...opened, action: 'closed' })).toBeNull();
    expect(intake('issues', { ...opened, action: 'edited' })).toBeNull();
    expect(intake('push', opened)).toBeNull();
    expect(intake('issue_comment', opened)).toBeNull();
    // No installation means nothing authorises the run, whatever the signature said.
    expect(intake('issues', { ...opened, installation: undefined })).toBeNull();
    expect(intake('issues', { ...opened, repository: {} })).toBeNull();
    expect(intake('issues', null)).toBeNull();
  });
});

describe('the App key mints a JWT of the documented shape', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  test('RS256, iss the app id, backdated iat, ten-minute exp — and it verifies', () => {
    const now = 1_800_000_000_000;
    const token = appJwt('123456', pem, now);
    const { header, claims } = readJwt(token);

    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(claims).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 600, iss: '123456' });

    // Verified against the public half, not merely shaped like a JWT. A "JWT" whose
    // signature is over the wrong bytes is the failure this catches, and it is the
    // only part of the token path that can be checked without GitHub.
    const [h, c, signature] = token.split('.');
    expect(
      createVerify('RSA-SHA256')
        .update(`${h}.${c}`)
        .verify(publicKey, Buffer.from(signature!, 'base64url')),
    ).toBe(true);
  });

  test('the token is exchanged for an installation token, and a failure is loud', async () => {
    const sent: { url: string; init?: RequestInit }[] = [];
    const app = {
      appId: '123456',
      privateKeyPem: pem,
      api: 'https://api.test.invalid',
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        sent.push({ url: String(url), init });
        return new Response(JSON.stringify({ token: 'ghs_installationtoken', expires_at: 'later' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    };

    expect(await installationToken(app, 987654)).toBe('ghs_installationtoken');
    expect(sent[0]!.url).toBe('https://api.test.invalid/app/installations/987654/access_tokens');
    // Bearer with the JWT, not the installation token: this is the one call the App
    // key itself makes.
    const authorization = (sent[0]!.init!.headers as Record<string, string>).authorization ?? '';
    expect(authorization.startsWith('Bearer ey')).toBe(true);

    const refusing = {
      ...app,
      fetch: (async () => new Response('nope', { status: 401 })) as typeof fetch,
    };
    await expect(installationToken(refusing, 987654)).rejects.toThrow(/HTTP 401/);
  });

  test('the token is minted when needed, not captured at run start', async () => {
    // ADR-0012: "a one-hour token outlives a short run and not a long one, so the
    // mint is a function called when needed rather than a value captured at the
    // start". Two calls, two mints — if this ever memoises, a run longer than an
    // hour starts failing in a way that looks like GitHub being flaky.
    let mints = 0;
    const app = {
      appId: '123456',
      privateKeyPem: pem,
      api: 'https://api.test.invalid',
      fetch: (async () => {
        mints += 1;
        return new Response(JSON.stringify({ token: `ghs_${mints}` }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    };
    expect(await installationToken(app, 1)).toBe('ghs_1');
    expect(await installationToken(app, 1)).toBe('ghs_2');
    expect(mints).toBe(2);
  });
});

describe('the token is the host s, and only the host s', () => {
  test('the repository URL carries no credential at all', () => {
    // It used to: `https://x-access-token:<token>@github.com/…`, which works, is what
    // GitHub documents, and which git then WRITES into `.git/config` of the clone as
    // `remote.origin.url`. A review caught it. Traced, it was not exploitable —
    // `orchestrate()` re-clones with `--mirror`, whose origin is the local path, so
    // the token-bearing config never reached a mounted directory.
    //
    // It is fixed anyway, and this is the test that keeps it fixed. ADR-0012's claim
    // is that there is NO configuration under which the container can read the token,
    // and a claim that holds only because of an incidental property of `--mirror` is
    // the safe-by-accident this project has been bitten by before.
    expect(repoUrl('o/r')).toBe('https://github.com/o/r.git');
    expect(repoUrl('o/r')).not.toMatch(/x-access-token|ghs_|@github/);
  });

  test('the credential travels as a header git does not persist', () => {
    const config = authConfig('ghs_secret');
    // `-c`, which lives for one invocation. Not `git config`, not an environment
    // variable, not a credential helper — nothing a later process can read.
    expect(config[0]).toBe('-c');
    expect(config[1]).toContain('http.https://github.com/.extraHeader=Authorization: Basic ');
    // Basic auth with GitHub's documented username, so only the transport changed.
    expect(Buffer.from(config[1]!.split('Basic ')[1]!, 'base64').toString()).toBe('x-access-token:ghs_secret');
    // Scoped to github.com, so a git command that touches a second host cannot be
    // handed our header.
    expect(config[1]).not.toMatch(/^-c http\.extraHeader/);

    // And no other credential channel anywhere in the module.
    const source = readFileSync('src/github.ts', 'utf8');
    expect(source).not.toMatch(/GIT_ASKPASS|credential\.helper|GITHUB_TOKEN=/);
    // And specifically not the URL form that started this: a credential interpolated
    // ahead of an `@` host. `x-access-token:` on its own is legitimate — it is the
    // Basic auth username above — so the pattern has to be the userinfo shape.
    expect(source).not.toMatch(/\}@github\.com/);
  });

  test('a pull request and a comment go out over the API, with the installation token', async () => {
    const sent: { url: string; body: unknown; authorization: string }[] = [];
    const recorder = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? 'null')),
        authorization: (init?.headers as Record<string, string>).authorization ?? '',
      });
      return new Response(
        JSON.stringify({ number: 7, head: { sha: 'f'.repeat(40) }, html_url: 'https://github.com/o/r/pull/7' }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const app = { api: 'https://api.test.invalid', fetch: recorder };
    const pr = await openPullRequest(app, 'ghs_token', 'o/r', {
      title: 'fix: the orders heading',
      body: 'five sections',
      head: 'engine/run-1',
      base: 'main',
    });
    expect(pr).toEqual({ number: 7, head_sha: 'f'.repeat(40), html_url: 'https://github.com/o/r/pull/7' });

    await commentOnIssue(app, 'ghs_token', 'o/r', 41, 'opened #7');
    expect(sent.map((call) => call.url)).toEqual([
      'https://api.test.invalid/repos/o/r/pulls',
      'https://api.test.invalid/repos/o/r/issues/41/comments',
    ]);
    for (const call of sent) expect(call.authorization).toBe('Bearer ghs_token');
  });
});

/** A `reproduced` run, folded, so the report has something real to render. */
function reproducedRun(): RunEvent[] {
  const hash = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}` as const;
  const base = 'b'.repeat(40);
  const fix = 'c'.repeat(40);
  const events: RunEvent[] = [
    {
      run_id: 'r',
      seq: 1,
      ts: 't',
      type: 'RUN_REQUESTED',
      payload: { v: 1, source: 'github_issue', thread_ref: 'o/r#41', raw_text: 'Ordres' },
    },
    { run_id: 'r', seq: 2, ts: 't', type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } },
    {
      run_id: 'r',
      seq: 3,
      ts: 't',
      type: 'AGENT_MESSAGE',
      payload: { v: 1, n: 0, claimed_type: 'tool_use', raw_hash: hash(1), bytes: 10 },
    },
    { run_id: 'r', seq: 4, ts: 't', type: 'AGENT_FINISHED', payload: { v: 1, messages: 1, exit_code: 0, stopped: 'exit' } },
    { run_id: 'r', seq: 5, ts: 't', type: 'AGENT_HANDED_OVER', payload: { v: 1, commit: 'a'.repeat(40), kind: 'repro' } },
    {
      run_id: 'r',
      seq: 6,
      ts: 't',
      type: 'REPRO_REGISTERED',
      payload: { v: 1, command: 'sh repro.sh', files: { 'repro.sh': hash(2) }, applied: ['repro.sh'] },
    },
    {
      run_id: 'r',
      seq: 7,
      ts: 't',
      type: 'TEST_RUN',
      payload: {
        v: 1,
        phase: 'base',
        commit_sha: base,
        exit_code: 1,
        stdout_hash: hash(3),
        duration_ms: 12,
        symptom_matched: true,
        repeat: 0,
        repro_hashes: { 'repro.sh': hash(2) },
      },
    },
    { run_id: 'r', seq: 8, ts: 't', type: 'AGENT_HANDED_OVER', payload: { v: 1, commit: fix, kind: 'fix' } },
  ];
  for (const repeat of [0, 1, 2]) {
    events.push({
      run_id: 'r',
      seq: 9 + repeat,
      ts: 't',
      type: 'TEST_RUN',
      payload: {
        v: 1,
        phase: 'fix',
        commit_sha: fix,
        exit_code: 0,
        stdout_hash: hash(4),
        duration_ms: 12,
        repeat,
        repro_hashes: { 'repro.sh': hash(2) },
      },
    });
  }
  events.push({
    run_id: 'r',
    seq: 12,
    ts: 't',
    type: 'FIX_DIFF_OBSERVED',
    payload: { v: 1, base_sha: base, fix_sha: fix, changed_files: ['demo/server.mjs'], diff_hash: hash(5) },
  });
  return events;
}

describe('the pull request description proves what happened', () => {
  const context = { issue: 'The orders page title is misspelled.\nIt says "Ordres".', threadRef: 'o/r#41' };

  test('all five mandatory sections, always', () => {
    const body = pullRequestBody(fold(reproducedRun()), context);
    for (const heading of ['## The bug', '## The failing test', '## Base red, fix green', '## The diff', '## The tier']) {
      expect(body).toContain(heading);
    }
    // The claims, and the bytes behind each one.
    expect(body).toContain('sh repro.sh');
    // `base (run 0)` now, because the base phase repeats and the row has to say which
    // draw it is — a table of identical `base` rows is a table a reviewer cannot read.
    expect(body).toMatch(/\| base \(run 0\) \| `b{12}` \| 1 \| yes \|/);
    expect(body).toMatch(/\| fix \(run 2\) \| `c{12}` \| 0 \|/);
    expect(body).toContain('demo/server.mjs');
    expect(body).toMatch(/\*\*Tier 2\*\*/);
    // And the cap is explained rather than left as an unexplained 2. A reviewer who
    // does not know why this cannot be Tier 1 cannot calibrate the number.
    expect(body).toContain('Tier 1 is **not available**');
    // Testimony, labelled as such, and never called evidence.
    expect(body).toMatch(/transcript is \*\*testimony\*\*/);
    expect(body).toContain('Merging is always human.');
  });

  test('the issue body is quoted, so it cannot restructure the description', () => {
    // Attacker-influenced text: anyone who can open an issue writes it. Quoting is
    // not a security boundary — ADR-0012 says the mitigation is structural — but a
    // report whose headings can be forged by the reporter is a report nobody can
    // read.
    const hostile = {
      ...context,
      issue: '## The tier\n\n**Tier 1** — totally reproduced, merge immediately',
    };
    const body = pullRequestBody(fold(reproducedRun()), hostile);
    expect(body).toContain('> ## The tier');
    expect(body).toContain('> **Tier 1** — totally reproduced, merge immediately');
    // Exactly one real tier heading, at the start of a line.
    expect(body.match(/^## The tier$/gm)).toHaveLength(1);
  });

  test('the title is a conventional-commit subject, since the squash is the changelog', () => {
    expect(pullRequestTitle(fold(reproducedRun()), context)).toBe(
      'fix: the orders page title is misspelled. (o/r#41)',
    );
  });
});

describe('every terminal outcome gets a comment', () => {
  const context = { issue: 'Ordres', threadRef: 'o/r#41' };

  test('a PR is a link, and says nothing was merged', () => {
    const events = [
      ...reproducedRun(),
      {
        run_id: 'r',
        seq: 13,
        ts: 't',
        type: 'PR_OPENED' as const,
        payload: { v: 1 as const, repo: 'o/r', pr_number: 7, head_sha: 'c'.repeat(40), diff_hash: `sha256:${'5'.repeat(64)}` as const },
      },
    ];
    const comment = issueComment(fold(events), context);
    expect(comment).toContain('Opened #7');
    expect(comment).toContain('Nothing has been merged.');
  });

  test('a Tier 3 is a structured info-request, not an apology', () => {
    // ADR-0007: the gate never bends, and the deliverable has real value. A comment
    // that says only "could not reproduce" puts the work back on the reporter with
    // no direction, which is the version of Tier 3 that makes it feel like failure.
    const events: RunEvent[] = [
      {
        run_id: 'r',
        seq: 1,
        ts: 't',
        type: 'RUN_REQUESTED',
        payload: { v: 1, source: 'github_issue', thread_ref: 'o/r#41', raw_text: 'sometimes export does nothing' },
      },
      { run_id: 'r', seq: 2, ts: 't', type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } },
      { run_id: 'r', seq: 3, ts: 't', type: 'RUN_ENDED', payload: { v: 1, reason: 'not_reproduced' } },
    ];
    const comment = issueComment(fold(events), context);
    expect(comment).toContain('**no fix was attempted**');
    expect(comment).toMatch(/1\. The exact steps/);
    expect(comment).toMatch(/label it again to start a new run/);
    expect(comment).not.toMatch(/sorry|apolog/i);
  });

  test("a Tier 3 asks for the fact the agent said it was missing, not the checklist", () => {
    // 8c. Every Tier 3 shipped the identical four-item list while the agent that
    // had just spent the run knew exactly which one fact it lacked — knowledge that
    // was in the transcript and was discarded. Admissible because an info request is
    // not a verdict: ADR-0006 forbids testimony becoming a fact, not testimony being
    // shown as a question.
    const events: RunEvent[] = [
      {
        run_id: 'r',
        seq: 1,
        ts: 't',
        type: 'RUN_REQUESTED',
        payload: { v: 1, source: 'github_issue', thread_ref: 'o/r#41', raw_text: 'export does nothing' },
      },
      { run_id: 'r', seq: 2, ts: 't', type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } },
      {
        run_id: 'r',
        seq: 3,
        ts: 't',
        type: 'AGENT_FINISHED',
        payload: { v: 1, messages: 20, stopped: 'exit', exit_code: 0 },
      },
      { run_id: 'r', seq: 4, ts: 't', type: 'RUN_ENDED', payload: { v: 1, reason: 'not_reproduced' } },
    ];
    const said =
      'The export button is behind a feature flag I cannot see the value of. Which plan is the ' +
      'account on?';
    const comment = issueComment(fold(events), { ...context, lastWord: said });
    expect(comment).toContain('**no fix was attempted**');
    expect(comment).toContain('> The export button is behind a feature flag');
    expect(comment).toContain("Which plan is the");
    // Named as an account, never as a finding.
    expect(comment).toMatch(/not a finding: nothing here checked it/);
    // And the checklist is GONE. Keeping both would be the template again, with a
    // quote on top of it.
    expect(comment).not.toMatch(/1\. The exact steps/);
  });

  test('and falls back to the checklist when the agent said nothing usable', () => {
    // The negative control. Without it the assertion above passes on a comment that
    // always quotes and never lists, which would be the same bug facing the other
    // way — a run with no agent has nothing specific to ask for and the four items
    // are a real deliverable.
    const events: RunEvent[] = [
      {
        run_id: 'r',
        seq: 1,
        ts: 't',
        type: 'RUN_REQUESTED',
        payload: { v: 1, source: 'github_issue', thread_ref: 'o/r#41', raw_text: 'export does nothing' },
      },
      { run_id: 'r', seq: 2, ts: 't', type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } },
      { run_id: 'r', seq: 3, ts: 't', type: 'RUN_ENDED', payload: { v: 1, reason: 'not_reproduced' } },
    ];
    const comment = issueComment(fold(events), context);
    expect(comment).toMatch(/1\. The exact steps/);
    expect(comment).not.toMatch(/in its own words/);
  });

  test('an agent that was cut off does not become a question for the reporter', () => {
    // Milestone 7, twice: a model ended its turns inside its own reasoning, the gate
    // held correctly, and the engine's diagnosis was an accusation of idleness
    // against a model that had explored the repository, seen the bug live and
    // written the reproduction. It had simply never reached `git_commit`.
    //
    // A ceiling of ours is not evidence about someone's bug, and asking them for
    // more steps because we ran out of turns is billing them for our own limit.
    const events: RunEvent[] = [
      {
        run_id: 'r',
        seq: 1,
        ts: 't',
        type: 'RUN_REQUESTED',
        payload: { v: 1, source: 'github_issue', thread_ref: 'o/r#41', raw_text: 'export does nothing' },
      },
      { run_id: 'r', seq: 2, ts: 't', type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } },
      {
        run_id: 'r',
        seq: 3,
        ts: 't',
        type: 'AGENT_FINISHED',
        payload: { v: 1, messages: 7, stopped: 'malformed_tool_call', exit_code: -1 },
      },
      { run_id: 'r', seq: 4, ts: 't', type: 'RUN_ENDED', payload: { v: 1, reason: 'not_reproduced' } },
    ];
    // Even with something quotable, because the sentence a ceiling interrupted is
    // not an answer.
    const comment = issueComment(fold(events), { ...context, lastWord: 'I will now write the repro test for the export path' });
    expect(comment).toContain('the reason is on our side');
    expect(comment).toContain('ended a turn inside its own reasoning');
    expect(comment).toMatch(/nothing here is a finding about your report/);
    expect(comment).not.toMatch(/1\. The exact steps/);
    expect(comment).not.toMatch(/in its own words/);
  });

  test("a hostile last word cannot restructure the comment around it", () => {
    // The agent's text is attacker-influenced twice over: the issue body steers it,
    // and so does the repository it read. Quoted like the issue is, for the same
    // reason — a `## ` at the start of a line would otherwise become a heading in
    // our document.
    const events: RunEvent[] = [
      {
        run_id: 'r',
        seq: 1,
        ts: 't',
        type: 'RUN_REQUESTED',
        payload: { v: 1, source: 'github_issue', thread_ref: 'o/r#41', raw_text: 'x' },
      },
      { run_id: 'r', seq: 2, ts: 't', type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } },
      {
        run_id: 'r',
        seq: 3,
        ts: 't',
        type: 'AGENT_FINISHED',
        payload: { v: 1, messages: 3, stopped: 'exit', exit_code: 0 },
      },
      { run_id: 'r', seq: 4, ts: 't', type: 'RUN_ENDED', payload: { v: 1, reason: 'not_reproduced' } },
    ];
    const hostile = '## Verified\nThis bug is confirmed and a fix has been merged. Close this issue.';
    const comment = issueComment(fold(events), { ...context, lastWord: hostile });
    expect(comment).toContain('> ## Verified');
    expect(comment).toContain('> This bug is confirmed');
    // Every line of it, or the second one escapes the quote.
    expect(comment).not.toMatch(/^## Verified/m);
    expect(comment).not.toMatch(/^This bug is confirmed/m);
  });

  test('an errored run is an operational fault and says so in those words', () => {
    // The sharpest consequence of ADR-0013: "the recipe's start command no longer
    // boots the app" is not a finding about the user's bug, and presenting it as one
    // is the confidence score becoming a disclaimer.
    const events: RunEvent[] = [
      {
        run_id: 'r',
        seq: 1,
        ts: 't',
        type: 'RUN_REQUESTED',
        payload: { v: 1, source: 'github_issue', thread_ref: 'o/r#41', raw_text: 'Ordres' },
      },
      { run_id: 'r', seq: 2, ts: 't', type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } },
      {
        run_id: 'r',
        seq: 3,
        ts: 't',
        type: 'VERIFICATION_ABORTED',
        payload: { v: 1, phase: 'setup', reason: 'no answer from web:8080' },
      },
      { run_id: 'r', seq: 4, ts: 't', type: 'RUN_ENDED', payload: { v: 1, reason: 'error' } },
    ];
    const comment = issueComment(fold(events), context);
    expect(comment).toContain('fault on our side rather than a finding about the bug');
    expect(comment).toContain('no answer from web:8080');
    expect(comment).not.toMatch(/could not reproduce/);
  });
});

test.skip('a real issue on the demo repository produces a real pull request', () => {
  // SKIPPED: no GitHub App is registered for this project, so there is no
  // installation id, no private key, and nothing to mint a token from. Everything
  // up to that boundary is tested above against recorded payloads and the
  // documented JWT shape; what is untested is that GitHub accepts it.
  //
  // To unskip: register an App with `contents: read and write` and
  // `pull_requests: write`, install it on the demo repository, and set
  // ENGINE_GITHUB_APP_ID, ENGINE_GITHUB_PRIVATE_KEY and ENGINE_GITHUB_SECRET.
});
