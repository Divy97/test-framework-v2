// The whole product, once, in order: connect a repository, refuse to run on it, onboard
// it, run, and read the result off the dashboard.
//
// Every step here is covered somewhere else in more detail. This file exists for the
// thing none of those can show — that the steps compose. Milestone 6's "what done looks
// like" is a sequence a person walks through, and a suite made entirely of unit tests can
// have every one of them green while the path between them is broken.
//
// Real Postgres, real HTTP, real HMAC, real routes, real HTML. The one fake is the run
// itself: `runFromIssue` costs containers and a model, and `test/run.test.ts` already
// drives it end to end. What is under test here is the wiring around it.

import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunEvent } from '../src/events.js';
import { loadInstallation } from '../src/installations.js';
import { listRuns, readRunRow, rebuildProjection, readUsage } from '../src/readmodel.js';
import { loadRecipe } from '../src/recipe.js';
import { serve, type Config, type Service } from '../src/serve.js';
import { appendEvent, connect } from '../src/store.js';

const REPO = 'journey-org/journey-repo';
const INSTALLATION_ID = 424242;
const SECRET = 'a-journey-secret';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

/**
 * Skip, loudly, rather than fail — the house rule from `test/store.test.ts`.
 *
 * A journey test that fails for want of a database teaches nothing and trains people to
 * ignore a red suite, which is worse than the coverage it would have bought.
 */
let client: pg.Client | null = null;
let why = '';
try {
  client = connect();
} catch (error) {
  why = String((error as Error).message);
}

let service: Service | undefined;
let dirs: string[] = [];
const runId = randomUUID();
const started: string[] = [];
const comments: { repo: string; issue: number; body: string }[] = [];

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-journey-'));
  dirs.push(dir);
  return dir;
};

const config = (): Config => ({
  appId: '123456',
  privateKeyPem: PEM,
  webhookSecret: SECRET,
  image: 'sandbox:test',
  agentImage: 'agent:test',
  blobRoot: join(temp(), 'blobs'),
  webhookPort: 0,
  eventsPort: 0,
  loop: { provider: 'openrouter', apiKey: 'sk-or-test', model: 'a/model', effort: 'low' },
});

const deliver = async (event: string, payload: unknown) => {
  const body = JSON.stringify(payload);
  return fetch(`http://127.0.0.1:${service!.webhookPort}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    },
    body,
  });
};

const page = async (path: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${service!.eventsPort}${path}`, init);

const issueDelivery = (number: number) => ({
  action: 'opened',
  issue: {
    number,
    title: 'The shipped filter returns everything',
    body: '/api/orders?status=shipped returns every order.',
    html_url: `https://github.com/${REPO}/issues/${number}`,
  },
  repository: { full_name: REPO },
  installation: { id: INSTALLATION_ID },
});

let ready = false;
beforeAll(async () => {
  if (!client) return;
  try {
    await client.connect();
    // Probe the tables this journey needs, so a missing migration skips with a name
    // rather than failing four steps in with a column nobody can find.
    for (const table of ['events', 'recipes', 'installations', 'run_projection', 'run_usage']) {
      await client.query(`select 1 from ${table} limit 1`);
    }
  } catch (error) {
    why = String((error as Error).message);
    client = null;
    return;
  }
  // A repository of our own, cleaned first: this test asserts on counts, and a leftover
  // row from a previous run would make it pass or fail for the wrong reason.
  await client.query('delete from run_usage where run_id = $1', [runId]);
  await client.query('delete from run_projection where repo = $1', [REPO]);
  await client.query('delete from events where run_id = $1', [runId]);
  await client.query('delete from installations where repo = $1', [REPO]);
  await client.query('delete from recipes where repo = $1', [REPO]);

  service = await serve({
    config: config(),
    client,
    log: () => {},
    comment: async (repo, issue, body) => void comments.push({ repo, issue, body }),
    run: async (request) => {
      started.push(request.intake.repo);
      return { runId, state: { status: 'pr_opened' } } as never;
    },
  });
  ready = true;
});

afterAll(async () => {
  await service?.close();
  if (client && ready) {
    await client.query('delete from run_usage where run_id = $1', [runId]);
    await client.query('delete from run_projection where repo = $1', [REPO]);
    await client.query('delete from events where run_id = $1', [runId]);
    await client.query('delete from installations where repo = $1', [REPO]);
    await client.query('delete from recipes where repo = $1', [REPO]);
    await client.end();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.sequential('a repository from install to evidence', () => {
  it('has somewhere to run', () => {
    if (!ready) console.log(`SKIPPED (journey): no usable database — ${why}`);
    expect(true).toBe(true);
  });

  it('1. an installation delivery is what makes the repository known', async () => {
    if (!ready) return;
    // Before M6a this delivery was answered `202 not a trigger` and discarded, so the
    // first thing we ever learned about a repository was an issue.
    const response = await deliver('installation', {
      action: 'created',
      installation: { id: INSTALLATION_ID, account: { login: 'journey-org' } },
      repositories: [{ full_name: REPO }],
    });
    expect(response.status).toBe(202);
    await service!.drain();

    const installation = await loadInstallation(client!, REPO);
    expect(installation).toMatchObject({ repo: REPO, installationId: INSTALLATION_ID, account: 'journey-org' });
    expect(await loadRecipe(client!, REPO)).toBeNull();
  });

  it('2. an issue on it starts NO run, and says why on the issue', async () => {
    if (!ready) return;
    await deliver('issues', issueDelivery(1));
    await service!.drain();

    // The whole point of 6a. A run here would boot nothing, reproduce nothing, and write
    // "we could not reproduce this" onto a stranger's issue about a bug we never had the
    // means to look at — in a log that cannot be edited.
    expect(started).toHaveLength(0);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ repo: REPO, issue: 1 });
    expect(comments[0]!.body).toMatch(/not onboarded yet/);
  });

  it('3. the repository shows as not onboarded on the dashboard', async () => {
    if (!ready) return;
    const html = await (await page('/repos')).text();
    expect(html).toContain(REPO);
    expect(html).toMatch(/not onboarded yet/i);
    // Per-segment encoding, so the slash survives: `/repos/owner/repo/onboard`.
    expect(html).toContain(`/repos/${REPO}/onboard`);
  });

  it('4. approving a recipe is a human POST, and it is the only write there is', async () => {
    if (!ready) return;
    // ADR-0013: the approval is the only control on a stored command we will execute
    // verbatim, in a sandbox, with a registry reachable. So it is a form a person
    // submits — not something the drafting agent can complete on its own.
    const form = await (await page(`/repos/${REPO}/onboard`)).text();
    expect(form).toMatch(/verbatim/);
    expect(form).toContain('<textarea');

    const recipe = { install: 'npm ci', services: [], test: 'npm test' };
    const response = await page(`/repos/${REPO}/onboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ recipe: JSON.stringify(recipe) }).toString(),
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
    expect(await loadRecipe(client!, REPO)).toMatchObject({ install: 'npm ci' });
  });

  it('5. a malformed recipe is refused with its own reason, not stored', async () => {
    if (!ready) return;
    // `parseRecipe` refuses a shape that would otherwise fail inside a container, where
    // it reads as the user's project being broken rather than their recipe being wrong.
    const response = await page(`/repos/${REPO}/onboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ recipe: '{"services":[{"name":"WEB","command":"x","port":1}]}' }).toString(),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/lowercase name/);
    // And the good recipe from step 4 survived the bad submission.
    expect(await loadRecipe(client!, REPO)).toMatchObject({ install: 'npm ci' });
  });

  it('6. now the same issue starts a run', async () => {
    if (!ready) return;
    await deliver('issues', issueDelivery(2));
    await service!.drain();
    expect(started).toEqual([REPO]);
  });

  it('7. the run appears on the dashboard, derived from the log', async () => {
    if (!ready) return;
    // The run is faked, so its events are written here — which is the honest way round:
    // the projection reads the LOG, so a projection that only worked when `runFromIssue`
    // handed it a result would be reading something else.
    const events: RunEvent[] = [
      {
        run_id: runId,
        seq: 1,
        ts: new Date().toISOString(),
        type: 'RUN_REQUESTED',
        payload: { v: 1, source: 'github_issue', thread_ref: `${REPO}#2`, raw_text: 'the filter is wrong' },
      },
      { run_id: runId, seq: 2, ts: new Date().toISOString(), type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } },
      { run_id: runId, seq: 3, ts: new Date().toISOString(), type: 'RUN_ENDED', payload: { v: 1, reason: 'not_reproduced' } },
    ];
    for (const event of events) await appendEvent(client!, event);
    await rebuildProjection(client!);

    const row = await readRunRow(client!, runId);
    expect(row).toMatchObject({ repo: REPO, issue_number: 2, tier: 3 });

    const list = await (await page(`/runs?repo=${encodeURIComponent(REPO)}`)).text();
    expect(list).toContain(runId);

    const evidence = await (await page(`/runs/${runId}`)).text();
    // A Tier 3 must VISIBLY refuse rather than quietly show an empty page — the gate
    // holding is the credibility of every verdict the system does issue.
    expect(evidence).toMatch(/no fix was attempted/i);
    expect(evidence).not.toContain('<h2>The diff</h2>');
  });

  it('8. the JSON surface answers the same thing the page does', async () => {
    if (!ready) return;
    const rows = (await (await page(`/api/runs?repo=${encodeURIComponent(REPO)}`)).json()) as { run_id: string }[];
    expect(rows.map((row) => row.run_id)).toContain(runId);
    const one = (await (await page(`/api/runs/${runId}`)).json()) as { repo: string };
    expect(one.repo).toBe(REPO);
  });

  it('9. and the whole read model can be thrown away and rebuilt from the log', async () => {
    if (!ready) return;
    const before = await listRuns(client!, REPO);
    await rebuildProjection(client!);
    const after = await listRuns(client!, REPO);
    // Byte-identical, which is milestone 6's own done-when and the most interesting
    // property it produces: the dashboard database holds no truth.
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(before.length).toBeGreaterThan(0);
  });

  it('10. what the run cost is kept beside the log, never inside it', async () => {
    if (!ready) return;
    // ADR-0006: our spending is a fact about us, and the log is about the user's bug. So
    // it cannot be rebuilt by replay — losing it loses real information, and that is the
    // price of keeping the log clean, paid knowingly.
    const usage = await readUsage(client!, runId);
    expect(Array.isArray(usage)).toBe(true);
    const events = await client!.query('select type from events where run_id = $1', [runId]);
    expect(events.rows.map((row: { type: string }) => row.type)).not.toContain('RUN_USAGE');
  });
});
