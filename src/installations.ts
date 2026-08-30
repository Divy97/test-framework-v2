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

import type { Db } from './store.js';

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
  client: Db,
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
export async function removeInstallation(client: Db, repo: string): Promise<void> {
  await client.query(
    'update installations set removed_at = now() where repo = $1 and removed_at is null',
    [repo],
  );
}

/** The live installation for a repository, or null. Removed rows never come back. */
export async function loadInstallation(client: Db, repo: string): Promise<Installation | null> {
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
export async function listInstallations(client: Db): Promise<Installation[]> {
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

/**
 * Ask GitHub what this installation actually covers, and make the table say that.
 *
 * `installation_repositories` reports a DELTA — the repositories just added or just
 * removed — and a delta is only enough if you heard every previous one. A plane deployed
 * today did not. Every repository installed before it existed is invisible to it, and no
 * future event will mention them, because they will never be "added" again.
 *
 * That is not a hypothetical. Moving from a laptop to a host is exactly this: a fresh
 * database, an App that has been installed for months, and a repository list that stays
 * wrong forever. It cost an evening to find, and the cost was hidden — the table looked
 * populated, with 176 of 177 rows.
 *
 * So the delta is not trusted. GitHub is asked for the whole list and the table is made
 * to match it: anything present is recorded, anything absent is marked removed. Marked,
 * never deleted — a repository we no longer hold still authored runs, and a reader asking
 * about one deserves an answer.
 *
 * Scoped to ONE installation. Another installation's rows are not this one's to judge.
 */
export async function reconcileInstallation(
  client: Db,
  installationId: number,
  mintToken: (installationId: number) => Promise<string>,
  options: { fetch?: typeof fetch; api?: string } = {},
): Promise<{ held: number; removed: number }> {
  const call = options.fetch ?? fetch;
  const api = options.api ?? 'https://api.github.com';
  const token = await mintToken(installationId);

  const held: { repo: string; account: string }[] = [];
  // Paginated, because "all repositories" on a real account is not one page. A truncated
  // list here would mark the remainder removed, which is worse than not reconciling.
  for (let page = 1; ; page += 1) {
    const response = await call(`${api}/installation/repositories?per_page=100&page=${page}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    });
    // 404 is not a failure to answer, it IS the answer: this installation is gone —
    // uninstalled, or its App deleted — so nothing is held any more. Reconciling to
    // empty is correct here and only here; every other bad status is a GitHub we could
    // not reach, and treating THAT as "holds nothing" would mark a working installation
    // removed during an outage.
    if (response.status === 404) {
      const { rowCount } = await client.query(
        'update installations set removed_at = now() where installation_id = $1 and removed_at is null',
        [installationId],
      );
      return { held: 0, removed: rowCount ?? 0 };
    }
    if (!response.ok) {
      throw new Error(`GitHub would not list installation ${installationId}: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      repositories?: { full_name?: unknown; owner?: { login?: unknown } }[];
    };
    const batch = body.repositories ?? [];
    for (const entry of batch) {
      if (typeof entry.full_name !== 'string') continue;
      held.push({
        repo: entry.full_name,
        account: typeof entry.owner?.login === 'string' ? entry.owner.login : entry.full_name.split('/')[0]!,
      });
    }
    if (batch.length < 100) break;
  }

  for (const entry of held) {
    await recordInstallation(client, { ...entry, installationId });
  }

  // Anything this installation used to hold and GitHub no longer lists. `= any($2)` with
  // an empty array is a valid empty set, so an installation reduced to nothing still
  // marks its old rows removed rather than silently keeping them.
  const { rowCount } = await client.query(
    `update installations set removed_at = now()
       where installation_id = $1 and removed_at is null and not (repo = any($2::text[]))`,
    [installationId, held.map((entry) => entry.repo)],
  );

  return { held: held.length, removed: rowCount ?? 0 };
}
