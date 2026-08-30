// The environment recipe: asked once, replayed forever (ADR-0013).
//
// Every repository boots differently and nothing in a repository reliably says
// how. The union of package manager, migration step, seed data, services, ports
// and what "ready" means has no detector, so this does not detect: an agent drafts
// a recipe once, a human approves it, and it is stored on OUR side keyed by
// repository. Never in the user's codebase — onboarding must not be a pull request
// against someone else's repo before we have delivered anything.
//
// The trust split is the load-bearing part and it is why this file has two halves:
//
//   **The recipe is testimony.** It was drafted by an agent and approved by a human
//   who may have skimmed it. `parse` validates its SHAPE and nothing else; a
//   recipe's commands are arbitrary and we run them knowingly.
//
//   **A service answering its healthcheck is evidence.** `replay` reports what the
//   Runner observed at its own process boundary — a status line from a socket, not
//   a claim from the recipe. `ENV_READY` is emitted for the second, never the first.
//
// A run that never reaches `ENV_READY` ends `errored`, not `not_reproduced`
// (ADR-0007's v1.5 amendment): our infrastructure being wrong about someone's
// project is not a finding about their bug.

import type { Db } from './store.js';
import { redact } from './redact.js';
import type { ToolHost } from './tools.js';

/** One long-lived process the recipe declares, and how to know it came up. */
export type Service = {
  name: string;
  command: string;
  port: number;
  /** A URL the Runner fetches until it answers. Absent, the port opening is the check. */
  healthcheck?: string;
};

export type Recipe = {
  install?: string;
  migrate?: string;
  seed?: string;
  services: Service[];
  /** The project's own test command. Not the reproduction — that is the agent's to write. */
  test?: string;
};

/** Bounds on a stored, human-approved, agent-drafted document. Generous, and finite. */
const MAX_COMMAND_CHARS = 4096;
const MAX_SERVICES = 8;

/**
 * Validate a recipe's shape. Nothing here judges its content.
 *
 * A recipe arrives from Postgres, which means it arrived from a draft an agent
 * wrote. The shape has to be right or `replay` fails in ways that read as the
 * user's project being broken — which is the one presentation ADR-0007's
 * amendment forbids.
 */
export function parseRecipe(input: unknown): Recipe {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('a recipe must be an object');
  }
  const raw = input as Record<string, unknown>;
  const command = (key: string): string | undefined => {
    const value = raw[key];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') throw new Error(`recipe.${key} must be a string`);
    if (value.length > MAX_COMMAND_CHARS) throw new Error(`recipe.${key} is longer than ${MAX_COMMAND_CHARS} characters`);
    return value;
  };

  const services: Service[] = [];
  const declared = raw.services ?? [];
  if (!Array.isArray(declared)) throw new Error('recipe.services must be an array');
  if (declared.length > MAX_SERVICES) throw new Error(`recipe declares more than ${MAX_SERVICES} services`);
  for (const entry of declared) {
    if (typeof entry !== 'object' || entry === null) throw new Error('each service must be an object');
    const service = entry as Record<string, unknown>;
    // A session id, so it has to be usable as one. `shell_create` takes a name and
    // the Runner holds the handle by it (ADR-0014); a duplicate would silently
    // hand two services one handle and leave one of them unreapable.
    if (typeof service.name !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(service.name)) {
      throw new Error('each service needs a lowercase name usable as a session id');
    }
    if (services.some((existing) => existing.name === service.name)) {
      throw new Error(`two services are called ${service.name}`);
    }
    if (typeof service.command !== 'string' || service.command === '') {
      throw new Error(`service ${service.name} needs a command`);
    }
    if (!Number.isInteger(service.port) || (service.port as number) < 1 || (service.port as number) > 65535) {
      throw new Error(`service ${service.name} needs a port`);
    }
    if (service.healthcheck !== undefined && typeof service.healthcheck !== 'string') {
      throw new Error(`service ${service.name} has a healthcheck that is not a URL`);
    }
    services.push({
      name: service.name,
      command: service.command,
      port: service.port as number,
      ...(service.healthcheck === undefined ? {} : { healthcheck: service.healthcheck }),
    });
  }

  return {
    ...(command('install') === undefined ? {} : { install: command('install')! }),
    ...(command('migrate') === undefined ? {} : { migrate: command('migrate')! }),
    ...(command('seed') === undefined ? {} : { seed: command('seed')! }),
    services,
    ...(command('test') === undefined ? {} : { test: command('test')! }),
  };
}

/** Keyed by repository, on our side. `full_name` — the same string GitHub uses. */
export async function saveRecipe(client: Db, repo: string, recipe: Recipe): Promise<void> {
  // `proof = null` on the update path, and it is not tidiness: a proof is about a
  // set of commands, and leaving the old one beside new commands would show a human
  // a green "ready" for an environment nobody has built (8f).
  await client.query(
    `insert into recipes (repo, recipe, approved_at) values ($1, $2, now())
       on conflict (repo) do update set recipe = $2, approved_at = now(), proof = null`,
    [repo, JSON.stringify(recipe)],
  );
}

export async function loadRecipe(client: Db, repo: string): Promise<Recipe | null> {
  const { rows } = await client.query('select recipe from recipes where repo = $1', [repo]);
  return rows.length === 0 ? null : parseRecipe(rows[0].recipe);
}

/**
 * What proving this repository found (8f), stored beside the recipe it is about.
 *
 * The same row on purpose. A proof is an observation about a specific set of
 * commands, so `saveRecipe` overwriting them has to invalidate it — and putting the
 * proof in its own table would make that an invariant somebody has to remember
 * instead of a fact about where the bytes live.
 */
export async function saveProof(client: Db, repo: string, proof: unknown): Promise<void> {
  await client.query('update recipes set proof = $2 where repo = $1', [repo, JSON.stringify(proof)]);
}

/**
 * Read it back, or null. Never parsed into a shape: this is display-only, and a
 * proof written by an older engine must render as what it is rather than throw on
 * a field that did not exist yet.
 */
export async function loadProof(client: Db, repo: string): Promise<unknown> {
  const { rows } = await client.query('select proof from recipes where repo = $1', [repo]);
  return rows.length === 0 ? null : (rows[0].proof ?? null);
}

/** What the Runner observed while standing the environment up. Facts, per service. */
export type ReplayOutcome = {
  /** True only when every declared service answered. `ENV_READY` is emitted for this. */
  ready: boolean;
  steps: { step: string; exit_code: number; output: string }[];
  services: { name: string; port: number; healthcheck?: string; answered: boolean; detail: string }[];
  /** Why setup stopped, when it did. Prose, display-only, bounded by the caller. */
  failed?: string;
};

const STEP_TIMEOUT_MS = 600_000;
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 250;
/** How much of a failing step's output travels with the reason. The end, where the cause is. */
const MAX_FAILURE_CHARS = 1200;

/**
 * Replay a recipe in a container and report what happened.
 *
 * The setup steps and the services all run through `ToolHost`, so a service lives
 * in a **named session the Runner holds a handle to** — which is ADR-0014's part
 * one, and the reason the reap can be demoted to belt-and-braces. Teardown closes
 * handles this process owns; there is nothing to enumerate in `/proc`.
 *
 * Returns rather than throws. A recipe that does not boot is an operational fault
 * to be recorded and presented as one, not an exception that unwinds a run.
 */
export async function replayRecipe(host: ToolHost, recipe: Recipe): Promise<ReplayOutcome> {
  const steps: ReplayOutcome['steps'] = [];
  const services: ReplayOutcome['services'] = [];
  let id = 0;
  const call = (tool: string, input: Record<string, unknown>) => host.run({ id: `setup-${++id}`, tool, input });

  const setup = 'engine-setup';
  const created = await call('shell_create', { name: setup });
  if (!created.ok) return { ready: false, steps, services, failed: created.output };

  // Sequential and fail-closed. A seed that runs before its migration is a
  // half-built world, and a run against a half-built world produces a verdict
  // about nothing.
  for (const step of ['install', 'migrate', 'seed'] as const) {
    const command = recipe[step];
    if (!command) continue;
    const result = await call('shell_write', { name: setup, input: command, timeout_ms: STEP_TIMEOUT_MS });
    const code = Number(/\[exit (-?\d+)\]/.exec(result.output)?.[1] ?? (result.ok ? 0 : -1));
    steps.push({ step, exit_code: code, output: result.output });
    if (!result.ok) {
      // REDACTED, because this string becomes `VERIFICATION_ABORTED.reason` and events are
      // immutable: a recipe carries environment inline (`PORT=8080 node server.mjs`), and
      // failure is exactly when a misconfigured credential appears in one. A secret
      // written here could never be deleted (M6e).
      // WITH THE OUTPUT, not just the command.
      //
      // It said only `recipe step install failed: <command>`, and the reason was sitting
      // in `result.output` two lines above, discarded. Diagnosing one real failure took
      // four separate container runs to rediscover a message the engine had already
      // captured: `corepack enable` needs to write `/usr/local/bin`, which is root, and
      // the agent sandbox runs as uid 1000 by design — so the same recipe succeeds in the
      // environment build and fails in the agent container. Nothing in the abort said so.
      //
      // "An operational failure with no diagnosis is the wrong thing to ship" is this
      // project's own rule about `PhaseResult.stderr`; the recipe path broke it.
      //
      // The tail, because a failure is at the end, and bounded because this becomes an
      // append-only event. `redact` covers it: a recipe carries environment inline, and a
      // failing step is exactly where a misconfigured credential shows up.
      const why = result.output.slice(-MAX_FAILURE_CHARS).trim();
      return {
        ready: false,
        steps,
        services,
        failed: redact(`recipe step ${step} failed: ${command}\n${why}`),
      };
    }
  }

  // One session per service, named after it. Backgrounded inside the session so
  // the tool call returns — the session is what keeps the process alive, and
  // `ToolHost.close()` is what ends it.
  for (const service of recipe.services) {
    const opened = await call('shell_create', { name: service.name });
    if (!opened.ok) {
      return { ready: false, steps, services, failed: `could not open a session for ${service.name}` };
    }
    await call('shell_write', {
      name: service.name,
      input: `${service.command} > /tmp/${service.name}.log 2>&1 &`,
      timeout_ms: 30_000,
    });
  }

  // And only NOW is anything observed. Everything above is testimony replayed;
  // this is the Runner reading a socket at its own process boundary.
  for (const service of recipe.services) {
    const observed = await waitForService(service);
    services.push({
      name: service.name,
      port: service.port,
      ...(service.healthcheck === undefined ? {} : { healthcheck: service.healthcheck }),
      ...observed,
    });
  }

  const missing = services.filter((service) => !service.answered);
  if (missing.length > 0) {
    return {
      ready: false,
      steps,
      services,
      failed: `no answer from ${missing.map((s) => `${s.name}:${s.port}`).join(', ')}`,
    };
  }
  return { ready: true, steps, services };
}

/** Poll one service until it answers, or until the ceiling. Never throws. */
async function waitForService(service: Service): Promise<{ answered: boolean; detail: string }> {
  const until = Date.now() + HEALTH_TIMEOUT_MS;
  let detail = 'never answered';
  while (Date.now() < until) {
    try {
      if (service.healthcheck) {
        const response = await fetch(service.healthcheck, { signal: AbortSignal.timeout(5_000) });
        detail = `HTTP ${response.status}`;
        // A 500 is an answer from a process that is up and broken. That is a real
        // distinction: "the recipe boots the wrong thing" and "the recipe boots
        // nothing" are different operational faults and the log should say which.
        if (response.ok) return { answered: true, detail };
      } else {
        const { connect } = await import('node:net');
        await new Promise<void>((resolve, reject) => {
          const socket = connect(service.port, '127.0.0.1');
          socket.setTimeout(2_000);
          socket.once('connect', () => {
            socket.destroy();
            resolve();
          });
          socket.once('timeout', () => {
            socket.destroy();
            reject(new Error('timed out'));
          });
          socket.once('error', reject);
        });
        return { answered: true, detail: `port ${service.port} accepted a connection` };
      }
    } catch (error) {
      detail = String((error as Error).message ?? error);
    }
    await new Promise((done) => setTimeout(done, HEALTH_INTERVAL_MS));
  }
  return { answered: false, detail };
}
