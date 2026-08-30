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

import { ensureBlobRoot } from './blobs.js';
import { runDaemon, type DaemonIo, type DaemonJob } from './daemon.js';
import type { IssueIntake } from './github.js';
import { providerName } from './loop.js';
import { runFromIssue } from './run.js';

export type RunnerConfig = {
  planeUrl: string;
  token: string;
  image: string;
  agentImage: string;
  blobRoot: string;
  loop: { provider?: string; apiKey?: string; model?: string; effort?: string };
};

/** What is missing, and what it costs — the shape `readConfig` in `serve.ts` uses. */
const REQUIRED: Record<string, string> = {
  ENGINE_PLANE_URL: 'there is nothing to take work from',
  ENGINE_RUNNER_TOKEN: 'the plane would answer 401 to every poll; pair this machine first',
  ENGINE_IMAGE: 'the phase containers have no image to run',
  ENGINE_AGENT_IMAGE: 'the agent sandbox has no image to run',
  ENGINE_BLOB_ROOT: 'artifacts would be written somewhere this process does not own',
};

export function readRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const missing = Object.keys(REQUIRED).filter((key) => !env[key]);

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
    image: env.ENGINE_IMAGE!,
    agentImage: env.ENGINE_AGENT_IMAGE!,
    blobRoot: env.ENGINE_BLOB_ROOT!,
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
export function engineExecute(config: RunnerConfig) {
  return async (job: DaemonJob, io: DaemonIo): Promise<void> => {
    await runFromIssue({
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
  log(`runner up: taking work from ${config.planeUrl}`);
  await runDaemon({
    planeUrl: config.planeUrl,
    token: config.token,
    blobRoot: config.blobRoot,
    log,
    execute: engineExecute(config),
  });
}

if (process.argv[1]?.endsWith('runner-main.ts') || process.argv[1]?.endsWith('runner-main.js')) {
  process.loadEnvFile?.('.env');
  main().catch((error: unknown) => {
    console.error(String((error as Error)?.message ?? error));
    process.exitCode = 1;
  });
}
