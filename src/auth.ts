// GitHub OAuth, and the authorization that follows from it.
//
// One human authentication and no second one. People arriving here already have a
// GitHub account, the App is installed by one, and asking for anything else would be
// asking them to remember a credential this product has no business owning.
//
// The line worth being precise about is the one between authentication and
// authorization. OAuth answers *who are you*. It does not answer *may you approve a
// recipe for this repository* — commands this engine will execute verbatim in a sandbox
// (ADR-0013). That second question is answered by GitHub too, at the moment it is asked:
// `GET /user/installations` is the source of truth, and this module deliberately builds
// no roles table, no permission model, and no cache of either. A permission system of
// our own would be a second definition of who owns a repository, free to disagree with
// GitHub's — and it would disagree on the day somebody was removed from an org.
//
// The machine credential is elsewhere: `plane.ts` mints a pairing token, and it is
// minted BECAUSE a human was authenticated here. One login; the daemon's token is a
// consequence of it, not a second thing to remember.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from './store.js';

export type Session = {
  id: string;
  githubId: number;
  login: string;
  avatarUrl: string;
  /** The user-to-server token. Narrow by construction; never leaves this process. */
  token: string;
};

export type OAuthConfig = {
  clientId: string;
  clientSecret: string;
  /** Where GitHub sends the browser back. Must match the App's registered callback. */
  callbackUrl: string;
  /** Injected so every path here is testable without a network. */
  fetch?: typeof fetch;
  api?: string;
  login?: string;
};

/** Sessions age out. A stale one is a login, not a renewal. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const GITHUB_LOGIN = 'https://github.com';
const GITHUB_API = 'https://api.github.com';

const token = (): string => randomBytes(32).toString('base64url');

/**
 * Where to send a browser to log in, and the `state` that has to come back.
 *
 * `state` is not decoration: without it, an attacker completes their own OAuth flow and
 * redirects the victim's browser to our callback carrying THEIR code, logging the victim
 * into the attacker's account — where anything the victim then approves belongs to the
 * attacker. It is stored in a cookie and compared on return.
 */
export function authorizeUrl(config: OAuthConfig): { url: string; state: string } {
  const state = token();
  const url = new URL('/login/oauth/authorize', config.login ?? GITHUB_LOGIN);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.callbackUrl);
  url.searchParams.set('state', state);
  return { url: url.toString(), state };
}

/** Constant-time, because one side of this comparison is attacker-supplied. */
export const sameState = (a: string | undefined, b: string | undefined): boolean => {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
};

/**
 * Trade the code for a user-to-server token, then find out who it belongs to.
 *
 * Returns null for every failure — a refused exchange, a token GitHub will not describe,
 * a body that is not what it claims. The caller's answer to all of them is the same
 * page, and distinguishing them for a stranger at a login screen tells them things
 * about our configuration rather than about their attempt.
 */
export async function identify(
  config: OAuthConfig,
  code: string,
): Promise<Omit<Session, 'id'> | null> {
  const call = config.fetch ?? fetch;
  try {
    const exchange = await call(`${config.login ?? GITHUB_LOGIN}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.callbackUrl,
      }),
    });
    if (!exchange.ok) return null;
    const granted = (await exchange.json()) as { access_token?: unknown };
    if (typeof granted.access_token !== 'string') return null;

    const who = await call(`${config.api ?? GITHUB_API}/user`, {
      headers: { authorization: `Bearer ${granted.access_token}`, accept: 'application/vnd.github+json' },
    });
    if (!who.ok) return null;
    const user = (await who.json()) as { id?: unknown; login?: unknown; avatar_url?: unknown };
    if (typeof user.id !== 'number' || typeof user.login !== 'string') return null;

    return {
      githubId: user.id,
      login: user.login,
      avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : '',
      token: granted.access_token,
    };
  } catch {
    return null;
  }
}

export async function createSession(client: Db, who: Omit<Session, 'id'>): Promise<string> {
  const id = token();
  await client.query(
    'insert into sessions (id, github_id, login, avatar_url, token) values ($1, $2, $3, $4, $5)',
    [id, who.githubId, who.login, who.avatarUrl, who.token],
  );
  return id;
}

/** Who this cookie is, or nobody. Expiry is enforced here rather than by a sweeper. */
export async function readSession(client: Db, id: string | undefined): Promise<Session | null> {
  if (!id) return null;
  const { rows } = await client.query(
    `select id, github_id, login, avatar_url, token from sessions
       where id = $1 and created_at > now() - ($2::bigint * interval '1 millisecond')`,
    [id, SESSION_TTL_MS],
  );
  const row = rows[0] as
    | { id: string; github_id: string; login: string; avatar_url: string; token: string }
    | undefined;
  if (!row) return null;
  await client.query('update sessions set seen_at = now() where id = $1', [id]);
  return {
    id: row.id,
    githubId: Number(row.github_id),
    login: row.login,
    avatarUrl: row.avatar_url,
    token: row.token,
  };
}

export async function endSession(client: Db, id: string | undefined): Promise<void> {
  if (id) await client.query('delete from sessions where id = $1', [id]);
}

/**
 * Which installations this person may act on, asked of GitHub every time.
 *
 * Not cached, and that is the decision. An installation list held in a session row is a
 * permission model of our own — correct until somebody is removed from an org, and then
 * confidently wrong for as long as the session lives. The cost is one API call on an
 * authorization decision; the alternative is a stale answer to "may you execute commands
 * on this repository".
 *
 * An empty list on failure, never a permissive default: a GitHub we cannot reach must
 * mean "we cannot say you may", not "go ahead".
 */
export async function installationsFor(
  session: Session,
  options: { fetch?: typeof fetch; api?: string } = {},
): Promise<number[]> {
  const call = options.fetch ?? fetch;
  try {
    const response = await call(`${options.api ?? GITHUB_API}/user/installations?per_page=100`, {
      headers: { authorization: `Bearer ${session.token}`, accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { installations?: { id?: unknown }[] };
    return (body.installations ?? [])
      .map((entry) => entry.id)
      .filter((id): id is number => typeof id === 'number');
  } catch {
    return [];
  }
}

/** The cookie, with the three attributes that make it not worth stealing over a wire. */
export const sessionCookie = (id: string, options: { secure?: boolean } = {}): string =>
  [
    `tf_session=${id}`,
    'Path=/',
    'HttpOnly',
    // Lax rather than Strict: the OAuth callback IS a cross-site navigation back from
    // github.com, and Strict would drop the cookie on exactly the request that sets up
    // the session. Lax still refuses it on cross-site POSTs, which is the case that
    // matters — the one write here executes shell commands.
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ...(options.secure === false ? [] : ['Secure']),
  ].join('; ');

export const clearedCookie = (): string => 'tf_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

/** Read one cookie out of a header, without a parser worth getting wrong. */
export const cookieValue = (header: string | string[] | undefined, name: string): string | undefined => {
  const raw = Array.isArray(header) ? header[0] : header;
  for (const part of (raw ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || undefined;
  }
  return undefined;
};
