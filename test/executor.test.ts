// The seam between the orchestrator and where a phase runs (M10, ADR-0021).
//
// A seam is only a seam if nothing above it reaches around. The container code was
// lifted out of `orchestrate.ts` verbatim; what this file pins is that it STAYS out —
// a later change that spawns a container from the orchestrator would compile, pass
// every Docker-gated test, and quietly make the second executor a lie.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { dockerExecutor } from '../src/executor-docker.js';

describe('the orchestrator does not know what Docker is', () => {
  test('orchestrate.ts names no docker executable, and the Docker executor does', () => {
    // Over the CODE, not the prose: the file's comments are the record of six review
    // rounds about containers and may say "docker" — quoted or not — as often as they
    // like. What must not appear is a process-spawning call whose first argument is the
    // executable, which is the only way to start one.
    const spawnsDocker = /\b(spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*['"`]docker['"`]/;
    const orchestrate = readFileSync(join(process.cwd(), 'src/orchestrate.ts'), 'utf8');
    const docker = readFileSync(join(process.cwd(), 'src/executor-docker.ts'), 'utf8');
    expect(orchestrate).not.toMatch(spawnsDocker);
    // And the control: the thing that was removed exists where it was moved to, in
    // both of its shapes — the phase container and the committed environment.
    expect(docker).toMatch(/spawn\(\s*'docker'/);
    expect(docker).toMatch(/execFile\('docker', \['commit'/);
  });

  test('the default executor is Docker, by name', () => {
    expect(dockerExecutor().kind).toBe('docker');
  });
});
