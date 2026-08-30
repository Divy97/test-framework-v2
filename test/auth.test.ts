// One human authentication, and the authorization that is deliberately not ours.
//
// Two things are under test and they are different: that a stranger cannot become
// somebody, and that being somebody is not the same as being allowed. The second is the
// one this project has to get right — the single write on this surface stores shell
// commands the engine executes verbatim (ADR-0013), so "logged in" was never the
// question.
//
// Sessions need a database; the OAuth exchange does not. The exchange tests inject
// `fetch` and run everywhere.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  authorizeUrl,
  clearedCookie,
  cookieValue,
  createSession,
  endSession,
  identify,
  installationsFor,
  readSession,
  sameState,
  sessionCookie,
  type OAuthConfig,
} from '../src/auth.js';
import type pg from 'pg';
import { connect } from '../src/store.js';

let client: pg.Pool | null = null;
let why = '';
const made: string[] = [];

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    why = 'DATABASE_URL is not set (copy .env.example to .env and `docker compose up -d`)';
    return;
  }
  try {
    const candidate = connect();
    await candidate.query('select 1 from sessions limit 1');
    client = candidate;
  } catch (error) {
    why = `no usable database: ${String((error as Error).message ?? error)} — run \`npm run db:schema\``;
  }
});

afterAll(async () => {
  if (client) await client.query('delete from sessions where id = any($1)', [made]).catch(() => {});
  await client?.end();
});

const withDb = (): boolean => {
  if (client) return false;
  expect.fail(`sessions were NOT verified: ${why}`);
};

/** A GitHub that answers exactly what a test wants, and records what it was asked. */
const fakeGitHub = (answers: Record<string, { status?: number; body: unknown }>) => {
  const seen: string[] = [];
  const call = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    seen.push(`${init?.method ?? 'GET'} ${target}`);
    const key = Object.keys(answers).find((k) => target.includes(k));
    const answer = key ? answers[key]! : { status: 404, body: { message: 'not found' } };
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { call, seen };
};

const config = (over: Partial<OAuthConfig> = {}): OAuthConfig => ({
  clientId: 'Iv1.test',
  clientSecret: 'secret',
  callbackUrl: 'https://plane.test/auth/github/callback',
  login: 'https://github.test',
  api: 'https://api.github.test',
  ...over,
});

describe('logging in is GitHub s job, and coming back is ours', () => {
  test('the authorize URL carries the client, the callback, and a state', () => {
    const { url, state } = authorizeUrl(config());
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://github.test');
    expect(parsed.searchParams.get('client_id')).toBe('Iv1.test');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://plane.test/auth/github/callback');
    expect(parsed.searchParams.get('state')).toBe(state);
    expect(state.length).toBeGreaterThan(20);
  });

  test('a state is single-use randomness, not a constant', () => {
    expect(authorizeUrl(config()).state).not.toBe(authorizeUrl(config()).state);
  });

  test('a mismatched state is refused, which is the whole of the login-CSRF defence', () => {
    // The attack without it: an attacker completes their OWN OAuth flow, then redirects
    // the victim's browser to our callback carrying the attacker's code. The victim is
    // logged into the attacker's account, and anything they approve there belongs to
    // somebody else.
    const { state } = authorizeUrl(config());
    expect(sameState(state, state)).toBe(true);
    expect(sameState(state, `${state.slice(0, -1)}x`)).toBe(false);
    expect(sameState(state, undefined)).toBe(false);
    expect(sameState(undefined, undefined)).toBe(false);
    expect(sameState(state, state.slice(0, -1))).toBe(false);
  });

  test('a code becomes a person, through two calls and no guessing', async () => {
    const github = fakeGitHub({
      '/login/oauth/access_token': { body: { access_token: 'ghu_user' } },
      '/user': { body: { id: 4242, login: 'divy97', avatar_url: 'https://avatars/1' } },
    });
    const who = await identify(config({ fetch: github.call }), 'the-code');

    expect(who).toMatchObject({ githubId: 4242, login: 'divy97', token: 'ghu_user' });
    expect(github.seen[0]).toContain('POST https://github.test/login/oauth/access_token');
    expect(github.seen[1]).toContain('https://api.github.test/user');
  });

  test.each([
    ['the exchange is refused', { '/login/oauth/access_token': { status: 401, body: {} } }],
    ['the exchange carries no token', { '/login/oauth/access_token': { body: { error: 'bad_verification_code' } } }],
    [
      'GitHub will not say who the token is',
      { '/login/oauth/access_token': { body: { access_token: 'ghu_user' } }, '/user': { status: 401, body: {} } },
    ],
    [
      'the user has no id',
      {
        '/login/oauth/access_token': { body: { access_token: 'ghu_user' } },
        '/user': { body: { login: 'divy97' } },
      },
    ],
  ])('%s produces nobody, not a half-identified session', async (_name, answers) => {
    const github = fakeGitHub(answers as Record<string, { status?: number; body: unknown }>);
    expect(await identify(config({ fetch: github.call }), 'the-code')).toBeNull();
  });
});

describe('a session is a row, and it expires', () => {
  test('it round-trips, and logging out ends it', async () => {
    if (withDb()) return;
    const id = await createSession(client!, {
      githubId: 4242,
      login: 'divy97',
      avatarUrl: '',
      token: 'ghu_user',
    });
    made.push(id);

    expect(await readSession(client!, id)).toMatchObject({ login: 'divy97', githubId: 4242 });
    await endSession(client!, id);
    expect(await readSession(client!, id)).toBeNull();
  });

  test('an invented cookie is nobody', async () => {
    if (withDb()) return;
    expect(await readSession(client!, 'not-a-session')).toBeNull();
    expect(await readSession(client!, undefined)).toBeNull();
  });

  test('an aged session is nobody, without a sweeper having to have run', async () => {
    if (withDb()) return;
    // Expiry enforced in the read, so a process that never runs a cleanup job cannot
    // leave a year-old cookie working.
    const id = await createSession(client!, { githubId: 1, login: 'old', avatarUrl: '', token: 't' });
    made.push(id);
    await client!.query("update sessions set created_at = now() - interval '13 hours' where id = $1", [id]);
    expect(await readSession(client!, id)).toBeNull();
  });
});

describe('being somebody is not being allowed', () => {
  const session = { id: 's', githubId: 1, login: 'divy97', avatarUrl: '', token: 'ghu_user' };

  test('what you may act on is asked of GitHub, every time', async () => {
    // Not cached into a permission model of our own. One held in a session row is
    // correct until somebody is removed from an org, and confidently wrong afterwards
    // for as long as the session lives.
    const github = fakeGitHub({
      '/user/installations': { body: { installations: [{ id: 152989253 }, { id: 7 }] } },
    });
    expect(await installationsFor(session, { fetch: github.call, api: 'https://api.github.test' })).toEqual([
      152989253, 7,
    ]);
    expect(github.seen[0]).toContain('/user/installations');
  });

  test('a GitHub we cannot reach means "we cannot say you may", never "go ahead"', async () => {
    // The fail-open bug this closes: an empty list denies everything, which is the only
    // safe direction for a question whose yes stores shell commands.
    const refused = fakeGitHub({ '/user/installations': { status: 500, body: {} } });
    expect(await installationsFor(session, { fetch: refused.call, api: 'https://api.github.test' })).toEqual([]);

    const broken = (async () => {
      throw new Error('DNS');
    }) as unknown as typeof fetch;
    expect(await installationsFor(session, { fetch: broken })).toEqual([]);
  });
});

describe('the cookie is not worth stealing over a wire', () => {
  test('it is HttpOnly, Secure, and SameSite=Lax', () => {
    const cookie = sessionCookie('abc');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    // Lax rather than Strict, deliberately: the OAuth callback is a cross-site
    // navigation back from github.com, and Strict drops the cookie on exactly the
    // request that establishes the session. Lax still refuses it on cross-site POSTs,
    // which is the case that matters here.
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=43200');
  });

  test('logging out sends a cookie that cannot be reused', () => {
    expect(clearedCookie()).toContain('Max-Age=0');
    expect(clearedCookie()).toContain('tf_session=;');
  });

  test('reading one out of a header does not need a parser worth getting wrong', () => {
    expect(cookieValue('a=1; tf_session=xyz; b=2', 'tf_session')).toBe('xyz');
    expect(cookieValue(['tf_session=only'], 'tf_session')).toBe('only');
    expect(cookieValue('tf_session=', 'tf_session')).toBeUndefined();
    expect(cookieValue(undefined, 'tf_session')).toBeUndefined();
    expect(cookieValue('other=1', 'tf_session')).toBeUndefined();
  });
});
