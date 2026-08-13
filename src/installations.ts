// Which repositories we are installed on (M6a).
//
// Current configuration, like `recipes` and unlike `events`: mutable, keyed by
// repository, and not a fact about any run. It exists because `installation.id` arrived
// on every delivery and was discarded, so the first thing the product ever learned about
// a repository was an issue — and by then a run had started with `recipe: null`, booted
// nothing, and answered a Tier 3 about a bug that was never shown.
//
// That is worth being precise about, because it is not merely a bad first impression: it
// put a finding about the *user's bug* into an append-only log when the truth was that we
// had never been told how to build their project. ADR-0007's amendment forbids exactly
// that presentation, and the gate could not catch it — the gate judges reproductions, and
// this one is upstream of anything being reproduced.

import type pg from 'pg';

export type Installation = {
  repo: string;
  installationId: number;
  account: string;
  connectedAt: string;
  /** Set when the App was uninstalled or the repository deselected. Never a delete. */
  removedAt: string | null;
};

/** `timestamptz` arrives as a JS `Date` from node-postgres; the wire format is ISO. */
const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

/**
 * Record that we hold a repository, or that we no longer do.
 *
 * An upsert rather than an insert, because re-installing a repository that was previously
 * removed is ordinary and must clear `removed_at` rather than collide. `installation_id`
 * is updated too: uninstalling and reinstalling issues a NEW id, and a stale one mints
 * tokens that 404 with a message that does not say why.
 */
export async function recordInstallation(
  client: pg.Client,
  entry: { repo: string; installationId: number; account: string },
): Promise<void> {
  await client.query(
    `insert into installations (repo, installation_id, account, connected_at, removed_at)
       values ($1, $2, $3, now(), null)
       on conflict (repo) do update
         set installation_id = $2, account = $3, connected_at = now(), removed_at = null`,
    [entry.repo, entry.installationId, entry.account],
  );
}

/**
 * Mark a repository as no longer ours, keeping the row.
 *
 * "We were installed and then removed" and "we have never heard of this repository" are
 * different answers to a delivery arriving, and only one of them is worth a message. A
 * delete would collapse them.
 */
export async function removeInstallation(client: pg.Client, repo: string): Promise<void> {
  await client.query(
    'update installations set removed_at = now() where repo = $1 and removed_at is null',
    [repo],
  );
}

/** The live installation for a repository, or null. Removed rows never come back. */
export async function loadInstallation(client: pg.Client, repo: string): Promise<Installation | null> {
  const { rows } = await client.query(
    `select repo, installation_id, account, connected_at, removed_at
       from installations where repo = $1 and removed_at is null`,
    [repo],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    repo: row.repo,
    // `bigint` would arrive as a string from node-postgres and then be interpolated into
    // a token URL as one; the column is `bigint` for range, so it is mapped here.
    installationId: Number(row.installation_id),
    account: row.account,
    connectedAt: iso(row.connected_at),
    removedAt: row.removed_at === null ? null : iso(row.removed_at),
  };
}

/** Every live installation, newest first. The repository list the dashboard renders. */
export async function listInstallations(client: pg.Client): Promise<Installation[]> {
  const { rows } = await client.query(
    `select repo, installation_id, account, connected_at, removed_at
       from installations where removed_at is null order by connected_at desc`,
  );
  return rows.map((row) => ({
    repo: row.repo,
    installationId: Number(row.installation_id),
    account: row.account,
    connectedAt: iso(row.connected_at),
    removedAt: row.removed_at === null ? null : iso(row.removed_at),
  }));
}
