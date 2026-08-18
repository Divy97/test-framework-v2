// The draft store, against a real database (M6b).
//
// `recipe_drafts` holds advisory testimony from an agent, never a fact about a run, and
// the store's own comment says losing it costs nothing but a re-draft — which is exactly
// why its only test is a round-trip and a delete, the same shape `test/store.test.ts`
// already uses for `recipes`. Without a database this SKIPS, naming the table that is
// missing, rather than failing with a message about a relation nobody has heard of.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type pg from 'pg';
import { clearDraft, loadDraft, saveDraft } from '../src/drafts.js';
import { connect } from '../src/store.js';

let client: pg.Client | null = null;
let why = '';

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    why = 'DATABASE_URL is not set (copy .env.example to .env and `docker compose up -d`)';
    return;
  }
  try {
    const candidate = connect();
    await candidate.connect();
    // The schema, not just the connection — a database with no `recipe_drafts` table
    // would fail every test below with a confusing error instead of skipping by name.
    await candidate.query('select 1 from recipe_drafts limit 1');
    client = candidate;
  } catch (error) {
    why = `no usable database: ${String((error as Error).message ?? error)} — run \`npm run db:schema\``;
  }
});

afterAll(async () => {
  await client?.end();
});

describe('the draft store, against a real database', () => {
  test('round-trips, a re-save overwrites, and clearing removes the row', async () => {
    if (!client) {
      console.log(`SKIPPED (recipe_drafts): ${why}`);
      return;
    }
    const repo = `owner/repo-${randomUUID().slice(0, 8)}`;
    try {
      expect(await loadDraft(client, repo)).toBeNull();

      // `draft` is `unknown` all the way to the row — this is deliberately NOT a shape
      // `parseRecipe` would accept, because nothing here validates it. That is the point:
      // storage must not be the gate.
      const first = { install: 'npm ci', services: [{ name: 'web', command: 'node s.mjs', port: 8080 }] };
      await saveDraft(client, repo, first);
      const stored = await loadDraft(client, repo);
      expect(stored).not.toBeNull();
      expect(stored!.repo).toBe(repo);
      expect(stored!.draft).toEqual(first);
      expect(new Date(stored!.draftedAt).getTime()).toBeGreaterThan(0);

      // Re-drafting is ordinary — an installation can be re-onboarded, or drafted again
      // after a failed one — and there is exactly one draft worth keeping: the latest.
      const second = { install: 'pnpm install', services: [] };
      await saveDraft(client, repo, second);
      expect((await loadDraft(client, repo))!.draft).toEqual(second);

      await clearDraft(client, repo);
      expect(await loadDraft(client, repo)).toBeNull();

      // Clearing a repo with no draft is not an error — the approval path calls this
      // unconditionally and best-effort, and a repository drafted for but never actually
      // proposing anything must not make that call throw.
      await clearDraft(client, repo);
    } finally {
      await client.query('delete from recipe_drafts where repo = $1', [repo]);
    }
  });
});
