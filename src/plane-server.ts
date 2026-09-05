// The control plane, as a program.
//
// One address that GitHub can always reach, one login, and a queue. It holds the App
// private key and the event log; it holds no Docker, no model credential, and it never
// executes anybody's code. The machine that does that is somebody's laptop, and it dials
// out to here (ADR-0019).
//
// What is NOT here is as deliberate as what is. There is no runner in this process, no
// container, and no path by which a webhook delivery can cause this program to run a
// command from a recipe — because the whole point of the split is that the thing with
// the credentials is not the thing that executes.

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBlobRoot } from './blobs.js';
import { authRoutes } from './auth-routes.js';
import { installationsFor, readSession, cookieValue, type OAuthConfig } from './auth.js';
import { webhookRoute, WEBHOOK_PATH, installationToken, type GitHubApp, type Intake } from './github.js';
import { forgetInstallation, loadInstallation, reconcileInstallation } from './installations.js';
import { readRunRow } from './readmodel.js';
import { dashboardRoutes } from './routes.js';
import { runnerRoutes } from './runner-api.js';
import { startStatusServer, type Route } from './sse.js';
import { loadEnv, connect, readRunAfter, type Db, ready, close } from './store.js';

export type PlaneConfig = {
  appId: string;
  privateKeyPem: string;
  webhookSecret: string;
  oauth: { clientId: string; clientSecret: string; callbackUrl: string };
  blobRoot: string;
  /**
   * The ONE port. The webhook used to have its own server on its own port, which is free
   * on a laptop and not free on a host: a public deployment gets one hostname and one
   * certificate, and path-routing between two internal servers needs a proxy in front of
   * them. So the receiver is a route in the chain below, at `WEBHOOK_PATH`.
   *
   * `serve.ts` keeps two ports, deliberately — it is the local product and nothing about
   * a laptop makes a second port cost anything.
   */
  port: number;
  /** Which interface to bind. Loopback locally; `0.0.0.0` in a container (see `sse.ts`). */
  host: string;
  /** False for http in development. The cookie is marked Secure either way it is told. */
  secure?: boolean;
};

/**
 * Bring the database up to `db/schema.sql`, on every start.
 *
 * A deployment otherwise needs somebody to remember a step, and a plane pointed at a
 * fresh volume answers every request with a relation that does not exist. The file is
 * idempotent by construction — `create table if not exists`, `create index if not
 * exists`, `alter table ... add column if not exists` — so running it against a database
 * that is already current does nothing.
 *
 * It is not a migration system and does not pretend to be. `db/schema.sql`'s own header
 * names the gap: adding a column to an existing table needs an explicit `alter`, written
 * by hand, or the change silently does nothing. That gap is unchanged; what this removes
 * is the separate step, not the discipline.
 */
async function applySchema(client: Db): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = await readFile(join(here, '..', 'db', 'schema.sql'), 'utf8');
  await client.query(sql);
}

/**
 * Try each route in turn; the first that answers wins.
 *
 * `null` already means "not mine" in this contract, so composition is free and no route
 * has to know what else is mounted.
 */
export const chain =
  (...routes: Route[]): Route =>
  async (request) => {
    for (const route of routes) {
      const answer = await route(request);
      if (answer) return answer;
    }
    return null;
  };

/**
 * What the plane does with a delivery (M6a, M10).
 *
 * A function of its dependencies rather than a closure inside `startPlane`, so a test can
 * hand it a fake client and a fake token minter and watch what it writes — `startPlane`
 * needs a database and every credential, and this is the one part of it with a decision
 * in it. It throws; the caller decides what an escape costs.
 */
export function planeIntake(deps: {
  client: Db;
  mint: (installationId: number) => Promise<string>;
  log: (line: string) => void;
  /** Injected for tests, exactly as `reconcileInstallation` already accepts it. */
  github?: { fetch?: typeof fetch; api?: string };
}): (intake: Intake) => Promise<void> {
  return async (intake) => {
    if (intake.kind === 'installation') {
      // An UNINSTALL is not reconciled, because there is nothing left to ask. Minting a
      // token for a deleted installation 404s and throws, so routing this through the
      // reconcile meant an uninstall marked nothing removed and the rows stayed live
      // forever — M6a's "removed means removed", quietly undone.
      if (intake.scope === 'app' && intake.action === 'removed') {
        const removed = await forgetInstallation(deps.client, intake.installationId);
        deps.log(`installation ${intake.installationId}: uninstalled, ${removed} marked removed`);
        return;
      }
      // Otherwise the DELTA is not applied. GitHub is asked what this installation
      // actually covers and the table is made to match, because a delta is only enough
      // if you heard every previous one — and a plane deployed today heard none.
      const { held, removed } = await reconcileInstallation(
        deps.client,
        intake.installationId,
        deps.mint,
        deps.github ?? {},
      );
      deps.log(
        `installation ${intake.installationId}: ${intake.action} ${intake.repos.length} named, ` +
          `reconciled to ${held} held${removed > 0 ? `, ${removed} marked removed` : ''}`,
      );
      return;
    }
    // AN ISSUE DELIVERY STARTS NOTHING (M10). Runs start from the dashboard, pressed by a
    // person who has a model key and a decision to make about the repository's
    // environment — two things a webhook cannot carry. The subscription stays, and the
    // delivery is acknowledged and written to the log here, so a repository somebody
    // configured the old way says so in this process's output rather than in a run that
    // never appears. `serve.ts`, the local product, still starts a run from the same
    // delivery; `intake()` is unchanged, and this is the one place the two diverge.
    deps.log(`${intake.repo}#${intake.issueNumber}: issues delivery ignored — runs start from the dashboard`);
  };
}

export async function startPlane(config: PlaneConfig): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const client = connect();
  await ready(client);
  await applySchema(client);
  await ensureBlobRoot(config.blobRoot);

  const app: GitHubApp = { appId: config.appId, privateKeyPem: config.privateKeyPem };
  const oauth: OAuthConfig = { ...config.oauth };
  const log = (line: string) => console.log(line);
  const mint = (installationId: number) => installationToken(app, installationId);
  const handle = planeIntake({ client, mint, log });

  const onIntake = (intake: Intake) => {
    // Never rethrown: this is called without being awaited, so an escape here is an
    // unhandled rejection that ends the process — and the process is the thing GitHub
    // is talking to.
    void handle(intake).catch((error: unknown) => log(`a delivery could not be handled: ${String(error)}`));
  };

  const session = (headers: Record<string, string | string[] | undefined>) =>
    readSession(client, cookieValue(headers['cookie'], 'tf_session'));

  const surface = await startStatusServer({
    port: config.port,
    host: config.host,
    read: (runId, afterSeq) => readRunAfter(client, runId, afterSeq),
    // The tail is authorized the way the run's own page is (M10). It streams every event
    // raw, and a run id being a uuid makes it hard to guess — which was never the same
    // thing as being allowed.
    authorize: async (runId, headers) => {
      const who = await session(headers);
      if (!who) return 'anonymous';
      const row = await readRunRow(client, runId);
      if (!row) return 'forbidden';
      const installation = await loadInstallation(client, row.repo);
      if (!installation) return 'forbidden';
      const allowed = await installationsFor(who);
      return allowed.includes(installation.installationId) ? 'ok' : 'forbidden';
    },
    routes: chain(
      // First. Its path is disjoint from every other, it carries no session, and a
      // delivery GitHub will retry should not wait behind a human's page.
      webhookRoute({ secret: config.webhookSecret, onIntake }),
      authRoutes({ client, oauth, ...(config.secure === undefined ? {} : { secure: config.secure }) }),
      // The runner API before the dashboard: its paths are disjoint, and putting the
      // machine surface first keeps a slow human page from ever sitting in front of a
      // poll that a runner is holding open.
      runnerRoutes({
        client,
        blobRoot: config.blobRoot,
        mintToken: mint,
      }),
      dashboardRoutes({
        client,
        blobRoot: config.blobRoot,
        auth: {
          session,
          installations: (who) => installationsFor(who),
        },
        // The plane holds the App key, so it is the surface that may read issues (M10).
        github: { token: mint },
      }),
    ),
  });

  log(`plane up`);
  log(`  surface  http://127.0.0.1:${surface.port}/`);
  log(`  webhook  http://127.0.0.1:${surface.port}${WEBHOOK_PATH}  <- tell the App this`);

  return {
    port: surface.port,
    close: async () => {
      await surface.close();
      await close(client);
    },
  };
}

/**
 * A port, or a legible refusal — never `NaN`.
 *
 * `Number('eight-thousand')` is `NaN`, which `listen` rejects with an error naming
 * neither the variable nor the value, thrown after the `REQUIRED` check that exists to
 * produce a readable message has already passed. This is the same idea one line earlier.
 */
function port(value: string | undefined): number {
  if (value === undefined) return 8788;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`PORT is "${value}", which is not a port number`);
  }
  return parsed;
}

/** What is missing, and what it costs — the shape `serve.ts` and the runner both use. */
const REQUIRED: Record<string, string> = {
  DATABASE_URL: 'there is nowhere to keep the log',
  GITHUB_APP_ID: 'the App cannot authenticate, so no token can be minted for any runner',
  GITHUB_WEBHOOK_SECRET: 'every delivery would be refused as unsigned',
  GITHUB_CLIENT_ID: 'nobody could sign in',
  GITHUB_CLIENT_SECRET: 'a sign-in could start and never complete',
  ENGINE_PLANE_CALLBACK_URL: 'GitHub would have nowhere to send anyone back to',
  ENGINE_BLOB_ROOT: 'artifacts would be written somewhere this process does not own',
};

export function readPlaneConfig(env: NodeJS.ProcessEnv = process.env): PlaneConfig {
  const missing = Object.keys(REQUIRED).filter((key) => !env[key]);
  let privateKeyPem = env.GITHUB_PRIVATE_KEY ?? '';
  if (!privateKeyPem && env.GITHUB_PRIVATE_KEY_PATH) {
    try {
      // A path is what a developer has; the contents are what a container's secret
      // mount gives you. Both are normal, exactly as `serve.ts` treats them.
      privateKeyPem = readFileSync(env.GITHUB_PRIVATE_KEY_PATH, 'utf8');
    } catch (error) {
      throw new Error(`GITHUB_PRIVATE_KEY_PATH is set but unreadable: ${String((error as Error).message)}`);
    }
  }
  if (!privateKeyPem) missing.push('GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH');

  if (missing.length > 0) {
    const detail = missing.map((key) => `  ${key} — ${REQUIRED[key] ?? 'the App cannot authenticate'}`).join('\n');
    throw new Error(`cannot start the plane; these are not set:\n${detail}`);
  }

  return {
    appId: env.GITHUB_APP_ID!,
    privateKeyPem,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET!,
    oauth: {
      clientId: env.GITHUB_CLIENT_ID!,
      clientSecret: env.GITHUB_CLIENT_SECRET!,
      callbackUrl: env.ENGINE_PLANE_CALLBACK_URL!,
    },
    blobRoot: env.ENGINE_BLOB_ROOT!,
    port: port(env.PORT ?? env.EVENTS_PORT),
    host: env.ENGINE_BIND ?? '127.0.0.1',
    ...(env.ENGINE_PLANE_INSECURE === '1' ? { secure: false } : {}),
  };
}

if (process.argv[1]?.endsWith('plane-server.ts') || process.argv[1]?.endsWith('plane-server.js')) {
  loadEnv();
  // Said out loud rather than ignored. Anyone with this set configured a second server
  // that no longer exists, and is likely to have pointed the App's webhook URL at it —
  // which now 404s, and GitHub retries a 404 until it disables the webhook.
  if (process.env.WEBHOOK_PORT) {
    console.warn(
      `WEBHOOK_PORT=${process.env.WEBHOOK_PORT} is ignored: the plane serves one port, and the webhook is a route on it at ${WEBHOOK_PATH}.`,
    );
  }
  // Inside the async function, not as its argument. `readPlaneConfig()` throws
  // SYNCHRONOUSLY when the environment is incomplete, and evaluating it as an argument
  // put that throw outside the `catch` below — so an operator missing one variable got
  // a stack trace instead of the list naming what each missing thing costs. The
  // message was always right; nobody was ever shown it.
  void (async () => {
    try {
      await startPlane(readPlaneConfig());
    } catch (error) {
      console.error(String((error as Error)?.message ?? error));
      process.exitCode = 1;
    }
  })();
}
