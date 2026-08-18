// A recipe an agent PROPOSED, before any human has approved it (M6b, ADR-0013).
//
// Current configuration, like `installations` and `recipes`: mutable, keyed by
// repository, and not a fact about a run. Unlike `recipes`, this row is advisory
// testimony — it is never read by anything that executes a command. Only `recipes`,
// populated by a human approving one at `/repos/<repo>/onboard`, is ever replayed.
// Losing this table costs nothing but a re-draft: the agent can always be asked again,
// which is why it gets no more durability than an upsert and a delete.

import type pg from 'pg';

export type Draft = {
  repo: string;
  /** Whatever the drafting agent produced, unvalidated. See `saveDraft`. */
  draft: unknown;
  draftedAt: string;
};

/** `timestamptz` arrives as a JS `Date` from node-postgres; the wire format is ISO. */
const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

/**
 * Store what a drafting agent proposed, replacing whatever was there.
 *
 * An upsert, same as `saveRecipe`: a repository can be re-drafted as often as it is
 * re-installed, and there is exactly one draft worth keeping — the latest — so there is
 * nothing here to append to. `draft` stays `unknown` all the way to the row: this
 * function's job is to hold what the agent said, not to judge it — `parseRecipe` is the
 * gate, and it runs when a human is about to approve, not when this is written.
 */
export async function saveDraft(client: pg.Client, repo: string, draft: unknown): Promise<void> {
  await client.query(
    `insert into recipe_drafts (repo, draft, drafted_at) values ($1, $2, now())
       on conflict (repo) do update set draft = $2, drafted_at = now()`,
    [repo, JSON.stringify(draft)],
  );
}

/** The live draft for a repository, or null. Unvalidated — see `saveDraft`. */
export async function loadDraft(client: pg.Client, repo: string): Promise<Draft | null> {
  const { rows } = await client.query(
    'select repo, draft, drafted_at from recipe_drafts where repo = $1',
    [repo],
  );
  const row = rows[0];
  if (!row) return null;
  return { repo: row.repo, draft: row.draft, draftedAt: iso(row.drafted_at) };
}

/**
 * Remove a draft once it has served its purpose.
 *
 * Called the moment a human approves a recipe (`src/routes.ts`): the draft's only job
 * was to give that human something to start from, and showing it again after approval
 * would read as a second, stale proposal sitting beside the one now actually in force.
 */
export async function clearDraft(client: pg.Client, repo: string): Promise<void> {
  await client.query('delete from recipe_drafts where repo = $1', [repo]);
}
