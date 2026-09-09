// What the plane does with a delivery (M10): an issue starts nothing; an installation
// still does its job.
//
// Both halves are asserted, because the change is to ONE of them. An `issues` delivery
// used to become a queued run; now it is acknowledged, written to the plane's own log, and
// dropped — runs start from the dashboard, by a person. If the installation half had
// quietly stopped too, onboarding would go deaf and nothing would say so, which is the
// failure this repository keeps finding in itself and keeps refusing.

import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/store.js';
import type { Intake } from '../src/github.js';
import { planeIntake } from '../src/plane-server.js';

/** Records every statement; answers nothing, because nothing here should need an answer. */
const client = (writes: string[]) =>
  ({
    query: vi.fn(async (sql: string) => {
      writes.push(sql);
      return { rows: [], rowCount: 0 };
    }),
  }) as unknown as Db;

const ISSUE: Intake = {
  kind: 'issue',
  repo: 'o/r',
  installationId: 1,
  issueNumber: 41,
  event: { v: 1, source: 'github_issue', thread_ref: 'o/r#41', raw_text: 'The title is misspelled' },
};

describe('what the plane does with a delivery', () => {
  it('an issue delivery is acknowledged, logged, and queues nothing', async () => {
    const writes: string[] = [];
    const lines: string[] = [];
    const mint = vi.fn(async () => 'never-minted');

    await planeIntake({ client: client(writes), mint, log: (line) => lines.push(line) })(ISSUE);

    // Not "no insert into jobs" alone — NO statement. The old gate read the recipe first,
    // and a delivery that is ignored has no business reading anything.
    expect(writes).toHaveLength(0);
    expect(mint).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/o\/r#41: issues delivery ignored — runs start from the dashboard/);
  });

  it('an uninstall still marks the installation removed', async () => {
    const writes: string[] = [];
    await planeIntake({ client: client(writes), mint: vi.fn(async () => 'ghs'), log: () => {} })({
      kind: 'installation',
      action: 'removed',
      scope: 'app',
      installationId: 7,
      account: 'o',
      repos: [],
    });
    expect(writes.some((sql) => sql.includes('update installations set removed_at'))).toBe(true);
  });

  it('a selection change still asks GitHub what the installation covers', async () => {
    // The control for the first test: the ignore is for issues ONLY. An installation
    // delivery is how the plane learns a repository exists at all.
    const writes: string[] = [];
    const mint = vi.fn(async () => 'ghs');
    const asked: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      asked.push(String(input instanceof Request ? input.url : input));
      return Response.json({ total_count: 0, repositories: [] });
    }) as typeof globalThis.fetch;

    await planeIntake({ client: client(writes), mint, log: () => {}, github: { fetch, api: 'http://github.invalid' } })({
      kind: 'installation',
      action: 'added',
      scope: 'repositories',
      installationId: 7,
      account: 'o',
      repos: ['o/r'],
    });

    expect(mint).toHaveBeenCalledWith(7);
    expect(asked[0]).toContain('/installation/repositories');
  });

  // ── the fan-out ceiling (10n) ─────────────────────────────────────────────
  //
  // "One job per repository NAMED IN THIS DELIVERY" was written believing a delivery
  // names a small delta — the comment above it reasons about "somebody adds a second one
  // to the same App". Setting an installation to ALL REPOSITORIES is also a delta, and on
  // a real account GitHub delivered one `installation_repositories.added` naming 176
  // repositories. The loop queued 176 drafting runs in one second: 176 sandboxes, 176
  // clones, 176 agent sessions at roughly thirteen cents each. It was survived only
  // because the model key was over its spend cap that minute.

  const bulk = (count: number): Intake => ({
    kind: 'installation',
    action: 'added',
    scope: 'repositories',
    installationId: 7,
    account: 'o',
    repos: Array.from({ length: count }, (_, n) => `o/r${n}`),
  });

  const reconciling = () => {
    const writes: string[] = [];
    const lines: string[] = [];
    const fetch = (async () => Response.json({ total_count: 0, repositories: [] })) as typeof globalThis.fetch;
    return {
      writes,
      lines,
      intake: planeIntake({
        client: client(writes),
        mint: vi.fn(async () => 'ghs'),
        log: (line) => lines.push(line),
        github: { fetch, api: 'http://github.invalid' },
      }),
    };
  };

  it('queues nothing when one delivery names more repositories than the ceiling', async () => {
    const { writes, lines, intake } = reconciling();
    await intake(bulk(176));

    const said = lines.join('\n');
    // Reconciliation still happened — the table must match GitHub either way, and a
    // deployment that stopped learning which repositories it holds would go deaf. It is
    // the DRAFTING that is declined.
    expect(said).toContain('reconciled to');
    expect(writes.some((sql) => sql.includes('insert into jobs'))).toBe(false);

    expect(said).toContain('176 repositories named');
    expect(said).toContain('queued none');
    // And it says how to get a draft anyway, because declining without a way forward is
    // just a different silence.
    expect(said).toMatch(/reconcile|Open a repository/);
  });

  it('still drafts for a delivery small enough to be one person onboarding', async () => {
    const { writes, lines, intake } = reconciling();
    await intake(bulk(2));

    expect(writes.some((sql) => sql.includes('insert into jobs'))).toBe(true);
    expect(lines.join('\n')).toContain('queued a drafting run');
  });
});
