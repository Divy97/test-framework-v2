// The runner, as a program: config from the environment, the engine behind it, and the
// daemon loop in front.
//
// Thin on purpose. Everything worth testing is either in `daemon.ts` (the loop, tested
// against a fake plane) or in the engine itself (tested against real containers); what
// is left here is the wiring that turns a job into a `runFromIssue` call, and the one
// thing that wiring must get right is the credential story:
//
//   - the GitHub token is asked for PER CALL, from the plane, and never held;
//   - the model key is read from this machine's environment and never leaves it;
//   - the run id comes from the plane, because the plane authorizes appends by it.
//
// `npx tsx src/runner-main.ts`, with ENGINE_PLANE_URL and ENGINE_RUNNER_TOKEN set.

import { join } from 'node:path';
import { ensureBlobRoot } from './blobs.js';
import { runDaemon, type DaemonIo, type DaemonJob } from './daemon.js';
import type { IssueIntake } from './github.js';
import { providerName } from './loop.js';
import type { RunPlan } from './orchestrate.js';
import { runFromIssue } from './run.js';
import { loadEnv } from './store.js';

/** Which substrate the phases run on. `docker` is this machine; `vercel` is a microVM. */
export type ExecutorKind = 'docker' | 'vercel';

/**
 * What a Vercel-backed runner needs beyond the rest.
 *
 * Credentials are optional as a group: the SDK reads a `vercel login` from disk when none
 * are given, which is how the spike ran. A machine with no CLI session — the worker —
 * needs all three, and `readRunnerConfig` refuses a partial set rather than falling back
 * to a login that is not there, because that failure surfaces as an authentication error
 * on the first sandbox rather than at boot.
 */
export type VercelConfig = {
  region: string;
  credentials: { token?: string; teamId?: string; projectId?: string };
};

export type RunnerConfig = {
  planeUrl: string;
  token: string;
  image: string;
  agentImage: string;
  blobRoot: string;
  executor: ExecutorKind;
  /** Present only when `executor` is `vercel`. */
  vercel?: VercelConfig;
  loop: { provider?: string; apiKey?: string; model?: string; effort?: string };
};

/**
 * What is missing, and what it costs — the shape `readConfig` in `serve.ts` uses.
 *
 * Only what CANNOT be defaulted. This list had five entries, and three of them were
 * asking an operator to name things this repository already decides: the two images are
 * built by the two Dockerfiles beside this file, under the names `npm run images` gives
 * them, and the blob root is a directory in the checkout. A new runner following the
 * pairing page's own command hit all three at once and had nowhere to look them up —
 * the answer lived in a document about setting up a GitHub App.
 *
 * The model credential stays required, because defaulting a credential is not a thing
 * that can be done honestly.
 */
const REQUIRED: Record<string, string> = {
  ENGINE_PLANE_URL: 'there is nothing to take work from',
  ENGINE_RUNNER_TOKEN: 'the plane would answer 401 to every poll; pair this machine first',
};

/** The names `npm run images` builds, and `docker-compose` uses. One place, so they agree. */
export const DEFAULT_IMAGE = 'test-framework-v2-sandbox:latest';
export const DEFAULT_AGENT_IMAGE = 'test-framework-v2-agent:latest';
/** Inside the checkout, which is a directory this process certainly owns. */
export const DEFAULT_BLOB_ROOT = './.evidence-store';

/** The default region. One, because a snapshot is not portable across them (ADR-0021). */
export const DEFAULT_VERCEL_REGION = 'iad1';

export function readRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const missing = Object.keys(REQUIRED).filter((key) => !env[key]);

  // WHICH SUBSTRATE, validated only for the one actually chosen (M10, 10e).
  //
  // A Docker runner must not be asked for a Vercel token it will never use, and a Vercel
  // worker must not start without one and discover it at the first sandbox — twenty
  // minutes into a run, as an authentication error that reads like an outage. So the
  // check is inside the branch rather than in `REQUIRED`.
  const wanted = env.ENGINE_EXECUTOR ?? 'docker';
  if (wanted !== 'docker' && wanted !== 'vercel') {
    throw new Error(`ENGINE_EXECUTOR must be docker or vercel, not ${wanted}`);
  }
  const executor: ExecutorKind = wanted;
  let vercel: VercelConfig | undefined;
  if (executor === 'vercel') {
    const token = env.VERCEL_TOKEN;
    const teamId = env.VERCEL_TEAM_ID;
    const projectId = env.VERCEL_PROJECT_ID;
    const given = [token, teamId, projectId].filter(Boolean).length;
    // All three or none. A partial set is the shape that silently falls back to a CLI
    // login the machine does not have, so it is refused where an operator is looking.
    if (given !== 0 && given !== 3) {
      missing.push('VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID together (or none, to use a `vercel login`)');
    }
    // The images are references the platform can pull, not tags on this machine — so the
    // defaults `npm run images` gives are wrong here and there is nothing to fall back to.
    if (!env.ENGINE_IMAGE || !env.ENGINE_AGENT_IMAGE) {
      missing.push('ENGINE_IMAGE and ENGINE_AGENT_IMAGE (registry references, not local tags)');
    }
    vercel = {
      region: env.ENGINE_VERCEL_REGION ?? DEFAULT_VERCEL_REGION,
      credentials: {
        ...(token === undefined ? {} : { token }),
        ...(teamId === undefined ? {} : { teamId }),
        ...(projectId === undefined ? {} : { projectId }),
      },
    };
  }

  // The model credential, for the provider actually selected — the same check
  // `serve.ts` makes, and for the same reason: a runner that starts without one reaches
  // the agent phase and silently consults nothing.
  const provider = providerName(env.ENGINE_PROVIDER);
  const key =
    provider === 'openrouter'
      ? (env.OPENROUTER_API_KEY ?? '')
      : (env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN ?? '');
  if (!key) {
    missing.push(
      provider === 'openrouter'
        ? 'OPENROUTER_API_KEY (ENGINE_PROVIDER=openrouter)'
        : 'ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN (ENGINE_PROVIDER=anthropic)',
    );
  }

  if (missing.length > 0) {
    const detail = missing
      .map((name) => `  ${name} — ${REQUIRED[name] ?? 'no model would ever be consulted'}`)
      .join('\n');
    throw new Error(`cannot start this runner; these are not set:\n${detail}`);
  }

  return {
    planeUrl: env.ENGINE_PLANE_URL!,
    token: env.ENGINE_RUNNER_TOKEN!,
    image: env.ENGINE_IMAGE ?? DEFAULT_IMAGE,
    agentImage: env.ENGINE_AGENT_IMAGE ?? DEFAULT_AGENT_IMAGE,
    blobRoot: env.ENGINE_BLOB_ROOT ?? DEFAULT_BLOB_ROOT,
    executor,
    ...(vercel ? { vercel } : {}),
    loop: {
      ...(env.ENGINE_PROVIDER === undefined ? {} : { provider: env.ENGINE_PROVIDER }),
      apiKey: key,
      ...(env.ENGINE_MODEL === undefined ? {} : { model: env.ENGINE_MODEL }),
      ...(env.ENGINE_EFFORT === undefined ? {} : { effort: env.ENGINE_EFFORT }),
    },
  };
}

/**
 * Turn one dispatched job into a run of the engine that already exists.
 *
 * Nothing about the engine changes for being hosted, which was the point of doing the
 * boundary first: `runFromIssue` takes an `append` and a run id, and this supplies the
 * ones the plane is expecting.
 */
/**
 * The executor this runner uses, built ONCE.
 *
 * Once, not per job, because the Vercel one holds a ledger of the sandboxes this worker
 * created and a `sweep()` over them — per-job instances would each have their own idea of
 * what is outstanding, which is exactly the bookkeeping the sweep exists to provide.
 *
 * A dynamic import, so a Docker runner never resolves `@vercel/sandbox` at all. Returns
 * `undefined` for Docker rather than building `dockerExecutor()` here: absent is what
 * every caller below already treats as "the default", and naming it twice invites the two
 * to disagree.
 */
export async function executorFor(
  config: RunnerConfig,
): Promise<(RunPlan['executor'] & { sweep?: () => Promise<number> }) | undefined> {
  if (config.executor !== 'vercel') return undefined;
  const { vercelClient } = await import('./vercel-client.js');
  const { vercelExecutor } = await import('./executor-vercel.js');
  return vercelExecutor({
    client: await vercelClient({ credentials: config.vercel!.credentials, region: config.vercel!.region }),
    ledger: { path: join(config.blobRoot, '..', 'sandboxes.jsonl') },
    // This worker's own tag, so a booting worker never stops another one's live phases.
    tags: { engine: 'test-framework-v2', worker: config.token.slice(-12) },
  });
}

export function engineExecute(config: RunnerConfig, executor?: RunPlan['executor']) {
  return async (job: DaemonJob, io: DaemonIo): Promise<void> => {
    await runFromIssue({
      ...(executor ? { executor } : {}),
      intake: job.intake as IssueIntake,
      // No App key on this machine. `installationToken` asks the plane instead, every
      // time it needs one, which is what keeps a run longer than an hour honest.
      app: { mint: () => io.token() },
      recipe: job.recipe,
      image: config.image,
      agentImage: config.agentImage,
      blobRoot: config.blobRoot,
      runId: job.runId,
      append: io.append,
      loop: config.loop,
    });
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = readRunnerConfig(env);
  // The SENTINEL, not just the directory. `orchestrate` refuses a blob root without one
  // — a typo'd path would otherwise produce a complete event stream whose artifacts went
  // nowhere — and a bare `mkdir` here meant every runner failed its first job on a
  // message about a mount it does not have.
  await ensureBlobRoot(config.blobRoot);
  const log = (line: string) => console.log(line);
  const executor = await executorFor(config);

  // BEFORE taking any work. A worker that died mid-run left machines the platform will
  // end at their own session timeout — up to an hour of compute per phase that nobody is
  // watching and everybody is paying for. Swept rather than trusted to expire.
  //
  // Never fatal. A sweep that cannot reach the platform is a worker that should still
  // take work; refusing to start over unfinished bookkeeping would turn a billing
  // annoyance into an outage.
  if (executor?.sweep) {
    const stopped = await executor.sweep().catch((error: unknown) => {
      log(`could not sweep sandboxes left by an earlier worker: ${String((error as Error).message ?? error)}`);
      return 0;
    });
    if (stopped > 0) log(`stopped ${stopped} sandbox(es) left behind by an earlier worker`);
  }

  log(`runner up on ${config.executor}: taking work from ${config.planeUrl}`);
  await runDaemon({
    planeUrl: config.planeUrl,
    token: config.token,
    blobRoot: config.blobRoot,
    log,
    execute: engineExecute(config, executor),
  });
}

if (process.argv[1]?.endsWith('runner-main.ts') || process.argv[1]?.endsWith('runner-main.js')) {
  loadEnv();
  main().catch((error: unknown) => {
    console.error(String((error as Error)?.message ?? error));
    process.exitCode = 1;
  });
}
