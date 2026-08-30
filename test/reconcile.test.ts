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
import { forgetInstallation, reconcileInstallation } from '../src/installations.js';

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

  it('refuses a 404 too, rather than reading it as "holds nothing"', async () => {
    // 404 is not documented for this endpoint, and an earlier version treated it as
    // authoritative emptiness — which would sweep an installation on a spurious 404 from
    // a proxy, or on page two after a hundred repositories had already been seen. When an
    // installation is genuinely gone GitHub says so with `installation.deleted`, and that
    // path does not come through here at all.
    const writes: { sql: string; params: unknown[] }[] = [];
    const fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof globalThis.fetch;

    await expect(reconcileInstallation(db(writes), 42, async () => 'ghs_tok', { fetch })).rejects.toThrow(/404/);
    expect(writes).toEqual([]);
  });

  it('throws rather than reconciling against an answer GitHub did not give', async () => {
    // A 5xx read as "no repositories" would mark every row removed and take a working
    // installation offline. Refusing leaves the table exactly as it was.
    const writes: { sql: string; params: unknown[] }[] = [];
    const fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof globalThis.fetch;

    await expect(reconcileInstallation(db(writes), 42, async () => 'ghs_tok', { fetch })).rejects.toThrow(/503/);
    expect(writes).toEqual([]);
  });

  it('refuses a 200 whose body is not the shape it claims', async () => {
    // The dangerous one, because `response.ok` is satisfied. A gateway's JSON or an API
    // change would read as an empty page — and an empty page sweeps every row.
    const writes: { sql: string; params: unknown[] }[] = [];
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ message: 'hello' }) })) as unknown as typeof globalThis.fetch;

    await expect(reconcileInstallation(db(writes), 42, async () => 'ghs_tok', { fetch })).rejects.toThrow(/repositories array/);
    expect(writes).toEqual([]);
  });

  it('refuses a walk that does not add up to the count GitHub gave for it', async () => {
    // Offset pagination over a set that changes mid-walk can skip an entry, and a skipped
    // entry is one the sweep removes.
    const writes: { sql: string; params: unknown[] }[] = [];
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ total_count: 9, repositories: [{ full_name: 'me/a', owner: { login: 'me' } }] }),
    })) as unknown as typeof globalThis.fetch;

    await expect(reconcileInstallation(db(writes), 42, async () => 'ghs_tok', { fetch })).rejects.toThrow(/1 of 9/);
    // Nothing swept, and nothing recorded either: a partial answer is not reconciled from.
    expect(writes.some((w) => w.sql.includes('set removed_at'))).toBe(false);
  });

  it('refuses a repository GitHub listed but did not name', async () => {
    // Dropping it silently means sweeping it — for a repository GitHub says is held.
    const writes: { sql: string; params: unknown[] }[] = [];
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ total_count: 2, repositories: [{ full_name: 'me/a', owner: { login: 'me' } }, { id: 7 }] }),
    })) as unknown as typeof globalThis.fetch;

    await expect(reconcileInstallation(db(writes), 42, async () => 'ghs_tok', { fetch })).rejects.toThrow(/full_name/);
  });

  it('fences the sweep on when the walk started, so an older reconcile cannot undo a newer one', async () => {
    // Deliveries are handled concurrently. Without this, a reconcile whose list was
    // fetched before a repository was added sweeps the row a later one just wrote — the
    // permanent invisibility this function exists to fix, reintroduced as a race.
    const writes: { sql: string; params: unknown[] }[] = [];
    const fetch = vi.fn(async () => page(['me/a'])) as unknown as typeof globalThis.fetch;

    const before = new Date();
    await reconcileInstallation(db(writes), 42, async () => 'ghs_tok', { fetch });

    const sweep = writes.find((w) => w.sql.includes('set removed_at'))!;
    expect(sweep.sql).toContain('connected_at < $3');
    expect((sweep.params[2] as Date).getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});

describe('an uninstall does not ask GitHub about an installation that is gone', () => {
  it('marks every row removed without minting a token', async () => {
    // Minting for a deleted installation 404s and throws, so routing an uninstall through
    // the reconcile marked nothing removed at all — rows stayed live forever.
    const writes: { sql: string; params: unknown[] }[] = [];
    const removed = await forgetInstallation(db(writes), 42);

    expect(removed).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.sql).toContain('set removed_at');
    expect(writes[0]!.params[0]).toBe(42);
  });
});
