// Revoke the worker we operate (M10, 10e). The other half of `pair-worker.mts`.
//
// A global runner's token claims ANY installation's job, and then mints that
// installation's GitHub App token, reads its stored secrets, and spends the requester's
// model key. It is the most valuable credential this system issues, and until this script
// existed the only way to withdraw it was SQL typed by hand at three in the morning.
//
//   npx tsx --env-file=.env scripts/unpair-worker.mts            # list them
//   npx tsx --env-file=.env scripts/unpair-worker.mts <runner-id>
//
// Revoking is a timestamp, not a delete: the events that runner wrote are in the log
// forever and a reader asking "who wrote this" deserves a row (see `runners.revoked_at`).

import { revokeRunner } from '../src/plane.js';
import { close, connect, ready } from '../src/store.js';

const id = process.argv[2];
const client = connect();
await ready(client);
try {
  if (!id) {
    const { rows } = await client.query(
      `select id, name, paired_at, revoked_at, last_seen from runners
         where installation_id is null order by paired_at desc`,
    );
    if (rows.length === 0) {
      console.log('No global workers are paired.');
    } else {
      console.log('Global workers (installation_id is null):\n');
      for (const row of rows) {
        const state = row.revoked_at ? `revoked ${row.revoked_at.toISOString()}` : 'ACTIVE';
        const seen = row.last_seen ? row.last_seen.toISOString() : 'never polled';
        console.log(`  ${row.id}  ${state}  last seen ${seen}  ${row.name}`);
      }
      console.log('\nRevoke one with:  npx tsx --env-file=.env scripts/unpair-worker.mts <id>');
    }
  } else if (await revokeRunner(client, id, null)) {
    console.log(`revoked ${id} — it will get 401 on its next poll, and its rows stay in the log.`);
  } else {
    // Deliberately not "no such runner": it may exist and be confined, or already
    // revoked, and telling those apart matters to whoever is trying to stop something.
    console.error(`nothing revoked: ${id} is not an ACTIVE global runner (already revoked, or not global).`);
    process.exit(1);
  }
} finally {
  await close(client);
}
