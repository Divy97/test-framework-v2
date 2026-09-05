// The plane's answer to "may you tail this run" (M10), against the fake `Db` the other
// authorization tests use.
//
// `test/sse.test.ts` proves the server honours a verdict. This proves the plane computes
// the right one — and computes it from `jobs`, which exists from the moment Start was
// pressed, rather than from the projection, which exists from the first event a worker
// appends minutes later. The first draft read the projection, and a page that opened the
// tail right after its own 202 would have been told the run did not exist.

import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/store.js';
import type { Session } from '../src/auth.js';
import { tailAuthorizer } from '../src/plane-server.js';

const SESSION: Session = { id: 's', githubId: 1, login: 'divy97', avatarUrl: '', token: 'ghu' };
// Run ids with NO entropy, and deliberately so. A realistic uuid here reads to a secret
// scanner as a "generic high entropy secret" — this repository's first GitGuardian failure
// was exactly that, on a literal in a test — and a scanner that cries wolf on our own
// fixtures is one people learn to click past. These are valid v4 shapes, so the
// authorizer's own uuid check still sees them as run ids, and no machine mistakes them for
// a credential.
const MINE = '11111111-1111-4111-8111-111111111111';
const THEIRS = '22222222-2222-4222-8222-222222222222';

/** Two queued jobs: mine under installation 1, theirs under 2. Records every query. */
const client = (queries: string[] = []) =>
  ({
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push(sql);
      const rows =
        sql.includes('from jobs') && params[0] === MINE
          ? [{ installation_id: '1' }]
          : sql.includes('from jobs') && params[0] === THEIRS
            ? [{ installation_id: '2' }]
            : [];
      return { rows, rowCount: rows.length };
    }),
  }) as unknown as Db;

const authorize = (options: { session?: Session | null; installations?: number[]; queries?: string[] } = {}) =>
  tailAuthorizer({
    client: client(options.queries),
    session: async () => (options.session === undefined ? SESSION : options.session),
    installations: async () => options.installations ?? [1],
  });

describe('the tail is authorized from the job, not the projection', () => {
  it('nobody is anonymous, and the database is never asked', async () => {
    const queries: string[] = [];
    expect(await authorize({ session: null, queries })(MINE, {})).toBe('anonymous');
    expect(queries).toHaveLength(0);
  });

  it('a run dispatched under an installation you may see is yours', async () => {
    expect(await authorize()(MINE, {})).toBe('ok');
  });

  it('one dispatched under another installation is not, with the same word an unknown run gets', async () => {
    expect(await authorize()(THEIRS, {})).toBe('forbidden');
    expect(await authorize()('33333333-3333-4333-8333-333333333333', {})).toBe('forbidden');
  });

  it('a GitHub that will not answer denies rather than admits', async () => {
    // `installationsFor` returns `[]` on any failure. An outage must not become a stream
    // of somebody's evidence.
    expect(await authorize({ installations: [] })(MINE, {})).toBe('forbidden');
  });

  it('a run id that is not a uuid is refused before the database sees it', async () => {
    // Postgres will not compare a `uuid` column with `somebody-elses-run`; it throws, and
    // that would have been a 500 where the run's own page gives a 404.
    const queries: string[] = [];
    expect(await authorize({ queries })('somebody-elses-run', {})).toBe('forbidden');
    expect(queries).toHaveLength(0);
  });
});
