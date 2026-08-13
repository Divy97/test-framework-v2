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
import type { InstallationIntake, IssueIntake } from './github.js';
import { commentOnIssue, installationToken, startWebhookReceiver } from './github.js';
import { MODEL, effortLevel, providerName } from './loop.js';
import { DEFAULT_OPENROUTER_MODEL } from './openrouter.js';
import { loadInstallation, recordInstallation, removeInstallation } from './installations.js';
import { projectOne, saveUsage } from './readmodel.js';
import { loadRecipe } from './recipe.js';
import { dashboardRoutes } from './routes.js';
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
  /**
   * Which model drives the agent, and the credential for it.
   *
   * Not optional, and validated at startup, because of how its absence presents. With
   * no `loop` on the plan, `orchestrate` takes its pre-ADR-0011 branch — `claude`
   * spawned inside the sealed container, which cannot reach any model — and the run
   * ends `unresolved` with `AGENT_FINISHED { stopped: 'spawn_failed', messages: 0 }`,
   * no `ENV_READY`, and every container exiting 0 with empty stderr. That is what the
   * first real webhook-driven run did, and nothing in the log named a cause.
   */
  loop: { provider: string; apiKey: string; model: string; effort: string };
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

  // The model credential, for the provider actually selected. A service that starts
  // without one reaches the agent phase and silently consults nothing.
  const provider = providerName(env.ENGINE_PROVIDER);
  const modelKey =
    provider === 'openrouter'
      ? (env.OPENROUTER_API_KEY ?? '')
      : (env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN ?? '');
  if (!modelKey) {
    missing.push(
      provider === 'openrouter'
        ? 'OPENROUTER_API_KEY (ENGINE_PROVIDER=openrouter)'
        : 'ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN (ENGINE_PROVIDER=anthropic)',
    );
  }

  if (missing.length > 0) {
    const cost = (key: string) =>
      REQUIRED[key] ??
      (key.includes('API_KEY') || key.includes('AUTH_TOKEN')
        ? 'no model would ever be consulted: the run reaches the agent phase and silently does nothing'
        : 'the App cannot authenticate');
    const detail = missing.map((key) => `  ${key} — ${cost(key)}`).join('\n');
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
    loop: {
      provider,
      apiKey: modelKey,
      // NOT `modelId()`. That falls back to `MODEL` — an Anthropic id — for every
      // provider, and ADR-0015 records why sending `claude-opus-5` to OpenRouter's
      // OpenAI endpoint is a 404 whose cause is not in the message. The default has to
      // follow the provider.
      model: env.ENGINE_MODEL ?? (provider === 'openrouter' ? DEFAULT_OPENROUTER_MODEL : MODEL),
      effort: effortLevel(env.ENGINE_EFFORT),
    },
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
  /**
   * How the service talks back to an issue, injected for the same reason `run` is.
   *
   * The un-onboarded reply is the first message this product ever sends, so it needs a
   * test — and a test that mints a real installation token to assert on a sentence would
   * be a test nobody can run.
   */
  comment?: (repo: string, issueNumber: number, body: string, installationId: number) => Promise<void>;
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
  const app = { appId: config.appId, privateKeyPem: config.privateKeyPem };
  const comment =
    options.comment ??
    (async (repo: string, issueNumber: number, body: string, installationId: number) => {
      // Minted per message, never cached — a service outlives an hour and ADR-0012 makes
      // the mint a function for exactly that reason.
      // `{}` rather than `app`: minting needs the key material, commenting needs only a
      // token and takes `Pick<GitHubApp,'fetch'|'api'>` so that no key can reach it.
      await commentOnIssue({}, await installationToken(app, installationId), repo, issueNumber, body);
    });
  await ensureBlobRoot(config.blobRoot);

  // A queue of one — see the header. A resource policy, not a port constraint.
  let tail: Promise<void> = Promise.resolve();

  /**
   * Tell the reporter their repository is not set up yet, and say who can fix it.
   *
   * The one message that has to be right, because it is the first the product ever sends
   * and it is about our own gap rather than their bug. It names what is missing, says
   * plainly that nothing was attempted, and does not dress that up as a finding.
   */
  const sayNotOnboarded = async (intake: IssueIntake): Promise<void> => {
    const body =
      `This repository is connected but **not onboarded yet**, so no run was started.\n\n` +
      `Before anything can be reproduced here, someone has to approve an environment ` +
      `recipe — the commands that install, migrate, seed and boot this project — and ` +
      `nothing in a repository reliably says what those are (ADR-0013).\n\n` +
      `Until then this is the honest answer. Starting a run anyway would boot nothing, ` +
      `reproduce nothing, and report that we could not reproduce your bug — which would ` +
      `be a statement about our setup wearing the shape of a finding about your code.\n\n` +
      `**Next:** approve a recipe for \`${intake.repo}\`, then re-label this issue.`;
    await comment(intake.repo, intake.issueNumber, body, intake.installationId);
  };

  /**
   * An installation delivery, which is how a repository first becomes known to us.
   *
   * Recorded rather than run: nothing is reproduced here, and the onboarding that follows
   * needs a human to approve a recipe before any run can boot anything (ADR-0013).
   */
  const record = (intake: InstallationIntake): void => {
    tail = tail.then(async () => {
      try {
        for (const repo of intake.repos) {
          if (intake.action === 'added') {
            await recordInstallation(client, {
              repo,
              installationId: intake.installationId,
              account: intake.account,
            });
            const recipe = await loadRecipe(client, repo);
            log(`${repo}: installed${recipe ? '' : ' — not onboarded yet, no recipe approved'}`);
          } else {
            await removeInstallation(client, repo);
            log(`${repo}: removed`);
          }
        }
      } catch (error) {
        log(`installation ${intake.installationId}: could not record — ${String((error as Error).message ?? error)}`);
      }
    });
  };

  const enqueue = (intake: IssueIntake): void => {
    tail = tail.then(async () => {
      const label = `${intake.repo}#${intake.issueNumber}`;
      try {
        // THE ONBOARDING GATE (M6a). No recipe, no run — and a comment saying so.
        //
        // This used to start the run anyway. With `recipe: null` nothing boots, the agent
        // is told there is no environment, and the overwhelmingly likely outcome is a
        // Tier 3: "we could not reproduce this" written onto a stranger's issue, in an
        // append-only log, about a bug we never had the means to look at. A user's first
        // experience of the product was a wrong answer, and a confident one.
        //
        // Refusing here is not a lesser outcome than a Tier 3; it is the honest one. The
        // gate ADR-0007 protects judges reproductions, and this failure is upstream of
        // anything being reproduced, so no gate could have caught it.
        // REMOVED means removed (M6a's third done-when, which was unimplemented). The
        // gate consulted `loadRecipe` only, and `removeInstallation` deliberately leaves
        // the `recipes` row alone — so an issue on an uninstalled repository still found
        // its recipe, started a full five-container run, and failed minutes later at the
        // token mint with a message about authentication rather than about not being
        // installed.
        //
        // GitHub stops delivering after an uninstall, so this is not a hole anyone walks
        // through; it is a stated done-when, and a redelivery reaches it.
        if (!(await loadInstallation(client, intake.repo))) {
          log(`${label}: not installed — ignoring`);
          return;
        }

        const recipe = await loadRecipe(client, intake.repo);
        if (!recipe) {
          log(`${label}: not onboarded — commenting, and starting no run`);
          await sayNotOnboarded(intake).catch((error) => {
            log(`${label}: could not comment — ${String((error as Error).message ?? error)}`);
          });
          return;
        }

        const result = await start({
          intake,
          app: { appId: config.appId, privateKeyPem: config.privateKeyPem },
          recipe,
          image: config.image,
          agentImage: config.agentImage,
          blobRoot: config.blobRoot,
          append: (event) => appendEvent(client, event),
          // Without this, `orchestrate` runs its pre-ADR-0011 path and no model is
          // reached. Passed explicitly rather than left to the loop's own environment
          // resolution, so the wiring is visible and a test can assert it.
          loop: config.loop,
        });

        // A run that reached no tier is an operational failure until proven otherwise, and
        // the container's own stderr is the only thing that can say which. Printed, because
        // a service whose failures are only visible in a debugger is not a service.
        for (const d of result.diagnostics ?? []) {
          log(`${label}: [${d.phase}] exit ${d.exitCode} stderr=${d.stderr.trim() ? `\n${d.stderr.trimEnd()}` : '(empty)'}`);
        }
        log(`${label}: phases=${(result.diagnostics ?? []).length} env=${JSON.stringify(result.state.env ?? null)}`);

        // WHAT IT COST, banked rather than logged and dropped (M6d). Not an event: our
        // spending is a fact about us, and the log is about the user's bug (ADR-0006).
        for (const entry of result.usage ?? []) {
          await saveUsage(client, {
            run_id: result.runId,
            phase: entry.phase,
            turns: entry.usage.turns,
            input_tokens: entry.usage.input_tokens,
            output_tokens: entry.usage.output_tokens,
            cache_read_input_tokens: entry.usage.cache_read_input_tokens,
            cache_creation_input_tokens: entry.usage.cache_creation_input_tokens,
            provider: config.loop.provider,
            model: config.loop.model,
          }).catch((error) => log(`${label}: could not record usage — ${String((error as Error).message ?? error)}`));
        }

        // And the read model, from the log rather than from `result` (M6c). Projecting
        // off the events means the row is exactly what a rebuild would produce; taking it
        // from the in-memory result would let the two drift and only a rebuild would say.
        await projectOne(client, result.runId).catch((error) =>
          log(`${label}: could not project — ${String((error as Error).message ?? error)}`),
        );

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
      if (intake.kind === 'installation') {
        log(`installation ${intake.installationId}: ${intake.action} ${intake.repos.join(', ')}`);
        record(intake);
        return;
      }
      log(`${intake.repo}#${intake.issueNumber}: queued`);
      enqueue(intake);
    },
  });

  const events = await startStatusServer({
    port: config.eventsPort,
    read: (runId, afterSeq) => readRunAfter(client, runId, afterSeq),
    // The dashboard shares the tail's port rather than binding a third (M6f). One
    // surface, one thing to expose, and the live tail a run page needs is already here.
    routes: dashboardRoutes({ client }),
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
