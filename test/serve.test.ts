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
import type { Db } from '../src/store.js';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
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
  loop: { provider: 'openrouter', apiKey: 'sk-or-test', model: 'moonshotai/kimi-k2-thinking', effort: 'low' },
  ...over,
});

/**
 * A `Db` that answers per QUERY, not one shape for everything.
 *
 * It used to return the same rows to every question, which stopped working the moment
 * the issue path asked two: is this repository still installed (M6a), and does it have an
 * approved recipe. A single-shape fake made those indistinguishable, so a test about the
 * recipe gate was silently exercising the installation gate instead.
 */
const fakeClient = (options: { installed?: boolean; recipe?: unknown } = {}) => {
  const installed = options.installed ?? true;
  return {
    query: vi.fn(async (sql: string) => {
      const rows =
        typeof sql === 'string' && sql.includes('from installations')
          ? installed
            ? [{ repo: 'o/r', installation_id: 987654, account: 'o', connected_at: new Date(), removed_at: null }]
            : []
          : typeof sql === 'string' && sql.includes('from recipes')
            ? options.recipe === undefined
              ? []
              : [{ recipe: options.recipe }]
            : [];
      return { rows, rowCount: rows.length };
    }),
  } as unknown as Db;
};

/**
 * A client that answers `loadRecipe`, i.e. an ONBOARDED repository.
 *
 * Since M6a an issue on a repository with no approved recipe starts no run at all, so
 * every test about what a run receives has to say which repository it is talking about.
 * Named rather than inlined because the distinction is the subject of two tests below and
 * `fakeClient([])` silently means "not onboarded" now.
 */
const onboarded = () => fakeClient({ recipe: { install: 'npm ci', services: [], test: 'npm test' } });

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
      OPENROUTER_API_KEY: 'sk-or-x',
    } as NodeJS.ProcessEnv;
    expect(readConfig(env).privateKeyPem).toBe(PEM);
  });

  it('refuses to start with no model credential for the selected provider', () => {
    // A service that starts without one reaches the agent phase and silently consults
    // nothing — the failure has no symptom except a run that resolves nothing.
    const base = {
      GITHUB_APP_ID: '1',
      GITHUB_WEBHOOK_SECRET: 's',
      DATABASE_URL: 'postgres://x',
      GITHUB_PRIVATE_KEY: PEM,
    } as NodeJS.ProcessEnv;
    expect(() => readConfig({ ...base, ENGINE_PROVIDER: 'openrouter' })).toThrow(/OPENROUTER_API_KEY/);
    expect(() => readConfig({ ...base, ENGINE_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
    // And says what the absence costs, not just the name.
    try {
      readConfig({ ...base, ENGINE_PROVIDER: 'openrouter' });
      expect.unreachable('started with no model credential');
    } catch (error) {
      expect(String((error as Error).message)).toMatch(/no model would ever be consulted/);
    }
    // With one, it starts and carries the selection through.
    const ok = readConfig({ ...base, ENGINE_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'sk-or-x', ENGINE_EFFORT: 'low' });
    expect(ok.loop).toEqual({
      provider: 'openrouter',
      apiKey: 'sk-or-x',
      model: 'moonshotai/kimi-k2-thinking',
      effort: 'low',
    });
    // The model default follows the PROVIDER. `modelId()` would return `claude-opus-5`
    // here, and ADR-0015 records that an Anthropic id on OpenRouter's OpenAI endpoint is
    // a 404 whose cause is not in the message.
    expect(ok.loop.model).not.toContain('claude');
    const anth = readConfig({ ...base, ENGINE_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-x' });
    expect(anth.loop.model).toBe('claude-opus-5');
  });

  it('refuses a key that is not a PEM at startup, not on the first delivery', () => {
    // Otherwise this surfaces as a crypto error inside `appJwt`, minutes later, on
    // someone's real issue.
    const env = {
      GITHUB_APP_ID: '1',
      GITHUB_WEBHOOK_SECRET: 's',
      DATABASE_URL: 'postgres://x',
      GITHUB_PRIVATE_KEY: 'not-a-key',
      OPENROUTER_API_KEY: 'sk-or-x',
    } as NodeJS.ProcessEnv;
    expect(() => readConfig(env)).toThrow(/not a PEM/);
  });

  it('says which path it could not read, rather than reporting the key as missing', () => {
    const env = {
      GITHUB_APP_ID: '1',
      GITHUB_WEBHOOK_SECRET: 's',
      DATABASE_URL: 'postgres://x',
      GITHUB_PRIVATE_KEY_PATH: '/nope/absent.pem',
      OPENROUTER_API_KEY: 'sk-or-x',
    } as NodeJS.ProcessEnv;
    expect(() => readConfig(env)).toThrow(/unreadable/);
  });
});

describe('approving a recipe proves the repository (8f)', () => {
  const PROOF = {
    state: 'ready_with_caveats' as const,
    commit: 'a'.repeat(40),
    environment: { built: true as const },
    caveats: ['the test command `npm test` already fails at this commit (exit 1)'],
    unproved: [],
    provedAt: 'T',
  };

  const approve = (port: number) =>
    fetch(`http://127.0.0.1:${port}/repos/o/r/onboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        recipe: JSON.stringify({ install: 'npm ci', services: [], test: 'npm test' }),
      }).toString(),
      redirect: 'manual',
    });

  it('starts the proving run on the recipe now in force, and stores what it found', async () => {
    // The trigger milestone 7 asked for. Before this, the first time anyone knew
    // whether an approved recipe works was in the middle of a real run.
    const proved: unknown[] = [];
    const client = onboarded();
    const service = await serve({
      config: config(),
      client,
      log: () => {},
      run: async () => ok('r'),
      // Neither of these may touch a network or a container for a test about wiring.
      cloneForDraft: async () => {},
      prove: async (plan) => {
        proved.push(plan.recipe);
        return PROOF;
      },
    });
    services.push(service);

    expect((await approve(service.eventsPort)).status).toBe(303);

    // Fired, not awaited — the human who pressed approve gets their page back
    // immediately, and this lands afterwards.
    await vi.waitFor(() => expect(proved).toHaveLength(1));
    expect(proved[0]).toMatchObject({ install: 'npm ci', test: 'npm test' });

    // And it was WRITTEN. A proving run whose result is not stored is a container
    // spent on a page that still says "not proved yet".
    const queries = () =>
      (client.query as unknown as Mock<(sql: string) => unknown>).mock.calls
        .map((call) => String(call[0]))
        .join('\n');
    await vi.waitFor(() => expect(queries()).toContain('update recipes set proof'));
  });

  it('a proving run that throws does not take the service down with it', async () => {
    // It is fired and not awaited, so a rejection escaping it is an unhandled
    // rejection — which on current Node ends the process. A database hiccup one second
    // after somebody approved a recipe would have killed the webhook receiver, and the
    // page that reported the approval would already have said it worked.
    const logs: string[] = [];
    const service = await serve({
      config: config(),
      client: onboarded(),
      log: (line) => logs.push(line),
      run: async () => ok('r'),
      cloneForDraft: async () => {},
      prove: async () => {
        throw new Error('the daemon went away');
      },
    });
    services.push(service);

    expect((await approve(service.eventsPort)).status).toBe(303);
    await vi.waitFor(() => expect(logs.join('\n')).toContain('could not be proved'));
    expect(logs.join('\n')).toContain('the daemon went away');

    // Still serving. The assertion that would have failed on an unhandled rejection is
    // the test runner surviving at all, and this one says it in the file.
    const alive = await fetch(`http://127.0.0.1:${service.eventsPort}/repos`);
    expect(alive.status).toBe(200);
  });
});

describe('a signed issue becomes a run', () => {
  it('drives the whole path from an HTTP delivery to runFromIssue', async () => {
    const seen: RunRequest[] = [];
    const service = await serve({
      config: config(),
      client: onboarded(),
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

  it('passes a loop, because without one no model is ever consulted', async () => {
    // The bug this exists for, found by the first real webhook-driven run. `serve.ts`
    // passed no `loop`, so `orchestrate` took its pre-ADR-0011 branch — `claude` spawned
    // INSIDE the sealed container, which can reach no model — and the run ended
    // `unresolved` with `AGENT_FINISHED { stopped: 'spawn_failed', messages: 0 }`, no
    // ENV_READY, and every container exiting 0 with an empty stderr. Nothing named a cause.
    //
    // The 18 tests here could not catch it: they replace `runFromIssue` with a fake, and
    // asserted the image and the app id reached it while never asserting a MODEL did.
    const seen: RunRequest[] = [];
    const service = await serve({
      config: config(),
      client: onboarded(),
      log: () => {},
      run: async (request) => {
        seen.push(request);
        return ok('r');
      },
    });
    services.push(service);
    await deliver(service.webhookPort, delivery());
    await service.drain();

    expect(seen[0]!.loop).toBeDefined();
    expect(seen[0]!.loop!.provider).toBe('openrouter');
    expect(seen[0]!.loop!.apiKey).toBe('sk-or-test');
    expect(seen[0]!.loop!.model).toBe('moonshotai/kimi-k2-thinking');
  });

  it('creates the evidence store, so the first run has somewhere to write', async () => {
    const root = join(temp(), 'blobs');
    const service = await serve({ config: config({ blobRoot: root }), client: onboarded(), log: () => {}, run: async () => ok('r') });
    services.push(service);
    expect(existsSync(join(root, '.evidence-store'))).toBe(true);
  });

  it('never lets a credential reach the log line', async () => {
    const lines: string[] = [];
    const service = await serve({
      config: config(),
      client: onboarded(),
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
      client: onboarded(),
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
      client: onboarded(),
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

describe('drafting a recipe for a freshly-installed, un-onboarded repository (M6b)', () => {
  const installedPayload = (repo = 'o/r') => ({
    action: 'created',
    installation: { id: 987654, account: { login: 'o' } },
    repositories: [{ full_name: repo }],
  });

  const EMPTY_USAGE = {
    turns: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

  /** Whichever `client.query` call, if any, inserted a draft — `saveDraft`'s own SQL. */
  const draftInsert = (client: Db): unknown[] | undefined =>
    (client.query as ReturnType<typeof vi.fn>).mock.calls.find(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('insert into recipe_drafts'),
    );

  it('clones the repository, runs the drafting agent, and stores whatever it proposed', async () => {
    const cloned: { repo: string; installationId: number; into: string }[] = [];
    const drafted: { repoPath: string; image: string; agentImage?: string }[] = [];
    const client = fakeClient();
    const service = await serve({
      config: config(),
      client,
      log: () => {},
      cloneForDraft: async (repo, installationId, into) => {
        cloned.push({ repo, installationId, into });
      },
      draft: async (plan) => {
        drafted.push(plan);
        return {
          ok: true,
          draft: { install: 'npm ci', services: [] },
          transcriptText: 'looks like a node project',
          usage: EMPTY_USAGE,
        };
      },
    });
    services.push(service);

    await deliver(service.webhookPort, installedPayload(), { event: 'installation' });
    await service.drain();

    expect(cloned).toEqual([{ repo: 'o/r', installationId: 987654, into: cloned[0]!.into }]);
    expect(drafted).toHaveLength(1);
    // The config actually reaches the drafting session, rather than it inventing its own.
    expect(drafted[0]).toMatchObject({ image: 'sandbox:test', agentImage: 'agent:test' });

    // Stored, not merely computed — `saveDraft`'s own upsert, seen on the fake client.
    const insert = draftInsert(client);
    expect(insert).toBeDefined();
    expect(JSON.parse((insert as [string, unknown[]])[1][1] as string)).toEqual({ install: 'npm ci', services: [] });
  });

  it('drafts nothing for a repository that already has an approved recipe', async () => {
    const cloned: unknown[] = [];
    const drafted: unknown[] = [];
    const service = await serve({
      config: config(),
      client: fakeClient({ recipe: { install: 'npm ci', services: [] } }),
      log: () => {},
      cloneForDraft: async (...args) => void cloned.push(args),
      draft: async (plan) => {
        drafted.push(plan);
        return { ok: true, draft: {}, transcriptText: '', usage: EMPTY_USAGE };
      },
    });
    services.push(service);

    await deliver(service.webhookPort, installedPayload(), { event: 'installation' });
    await service.drain();

    expect(cloned).toEqual([]);
    expect(drafted).toEqual([]);
  });

  it('a failed clone or a refusing agent is logged and stores nothing, without losing the installation record', async () => {
    const lines: string[] = [];
    const client = fakeClient();
    const service = await serve({
      config: config(),
      client,
      log: (line) => lines.push(line),
      cloneForDraft: async () => {
        throw new Error('could not clone: repository too large');
      },
      draft: async () => {
        throw new Error('must not be called once the clone has failed');
      },
    });
    services.push(service);

    await deliver(service.webhookPort, installedPayload(), { event: 'installation' });
    await service.drain();

    // The installation is still recorded — a drafting failure is not an installation
    // failure, and the two must not be conflated into one log line either.
    expect(lines.join('\n')).toContain('o/r: installed');
    expect(lines.join('\n')).toContain('could not draft a recipe');
    expect(draftInsert(client)).toBeUndefined();
  });

  it('an agent that refuses to draft is logged by its own reason, and stores nothing', async () => {
    const lines: string[] = [];
    const client = fakeClient();
    const service = await serve({
      config: config(),
      client,
      log: (line) => lines.push(line),
      cloneForDraft: async () => {},
      draft: async () => ({
        ok: false,
        reason: 'the drafting agent never ran',
        transcriptText: '',
        usage: EMPTY_USAGE,
      }),
    });
    services.push(service);

    await deliver(service.webhookPort, installedPayload(), { event: 'installation' });
    await service.drain();

    expect(lines.join('\n')).toContain('the drafting agent never ran');
    expect(draftInsert(client)).toBeUndefined();
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
      client: onboarded(),
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
      client: onboarded(),
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

    // The first delivery's run throws; the queue survives and the second still runs.
    expect(lines.join('\n')).toContain('could not start');
    expect(second).toBe(true);
  });
});

describe('the recipe is per repository, and its absence is not an error', () => {
  it('passes the stored recipe through', async () => {
    const recipe = { install: 'npm ci', services: [{ name: 'web', command: 'node s.mjs', port: 8080 }], test: 'npm test' };
    const seen: RunRequest[] = [];
    const service = await serve({
      config: config(),
      client: fakeClient({ recipe }),
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

  it('starts NO run for a repository with no approved recipe, and says so on the issue', async () => {
    // THIS TEST IS INVERTED, and the inversion is milestone 6a.
    //
    // It used to assert the opposite: that a missing recipe was "a Tier 3 waiting to
    // happen, not a reason to drop the delivery on the floor". That reasoning was right
    // about not dropping the delivery and wrong about what to do instead. With no recipe
    // nothing boots, the agent is told there is no environment, and the overwhelmingly
    // likely outcome is `not_reproduced` — "we could not reproduce this" written onto a
    // stranger's issue, in an append-only log, about a bug we never had the means to look
    // at. A user's first experience of the product was a confident wrong answer.
    //
    // The reproduce-first gate could not catch it either: ADR-0007 judges reproductions,
    // and this failure is upstream of anything being reproduced.
    const lines: string[] = [];
    const seen: RunRequest[] = [];
    const comments: { repo: string; issue: number; body: string }[] = [];
    const service = await serve({
      config: config(),
      client: fakeClient(),
      log: (line) => lines.push(line),
      run: async (request) => {
        seen.push(request);
        return ok('r');
      },
      comment: async (repo, issue, body) => void comments.push({ repo, issue, body }),
    });
    services.push(service);
    await deliver(service.webhookPort, delivery());
    await service.drain();

    // Zero runs. Not a cheap run, not a short run — none.
    expect(seen).toHaveLength(0);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ repo: 'o/r', issue: 41 });
    expect(comments[0]!.body).toMatch(/not onboarded yet/);
    // And it says whose gap it is, rather than implying the report was inadequate.
    expect(comments[0]!.body).toMatch(/no run was started/);
    expect(lines.join('\n')).toMatch(/not onboarded/);
  });

  it('a failed comment does not take the service down, because the next issue is not this one', async () => {
    // The comment is best-effort for the same reason `run.ts`'s is: GitHub being
    // unreachable is our outage, and one unreachable repository must not stop the queue.
    const lines: string[] = [];
    const service = await serve({
      config: config(),
      client: fakeClient(),
      log: (line) => lines.push(line),
      run: async () => ok('r'),
      comment: async () => {
        throw new Error('github said no');
      },
    });
    services.push(service);
    await deliver(service.webhookPort, delivery());
    await service.drain();
    expect(lines.join('\n')).toMatch(/could not comment/);
  });
});

describe('the event tail is served beside the receiver', () => {
  it('binds a second port and streams a run', async () => {
    const events = [
      { run_id: 'run-1', seq: 1, type: 'RUN_REQUESTED', payload: { v: 1 }, ts: new Date().toISOString() },
    ];
    const service = await serve({
      config: config(),
      client: { query: async () => ({ rows: events.map((e) => ({ ...e })), rowCount: 1 }) } as unknown as Db,
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

  it('calls exactly the five endpoints the guide accounts for', () => {
    // Two more since M10: the issue picker lists, and the button reads one issue before
    // it queues a run. Both are covered by the Issues permission the comment already
    // needed, so the table gained words rather than a row.
    expect(called).toEqual([
      '/app/installations/:x/access_tokens',
      '/repos/:x/issues',
      '/repos/:x/issues/:x',
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

  it('subscribes the operator to exactly the events intake() acts on', () => {
    // The test milestone 6a asks for, and the one the permission set needed and did not
    // have: "the permission set was wrong for a whole milestone because no document was
    // ever checked against the code."
    //
    // An event `intake()` handles but the guide never mentions is a subscription nobody
    // ticks, and its absence is silent — GitHub simply never delivers, which is
    // indistinguishable from nothing happening. That is precisely how installation
    // events would fail: the operator sees issues working and never learns that
    // onboarding is deaf.
    //
    // Read off the source rather than restated, so adding an event to `intake()` without
    // documenting it fails here.
    // `[!=]==` because the issues branch is written as a guard — `if (event !== 'issues')
    // return null` — and a regex looking only for equality found two of the three.
    const handled = [...github.matchAll(/\bevent [!=]== '([a-z_]+)'/g)].map((match) => match[1]!).sort();
    expect([...new Set(handled)]).toEqual(['installation', 'installation_repositories', 'issues']);

    expect(guide).toMatch(/\*\*Issues\*\* \| `opened`, `labeled`/);
    expect(guide).toMatch(/\*\*Installation\*\* \| `created`, `deleted`/);
    expect(guide).toMatch(/\*\*Installation repositories\*\* \| `added`, `removed`/);
    // And the guide no longer says the thing that stopped being true.
    expect(guide).not.toMatch(/\*\*Issues only\.\*\*/);
  });

  it('says why an un-onboarded repository gets a comment rather than a run', () => {
    // The behaviour change with the least visible failure mode: starting a run anyway
    // produces a confident Tier 3 about a bug nothing ever had the means to look at, and
    // writes it somewhere it cannot be deleted. A guide that does not explain the
    // subscription's purpose gets it switched off by someone tidying.
    expect(guide).toMatch(/no run starts at all/);
  });
});
