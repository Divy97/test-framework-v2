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

/** GitHub's page size, and the number the loop stops on. Once, because it is one fact. */
const PER_PAGE = 100;

/**
 * Every repository of an installation is gone, without asking GitHub whether it agrees.
 *
 * For `installation.deleted` only, where GitHub has already told us: the App was
 * uninstalled. Reconciling here would mint a token for an installation that no longer
 * exists, which 404s and throws — so the reconcile path cannot mark an uninstall removed,
 * and for a while it did not. Marked, never deleted: a repository we no longer hold still
 * authored runs.
 */
export async function forgetInstallation(client: Db, installationId: number): Promise<number> {
  const { rowCount } = await client.query(
    'update installations set removed_at = now() where installation_id = $1 and removed_at is null',
    [installationId],
  );
  return rowCount ?? 0;
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
 * THE SWEEP AT THE END IS DESTRUCTIVE, which is what all the refusing is about. Marking a
 * live repository removed makes it vanish from the dashboard and stops its runs, and no
 * later event repairs it — the same permanence this function exists to fix. So anything
 * short of a complete, well-formed answer from GitHub throws instead of reconciling: a
 * partial list swept against would remove whatever it failed to mention.
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

  // Noted BEFORE the walk. Anything recorded after this moment was written by a reconcile
  // that started later and therefore saw a fresher list, so this sweep must not judge it —
  // see the fence in the update below.
  const startedAt = new Date();

  const held: { repo: string; account: string }[] = [];
  let expected: number | null = null;
  // Paginated, because "all repositories" on a real account is not one page. A truncated
  // list here would mark the remainder removed, which is worse than not reconciling.
  for (let page = 1; ; page += 1) {
    const response = await call(`${api}/installation/repositories?per_page=${PER_PAGE}&page=${page}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    });
    // EVERY non-2xx throws, 404 included. A 404 here is not documented for this endpoint
    // and would be an unmodelled status treated as "holds nothing" — the same inversion
    // this function refuses for a 503. When an installation is genuinely gone, GitHub says
    // so with `installation.deleted`, and `forgetInstallation` handles that without asking.
    if (!response.ok) {
      throw new Error(`GitHub would not list installation ${installationId}: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      total_count?: unknown;
      repositories?: { full_name?: unknown; owner?: { login?: unknown } }[];
    };
    // A 200 whose body is not the shape we expect — a gateway's JSON, an API change —
    // would otherwise read as an empty page and sweep every row for this installation.
    if (!Array.isArray(body.repositories)) {
      throw new Error(`GitHub listed installation ${installationId} without a repositories array`);
    }
    if (typeof body.total_count === 'number') expected = body.total_count;
    for (const entry of body.repositories) {
      // A repository GitHub listed but did not name cannot be keyed by, and must not be
      // quietly dropped either: dropping it means sweeping it, for a repository GitHub
      // says is held.
      if (typeof entry.full_name !== 'string') {
        throw new Error(`GitHub listed a repository of installation ${installationId} with no full_name`);
      }
      held.push({
        repo: entry.full_name,
        account: typeof entry.owner?.login === 'string' ? entry.owner.login : entry.full_name.split('/')[0]!,
      });
    }
    if (body.repositories.length < PER_PAGE) break;
  }

  // The walk agreed with the count GitHub gave for it. Offset pagination over a set that
  // changes mid-walk can skip an entry, and a skipped entry is one the sweep removes.
  if (expected !== null && held.length !== expected) {
    throw new Error(`incomplete list for installation ${installationId}: saw ${held.length} of ${expected}`);
  }

  for (const entry of held) {
    await recordInstallation(client, { ...entry, installationId });
  }

  // Anything this installation used to hold and GitHub no longer lists.
  //
  // Fenced on `connected_at < $3`, and that is not belt-and-braces. Deliveries are handled
  // concurrently, so two reconciles for one installation overlap: an older one whose list
  // was fetched before a repository was added would otherwise sweep the row a newer one
  // just wrote. `recordInstallation` stamps `connected_at = now()`, so a row younger than
  // this walk is left alone. It fails toward keeping a row live, which is the direction
  // everything else here fails in too.
  const { rowCount } = await client.query(
    `update installations set removed_at = now()
       where installation_id = $1 and removed_at is null and connected_at < $3
         and not (repo = any($2::text[]))`,
    [installationId, held.map((entry) => entry.repo), startedAt],
  );

  return { held: held.length, removed: rowCount ?? 0 };
}
