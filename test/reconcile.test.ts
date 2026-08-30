// The repository list is a CACHE of GitHub's answer, not a ledger of deltas (M9).
//
// `installation_repositories` reports what just changed. Applying deltas is correct only
// if you heard every previous one, and a plane deployed today heard none — every
// repository installed before it existed is invisible, and no future event will name
// them, because they will never be "added" again.
//
// That is not hypothetical. It is what moving from a laptop to a host did: 176 rows out
// of 177, missing precisely the repository the whole demo ran on, with a list that looked
// populated enough that nothing complained.

import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/store.js';
import { reconcileInstallation } from '../src/installations.js';

/** Records every statement, and answers the update with a row count. */
const db = (writes: { sql: string; params: unknown[] }[]) =>
  ({
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      writes.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: sql.includes('set removed_at') ? 1 : 0 };
    }),
  }) as unknown as Db;

const page = (names: string[]) => ({
  ok: true,
  json: async () => ({
    repositories: names.map((full) => ({ full_name: full, owner: { login: full.split('/')[0] } })),
  }),
});

const recorded = (writes: { sql: string; params: unknown[] }[]) =>
  writes.filter((w) => w.sql.includes('insert into installations')).map((w) => w.params[0]);

describe('the repository list is reconciled against GitHub, not accumulated from deltas', () => {
  it('records a repository that was installed before this plane ever ran', async () => {
    // THE case. GitHub holds two; a delta would only ever have mentioned the new one.
    const writes: { sql: string; params: unknown[] }[] = [];
    const fetch = vi.fn(async () => page(['me/installed-long-ago', 'me/added-today'])) as unknown as typeof globalThis.fetch;

    const result = await reconcileInstallation(db(writes), 42, async () => 'ghs_tok', { fetch });

    expect(result.held).toBe(2);
    expect(recorded(writes)).toEqual(['me/installed-long-ago', 'me/added-today']);
  });

  it('marks removed what GitHub no longer lists, scoped to this installation', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    const fetch = vi.fn(async () => page(['me/still-here'])) as unknown as typeof globalThis.fetch;

    await reconcileInstallation(db(writes), 42, async () => 'ghs_tok', { fetch });

    const sweep = writes.find((w) => w.sql.includes('set removed_at'))!;
    // Scoped by installation_id: another installation's rows are not this one's to judge.
    expect(sweep.sql).toContain('installation_id = $1');
    expect(sweep.params[0]).toBe(42);
    expect(sweep.params[1]).toEqual(['me/still-here']);
  });

  it('follows pagination, because a truncated list would mark the rest removed', async () => {
    // The dangerous failure: one page of 100, stop, and mark repositories 101+ removed.
    const writes: { sql: string; params: unknown[] }[] = [];
    const first = Array.from({ length: 100 }, (_, i) => `me/repo-${i}`);
    // The page number is READ, not matched as a substring. `includes('page=1')` was the
    // first attempt and it is true of every URL here, because `per_page=100` contains
    // it — so every page looked like page one, returned a full batch, and paginated
    // until the worker ran out of memory.
    const fetch = vi.fn(async (url: string) =>
      new URL(String(url)).searchParams.get('page') === '1' ? page(first) : page(['me/repo-100']),
    ) as unknown as typeof globalThis.fetch;

    const result = await reconcileInstallation(db(writes), 42, async () => 'ghs_tok', { fetch });

    expect(result.held).toBe(101);
    expect(recorded(writes)).toContain('me/repo-100');
  });

  it('treats a gone installation as holding nothing, because 404 IS the answer', async () => {
    // Uninstalled, or the App deleted. Distinct from an outage: here GitHub told us.
    const writes: { sql: string; params: unknown[] }[] = [];
    const fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof globalThis.fetch;

    const result = await reconcileInstallation(db(writes), 42, async () => 'ghs_tok', { fetch });

    expect(result).toEqual({ held: 0, removed: 1 });
    expect(writes[0]!.sql).toContain('set removed_at');
    expect(writes[0]!.params[0]).toBe(42);
  });

  it('throws rather than reconciling against an answer GitHub did not give', async () => {
    // A 5xx read as "no repositories" would mark every row removed and take a working
    // installation offline. Refusing leaves the table exactly as it was.
    const writes: { sql: string; params: unknown[] }[] = [];
    const fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof globalThis.fetch;

    await expect(reconcileInstallation(db(writes), 42, async () => 'ghs_tok', { fetch })).rejects.toThrow(/503/);
    expect(writes).toEqual([]);
  });
});
