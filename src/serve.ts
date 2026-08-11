// The service. Everything else in `src/` was a part; this is the thing that runs.
//
// Every piece below was already built and tested — the receiver verifies HMACs, the
// intake maps deliveries, `runFromIssue` drives a run to a pull request, the SSE server
// tails a log. Nothing started any of them outside a test, which is a specific kind of
// gap: the whole system was reachable only from `vitest`, and "it works" meant "it works
// when a test wires it up".
//
// Two decisions here are not stylistic:
//
//   1. **Config is validated before anything binds a port.** A service that starts with
//      no webhook secret and 401s every delivery looks identical to GitHub sending
//      nothing. `readConfig` refuses, by name, with the variable that is missing.
//   2. **Runs are serialised — as a resource policy, not a correctness requirement.**
//      An earlier version of this comment said concurrent runs would fight over the host
//      port a recipe pins. That was **wrong**, and it is worth recording rather than
//      quietly deleting: `replayRecipe` runs inside the container (`runner.ts`), its
//      healthcheck fetches `127.0.0.1:port` from inside that same container, and no
//      container publishes a port to the host. Each run's services live in their own
//      network namespace, so nothing collides.
//
//      What is actually true: one run is an agent container plus a base container plus
//      three fix containers, and a second concurrent run doubles the Docker load and the
//      model spend on one machine with no ceiling. A queue of one is a defensible default
//      for a single-host deployment and a **choice**, not a constraint — raising it is a
//      configuration change, not a redesign.

import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import type { Intake } from './github.js';
import { startWebhookReceiver } from './github.js';
import { loadRecipe } from './recipe.js';
import { runFromIssue } from './run.js';
import { startStatusServer } from './sse.js';
import { appendEvent, connect, readRunAfter } from './store.js';

export type Config = {
  /** The GitHub App's numeric id, and the PEM it signs its JWT with (ADR-0012). */
  appId: string;
  privateKeyPem: string;
  webhookSecret: string;
  /** The sealed phase image, and the one with a browser for the agent sandbox (5f). */
  image: string;
  agentImage: string;
  blobRoot: string;
  webhookPort: number;
  eventsPort: number;
};

/** What a missing variable costs, so the message can say it. */
const REQUIRED: Record<string, string> = {
  GITHUB_APP_ID: 'the App cannot mint an installation token, so no run can clone or push',
  GITHUB_WEBHOOK_SECRET: 'every delivery would be rejected as unsigned, which looks exactly like GitHub sending nothing',
  DATABASE_URL: 'there is nowhere to append events, and a run with no log is not a run',
};

/**
 * Read the environment, or refuse to start.
 *
 * Refusing is the whole point. The alternative — defaults and empty strings — produces a
 * process that binds a port, answers health checks, 401s every real delivery, and gives
 * an operator nothing to look at. This project's rule about credentials is that an
 * absence must be loud, and a service is where that rule is easiest to break.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = Object.keys(REQUIRED).filter((key) => !env[key]);

  // The PEM may arrive as a path or as the key itself. Both are normal: a path is what a
  // developer has, and the contents are what a container's secret mount gives you.
  let privateKeyPem = env.GITHUB_PRIVATE_KEY ?? '';
  if (!privateKeyPem && env.GITHUB_PRIVATE_KEY_PATH) {
    try {
      privateKeyPem = readFileSync(env.GITHUB_PRIVATE_KEY_PATH, 'utf8');
    } catch (error) {
      throw new Error(`GITHUB_PRIVATE_KEY_PATH is set but unreadable: ${String((error as Error).message)}`);
    }
  }
  if (!privateKeyPem) missing.push('GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH');

  if (missing.length > 0) {
    const detail = missing.map((key) => `  ${key} — ${REQUIRED[key] ?? 'the App cannot authenticate'}`).join('\n');
    throw new Error(`cannot start; these are not set:\n${detail}\n\nSee .env.example.`);
  }

  // A PEM that is not a PEM fails later, inside `appJwt`, as a crypto error during the
  // first real delivery. Checked here so the failure is at startup instead.
  if (!privateKeyPem.includes('-----BEGIN')) {
    throw new Error('the GitHub App private key is not a PEM — expected a "-----BEGIN …" block');
  }

  return {
    appId: env.GITHUB_APP_ID!,
    privateKeyPem,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET!,
    image: env.ENGINE_IMAGE ?? 'test-framework-v2-sandbox:latest',
    agentImage: env.ENGINE_AGENT_IMAGE ?? env.ENGINE_IMAGE ?? 'test-framework-v2-agent:latest',
    blobRoot: env.ENGINE_BLOB_ROOT ?? '/blobs',
    webhookPort: Number(env.WEBHOOK_PORT ?? 8787),
    eventsPort: Number(env.EVENTS_PORT ?? 8788),
  };
}

/** The evidence store's sentinel, created once so `put` has somewhere to write. */
async function ensureBlobRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, '.evidence-store'), '', { flag: 'a' });
}

export type Service = {
  webhookPort: number;
  eventsPort: number;
  /** Resolves when every queued run has finished. For tests, and for a clean shutdown. */
  drain: () => Promise<void>;
  close: () => Promise<void>;
};

export type ServeOptions = {
  config: Config;
  client: pg.Client;
  /** Injected so a test can watch a run start without spending a model or a container. */
  run?: typeof runFromIssue;
  log?: (line: string) => void;
};

/**
 * Boot the receiver and the event tail, and run one issue at a time.
 *
 * The queue here does exactly ONE job — serialise runs, so one machine is not asked to
 * hold several sandboxes and several model bills at once.
 * It is worth being precise about what it does not do: acknowledging GitHub before the
 * run is `startWebhookReceiver`'s guarantee, which replies `202` and then calls
 * `onIntake` without awaiting it (`src/github.ts`, asserted in `test/github.test.ts`).
 * An earlier version of this comment credited the queue for that, and a mutation test
 * proved the claim empty: making `onIntake` await the whole run changed no observable
 * behaviour and broke no test, because the socket was already answered.
 */
export async function serve(options: ServeOptions): Promise<Service> {
  const { config, client } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const start = options.run ?? runFromIssue;
  await ensureBlobRoot(config.blobRoot);

  // A queue of one — see the header. A resource policy, not a port constraint.
  let tail: Promise<void> = Promise.resolve();

  const enqueue = (intake: Intake): void => {
    tail = tail.then(async () => {
      const label = `${intake.repo}#${intake.issueNumber}`;
      try {
        // Per-repository, and `null` is a legitimate answer: a repo with no recipe boots
        // nothing and the agent is told so (ADR-0013). It is not an error to be caught.
        const recipe = await loadRecipe(client, intake.repo);
        if (!recipe) log(`${label}: no recipe for this repository — nothing will be booted`);

        const result = await start({
          intake,
          app: { appId: config.appId, privateKeyPem: config.privateKeyPem },
          recipe,
          image: config.image,
          agentImage: config.agentImage,
          blobRoot: config.blobRoot,
          append: (event) => appendEvent(client, event),
        });

        const spent = (result.usage ?? []).reduce((total, entry) => total + entry.usage.output_tokens, 0);
        log(
          `${label}: run ${result.runId} ended ${result.state.status}` +
            `${result.prUrl ? ` → ${result.prUrl}` : ''}` +
            `${spent > 0 ? ` (${spent} output tokens)` : ''}`,
        );
      } catch (error) {
        // A run that throws got past `runFromIssue`'s own reporting, which means it could
        // not start at all — no token, no clone. Logged and swallowed, because the
        // alternative is one bad repository taking the service down for every other.
        log(`${label}: could not start — ${String((error as Error).message ?? error)}`);
      }
    });
  };

  const receiver = await startWebhookReceiver({
    secret: config.webhookSecret,
    port: config.webhookPort,
    onIntake: (intake) => {
      log(`${intake.repo}#${intake.issueNumber}: queued`);
      enqueue(intake);
    },
  });

  const events = await startStatusServer({
    port: config.eventsPort,
    read: (runId, afterSeq) => readRunAfter(client, runId, afterSeq),
  });

  return {
    webhookPort: receiver.port,
    eventsPort: events.port,
    drain: () => tail,
    close: async () => {
      await receiver.close();
      await events.close();
    },
  };
}

/** `npx tsx src/serve.ts`. Nothing here is importable behaviour; it is the entrypoint. */
if (import.meta.url === `file://${process.argv[1]}`) {
  process.loadEnvFile?.('.env');
  const config = readConfig();
  const client = connect();
  await client.connect();
  const service = await serve({ config, client });
  console.log(`webhook  http://127.0.0.1:${service.webhookPort}/`);
  console.log(`events   http://127.0.0.1:${service.eventsPort}/runs/<run-id>/events`);
  console.log('one run at a time — one run is five containers, so a second would double the bill');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      console.log(`\n${signal}: no longer accepting deliveries; finishing the run in flight`);
      service
        .close()
        .then(() => service.drain())
        .then(() => client.end())
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  }
}
