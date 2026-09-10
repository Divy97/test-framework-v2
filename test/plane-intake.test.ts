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
import { planeDraftRequest, planeIntake } from '../src/plane-server.js';

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

  // ── installing queues nothing (10n) ──────────────────────────────────────
  //
  // This queued one drafting run per repository named in a delivery — a full agent
  // session each, clone and boot and propose. Two things were wrong beyond the cost.
  // `enqueueJob` set no `requestedBy`, so the worker fell back to the OPERATOR's model
  // key for repositories nobody had opened; and the Environment panel offered no way for
  // a person to ask, so the ninety-nine nobody cared about were drafted and the one
  // somebody did care about waited behind them.
  //
  // Measured: switching this installation to *all repositories* fired one delivery naming
  // 176, and the loop queued 176 sessions in a second. A ceiling of five was the first
  // answer and it was a bandage on a wrong default — it capped the blast radius and left
  // the trigger, the billing and the missing button exactly as they were.

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

  it('queues no drafting run, however many repositories a delivery names', async () => {
    for (const count of [1, 2, 176]) {
      const { writes, lines, intake } = reconciling();
      await intake(bulk(count));
      // Reconciliation still happens — the table must match GitHub, and a plane that
      // stopped learning which repositories it holds would go deaf.
      expect(lines.join('\n'), `${count} named`).toContain('reconciled to');
      // Drafting does not. Permission is not an instruction.
      expect(writes.some((sql) => sql.includes('insert into jobs')), `${count} named`).toBe(false);
      expect(lines.join('\n'), `${count} named`).not.toContain('drafting run');
    }
  });
});

// ── the asker pays (10n) ─────────────────────────────────────────────────────
//
// The one line that matters in the draft-request callback is `requestedBy`. Without it
// `/runner/runs/:id/model-key` answers null, the worker falls back to its own
// configuration — the operator's key — and a drafting run somebody asked for is billed to
// whoever runs the service. That is the mistake this milestone removed from the install
// path, and leaving it reachable from the button would have moved it rather than fixed it.
//
// This test exists because deleting that line left all 48 authorization tests green: they
// assert what the ROUTE hands the callback, and nothing had asked what the callback does
// with it.

describe('a requested draft is billed to whoever asked', () => {
  const withInstallation = (writes: { sql: string; params: unknown[] }[]) =>
    ({
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        writes.push({ sql, params });
        if (sql.includes('from installations where repo = $1')) {
          return { rows: [{ repo: 'o/r', installation_id: 7, account: 'o', connected_at: new Date(), removed_at: null }], rowCount: 1 };
        }
        return { rows: [{ run_id: '3f1c9a52-7b0e-4d2f-9c41-8a6e5d0b21c7' }], rowCount: 1 };
      }),
    }) as unknown as Db;

  it('puts the asker on the job row, not a null', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    const lines: string[] = [];
    planeDraftRequest({ client: withInstallation(writes), log: (line) => lines.push(line) })('o/r', 4242);
    // `void`-ed on purpose, so the button answers immediately. Give the write a tick.
    await new Promise((done) => setTimeout(done, 20));

    const insert = writes.find((write) => write.sql.includes('insert into jobs'));
    expect(insert, 'no job was queued').toBeDefined();
    // The asker's GitHub id is IN the row. Not a null, and not the string 'draft' landing
    // in the wrong column — the params are asserted by value.
    expect(insert!.params).toContain(4242);
    expect(insert!.params).toContain('draft');
    expect(insert!.params).toContain('o/r');
    expect(lines.join('\n')).toContain('4242 asked for a recipe');
  });

  it('queues nothing for a repository the plane no longer holds', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        writes.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as Db;
    planeDraftRequest({ client, log: () => {} })('o/gone', 1);
    await new Promise((done) => setTimeout(done, 20));
    expect(writes.some((write) => write.sql.includes('insert into jobs'))).toBe(false);
  });
});
