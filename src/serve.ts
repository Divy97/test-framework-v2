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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDraft } from './drafts.js';
import type { InstallationIntake, IssueIntake } from './github.js';
import { cloneRepository, commentOnIssue, installationToken, repoUrl, startWebhookReceiver } from './github.js';
import { MODEL, effortLevel, providerName } from './loop.js';
import { DEFAULT_OPENROUTER_MODEL } from './openrouter.js';
import { loadInstallation, recordInstallation, removeInstallation } from './installations.js';
import { ensureBlobRoot } from './blobs.js';
import { draftRecipe, proveRepository } from './orchestrate.js';
import { projectOne, saveUsage } from './readmodel.js';
import { loadRecipe, saveProof } from './recipe.js';
import { dashboardRoutes } from './routes.js';
import { runFromIssue } from './run.js';
import { startStatusServer } from './sse.js';
import { loadEnv, appendEvent, connect, readRunAfter, type Db, ready, close } from './store.js';

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
export type Service = {
  webhookPort: number;
  eventsPort: number;
  /** Resolves when every queued run has finished. For tests, and for a clean shutdown. */
  drain: () => Promise<void>;
  close: () => Promise<void>;
};

export type ServeOptions = {
  config: Config;
  client: Db;
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
  /**
   * Get the drafting agent a checkout to explore (M6b), injected for the same reason
   * `comment` is: the default mints a real installation token and clones over the
   * network, and a test asserting on what a draft turns into should need neither a
   * registered GitHub App nor a reachable remote.
   */
  cloneForDraft?: (repo: string, installationId: number, into: string) => Promise<void>;
  /**
   * The drafting session itself, injected so a test can watch what gets stored without
   * spending a container or a model credential.
   */
  draft?: typeof draftRecipe;
  /**
   * The proving run (8f), injected for the same reason: it is two real containers and
   * several minutes, and a test about what onboarding STORES should need neither.
   */
  prove?: typeof proveRepository;
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
  // Same reasoning as `comment` above, for the same reason: the default mints a real
  // token and clones over the network, and a test that only cares what a draft turns
  // into should need neither a registered GitHub App nor a reachable remote.
  const cloneForDraft =
    options.cloneForDraft ??
    (async (repo: string, installationId: number, into: string) => {
      await cloneRepository(repoUrl(repo), into, await installationToken(app, installationId));
    });
  const draft = options.draft ?? draftRecipe;
  const prove = options.prove ?? proveRepository;
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
      `**Next:** approve a recipe for \`${intake.repo}\`, then start a run for this issue.`;
    await comment(intake.repo, intake.issueNumber, body, intake.installationId);
  };

  /**
   * Explore a freshly-installed, un-onboarded repository and propose a recipe (M6b).
   *
   * A convenience, never a control: ADR-0013's control is the human approving at
   * `/repos/<repo>/onboard`, and nothing here runs anything that human has not seen —
   * the draft only changes what is pre-filled in that box. `saveDraft` stores whatever
   * the agent produced, unvalidated, and deliberately: `parseRecipe` is the gate a
   * human's approval runs through, and pre-filtering here would as often discard a
   * proposal a human would have accepted with one field corrected.
   *
   * Failing quietly is the point, not a gap in it. A repository too large to clone, an
   * agent that produced garbage, a model that never answered — none of those may cost
   * the installation record itself, because `recipe_drafts` losing this row costs
   * nothing but asking the agent again.
   */
  const draftForRepo = async (repo: string, installationId: number): Promise<void> => {
    const workspace = await mkdtemp(join(tmpdir(), 'engine-draft-clone-'));
    try {
      const source = join(workspace, 'source');
      await cloneForDraft(repo, installationId, source);
      const outcome = await draft({
        runId: crypto.randomUUID(),
        repoPath: source,
        image: config.image,
        agentImage: config.agentImage,
        loop: config.loop,
      });
      if (!outcome.ok) {
        log(`${repo}: drafting produced nothing — ${outcome.reason}`);
        return;
      }
      await saveDraft(client, repo, outcome.draft);
      log(`${repo}: drafted a recipe for a human to review at /repos/${repo}/onboard`);
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  };

  /**
   * Prove that a just-approved repository actually runs (8f).
   *
   * Milestone 7: *"Onboarding proves a recipe, not a repository."* Until now the last
   * step of onboarding was a human pressing approve, and the first time anyone found
   * out whether those commands work was in the middle of a real run — twenty minutes
   * after a stranger filed an issue, presented as a finding about their bug.
   *
   * The same two containers a run would use, so the answer is the one a run will get.
   * Failing quietly for the same reason `draftForRepo` does: the recipe is stored
   * either way, the human approved it either way, and a proving run that cannot start
   * must never look like an approval that did not take.
   */
  const proveForRepo = async (repo: string): Promise<void> => {
    // EVERYTHING inside the try, including the two lookups and the temp directory.
    // This is fired and not awaited, so a rejection escaping it is an unhandled
    // rejection — which on current Node ends the process. A database hiccup one
    // second after somebody approved a recipe would have taken the receiver down
    // with it, and the surface that reported the approval would already have said
    // it worked.
    let workspace: string | undefined;
    try {
      const installation = await loadInstallation(client, repo);
      const recipe = await loadRecipe(client, repo);
      if (!installation || !recipe) return;
      workspace = await mkdtemp(join(tmpdir(), 'engine-prove-clone-'));
      const source = join(workspace, 'source');
      await cloneForDraft(repo, installation.installationId, source);
      const proof = await prove({
        runId: crypto.randomUUID(),
        repoPath: source,
        image: config.image,
        recipe,
      });
      await saveProof(client, repo, proof);
      log(`${repo}: proved ${proof.state}${proof.caveats.length ? ` — ${proof.caveats.length} caveat(s)` : ''}`);
    } catch (error) {
      log(`${repo}: could not be proved — ${String(error)}`);
    } finally {
      if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  };

  /**
   * An installation delivery, which is how a repository first becomes known to us.
   *
   * Recorded rather than run: nothing is reproduced here, and the onboarding that follows
   * needs a human to approve a recipe before any run can boot anything (ADR-0013).
   */
  /**
   * DELTA-BASED, deliberately, and unlike the hosted plane.
   *
   * `plane-server.ts` reconciles against GitHub because a plane deployed today never
   * heard the events that installed everything already there. This does not, for a
   * reason that is about cost rather than correctness: recording a repository here also
   * DRAFTS a recipe for it, which is a model call and a container. Reconciling would
   * fan that out across every repository the App has ever been installed on, at once,
   * on somebody's laptop.
   *
   * The consequence is real and accepted: a repository installed before this process
   * first ran is not in the table, and `installation_repositories` will not mention it
   * again. On one machine with one operator that is a `draft a recipe` link away.
   *
   * An intake whose `repos` is empty is therefore an expected no-op here, not a bug —
   * GitHub sends exactly that when a selection widens to "all repositories".
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
            // DRAFTING (M6b). Its own failure is caught right here rather than by the
            // `catch` around this whole loop — a repository this cannot draft for must
            // not stop the NEXT repository in the same delivery from being recorded.
            if (!recipe) {
              await draftForRepo(repo, intake.installationId).catch((error) => {
                log(`${repo}: could not draft a recipe — ${String((error as Error).message ?? error)}`);
              });
            }
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
        const banked = result.usage ?? [];
        for (const [index, entry] of banked.entries()) {
          await saveUsage(client, {
            run_id: result.runId,
            phase: entry.phase,
            // Which phase of this name it is. Two `agent` phases per run, and before this
            // the fix agent's row landed on the repro agent's and half the bill vanished.
            n: banked.slice(0, index).filter((one) => one.phase === entry.phase).length,
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
        // Says what actually happened. An empty list logged as `added ` reads as though
        // something was recorded, and nothing was.
        log(
          intake.repos.length === 0
            ? `installation ${intake.installationId}: ${intake.action}, naming no repository — nothing to record`
            : `installation ${intake.installationId}: ${intake.action} ${intake.repos.join(', ')}`,
        );
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
    routes: dashboardRoutes({
      client,
      // The engine runs HERE: containers on this machine, and installing a repository
      // starts a drafting run that fills the recipe box. The hosted plane can promise
      // neither, so the pages say different things.
      mode: 'local',
      // Not awaited: proving is two containers and several minutes, and the human who
      // just pressed approve is owed a page now. The result lands in the row and the
      // next render of this page shows it.
      onApproved: (repo) => void proveForRepo(repo),
    }),
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
  loadEnv();
  const config = readConfig();
  const client = connect();
  await ready(client);
  const service = await serve({ config, client });
  console.log(`webhook  http://127.0.0.1:${service.webhookPort}/`);
  console.log(`events   http://127.0.0.1:${service.eventsPort}/runs/<run-id>/events`);
  console.log('one run at a time — one run is five containers, so a second would double the bill');

  // One shutdown, however many signals arrive. `process.once` is per SIGNAL, so an
  // operator's Ctrl-C followed by a supervisor's SIGTERM ran this chain twice — and the
  // second run would reach `close(client)` while the first was still inside `drain()`,
  // killing the run in flight and exiting 1. Harmless under `pg.Client`, whose `end()`
  // was idempotent; not under a pool, whose second `end()` rejects.
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n${signal}: no longer accepting deliveries; finishing the run in flight`);
      service
        .close()
        .then(() => service.drain())
        .then(() => close(client))
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  }
}
