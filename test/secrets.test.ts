// A value this service holds and can never show you again (M10, ADR-0017).
//
// Three properties, and each is tested by trying to break it rather than by exercising
// the happy path:
//
//   - **A ciphertext belongs to one row.** Moved to another, it does not decrypt to
//     something wrong; it fails to decrypt at all. That is the AAD, and the control below
//     is a re-homed blob.
//   - **No route returns a value.** Not "no route is documented to" — the test stores a
//     recognisable string and then greps every response the surface can produce for it.
//   - **A runner gets what its run is entitled to.** Not what it asks for: the repository
//     comes from the `jobs` row, so a runner holding one run cannot name another's
//     repository and be handed its credentials.
//
// The crypto half needs no database. The storage and route halves do, and skip loudly
// without one for the reason `plane.test.ts` gives.

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type pg from 'pg';
import type { Db } from '../src/store.js';
import type { Session } from '../src/auth.js';
import { connect } from '../src/store.js';
import { dashboardRoutes } from '../src/routes.js';
import { readPlaneConfig } from '../src/plane-server.js';
import { runnerRoutes } from '../src/runner-api.js';
import { enqueueJob, pairRunner } from '../src/plane.js';
import { recordInstallation } from '../src/installations.js';
import {
  deleteModelKey,
  deleteRepoSecret,
  hasModelKey,
  listRepoSecretNames,
  modelKey,
  open,
  putModelKey,
  putRepoSecret,
  repoAad,
  repoSecrets,
  seal,
  sealingKey,
  secretsEnabled,
  userAad,
} from '../src/secrets.js';

/** A recognisable value. If any response ever contains this, a route returned a secret. */
const CANARY = 'hunter2-canary-do-not-return-this';
const KEY = randomBytes(32);

describe('sealing binds a value to the row it belongs to', () => {
  test('a round trip, and the same value sealed twice looks different', () => {
    const sealed = seal(CANARY, repoAad('o/r', 'STRIPE_SECRET_KEY'), KEY);
    expect(open(sealed, repoAad('o/r', 'STRIPE_SECRET_KEY'), KEY)).toBe(CANARY);
    // Equal ciphertexts would tell anyone who can read the table which repositories
    // share a key. The nonce is what stops that, and it is fresh per call.
    expect(seal(CANARY, repoAad('o/r', 'A'), KEY).equals(seal(CANARY, repoAad('o/r', 'A'), KEY))).toBe(false);
  });

  test('THE control: a ciphertext moved to another row does not open', () => {
    // The attack this closes is not "somebody reads the table" — it is somebody who can
    // WRITE one: a restored backup, a bad migration, an injection. Without the AAD a
    // ciphertext is portable, and moving `STRIPE_SECRET_KEY` from a repository you own
    // onto one you do not would have the worker inject it there.
    const sealed = seal(CANARY, repoAad('mine/repo', 'STRIPE_SECRET_KEY'), KEY);
    expect(() => open(sealed, repoAad('theirs/repo', 'STRIPE_SECRET_KEY'), KEY)).toThrow();
    // And the same value under a different NAME in the same repository is also refused,
    // because the name is half of what the row is.
    expect(() => open(sealed, repoAad('mine/repo', 'DATABASE_URL'), KEY)).toThrow();
    // A wrong key fails the tag check too, rather than yielding plausible bytes.
    expect(() => open(sealed, repoAad('mine/repo', 'STRIPE_SECRET_KEY'), randomBytes(32))).toThrow();
  });

  test('a tampered byte is a throw, not a different answer', () => {
    const sealed = seal(CANARY, userAad(4242, 'openrouter'), KEY);
    const bent = Buffer.from(sealed);
    bent[bent.length - 1] = (bent.at(-1)! ^ 0xff) & 0xff;
    expect(() => open(bent, userAad(4242, 'openrouter'), KEY)).toThrow();
    // And something far too short to be a sealed value is refused before the cipher is
    // asked, so the error says what is wrong rather than surfacing a node internal.
    expect(() => open(Buffer.alloc(4), userAad(4242, 'openrouter'), KEY)).toThrow(/too short/);
  });

  test('the provider is inside the seal, because it decides where the key is sent', () => {
    // The attack: somebody who can WRITE a row — a restored backup, a migration, an
    // injection — cannot forge the ciphertext, and does not need to. Flipping `provider`
    // in place would have the worker put an OpenRouter key in an Anthropic auth header,
    // which is the same key leaving for a destination its owner never chose.
    const sealed = seal(CANARY, userAad(4242, 'openrouter'), KEY);
    expect(open(sealed, userAad(4242, 'openrouter'), KEY)).toBe(CANARY);
    expect(() => open(sealed, userAad(4242, 'anthropic'), KEY)).toThrow();
    // And it is still bound to the person, which was the original point.
    expect(() => open(sealed, userAad(4243, 'openrouter'), KEY)).toThrow();
  });

  test('the key has to be a key, and the refusal says how to make one', () => {
    expect(() => sealingKey({} as NodeJS.ProcessEnv)).toThrow(/openssl rand -base64 32/);
    expect(() => sealingKey({ PLANE_SECRETS_KEY: 'aGk=' } as NodeJS.ProcessEnv)).toThrow(/32/);
    expect(sealingKey({ PLANE_SECRETS_KEY: KEY.toString('base64') } as NodeJS.ProcessEnv).equals(KEY)).toBe(true);
  });

  test('injection is off unless a deployment says otherwise', () => {
    expect(secretsEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(secretsEnabled({ ENGINE_SECRETS_ENABLED: 'no' } as NodeJS.ProcessEnv)).toBe(false);
    expect(secretsEnabled({ ENGINE_SECRETS_ENABLED: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(secretsEnabled({ ENGINE_SECRETS_ENABLED: 'TRUE' } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('a plane that cannot seal does not start', () => {
  /** Everything `readPlaneConfig` demands, so a test can remove exactly one thing. */
  const complete = (): NodeJS.ProcessEnv => ({
    DATABASE_URL: 'postgres://x/y',
    GITHUB_APP_ID: '1',
    GITHUB_PRIVATE_KEY: 'a-pem',
    GITHUB_WEBHOOK_SECRET: 's',
    GITHUB_CLIENT_ID: 'c',
    GITHUB_CLIENT_SECRET: 'cs',
    ENGINE_PLANE_CALLBACK_URL: 'https://x/callback',
    ENGINE_BLOB_ROOT: '/tmp/blobs',
    PLANE_SECRETS_KEY: KEY.toString('base64'),
  });

  test('a missing sealing key is a boot failure, not a surprise at the first write', () => {
    // The alternative is a process that accepts a credential and then finds it has
    // nowhere to seal it — at which point the only options are refusing at the last
    // moment or writing plaintext. Failing where an operator is looking is the only
    // version of this that cannot go wrong quietly.
    const { PLANE_SECRETS_KEY, ...without } = complete();
    expect(() => readPlaneConfig(without)).toThrow(/PLANE_SECRETS_KEY/);
    expect(() => readPlaneConfig(without)).toThrow(/openssl rand -base64 32/);
    // THE positive control: with it, the same environment starts. Without this the
    // assertion above passes on a config function that refuses everything.
    expect(() => readPlaneConfig(complete())).not.toThrow();
  });
});

// ── The surface: what a person may do, and what nobody may read back ───────────

const SESSION: Session = { id: 's', githubId: 1, login: 'divy97', avatarUrl: '', token: 'ghu' };

const fakeClient = (rows: { name: string }[] = []) =>
  ({
    query: vi.fn(async (sql: string) => {
      const answer = sql.includes('from installations')
        ? [
            { repo: 'mine/repo', installation_id: 1, account: 'me', connected_at: new Date(), removed_at: null },
            { repo: 'theirs/repo', installation_id: 2, account: 'them', connected_at: new Date(), removed_at: null },
          ]
        : sql.includes('from repo_secrets')
          ? rows
          : sql.includes('from user_model_keys')
            ? [{ provider: 'openrouter' }]
            : [];
      return { rows: answer, rowCount: answer.length };
    }),
  }) as unknown as Db;

const surface = (
  options: {
    client?: Db;
    installations?: number[];
    checkKey?: (provider: string, key: string) => Promise<{ ok: boolean; detail: string; status?: number }>;
  } = {},
) =>
  dashboardRoutes({
    client: options.client ?? fakeClient(),
    installUrl: 'https://example.invalid',
    // A key that always works, so the route stores what it is given. The real checker
    // spends a request on a real provider — with the CANARY as the bearer token, in the
    // sweep below — and a test suite must not reach the network to find that out.
    checkKey: options.checkKey ?? (async () => ({ ok: true, detail: 'a fake accepted it' })),
    auth: {
      session: async () => SESSION,
      installations: async () => options.installations ?? [1],
    },
  });

const call = (
  route: ReturnType<typeof dashboardRoutes>,
  method: string,
  path: string,
  body = '',
  headers: Record<string, string> = { 'content-type': 'application/json' },
) =>
  route({ method, path, query: new URLSearchParams(), headers, body: async () => body, raw: async () => Buffer.from(body) });

describe('the secrets routes answer with names and never with values', () => {
  test('listing gives names and says whether they are injected yet', async () => {
    const response = await call(surface({ client: fakeClient([{ name: 'STRIPE_SECRET_KEY' }]) }), 'GET', '/api/repos/mine%2Frepo/secrets');
    expect(response?.status).toBe(200);
    const body = JSON.parse(String(response?.body)) as { names: string[]; enabled: boolean };
    expect(body.names).toEqual(['STRIPE_SECRET_KEY']);
    // The flag the pages tell the truth from. Off in this process, and the copy that
    // depends on it is asserted in `web.test.ts`.
    expect(body.enabled).toBe(false);
  });

  test('there is no verb that reads one back', async () => {
    // A GET of a specific name is 405 rather than 404: 404 would read as "no such
    // secret", which invites a client to keep trying names. This says the operation
    // does not exist.
    const response = await call(surface(), 'GET', '/api/repos/mine%2Frepo/secrets/STRIPE_SECRET_KEY');
    expect(response?.status).toBe(405);
    expect(String(response?.body)).toMatch(/never returned/);
  });

  test("a repository you cannot see is not yours to store into, and says nothing about itself", async () => {
    // 404 and identical words for "not yours" and "no such repository": a stranger
    // probing names learns nothing about which repositories this service knows.
    for (const [method, path] of [
      ['GET', '/api/repos/theirs%2Frepo/secrets'],
      ['PUT', '/api/repos/theirs%2Frepo/secrets/STRIPE_SECRET_KEY'],
      ['DELETE', '/api/repos/theirs%2Frepo/secrets/STRIPE_SECRET_KEY'],
    ] as const) {
      const response = await call(surface(), method, path, JSON.stringify({ value: CANARY }));
      expect(response?.status).toBe(404);
      expect(String(response?.body)).toContain('not connected');
    }
    // THE POSITIVE CONTROL: the same three verbs on a repository this person CAN see
    // are not 404 — without this the test above passes on a surface that refuses
    // everything.
    const allowed = await call(surface({ installations: [1, 2] }), 'GET', '/api/repos/theirs%2Frepo/secrets');
    expect(allowed?.status).toBe(200);
  });

  test('a name has to be a name, and a value has to be one', async () => {
    const bad = async (name: string, body: string) =>
      (await call(surface(), 'PUT', `/api/repos/mine%2Frepo/secrets/${name}`, body))?.status;
    expect(await bad('lower_case', JSON.stringify({ value: 'x' }))).toBe(400);
    expect(await bad('HAS SPACE', JSON.stringify({ value: 'x' }))).toBe(400);
    // An empty value would be stored as present and still block the run, which is the
    // worst of both answers.
    expect(await bad('OK_NAME', JSON.stringify({ value: '' }))).toBe(400);
    expect(await bad('OK_NAME', JSON.stringify({}))).toBe(400);
    expect(await bad('OK_NAME', 'not json')).toBe(400);
    expect(await bad('OK_NAME', JSON.stringify({ value: 'x'.repeat(9000) }))).toBe(413);
  });

  test('a write has to arrive as JSON, from this origin', async () => {
    const formShaped = await call(surface(), 'PUT', '/api/repos/mine%2Frepo/secrets/A_NAME', 'value=x', {
      'content-type': 'text/plain',
    });
    expect(formShaped?.status).toBe(415);
    const crossSite = await call(surface(), 'PUT', '/api/repos/mine%2Frepo/secrets/A_NAME', '{}', {
      'content-type': 'application/json',
      'sec-fetch-site': 'cross-site',
    });
    expect(crossSite?.status).toBe(403);
    const crossSiteDelete = await call(surface(), 'DELETE', '/api/repos/mine%2Frepo/secrets/A_NAME', '', {
      'sec-fetch-site': 'cross-site',
    });
    expect(crossSiteDelete?.status).toBe(403);
  });

  test('the model key is per person, and reading it back gives a provider and no key', async () => {
    const response = await call(surface(), 'GET', '/api/settings/model-key');
    expect(response?.status).toBe(200);
    expect(JSON.parse(String(response?.body))).toEqual({ provider: 'openrouter' });
    // A provider this engine cannot drive is refused rather than stored, because a key
    // filed under a name nothing reads is a credential held for nothing.
    const wrong = await call(surface(), 'PUT', '/api/settings/model-key', JSON.stringify({ provider: 'acme', key: 'k' }));
    expect(wrong?.status).toBe(400);
  });

  test('a refused key is told what to DO about it, per refusal', async () => {
    // This route answered `openrouter refused this key` and then relayed the provider's
    // response — which arrived as its raw JSON envelope, so somebody who had just mistyped
    // a key read
    //   openrouter refused this key … — HTTP 401 — {"error":{"message":"Missing
    //   Authentication header","code":401}}
    // on a settings page. It tells them nothing they can act on and nothing they cannot
    // already see. Every branch below is an ACTION, and the statuses call for different
    // ones.
    const at = async (status: number | undefined, detail: string) => {
      const response = await call(
        surface({ checkKey: async () => ({ ok: false, detail, status }) }),
        'PUT',
        '/api/settings/model-key',
        JSON.stringify({ provider: 'openrouter', key: 'k' }),
      );
      expect(response?.status).toBe(400);
      return (JSON.parse(String(response?.body)) as { error: string }).error;
    };

    // A mistyped or truncated key — the commonest way this fails, and the one the old
    // message served worst.
    expect(await at(401, 'Missing Authentication header')).toMatch(/pasted the whole thing/);
    expect(await at(401, 'Missing Authentication header')).toContain('sk-or-');
    // A key that is valid, was funded once, and is spent. The failure that cost most of a
    // day, so it says how much headroom a session needs.
    expect(await at(403, 'Key limit exceeded (total limit)')).toMatch(/over its spend limit/);
    expect(await at(403, 'Key limit exceeded (total limit)')).toMatch(/tens of turns/);
    // Refused for some other reason.
    expect(await at(403, 'forbidden')).toMatch(/revoked or restricted/);
    expect(await at(404, 'no endpoints found')).toMatch(/does not offer/);
    expect(await at(429, 'slow down')).toMatch(/rate-limiting/);
    // No status at all is a request that never got an answer, which is not the key's fault
    // and must not be described as if it were.
    expect(await at(undefined, 'fetch failed')).toMatch(/could not be reached/);
    // Every one of them says the key was not saved, because that is the fact a person needs
    // before they navigate away believing it was.
    for (const status of [401, 403, 404, 429, undefined]) {
      expect(await at(status, 'whatever'), `status ${status}`).toMatch(/not been saved/);
    }
  });

  test('a key the provider refuses is not stored, and the refusal is quoted', async () => {
    // The onboarding failure this closes. The route checked the length of the string and
    // the spelling of the provider and stored whatever it was handed, so a key that was
    // revoked, expired, or over its spend cap was accepted and shown as configured — and
    // the first thing to discover otherwise was an agent seventeen turns into the first
    // drafting session on a repository the person had just connected.
    const asked: { provider: string; key: string }[] = [];
    const refusing = surface({
      checkKey: async (provider, key) => {
        asked.push({ provider, key });
        return { ok: false, detail: 'Key limit exceeded (total limit)' };
      },
    });
    const response = await call(
      refusing,
      'PUT',
      '/api/settings/model-key',
      JSON.stringify({ provider: 'openrouter', key: 'sk-or-spent' }),
    );

    expect(response?.status).toBe(400);
    const body = JSON.parse(String(response?.body)) as { error: string; detail: string };
    expect(body.error).toContain('has not been saved');
    // The provider's own words reach the person, because ours would be a guess at which
    // of expired, revoked, out of credit, or not entitled to this model it was.
    expect(body.detail).toContain('Key limit exceeded');
    // And it was really asked, with the key it was given — a route that skipped the check
    // and hard-coded the 400 would pass every assertion above.
    expect(asked).toEqual([{ provider: 'openrouter', key: 'sk-or-spent' }]);
  });

  test('a key the provider accepts is stored, and says it was checked', async () => {
    const response = await call(
      surface({ checkKey: async () => ({ ok: true, detail: 'the key answered' }) }),
      'PUT',
      '/api/settings/model-key',
      JSON.stringify({ provider: 'openrouter', key: 'sk-or-good' }),
    );
    expect(response?.status).toBe(200);
    const body = JSON.parse(String(response?.body)) as { stored: boolean; checked: string };
    expect(body.stored).toBe(true);
    expect(body.checked).toBe('the key answered');
  });
});

// ── Storage, against the database the plane actually uses ──────────────────────

let client: pg.Pool | null = null;
let why = '';
const REPO = `secrets-test/${randomUUID()}`;
const GITHUB_ID = 900000 + Math.floor(Math.random() * 90000);
const madeRuns: string[] = [];
const madeRunners: string[] = [];

beforeAll(async () => {
  // The tests below seal, so this process needs a key. Set here rather than required of
  // whoever runs the suite: it is a test key, it never leaves this file, and the
  // alternative is a suite that skips its only coverage of the storage rules.
  process.env.PLANE_SECRETS_KEY ??= KEY.toString('base64');
  if (!process.env.DATABASE_URL) {
    why = 'DATABASE_URL is not set (copy .env.example to .env and `docker compose up -d`)';
    return;
  }
  try {
    const candidate = connect();
    await candidate.query('select 1 from repo_secrets limit 1');
    await candidate.query('select 1 from user_model_keys limit 1');
    client = candidate;
  } catch (error) {
    why = `no usable database: ${String((error as Error).message ?? error)} — run \`npm run db:schema\``;
  }
});

afterAll(async () => {
  if (client) {
    await client.query('delete from repo_secrets where repo = $1', [REPO]).catch(() => {});
    await client.query('delete from user_model_keys where github_id = $1', [GITHUB_ID]).catch(() => {});
    await client.query('delete from jobs where run_id = any($1)', [madeRuns]).catch(() => {});
    await client.query('delete from runners where id = any($1)', [madeRunners]).catch(() => {});
  }
  await client?.end();
});

describe('stored, listed by name, deleted, never read back', () => {
  test('the whole life of a secret', async () => {
    if (!client) return void expect(why).toBe('SKIP');
    await putRepoSecret(client, REPO, 'STRIPE_SECRET_KEY', CANARY, 'divy97');
    await putRepoSecret(client, REPO, 'DATABASE_URL', 'postgres://localhost/x', 'divy97');
    expect(await listRepoSecretNames(client, REPO)).toEqual(['DATABASE_URL', 'STRIPE_SECRET_KEY']);

    // What is in the table is not the value. Read as raw bytes, the way a backup or a
    // `select *` would see it.
    const { rows } = await client.query('select ciphertext from repo_secrets where repo = $1', [REPO]);
    for (const row of rows) {
      expect(Buffer.from(row.ciphertext as Uint8Array).toString('utf8')).not.toContain(CANARY);
    }

    // The one reader, which the runner route calls and nothing else does.
    expect(await repoSecrets(client, REPO)).toEqual({
      STRIPE_SECRET_KEY: CANARY,
      DATABASE_URL: 'postgres://localhost/x',
    });

    // Typing it again is how a value is rotated.
    await putRepoSecret(client, REPO, 'STRIPE_SECRET_KEY', 'a-new-one', 'divy97');
    expect((await repoSecrets(client, REPO)).STRIPE_SECRET_KEY).toBe('a-new-one');

    expect(await deleteRepoSecret(client, REPO, 'STRIPE_SECRET_KEY')).toBe(true);
    expect(await deleteRepoSecret(client, REPO, 'STRIPE_SECRET_KEY')).toBe(false);
    expect(await listRepoSecretNames(client, REPO)).toEqual(['DATABASE_URL']);
  });

  test('a model key is one per person, and what comes back is a provider', async () => {
    if (!client) return void expect(why).toBe('SKIP');
    expect(await hasModelKey(client, GITHUB_ID)).toBeNull();
    await putModelKey(client, GITHUB_ID, 'openrouter', CANARY);
    expect(await hasModelKey(client, GITHUB_ID)).toEqual({ provider: 'openrouter' });
    expect(await modelKey(client, GITHUB_ID)).toEqual({ provider: 'openrouter', key: CANARY });
    await putModelKey(client, GITHUB_ID, 'anthropic', 'a-second-one');
    expect(await modelKey(client, GITHUB_ID)).toEqual({ provider: 'anthropic', key: 'a-second-one' });
    expect(await deleteModelKey(client, GITHUB_ID)).toBe(true);
    expect(await deleteModelKey(client, GITHUB_ID)).toBe(false);
  });

  test('a re-homed row fails to open rather than opening somewhere it should not', async () => {
    if (!client) return void expect(why).toBe('SKIP');
    // The database half of the AAD control above: this is the write an attacker with
    // SQL access makes, and the read is what the worker would do next.
    await putRepoSecret(client, REPO, 'MOVED_KEY', CANARY, 'divy97');
    const { rows } = await client.query('select ciphertext from repo_secrets where repo = $1 and name = $2', [
      REPO,
      'MOVED_KEY',
    ]);
    const elsewhere = `${REPO}-elsewhere`;
    await client.query(
      `insert into repo_secrets (repo, name, ciphertext, key_id, created_by)
         values ($1, $2, $3, 'k1', 'an-attacker')`,
      [elsewhere, 'MOVED_KEY', rows[0].ciphertext],
    );
    try {
      await expect(repoSecrets(client, elsewhere)).rejects.toThrow();
    } finally {
      await client.query('delete from repo_secrets where repo = $1', [elsewhere]);
    }
  });
});

describe('THE test: a value stored through the surface never comes back out of it', () => {
  test('every response the dashboard can produce, greppped for the value that was stored', async () => {
    if (!client) return void expect(why).toBe('SKIP');
    // Against a REAL database, because the fake client used above stores nothing: with no
    // value in play, no route test could leak one however it were written. That is how
    // three separate echoes — `{ stored, value }` on the PUT, `{ stored, provider, key }`
    // on the model key, and a `values` field on the listing — each survived a green suite.
    //
    // So this stores `CANARY` through the surface, then asks the surface for everything it
    // will say about that repository and that person, and greps all of it. Add a route
    // that echoes a value and this fails; add a field to an existing response and this
    // fails too, which is the property the comments in `routes.ts` claim and could not
    // demonstrate.
    await recordInstallation(client, { repo: REPO, installationId: 1, account: 'me' });
    const surface = dashboardRoutes({
      client: client as unknown as Db,
      installUrl: 'https://example.invalid',
      // Accepting, so the model key really is STORED and this sweep is asking whether a
      // stored value leaks — which is the whole point of it. With the real checker the
      // canary would be refused, nothing would be stored, and every assertion below would
      // pass on a surface that had written nothing.
      checkKey: async () => ({ ok: true, detail: 'a fake accepted it' }),
      auth: { session: async () => ({ ...SESSION, githubId: GITHUB_ID }), installations: async () => [1] },
    });
    const path = `/api/repos/${encodeURIComponent(REPO)}/secrets`;

    const responses: string[] = [];
    const say = async (method: string, at: string, body = '') =>
      responses.push(String((await call(surface, method, at, body))?.body ?? ''));

    await say('PUT', `${path}/A_STORED_SECRET`, JSON.stringify({ value: CANARY }));
    await say('PUT', '/api/settings/model-key', JSON.stringify({ provider: 'openrouter', key: CANARY }));
    await say('GET', path);
    await say('GET', `${path}/A_STORED_SECRET`);
    await say('GET', '/api/settings/model-key');
    await say('GET', `/repos/${encodeURIComponent(REPO)}/onboard`);
    // The JSON surface 10i added, and it is the half most likely to leak: these routes
    // exist to hand a client the state of a repository and a person, which is exactly the
    // shape of answer a value slips into as one more field. `/api/repos/:repo` returns a
    // `secrets` object; `/api/me` returns a `modelKey` one. Both must be names and
    // providers only.
    await say('GET', '/api/me');
    await say('GET', '/api/repos');
    await say('GET', `/api/repos/${encodeURIComponent(REPO)}`);
    await say('GET', `/api/repos/${encodeURIComponent(REPO)}/recipe`);
    // The three the first pass of this sweep missed. Each was clean by inspection, and
    // that is exactly the standard this test exists to replace: the comment in
    // `routes.ts` claims the mechanism is "the test greps every response this surface can
    // produce", and a sweep covering four of seven new routes does not make that true.
    await say('GET', `/api/repos/${encodeURIComponent(REPO)}/runners`);
    await say('GET', `/api/runs/${madeRuns[0] ?? '00000000-0000-4000-8000-000000000000'}/evidence`);
    await say('GET', `/api/runs/${madeRuns[0] ?? '00000000-0000-4000-8000-000000000000'}/events`);
    await say('DELETE', `${path}/A_STORED_SECRET`);
    await say('DELETE', '/api/settings/model-key');

    // The value was really stored — without this the assertion below passes on a surface
    // that refused every write.
    expect(responses[0]).toContain('A_STORED_SECRET');
    expect(responses[2]).toContain('A_STORED_SECRET');
    for (const [index, body] of responses.entries()) {
      expect(body, `response ${index} carried the stored value`).not.toContain(CANARY);
    }
  });
});

describe('a runner is handed what its run is entitled to, and nothing it names', () => {
  const runnerCall = (route: ReturnType<typeof runnerRoutes>, path: string, token: string) =>
    route({
      method: 'POST',
      path,
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: async () => '',
      raw: async () => Buffer.alloc(0),
    });

  test('another runner cannot ask for this run, and this one cannot while injection is off', async () => {
    if (!client) return void expect(why).toBe('SKIP');
    const mine = await pairRunner(client, { installationId: 1, name: 'mine' });
    const theirs = await pairRunner(client, { installationId: 2, name: 'theirs' });
    madeRunners.push(mine.runner.id, theirs.runner.id);
    const runId = await enqueueJob(client, {
      installationId: 1,
      repo: REPO,
      intake: {},
      requestedBy: GITHUB_ID,
    });
    madeRuns.push(runId);
    // Claimed by `mine`, so `mine` is the only runner with standing.
    await client.query('update jobs set runner_id = $2 where run_id = $1', [runId, mine.runner.id]);

    const routes = runnerRoutes({ client, blobRoot: '/tmp' });
    const stranger = await runnerCall(routes, `/runner/runs/${runId}/secrets`, theirs.token);
    expect(stranger?.status).toBe(403);
    expect(String(stranger?.body)).not.toContain(CANARY);

    // The right runner, and still refused — because this deployment does not inject yet
    // (ADR-0017). 501, not an empty object: the worker has to be able to tell "no
    // secrets here" from "not handed out on this deployment".
    const held = await runnerCall(routes, `/runner/runs/${runId}/secrets`, mine.token);
    expect(held?.status).toBe(501);
    expect(String(held?.body)).toMatch(/ADR-0017/);

    // The model key is not gated the same way: it is what pays for the run, it never
    // enters a sandbox, and the worker cannot start without it.
    await putModelKey(client, GITHUB_ID, 'openrouter', CANARY);
    const paid = await runnerCall(routes, `/runner/runs/${runId}/model-key`, mine.token);
    expect(paid?.status).toBe(200);
    expect(JSON.parse(String(paid?.body))).toEqual({ provider: 'openrouter', key: CANARY });
    // And a runner that does not hold the run gets nothing, key or not.
    const notYours = await runnerCall(routes, `/runner/runs/${runId}/model-key`, theirs.token);
    expect(notYours?.status).toBe(403);
    expect(String(notYours?.body)).not.toContain(CANARY);
  });
});
