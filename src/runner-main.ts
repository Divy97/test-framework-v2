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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureBlobRoot } from './blobs.js';
import { runDaemon, type DaemonIo, type DaemonJob } from './daemon.js';
import { cloneRepository, repoUrl, type IssueIntake } from './github.js';
import { providerName } from './loop.js';
import { draftRecipe, proveRepository, type RunPlan } from './orchestrate.js';
import { runFromIssue } from './run.js';
import { loadEnv } from './store.js';
import type { ComputeRow } from './readmodel.js';

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
  /** The longest sandbox session this plan permits. Absent, the executor's Hobby-safe default. */
  maxSessionMs?: number;
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
      // A plan's ceiling, not a preference. Absent, the executor uses the Hobby limit,
      // which is the value that cannot be refused at create time.
      ...(env.ENGINE_VERCEL_MAX_SESSION_MS === undefined
        ? {}
        : { maxSessionMs: Number(env.ENGINE_VERCEL_MAX_SESSION_MS) }),
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
/**
 * What the sandboxes of one run cost, held until the job that made them is over.
 *
 * The executor is built ONCE per worker — it owns the ledger of machines this process
 * created — but `onCompute` fires per sandbox, mid-run, and the plane will only take a
 * bill for a run this runner still holds. So the numbers are kept here, keyed by run,
 * and `engineExecute` drains them at the end of the job that produced them.
 *
 * Drained rather than accumulated: a worker takes jobs forever, and a map that only ever
 * grows is a leak with a very slow fuse.
 *
 * TYPED WITH THE ROW THE DATABASE TAKES, not `unknown[]`. As `unknown[]` the shape written
 * here and the shape `saveCompute` inserts were two claims nobody compared: renaming this
 * end's `sandbox_id` to `sandboxId` typechecks, passes every test, and in production every
 * insert fails a NOT NULL constraint — which the route swallows, the daemon does not log,
 * and the page reports as an empty table forever. The same shape of defect as the
 * `sandboxId` the SDK never had, and the same one-line fix: let the compiler compare them.
 */
export type ComputeLog = Map<string, Omit<ComputeRow, 'run_id'>[]>;

export async function executorFor(
  config: RunnerConfig,
  spent?: ComputeLog,
): Promise<(RunPlan['executor'] & { sweep?: () => Promise<number> }) | undefined> {
  if (config.executor !== 'vercel') return undefined;
  const { vercelClient } = await import('./vercel-client.js');
  const { vercelExecutor } = await import('./executor-vercel.js');
  return vercelExecutor({
    client: await vercelClient({ credentials: config.vercel!.credentials, region: config.vercel!.region }),
    ...(config.vercel!.maxSessionMs === undefined ? {} : { maxSessionMs: config.vercel!.maxSessionMs }),
    ledger: { path: join(config.blobRoot, '..', 'sandboxes.jsonl') },
    // THE MACHINE, not the token and not the app.
    //
    // This was `config.token.slice(-12)`, which is wrong twice. `ENGINE_RUNNER_TOKEN` is a
    // Fly APP secret, so every machine in the app holds the same value — two machines
    // during a rolling deploy would share a tag, and `sweep()` stops everything the tag
    // matches, which is precisely the outage the tag exists to prevent. And it exported
    // ~72 bits of a 256-bit bearer credential into sandbox metadata, where it shows in
    // listings and logs.
    //
    // `FLY_MACHINE_ID` is injected by the platform, is per-machine, is stable across
    // restarts, and is not a secret — exactly what this needs. The fallback is for a
    // developer running the worker outside Fly, where the pid is per-process and the
    // sweep's ledger half carries the rest.
    tags: {
      engine: 'test-framework-v2',
      worker: process.env.FLY_MACHINE_ID ?? `local-${process.pid}`,
    },
    ...(spent === undefined
      ? {}
      : {
          onCompute: (compute) => {
            const { runId, phase, sandboxId, ...measured } = compute;
            // `sandbox_id` and not `phase` is what makes a row unique: a run creates two
            // agent sandboxes, and keying on the phase would keep the second and lose the
            // first without saying so.
            spent.set(runId, [
              ...(spent.get(runId) ?? []),
              {
                sandbox_id: sandboxId,
                phase,
                active_cpu_ms: measured.activeCpuMs ?? null,
                duration_ms: measured.durationMs ?? null,
                ingress_bytes: measured.ingressBytes ?? null,
                egress_bytes: measured.egressBytes ?? null,
              },
            ]);
          },
        }),
  });
}

/**
 * A `prove` or a `draft` job: clone, run the thing, send the answer to the plane (10h).
 *
 * Deliberately NOT a run. Neither of these writes an event, and that is the whole reason
 * they are separate: a proof is a fact about whether this engine can run somebody's project
 * and a draft is an agent's proposal nobody has approved — putting either in an append-only
 * log about a user's bug is what `readmodel.ts` explains this project does not do
 * (ADR-0006). So there is no `RUN_REQUESTED`, no fold, and nothing on the run list.
 *
 * The clone is the worker's, using a token the plane mints per job. The recipe travels with
 * the dispatch (`runner-api.ts` reads it fresh), so a `prove` job proves what is approved
 * NOW rather than what was approved when the job was queued.
 *
 * A failure here is logged and rethrown to the daemon, which leaves the job open for a
 * re-dispatch — a proving run that could not start must never look like an approval that
 * did not take, and the recipe is stored either way.
 */
async function onboardingJob(
  config: RunnerConfig,
  job: DaemonJob,
  io: DaemonIo,
  executor?: RunPlan['executor'],
): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), `engine-${job.kind}-`));
  try {
    const source = join(workspace, 'source');
    // The token, per job, from the plane — there is no App key on this machine (ADR-0012).
    await cloneRepository(repoUrl(job.repo), source, await io.token());

    if (job.kind === 'prove') {
      // A recipe is what there is to prove. Absent means it was withdrawn between the
      // approval that queued this and now, which is not a failure — there is nothing to
      // prove and nobody to tell.
      if (!job.recipe) return;
      const proof = await proveRepository({
        runId: job.runId,
        repoPath: source,
        image: config.image,
        recipe: job.recipe,
        ...(executor ? { executor } : {}),
      });
      await io.finding({ proof });
      return;
    }

    const outcome = await draftRecipe({
      runId: job.runId,
      repoPath: source,
      image: config.image,
      agentImage: config.agentImage,
      loop: config.loop,
      ...(executor ? { executor } : {}),
    });
    // A drafting session that produced nothing is an ordinary outcome — the agent explored
    // and had nothing it was willing to propose — and storing an empty draft would put a
    // box in front of a human that says an agent filled it in.
    if (!outcome.ok) return;
    await io.finding({ draft: outcome.draft });
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

export function engineExecute(config: RunnerConfig, executor?: RunPlan['executor'], spent?: ComputeLog) {
  return async (job: DaemonJob, io: DaemonIo): Promise<void> => {
    // ── THREE KINDS OF WORK, ONE WORKER (10h) ───────────────────────────────────────
    //
    // Dispatched here rather than in `runDaemon`, because the two new kinds need exactly
    // what this function already has: a config, an executor, and an `io` that can mint a
    // token and send a result home. `kind` defaults to `run` in the database, so a job
    // queued before 10h — and every test that queues one without saying — takes the path
    // below unchanged.
    //
    // Why they are jobs at all: the plane holds no model key and starts no containers
    // (ADR-0011, ADR-0019), so approving a recipe there proved nothing and installing the
    // App drafted nothing, while both worked on a laptop where `serve.ts` has Docker. The
    // asymmetry was invisible because the only deployment anybody onboarded against was
    // the laptop.
    if (job.kind === 'prove' || job.kind === 'draft') {
      await onboardingJob(config, job, io, executor);
      return;
    }

    // `try/finally` so a run that ended badly still reports what it burned getting there.
    // A failed run is the one whose cost is most worth knowing.
    // ── THE STORED VALUES, ONCE PER RUN (10l, ADR-0017) ─────────────────────────────
    //
    // Fetched here rather than per phase, because every phase of a run belongs to one
    // repository and asking six times would put a credential on the wire six times for one
    // answer. Held in this scope for the length of the run and offered to sandboxes;
    // `mayInject` in `executor.ts` decides which of them may have it, and this file
    // deliberately does not — the only party that knows whether a sandbox has a route out
    // is the one that probed it.
    //
    // `null` means this deployment does not inject. It is passed through as `null` rather
    // than flattened to `{}`, because `runFromIssue` uses the DIFFERENCE to decide whether a
    // recipe's `required` names can be satisfied at all.
    const stored = await io.secrets();

    let result: Awaited<ReturnType<typeof runFromIssue>> | undefined;
    try {
      result = await runFromIssue({
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
        // NAMES for the gate, VALUES for the injection, and they travel separately on
        // purpose: `secretNames` reaches `missingRequired`, which decides whether the run
        // happens, and is safe to log. `secrets` reaches the executor and is not.
        secretsInjected: stored !== null,
        ...(stored === null ? {} : { secretNames: Object.keys(stored), secrets: stored }),
      });
    } finally {
      // The model and the machines, in one call, whatever happened above.
      //
      // Until 10f this return value was discarded: `saveUsage` had exactly one caller,
      // `serve.ts`, so every run a WORKER drove lost what it spent. The dashboard's usage
      // table was empty for hosted runs and nobody had noticed, because the only runs
      // anyone read closely were local ones.
      const compute = spent?.get(job.runId) ?? [];
      // CLEARED, not just deleted. A worker runs one job at a time — `runDaemon` awaits
      // `execute` before claiming again — so anything left under another key was written
      // when `plan.runId` and `job.runId` disagreed. They cannot today, because
      // `engineExecute` passes `job.runId` in and `run.ts` uses what it is given; if that
      // ever changed, `delete` alone would leak those rows forever under a uuid nobody
      // holds. Dropping them loses a number; keeping them grows without bound.
      spent?.clear();
      await io.cost({
        // `n` counts phases of the same NAME, so the repro agent and the fix agent get 0
        // and 1 rather than one row overwriting the other.
        usage: (result?.usage ?? []).map(({ phase, usage }, index, all) => ({
          phase,
          n: all.slice(0, index).filter((one) => one.phase === phase).length,
          turns: usage.turns,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          provider: config.loop.provider ?? 'openrouter',
          model: config.loop.model ?? '',
        })),
        compute,
      });
    }
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
  const spent: ComputeLog = new Map();
  const executor = await executorFor(config, spent);

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
    execute: engineExecute(config, executor, spent),
  });
}

if (process.argv[1]?.endsWith('runner-main.ts') || process.argv[1]?.endsWith('runner-main.js')) {
  loadEnv();
  main().catch((error: unknown) => {
    console.error(String((error as Error)?.message ?? error));
    process.exitCode = 1;
  });
}
