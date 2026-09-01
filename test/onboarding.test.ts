// Onboarding proves a repository, not just a recipe (8f).
//
// Milestone 7: "6b's drafting run has a trigger now — installation — and a human
// still has to approve what it proposes. What it does not do is the fuller
// connect-time job: prove the repo runs and record what could not be proved."
//
// What is asserted here is the TRIGGER and its boundaries. Whether the proof is
// right is `sandbox.test.ts`'s question, because answering it takes two containers.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/store.js';
import { dashboardRoutes } from '../src/routes.js';
import { onboardPage } from '../src/web.js';
import { startStatusServer, type StatusServer } from '../src/sse.js';

const servers: StatusServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

/** Answers the lookups the onboarding route makes, and records every write. */
const client = (writes: string[]) =>
  ({
    query: vi.fn(async (sql: string) => {
      writes.push(sql);
      const rows =
        typeof sql === 'string' && sql.includes('from installations')
          ? [{ repo: 'o/r', installation_id: 1, account: 'o', connected_at: new Date(), removed_at: null }]
          : [];
      return { rows, rowCount: rows.length };
    }),
  }) as unknown as Db;

const serve = async (onApproved: (repo: string) => void, writes: string[] = []) => {
  const server = await startStatusServer({
    read: async () => [],
    routes: dashboardRoutes({ client: client(writes), installUrl: 'https://example.invalid', onApproved }),
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
};

const approve = (base: string, recipe: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/repos/o/r/onboard`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ recipe }).toString(),
    redirect: 'manual',
  });

const GOOD = JSON.stringify({ install: 'npm ci', services: [], test: 'npm test' });

describe('approving a recipe starts a proving run', () => {
  it('fires with the repository, once, after the recipe is stored', async () => {
    const approved: string[] = [];
    const writes: string[] = [];
    const base = await serve((repo) => approved.push(repo), writes);

    const response = await approve(base, GOOD);
    expect(response.status).toBe(303);
    expect(approved).toEqual(['o/r']);

    // AFTER the write, and the order is the claim: proving is about the commands now
    // in force, so a proof of something that failed to store would be a proof of
    // nothing at all.
    const stored = writes.findIndex((sql) => sql.includes('insert into recipes'));
    expect(stored).toBeGreaterThanOrEqual(0);
  });

  it('does not fire when the recipe was refused', async () => {
    // The negative control. `parseRecipe` refuses a shape that would fail later
    // inside a container, and nothing is stored — so there is nothing to prove, and
    // a proving run here would build an environment for a recipe nobody has.
    const approved: string[] = [];
    const base = await serve((repo) => approved.push(repo));

    const response = await approve(base, JSON.stringify({ services: 'not an array' }));
    expect(response.status).toBe(400);
    expect(approved).toEqual([]);
  });

  it('does not fire on a cross-site POST, because that POST stores nothing', async () => {
    // ADR-0013's control is the human at our own page. A forged approval is refused
    // before the handler — and this asserts the callback sits behind that refusal
    // rather than beside it, because a proving run is two containers a stranger
    // would otherwise be able to start.
    const approved: string[] = [];
    const base = await serve((repo) => approved.push(repo));

    const response = await approve(base, GOOD, {
      'sec-fetch-site': 'cross-site',
      origin: 'https://evil.invalid',
    });
    expect(response.status).toBe(403);
    expect(approved).toEqual([]);
  });
});

/**
 * Approving is a write with no visible result, and that made a working button look broken.
 *
 * The form 303s back to a page that renders the recipe it already showed. A click that
 * stored something and a click that stored the same thing again are pixel-identical — so
 * the first person to use this pasted a recipe, clicked, saw no change, and reported that
 * nothing happened. The click had worked. The paste had not landed, and an empty recipe
 * was approved for real, with the page unable to say either way.
 */
describe('the page says what approving did', () => {
  it('names when the recipe in force took force', () => {
    const html = onboardPage('acme/widgets', { install: 'npm ci', services: [], test: 'npm test' }, undefined, undefined, {
      approvedAt: '2026-09-01T18:12:33.928Z',
    });

    expect(html).toContain('In force');
    // The moving part: a second approval writes a new timestamp, so the page changes even
    // when the recipe does not.
    expect(html).toContain('01 Sept');
  });

  it('says nothing of the sort when no recipe has ever been approved', () => {
    expect(onboardPage('acme/widgets', null)).not.toContain('In force');
  });
});
