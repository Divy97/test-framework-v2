// The GitHub App: intake in, pull request out (ADR-0012).
//
// One integration carries all three things v1.5 needs — the issue that starts a
// run, the repository to clone, and somewhere to put the pull request — so the
// only real question is which credential carries them and which process holds it.
//
// **The token never enters the sandbox.** Everything in this file runs on the host
// orchestrator: it clones, it pushes, it opens the PR, it comments. The agent's
// only outbound artifact is a commit, exactly as ADR-0010 already required. So
// there is no step in the design where a credential and the agent are in the same
// process, and none where one is in the same container — the same argument as
// ADR-0011 applied to a second secret, landing the same way: not an allowlist, an
// absence.
//
// Two things are deliberately NOT here:
//
//   - **No personal access token.** One form field, wrong twice: a PAT carries its
//     owner's full access for as long as it lives, and it dies when its owner
//     leaves the organisation, converting a routine offboarding into an outage.
//   - **No token captured at run start.** A run can outlive an hour, so
//     `installationToken` is a function called when needed rather than a value
//     held. That is what the one-hour lifetime actually implies.
//
// No dependency: `node:crypto` signs the JWT and the global `fetch` talks to the
// API. An SDK here would be a large surface for six requests.

import { createServer } from 'node:http';
import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunRequestedV1 } from './events.js';

const execFileAsync = promisify(execFile);

/** GitHub's own ceiling is 25MB; ours is smaller because a webhook body is not evidence. */
export const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;

/**
 * Is this payload really from GitHub?
 *
 * Necessary and NOT sufficient, which is the whole point of ADR-0012's third
 * rejection: a signature proves a payload came from GitHub, not that its sender is
 * entitled to a run against that repository. The installation id is what
 * authorises; this is what authenticates.
 *
 * `timingSafeEqual` on equal-length buffers, and a length check first — comparing
 * a 64-character digest against a 3-character forgery must not throw, because a
 * receiver that 500s on a malformed signature is a receiver that tells an attacker
 * which guesses were the right shape.
 */
export function verifyWebhook(secret: string, body: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}

/** What the receiver needs out of an ISSUE delivery, once it is authentic. */
export type IssueIntake = {
  kind: 'issue';
  event: RunRequestedV1;
  repo: string;
  installationId: number;
  issueNumber: number;
};

/**
 * What the receiver needs out of an INSTALLATION delivery (M6a).
 *
 * A separate shape rather than a widened `IssueIntake`, because an installation
 * delivery has no issue: no number to comment on, no reported text, and nothing that is
 * honestly a `RUN_REQUESTED`. Fabricating those to reuse one type would put an invented
 * issue number into the only record we keep, and the discriminant is one `switch` at
 * three call sites.
 *
 * `repos` is plural because `installation_repositories` adds and removes several at
 * once, and `installation` itself carries the whole selected set.
 */
export type InstallationIntake = {
  kind: 'installation';
  /** `added` covers install and select-more; `removed` covers uninstall and deselect. */
  action: 'added' | 'removed';
  installationId: number;
  /** The owner login the App was installed on, for display. */
  account: string;
  repos: string[];
};

export type Intake = IssueIntake | InstallationIntake;

/**
 * Map a delivery to `RUN_REQUESTED`, or to nothing.
 *
 * Exactly two triggers: an issue opened, and an issue labelled. Everything else is
 * rejected rather than ignored-and-logged — a receiver that quietly accepts a
 * `push` and does nothing is a receiver whose behaviour nobody can state.
 *
 * The issue body is attacker-influenced text that reaches the agent's prompt, and
 * ADR-0012 is explicit that the mitigation is structural rather than textual: the
 * agent has no credential to leak, no network to reach and no path to append an
 * event, so the worst an injected instruction achieves is a bad reproduction or a
 * bad fix — both of which the phase containers judge on exit code without
 * consulting anything the agent said. Nothing here tries to sanitise it, because a
 * sanitiser here would be a claim we cannot keep.
 */
export function intake(event: string, payload: unknown): Intake | null {
  if (event === 'installation' || event === 'installation_repositories') {
    return installationIntake(event, payload);
  }
  if (event !== 'issues') return null;
  if (typeof payload !== 'object' || payload === null) return null;
  const body = payload as {
    action?: unknown;
    issue?: { number?: unknown; title?: unknown; body?: unknown; html_url?: unknown };
    repository?: { full_name?: unknown };
    installation?: { id?: unknown };
  };
  if (body.action !== 'opened' && body.action !== 'labeled') return null;
  const repo = body.repository?.full_name;
  const number = body.issue?.number;
  const installationId = body.installation?.id;
  if (typeof repo !== 'string' || typeof number !== 'number' || typeof installationId !== 'number') {
    return null;
  }
  const title = typeof body.issue?.title === 'string' ? body.issue.title : '';
  const text = typeof body.issue?.body === 'string' ? body.issue.body : '';
  return {
    kind: 'issue',
    repo,
    installationId,
    issueNumber: number,
    event: {
      v: 1,
      source: 'github_issue',
      // The thread to comment back on, in the form every later step needs.
      thread_ref: `${repo}#${number}`,
      // Title AND body. A great many real reports put the whole symptom in the
      // title and leave the body empty.
      raw_text: `${title}\n\n${text}`.trim(),
    },
  };
}

/**
 * Map an installation delivery, which is how we learn a repository exists at all.
 *
 * Before this, `installation.id` arrived on every delivery and was discarded, so the
 * first thing the product ever learned about a repository was an issue — by which point
 * a run had started with `recipe: null`, booted nothing, and produced a Tier 3 about a
 * bug that was never shown. **A user's first experience was a wrong answer**, recorded in
 * an immutable log as a finding about their bug rather than about our onboarding.
 *
 * The two events carry the repository list in different fields, which is GitHub's shape
 * and not a choice: `installation` has `repositories` (the whole selection), while
 * `installation_repositories` has `repositories_added` and `repositories_removed`.
 */
function installationIntake(event: string, payload: unknown): InstallationIntake | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const body = payload as {
    action?: unknown;
    installation?: { id?: unknown; account?: { login?: unknown } };
    repositories?: unknown;
    repositories_added?: unknown;
    repositories_removed?: unknown;
  };
  const installationId = body.installation?.id;
  const account = body.installation?.account?.login;
  if (typeof installationId !== 'number' || typeof account !== 'string') return null;

  // `full_name` only. A repository we cannot name is one we cannot key a recipe by, so
  // it is dropped rather than stored under a placeholder.
  const names = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .map((entry) => (entry as { full_name?: unknown })?.full_name)
          .filter((name): name is string => typeof name === 'string')
      : [];

  if (event === 'installation') {
    // `created` and `deleted` only. `suspend`/`unsuspend`/`new_permissions_accepted` are
    // real actions that say nothing about which repositories we hold, and treating them
    // as `added` would resurrect a removed row.
    if (body.action !== 'created' && body.action !== 'deleted') return null;
    const repos = names(body.repositories);
    // Symmetric with `installation_repositories` below: a delivery naming no repository
    // is not a fact about any repository. It was non-null here and null there, which is
    // the same rule stated twice and obeyed once.
    if (repos.length === 0) return null;
    return {
      kind: 'installation',
      action: body.action === 'created' ? 'added' : 'removed',
      installationId,
      account,
      repos,
    };
  }

  if (body.action !== 'added' && body.action !== 'removed') return null;
  const repos = names(body.action === 'added' ? body.repositories_added : body.repositories_removed);
  // An add or remove naming nothing is not a fact about any repository.
  if (repos.length === 0) return null;
  return { kind: 'installation', action: body.action, installationId, account, repos };
}

/**
 * The App's own JWT: RS256, `iss` the app id, ten minutes.
 *
 * GitHub's documented shape, and the numbers are theirs: `iat` is backdated 60
 * seconds because their clock and ours disagree by more than zero, and `exp` is
 * capped at ten minutes because they reject anything longer.
 *
 * This is the ONE secret whose compromise is total — it mints tokens for every
 * installation — and nothing in this design reduces that. It moves the risk from
 * many long-lived per-user tokens to one key we can actually protect and rotate,
 * which is a better trade and not a solved problem.
 */
export function appJwt(appId: string, privateKeyPem: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iat: seconds - 60, exp: seconds + 600, iss: appId };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

const base64url = (input: string | Buffer): string =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Decoded halves of a JWT, for anyone who needs to check what was signed. */
export const readJwt = (token: string): { header: unknown; claims: unknown } => {
  const [header, claims] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header!, 'base64url').toString()),
    claims: JSON.parse(Buffer.from(claims!, 'base64url').toString()),
  };
};

export type Fetcher = typeof fetch;

export type GitHubApp = {
  appId: string;
  privateKeyPem: string;
  /** Injected so the token path is testable against a recorded API without a network. */
  fetch?: Fetcher;
  api?: string;
};

/**
 * Mint a one-hour installation token, scoped to that installation's repositories.
 *
 * Called when needed, never captured at run start: a run that exceeds an hour needs
 * a refresh mid-flight, and a value held in a variable cannot refresh itself.
 */
export async function installationToken(app: GitHubApp, installationId: number): Promise<string> {
  const api = app.api ?? 'https://api.github.com';
  const call = app.fetch ?? fetch;
  const response = await call(`${api}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${appJwt(app.appId, app.privateKeyPem)}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`could not mint an installation token for ${installationId}: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== 'string') throw new Error('the installation token response carried no token');
  return body.token;
}

/**
 * The repository URL. **No credential in it.**
 *
 * It used to be `https://x-access-token:<token>@github.com/…`, which works and is
 * what GitHub documents — and which git then WRITES INTO `.git/config` of the clone
 * as `remote.origin.url`. A review caught it. Traced, it was not exploitable today:
 * `orchestrate()` re-clones with `--mirror`, whose origin is the local path, so the
 * token-bearing config never reached a mounted directory.
 *
 * It is fixed anyway, because "not exploitable today" is not the claim ADR-0012
 * makes. Its claim is that there is *no configuration* under which the container can
 * read the token, and a claim that holds only because of an incidental property of
 * `git clone --mirror` is exactly the kind of safe-by-accident this project has been
 * bitten by before — ADR-0010's whole history is that failure mode. One refactor that
 * mounted `repoPath` directly would have turned an accident into a leak.
 *
 * The credential now travels as an `http.extraHeader` passed with `-c`, which git
 * does **not** persist: command-line config lives for that invocation only.
 */
export const repoUrl = (repo: string): string => `https://github.com/${repo}.git`;

/**
 * `-c` arguments that authenticate one git invocation and leave nothing behind.
 *
 * Scoped to `https://github.com/` rather than set globally, so a git command that
 * happens to touch a second host cannot be handed our header. Basic auth with
 * `x-access-token` as the username is GitHub's documented scheme for an installation
 * token; only the transport differs.
 */
export const authConfig = (token: string): string[] => [
  '-c',
  `http.https://github.com/.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
];

const git = (args: string[], cwd?: string) =>
  execFileAsync('git', args, { ...(cwd === undefined ? {} : { cwd }), maxBuffer: 64 * 1024 * 1024 });

/**
 * Clone, on the host. The sandbox gets this directory read-only and never the URL.
 *
 * `remote` rather than `(repo, token)` so the credential is built at one call site
 * and this function has no opinion about where the repository lives — which is also
 * what lets the whole outbound path be tested against a local bare repo, with no
 * GitHub in it.
 */
export async function cloneRepository(remote: string, into: string, token?: string): Promise<void> {
  await git([...(token ? authConfig(token) : []), 'clone', '--quiet', '--', remote, into]);
}

/** Push one branch we created. Never a force, never another ref. */
export async function pushBranch(
  repoPath: string,
  remote: string,
  branch: string,
  sha: string,
  token?: string,
): Promise<void> {
  // `<sha>:refs/heads/<branch>`, so what is pushed is the commit under judgement
  // and not whatever HEAD happens to be. `--no-verify` and `--no-follow-tags`
  // because a developer's global git config must not decide what a run pushes.
  await git(
    [
      ...(token ? authConfig(token) : []),
      'push', '--quiet', '--no-verify', '--no-follow-tags', remote, `${sha}:refs/heads/${branch}`,
    ],
    repoPath,
  );
}

export type PullRequest = { number: number; head_sha: string; html_url: string };

export async function openPullRequest(
  app: Pick<GitHubApp, 'fetch' | 'api'>,
  token: string,
  repo: string,
  input: { title: string; body: string; head: string; base: string },
): Promise<PullRequest> {
  const api = app.api ?? 'https://api.github.com';
  const call = app.fetch ?? fetch;
  const response = await call(`${api}/repos/${repo}/pulls`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`could not open a pull request on ${repo}: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { number?: unknown; head?: { sha?: unknown }; html_url?: unknown };
  if (typeof body.number !== 'number') throw new Error('the pull request response carried no number');
  return {
    number: body.number,
    head_sha: typeof body.head?.sha === 'string' ? body.head.sha : input.head,
    html_url: typeof body.html_url === 'string' ? body.html_url : `https://github.com/${repo}/pull/${body.number}`,
  };
}

/**
 * Comment on the issue. Called on EVERY terminal outcome, including Tier 3 and
 * `errored` — a run that ends silently is worse than no run, because the person who
 * opened the issue is left waiting on something that already finished.
 */
/**
 * Receive deliveries, verify them, and hand the authentic ones on.
 *
 * Two rules, in this order and no other: the HMAC first, then the mapping. A
 * receiver that parsed before it verified would be running our JSON parser on
 * anything the internet posts, and the signature is the only thing standing between
 * those two facts.
 */
export function startWebhookReceiver(options: {
  secret: string;
  onIntake: (intake: Intake) => void | Promise<void>;
  port?: number;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let oversize = false;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      // Bounded before it is buffered. A webhook body is not evidence and an
      // unbounded one is host memory anyone can spend.
      if (bytes > MAX_WEBHOOK_BYTES) {
        oversize = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const reply = (status: number, text: string) => {
        response.writeHead(status, { 'content-type': 'text/plain' });
        response.end(`${text}\n`);
      };
      if (request.method !== 'POST') return reply(405, 'post only');
      if (oversize) return reply(413, 'too large');
      const body = Buffer.concat(chunks).toString();
      // The RAW bytes, not a re-serialisation. Any framework that reparses and
      // re-encodes the body changes it and breaks the MAC — which is why this reads
      // the stream itself rather than taking a parsed object.
      if (!verifyWebhook(options.secret, body, request.headers['x-hub-signature-256'] as string | undefined)) {
        // 401 and nothing else. Not a hint about which part was wrong.
        return reply(401, 'bad signature');
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        return reply(400, 'not json');
      }
      const mapped = intake(String(request.headers['x-github-event'] ?? ''), payload);
      if (!mapped) {
        // Accepted and ignored, explicitly. GitHub retries a non-2xx, and retrying a
        // `push` we will never act on forever is worse than saying so once.
        return reply(202, 'not a trigger');
      }
      // Acknowledged BEFORE the run. A run takes minutes and GitHub's delivery
      // timeout is seconds, so holding the response open would guarantee a retry and
      // a second run for the same issue.
      reply(202, 'accepted');
      void Promise.resolve(options.onIntake(mapped)).catch(() => {
        // The caller owns its own failures. Throwing here would take the receiver
        // down and lose every later delivery.
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the webhook receiver did not bind a port'));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

export async function commentOnIssue(
  app: Pick<GitHubApp, 'fetch' | 'api'>,
  token: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  const api = app.api ?? 'https://api.github.com';
  const call = app.fetch ?? fetch;
  const response = await call(`${api}/repos/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) {
    throw new Error(`could not comment on ${repo}#${issueNumber}: HTTP ${response.status}`);
  }
}
