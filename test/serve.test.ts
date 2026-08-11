// The service, asserted end to end over real HTTP with a fake GitHub delivery.
//
// What is real here: the HMAC, the receiver, the intake mapping, the queue, the recipe
// lookup, the SSE tail. What is faked is `runFromIssue` — because the point of these
// tests is the wiring nobody had, not the run, which `test/run.test.ts` already drives
// through containers.
//
// Two of these cover failures that are silent by construction: a service that starts with
// no secret and 401s every real delivery, and a recipe whose absence is treated as fatal
// rather than as the un-onboarded repository it describes.

import { createHmac, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Intake } from '../src/github.js';
import type { RunRequest, RunResult } from '../src/run.js';
import { readConfig, serve, type Config, type Service } from '../src/serve.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SECRET = 'a-webhook-secret';

const dirs: string[] = [];
const services: Service[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-serve-'));
  dirs.push(dir);
  return dir;
};

const config = (over: Partial<Config> = {}): Config => ({
  appId: '123456',
  privateKeyPem: PEM,
  webhookSecret: SECRET,
  image: 'sandbox:test',
  agentImage: 'agent:test',
  blobRoot: join(temp(), 'blobs'),
  webhookPort: 0,
  eventsPort: 0,
  ...over,
});

/** A `pg.Client` that answers only what the service actually asks it. */
const fakeClient = (rows: unknown[] = []) =>
  ({ query: vi.fn(async () => ({ rows, rowCount: rows.length })) }) as unknown as pg.Client;

const delivery = (issueNumber = 41) => ({
  action: 'opened',
  issue: {
    number: issueNumber,
    title: 'The shipped filter returns everything',
    body: '/api/orders?status=shipped returns every order, including pending ones.',
    html_url: `https://github.com/o/r/issues/${issueNumber}`,
  },
  repository: { full_name: 'o/r', default_branch: 'main' },
  installation: { id: 987654 },
});

/** POST a delivery the way GitHub does: raw bytes, signed. */
const deliver = async (port: number, payload: unknown, options: { secret?: string; event?: string } = {}) => {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', options.secret ?? SECRET).update(body).digest('hex')}`;
  return fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': options.event ?? 'issues',
      'x-hub-signature-256': signature,
    },
    body,
  });
};

const ok = (runId: string, prUrl?: string) =>
  ({
    runId,
    state: { status: 'solved' },
    ...(prUrl === undefined ? {} : { prUrl }),
  }) as unknown as RunResult;

describe('the service refuses to start rather than start uselessly', () => {
  it('names every missing variable, and what its absence costs', () => {
    // A service that boots with no secret binds a port, answers, and 401s every real
    // delivery — indistinguishable from GitHub sending nothing at all.
    expect(() => readConfig({} as NodeJS.ProcessEnv)).toThrow(/GITHUB_APP_ID/);
    try {
      readConfig({} as NodeJS.ProcessEnv);
      expect.unreachable('it started with nothing set');
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).toContain('GITHUB_WEBHOOK_SECRET');
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH');
      // Not just the name — why it matters, because the name alone sends an operator
      // looking for a typo rather than for a missing secret mount.
      expect(message).toMatch(/looks exactly like GitHub sending nothing/);
    }
  });

  it('reads the private key from a path as well as from the value', () => {
    const dir = temp();
    const path = join(dir, 'key.pem');
    writeFileSync(path, PEM);
    const env = {
      GITHUB_APP_ID: '1',
      GITHUB_WEBHOOK_SECRET: 's',
      DATABASE_URL: 'postgres://x',
      GITHUB_PRIVATE_KEY_PATH: path,
    } as NodeJS.ProcessEnv;
    expect(readConfig(env).privateKeyPem).toBe(PEM);
  });

  it('refuses a key that is not a PEM at startup, not on the first delivery', () => {
    // Otherwise this surfaces as a crypto error inside `appJwt`, minutes later, on
    // someone's real issue.
    const env = {
      GITHUB_APP_ID: '1',
      GITHUB_WEBHOOK_SECRET: 's',
      DATABASE_URL: 'postgres://x',
      GITHUB_PRIVATE_KEY: 'not-a-key',
    } as NodeJS.ProcessEnv;
    expect(() => readConfig(env)).toThrow(/not a PEM/);
  });

  it('says which path it could not read, rather than reporting the key as missing', () => {
    const env = {
      GITHUB_APP_ID: '1',
      GITHUB_WEBHOOK_SECRET: 's',
      DATABASE_URL: 'postgres://x',
      GITHUB_PRIVATE_KEY_PATH: '/nope/absent.pem',
    } as NodeJS.ProcessEnv;
    expect(() => readConfig(env)).toThrow(/unreadable/);
  });
});

describe('a signed issue becomes a run', () => {
  it('drives the whole path from an HTTP delivery to runFromIssue', async () => {
    const seen: RunRequest[] = [];
    const service = await serve({
      config: config(),
      client: fakeClient(),
      log: () => {},
      run: async (request) => {
        seen.push(request);
        return ok('run-1', 'https://github.com/o/r/pull/7');
      },
    });
    services.push(service);

    const response = await deliver(service.webhookPort, delivery());
    expect(response.status).toBe(202);
    await service.drain();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.intake.repo).toBe('o/r');
    expect(seen[0]!.intake.issueNumber).toBe(41);
    expect(seen[0]!.intake.installationId).toBe(987654);
    // The config actually reaches the run, rather than the run using its own defaults.
    expect(seen[0]!.image).toBe('sandbox:test');
    expect(seen[0]!.agentImage).toBe('agent:test');
    expect(seen[0]!.app.appId).toBe('123456');
  });

  it('creates the evidence store, so the first run has somewhere to write', async () => {
    const root = join(temp(), 'blobs');
    const service = await serve({ config: config({ blobRoot: root }), client: fakeClient(), log: () => {}, run: async () => ok('r') });
    services.push(service);
    expect(existsSync(join(root, '.evidence-store'))).toBe(true);
  });

  it('never lets a credential reach the log line', async () => {
    const lines: string[] = [];
    const service = await serve({
      config: config(),
      client: fakeClient(),
      log: (line) => lines.push(line),
      run: async () => ok('run-1', 'https://github.com/o/r/pull/7'),
    });
    services.push(service);
    await deliver(service.webhookPort, delivery());
    await service.drain();
    const all = lines.join('\n');
    expect(all).toContain('o/r#41');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('BEGIN');
  });

  it('rejects an unsigned delivery and starts nothing', async () => {
    const seen: RunRequest[] = [];
    const service = await serve({
      config: config(),
      client: fakeClient(),
      log: () => {},
      run: async (request) => {
        seen.push(request);
        return ok('never');
      },
    });
    services.push(service);
    const response = await deliver(service.webhookPort, delivery(), { secret: 'the-wrong-secret' });
    expect(response.status).toBe(401);
    await service.drain();
    expect(seen).toEqual([]);
  });

  it('starts nothing for an event that is not one of the two triggers', async () => {
    const seen: RunRequest[] = [];
    const service = await serve({
      config: config(),
      client: fakeClient(),
      log: () => {},
      run: async (request) => {
        seen.push(request);
        return ok('never');
      },
    });
    services.push(service);
    // Correctly signed, and still not a run. A receiver that quietly accepts a `push`
    // and does nothing is a receiver whose behaviour nobody can state.
    await deliver(service.webhookPort, { ref: 'refs/heads/main' }, { event: 'push' });
    await service.drain();
    expect(seen).toEqual([]);
  });
});

describe('the queue is the boundary, not an optimisation', () => {
  // REMOVED: a test named "answers GitHub before the run finishes".
  //
  // It passed, and it could not fail. The ack-before-run guarantee is
  // `startWebhookReceiver`'s — it replies `202` and then calls `onIntake` without
  // awaiting it — so mutating this file to await the entire run left all 16 tests green.
  // A test that cannot fail is worse than no test, because it implies coverage that is
  // not there. The property is real and is asserted where it lives: `test/github.test.ts`.

  it('runs one at a time, so one machine holds one sandbox', async () => {
    // The behaviour is right; the reason first given for it was not. This said concurrent
    // runs would fight over the host port a recipe pins — they cannot: `replayRecipe` runs
    // inside the container, its healthcheck fetches `127.0.0.1:port` from inside that same
    // container, and nothing publishes a port to the host.
    //
    // The real reason: one run is an agent container plus a base plus three fix runs, so a
    // second concurrent run doubles the Docker load and the model spend with no ceiling.
    // A default worth asserting, and a policy rather than a constraint.
    let concurrent = 0;
    let peak = 0;
    const order: number[] = [];

    const service = await serve({
      config: config(),
      client: fakeClient(),
      log: () => {},
      run: async (request) => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 40));
        order.push(request.intake.issueNumber);
        concurrent -= 1;
        return ok(`run-${request.intake.issueNumber}`);
      },
    });
    services.push(service);

    await Promise.all([1, 2, 3].map((n) => deliver(service.webhookPort, delivery(n))));
    await service.drain();

    expect(peak).toBe(1);
    expect(order).toHaveLength(3);
  });

  it('one repository that cannot start does not take the service down', async () => {
    const lines: string[] = [];
    let second = false;
    const service = await serve({
      config: config(),
      client: fakeClient(),
      log: (line) => lines.push(line),
      run: async (request) => {
        if (request.intake.issueNumber === 1) throw new Error('no installation token');
        second = true;
        return ok('run-2');
      },
    });
    services.push(service);

    await deliver(service.webhookPort, delivery(1));
    await deliver(service.webhookPort, delivery(2));
    await service.drain();

    expect(lines.join('\n')).toContain('no installation token');
    expect(second).toBe(true);
  });
});

describe('the recipe is per repository, and its absence is not an error', () => {
  it('passes the stored recipe through', async () => {
    const recipe = { install: 'npm ci', services: [{ name: 'web', command: 'node s.mjs', port: 8080 }], test: 'npm test' };
    const seen: RunRequest[] = [];
    const service = await serve({
      config: config(),
      client: fakeClient([{ recipe }]),
      log: () => {},
      run: async (request) => {
        seen.push(request);
        return ok('r');
      },
    });
    services.push(service);
    await deliver(service.webhookPort, delivery());
    await service.drain();
    expect(seen[0]!.recipe).toMatchObject({ install: 'npm ci' });
  });

  it('runs with a null recipe and says so, rather than refusing the issue', async () => {
    // ADR-0013: a repository with no recipe boots nothing and the agent is told. That is
    // a Tier 3 waiting to happen, not a reason to drop the delivery on the floor.
    const lines: string[] = [];
    const seen: RunRequest[] = [];
    const service = await serve({
      config: config(),
      client: fakeClient([]),
      log: (line) => lines.push(line),
      run: async (request) => {
        seen.push(request);
        return ok('r');
      },
    });
    services.push(service);
    await deliver(service.webhookPort, delivery());
    await service.drain();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.recipe).toBeNull();
    expect(lines.join('\n')).toMatch(/no recipe/);
  });
});

describe('the event tail is served beside the receiver', () => {
  it('binds a second port and streams a run', async () => {
    const events = [
      { run_id: 'run-1', seq: 1, type: 'RUN_REQUESTED', payload: { v: 1 }, ts: new Date().toISOString() },
    ];
    const service = await serve({
      config: config(),
      client: { query: async () => ({ rows: events.map((e) => ({ ...e })), rowCount: 1 }) } as unknown as pg.Client,
      log: () => {},
      run: async () => ok('r'),
    });
    services.push(service);

    expect(service.eventsPort).toBeGreaterThan(0);
    expect(service.eventsPort).not.toBe(service.webhookPort);

    const response = await fetch(`http://127.0.0.1:${service.eventsPort}/runs/run-1/events`, {
      headers: { accept: 'text/event-stream' },
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    // `id:` is the seq, which is what makes resumption a `>` (ADR-0005).
    expect(chunk).toContain('id: 1');
    expect(chunk).toContain('RUN_REQUESTED');
    await reader.cancel();
  });
});

describe('the source keeps the promises this file makes', () => {
  it('reads the config before it binds anything', () => {
    // Asserted over the source because the ordering is the property: a `serve()` that
    // bound a port and then validated would already be answering when it threw.
    const source = readFileSync(new URL('../src/serve.ts', import.meta.url), 'utf8');
    const validate = source.indexOf('export function readConfig');
    const bind = source.indexOf('startWebhookReceiver({');
    expect(validate).toBeGreaterThan(-1);
    expect(bind).toBeGreaterThan(validate);
  });
});

describe('the setup document cannot drift from the calls we make', () => {
  // The permission set was wrong in `architecture-v1.5.md` for the whole of milestone 5,
  // and it was wrong in the way that matters: `issues: write` is needed by the issue
  // comment, which for Tier 3 IS the deliverable, and `run.ts` swallows a failed comment
  // on purpose. So the narrower set produced a run that did everything right, said
  // nothing, and recorded no error. Nobody noticed because no document was checked
  // against the code.
  //
  // This asserts the GitHub API surface is exactly what the setup guide documents. Add a
  // fourth call and this fails, which forces the permission table to be reconsidered
  // rather than silently outgrown.
  const github = readFileSync(new URL('../src/github.ts', import.meta.url), 'utf8');
  const guide = readFileSync(new URL('../docs/github-app-setup.md', import.meta.url), 'utf8');

  /** Every `${api}/…` path github.ts calls, with interpolations flattened. */
  const called = [...github.matchAll(/\$\{api\}(\/[^`]*)`/g)]
    .map((match) => match[1]!.replace(/\$\{[^}]+\}/g, ':x'))
    .sort();

  it('calls exactly the three endpoints the guide accounts for', () => {
    expect(called).toEqual([
      '/app/installations/:x/access_tokens',
      '/repos/:x/issues/:x/comments',
      '/repos/:x/pulls',
    ]);
  });

  it('documents every permission those endpoints require', () => {
    expect(guide).toMatch(/\*\*Contents\*\* — read and write/);
    expect(guide).toMatch(/\*\*Pull requests\*\* — read and write/);
    expect(guide).toMatch(/\*\*Issues\*\* — read and write/);
    // And says why the third one's absence is invisible, because that is the whole
    // reason this file exists rather than a link to GitHub's docs.
    expect(guide).toMatch(/indistinguishable from a webhook that never fired/);
  });

  it('no longer claims contents and pull_requests are enough', () => {
    const architecture = readFileSync(new URL('../docs/architecture-v1.5.md', import.meta.url), 'utf8');
    expect(architecture).toMatch(/issues: read and write/);
    expect(architecture).not.toMatch(/`contents: read and write` and `pull_requests: write` — nothing else/);
  });
});
