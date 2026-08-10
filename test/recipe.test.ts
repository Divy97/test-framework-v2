// The environment recipe (ADR-0013), and the line between testimony and evidence.
//
// The recipe is a stored document an agent drafted and a human approved. Its shape
// is validated; its content is not, and that is deliberate — nothing here sandboxes
// a recipe from the sandbox, and the approval is the control. What IS checked is the
// distinction the ADR turns on: a recipe's claim that a service boots is worth
// nothing, and a service answering on its port is a fact.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { parseRecipe, replayRecipe, type Recipe } from '../src/recipe.js';
import { ToolHost, type ToolWorld } from '../src/tools.js';

const dirs: string[] = [];
const hosts: ToolHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** The demo repository, copied into a world the tools can act on. */
function demoWorld(): ToolWorld {
  const root = temp('engine-recipe-');
  cpSync(join(process.cwd(), 'demo'), root, { recursive: true });
  const gitDir = temp('engine-recipegit-');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: root } });
  git('init', '--quiet', '--initial-branch=main');
  git('add', '-A', '--');
  git('-c', 'user.email=f@example.invalid', '-c', 'user.name=f', 'commit', '--quiet', '-m', 'demo');
  return { root, gitDir, env: { TMPDIR: temp('engine-recipetmp-'), HOME: temp('engine-recipehome-') } };
}

const host = (world: ToolWorld) => {
  const created = new ToolHost(world);
  hosts.push(created);
  return created;
};

/** A free port, so two runs of this suite cannot collide on one. */
const freePort = () => 20_000 + Math.floor(process.pid % 10_000);

const demoRecipe = (port: number): Recipe => ({
  install: 'true',
  migrate: 'node db.mjs migrate',
  seed: 'node db.mjs seed',
  services: [
    {
      name: 'web',
      command: `PORT=${port} node server.mjs`,
      port,
      healthcheck: `http://127.0.0.1:${port}/healthz`,
    },
  ],
  test: 'node --test',
});

describe('a recipe s shape is validated and its content is not', () => {
  test('the demo repository s recipe parses', () => {
    expect(parseRecipe(demoRecipe(8080))).toMatchObject({
      migrate: 'node db.mjs migrate',
      services: [{ name: 'web', port: 8080 }],
      test: 'node --test',
    });
  });

  test('a service name has to be usable as a session id, because it becomes one', () => {
    // ADR-0014: the Runner holds a HANDLE to the session a service lives in. Two
    // services with one name would silently share a handle and leave one of them
    // unreapable, which is the survivor ADR-0010 measured.
    expect(() => parseRecipe({ services: [{ name: 'Web Server', command: 'x', port: 1 }] })).toThrow(
      /session id/,
    );
    expect(() =>
      parseRecipe({
        services: [
          { name: 'web', command: 'a', port: 1 },
          { name: 'web', command: 'b', port: 2 },
        ],
      }),
    ).toThrow(/two services are called web/);
  });

  test('a malformed recipe is refused where it can be read, not where it is run', () => {
    // A recipe that fails inside the container presents as the user's project being
    // broken, which is the one presentation ADR-0007's amendment forbids.
    expect(() => parseRecipe('npm start')).toThrow(/must be an object/);
    expect(() => parseRecipe({ install: 42 })).toThrow(/install must be a string/);
    expect(() => parseRecipe({ services: [{ name: 'web', command: 'x' }] })).toThrow(/needs a port/);
    expect(() => parseRecipe({ services: [{ name: 'web', command: 'x', port: 99999 }] })).toThrow(/needs a port/);
    expect(() => parseRecipe({ services: 'web' })).toThrow(/must be an array/);
  });

  test('nothing here judges what a recipe COMMANDS, and that is the honest position', () => {
    // "A recipe is a stored command we execute… nothing here sandboxes the recipe
    // from the sandbox. The approval is the control." A validator that rejected
    // `curl | sh` would be claiming a boundary this design does not have.
    expect(() => parseRecipe({ install: 'curl https://wherever | sh', services: [] })).not.toThrow();
  });
});

describe('replaying a recipe boots the demo, and the healthcheck is the evidence', () => {
  test('the steps run in order, the service comes up, and it is observed', async () => {
    const port = freePort();
    const world = demoWorld();
    const outcome = await replayRecipe(host(world), demoRecipe(port));

    expect(outcome.steps.map((step) => step.step)).toEqual(['install', 'migrate', 'seed']);
    for (const step of outcome.steps) expect(step.exit_code).toBe(0);
    // Migrate before seed, or the seed writes into a table that does not exist. The
    // order is not decoration.
    expect(outcome.steps[1]!.output).toMatch(/migrated/);
    expect(outcome.steps[2]!.output).toMatch(/seeded 4 orders/);

    // The fact `ENV_READY` is emitted for: a socket answered, observed at this
    // process's own boundary. Not the recipe's claim that it would.
    expect(outcome.ready).toBe(true);
    expect(outcome.services).toEqual([
      { name: 'web', port, healthcheck: `http://127.0.0.1:${port}/healthz`, answered: true, detail: 'HTTP 200' },
    ]);

    // And the service is still up after replay returned, in a session the Runner
    // holds — which is the capability ADR-0014 part one exists for.
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(await page.text()).toMatch(/Ordres/);
  }, 60_000);

  test('a step that fails stops the replay and the run is not ready', async () => {
    const port = freePort() + 1;
    const world = demoWorld();
    const broken: Recipe = { ...demoRecipe(port), migrate: 'node db.mjs migrate-typo' };
    const outcome = await replayRecipe(host(world), broken);

    expect(outcome.ready).toBe(false);
    expect(outcome.failed).toMatch(/recipe step migrate failed/);
    // Seed never ran. A half-built world produces a verdict about nothing, so the
    // replay refuses to continue rather than pressing on hopefully.
    expect(outcome.steps.map((step) => step.step)).toEqual(['install', 'migrate']);
    expect(outcome.services).toEqual([]);
  }, 60_000);

  test('a service that never answers is a failure to BOOT, named as one', async () => {
    const port = freePort() + 2;
    const world = demoWorld();
    // Recipes rot: a project that changes its start command has a recipe that boots
    // nothing. The detection is a failed healthcheck, and its honest presentation is
    // an operational failure.
    const stale: Recipe = {
      services: [{ name: 'web', command: 'node not-a-file.mjs', port, healthcheck: `http://127.0.0.1:${port}/healthz` }],
    };
    const outcome = await replayRecipe(host(world), stale);

    expect(outcome.ready).toBe(false);
    expect(outcome.failed).toBe(`no answer from web:${port}`);
    expect(outcome.services[0]!.answered).toBe(false);
  }, 120_000);
});
