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

import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { authRoutes } from './auth-routes.js';
import { installationsFor, readSession, cookieValue, type OAuthConfig } from './auth.js';
import { startWebhookReceiver, installationToken, type GitHubApp, type Intake } from './github.js';
import { recordInstallation, removeInstallation } from './installations.js';
import { enqueueJob } from './plane.js';
import { loadRecipe } from './recipe.js';
import { dashboardRoutes } from './routes.js';
import { runnerRoutes } from './runner-api.js';
import { startStatusServer, type Route } from './sse.js';
import { connect, readRunAfter } from './store.js';

export type PlaneConfig = {
  appId: string;
  privateKeyPem: string;
  webhookSecret: string;
  oauth: { clientId: string; clientSecret: string; callbackUrl: string };
  blobRoot: string;
  webhookPort: number;
  port: number;
  /** False for http in development. The cookie is marked Secure either way it is told. */
  secure?: boolean;
};

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

export async function startPlane(config: PlaneConfig): Promise<{
  port: number;
  webhookPort: number;
  close: () => Promise<void>;
}> {
  const client = connect();
  await client.connect();
  await mkdir(config.blobRoot, { recursive: true });

  const app: GitHubApp = { appId: config.appId, privateKeyPem: config.privateKeyPem };
  const oauth: OAuthConfig = { ...config.oauth };
  const log = (line: string) => console.log(line);

  /**
   * A delivery becomes a queued job, or a comment saying why it did not.
   *
   * The gate is the same one `serve.ts` applies and for the same reason (M6a): a
   * repository nobody has onboarded gets an answer, not a run that reproduces nothing
   * and reports it as a finding about their bug.
   */
  const receiver = await startWebhookReceiver({
    secret: config.webhookSecret,
    port: config.webhookPort,
    onIntake: (intake: Intake) => {
      void (async () => {
        try {
          if (intake.kind === 'installation') {
            // A delivery names several repositories — `installation_repositories` adds
            // and removes in batches — so each one is its own row.
            for (const repo of intake.repos) {
              if (intake.action === 'added') {
                await recordInstallation(client, {
                  repo,
                  installationId: intake.installationId,
                  account: intake.account,
                });
              } else {
                await removeInstallation(client, repo);
              }
            }
            log(`installation ${intake.installationId}: ${intake.action} ${intake.repos.join(', ')}`);
            return;
          }
          const recipe = await loadRecipe(client, intake.repo);
          if (!recipe) {
            log(`${intake.repo}#${intake.issueNumber}: not onboarded — nothing queued`);
            return;
          }
          const runId = await enqueueJob(client, {
            installationId: intake.installationId,
            repo: intake.repo,
            intake,
          });
          log(`${intake.repo}#${intake.issueNumber}: queued as ${runId}`);
        } catch (error) {
          // Never rethrown: this is called without being awaited, so an escape here is
          // an unhandled rejection that ends the process — and the process is the thing
          // GitHub is talking to.
          log(`a delivery could not be queued: ${String(error)}`);
        }
      })();
    },
  });

  const surface = await startStatusServer({
    port: config.port,
    read: (runId, afterSeq) => readRunAfter(client, runId, afterSeq),
    routes: chain(
      authRoutes({ client, oauth, ...(config.secure === undefined ? {} : { secure: config.secure }) }),
      // The runner API before the dashboard: its paths are disjoint, and putting the
      // machine surface first keeps a slow human page from ever sitting in front of a
      // poll that a runner is holding open.
      runnerRoutes({
        client,
        blobRoot: config.blobRoot,
        mintToken: (installationId) => installationToken(app, installationId),
      }),
      dashboardRoutes({
        client,
        blobRoot: config.blobRoot,
        auth: {
          session: (headers) => readSession(client, cookieValue(headers['cookie'], 'tf_session')),
          installations: (session) => installationsFor(session),
        },
      }),
    ),
  });

  log(`plane up`);
  log(`  webhook  http://127.0.0.1:${receiver.port}/`);
  log(`  surface  http://127.0.0.1:${surface.port}/`);

  return {
    port: surface.port,
    webhookPort: receiver.port,
    close: async () => {
      await receiver.close();
      await surface.close();
      await client.end();
    },
  };
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
    webhookPort: Number(env.WEBHOOK_PORT ?? 8787),
    port: Number(env.EVENTS_PORT ?? 8788),
    ...(env.ENGINE_PLANE_INSECURE === '1' ? { secure: false } : {}),
  };
}

if (process.argv[1]?.endsWith('plane-server.ts') || process.argv[1]?.endsWith('plane-server.js')) {
  process.loadEnvFile?.('.env');
  startPlane(readPlaneConfig()).catch((error: unknown) => {
    console.error(String((error as Error)?.message ?? error));
    process.exitCode = 1;
  });
}
