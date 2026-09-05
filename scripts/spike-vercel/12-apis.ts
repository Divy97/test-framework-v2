// Item 12. The APIs the executor will lean on exist: list by tag, snapshot get/delete,
// command re-attach, and what `Sandbox.get` does to a stopped sandbox.
import { Sandbox, Snapshot } from '@vercel/sandbox';
import { creds, TAG, create, sh, verdict, record, done, stopQuietly } from './lib.js';

const sandbox = await create({ networkPolicy: 'deny-all', tags: { ...TAG, item: '12' } });
try {
  const page = await Sandbox.list({ ...creds(), tags: { item: '12' } });
  verdict('12.list-by-tag', page.sandboxes.some((s) => s.name === sandbox.name), `${page.sandboxes.length} listed with item=12`);
  const cmd = await sandbox.runCommand({ cmd: 'sh', args: ['-c', 'echo hello; sleep 2; echo bye'], detached: true });
  const again = await sandbox.getCommand(cmd.cmdId);
  const finished = await again.wait();
  verdict('12.getCommand', finished.exitCode === 0 && (await finished.stdout()).includes('bye'), `re-attached, exit ${finished.exitCode}`);
  await sh(sandbox, 'echo x > /tmp/x');
  const snapshot = await sandbox.snapshot({ expiration: 10 * 60_000 });
  record('12', `snapshot ${snapshot.snapshotId}; sandbox status after snapshot(): ${sandbox.status}`);
  const got = await Snapshot.get({ ...creds(), snapshotId: snapshot.snapshotId });
  record('12', `Snapshot.get → status ${got.status}, ${Math.round(got.sizeBytes / 1024 / 1024)} MB, regions ${got.regions.join(',')}`);
  const listed = await Snapshot.list({ ...creds() });
  verdict('12.snapshot-list', listed.snapshots.some((s) => s.id === snapshot.snapshotId), `${listed.snapshots.length} snapshots listed`);
  await got.delete();
  const after = await Snapshot.get({ ...creds(), snapshotId: snapshot.snapshotId }).then((s) => s.status, (e: Error) => `get after delete threw: ${e.message.slice(0, 60)}`);
  verdict('12.snapshot-delete', after === 'deleted' || String(after).startsWith('get after delete threw'), `status after delete: ${after}`);
} finally {
  if (sandbox.status === 'running') await stopQuietly(sandbox);
}
done();
