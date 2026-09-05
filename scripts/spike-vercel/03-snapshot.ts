// Item 3. Snapshot after a real install; create from it under deny-all; the tree is there
// and hardlinks work across it (what `restoreEnvironment`'s `cp -al` needs).
import { Sandbox, Snapshot } from '@vercel/sandbox';
import { creds, REGION, TAG, create, sh, PROBES, verdict, record, done, stopQuietly, timed } from './lib.js';

const build = await create({ networkPolicy: 'allow-all', timeout: 20 * 60_000 });
let phase: Sandbox | undefined;
let snapshotId: string | undefined;
try {
  await build.writeFiles([
    {
      path: '/opt/env/repo/package.json',
      content: JSON.stringify({ name: 'spike', private: true, dependencies: { typescript: '5.7.2', vitest: '2.1.8', next: '15.1.0', react: '19.0.0', 'react-dom': '19.0.0' } }),
    },
  ]);
  const install = await sh(build, 'cd /opt/env/repo && npm install --no-audit --no-fund 2>&1 | tail -2 && du -sm node_modules | cut -f1', { timeoutMs: 15 * 60_000 });
  record('3', `npm install: exit ${install.code}, ${Math.round(install.ms)}ms; ${install.out.split('\n').at(-1)} MB`);
  await sh(build, 'echo marker > /opt/env/ignored.txt');

  const snap = await timed(() => build.snapshot({ expiration: 6 * 60 * 60_000 }));
  snapshotId = snap.value.snapshotId;
  record('3', `snapshot() ${Math.round(snap.ms)}ms → ${snapshotId} (build sandbox status now ${build.status})`);

  const made = await timed(() =>
    Sandbox.create({ ...creds(), region: REGION, tags: TAG, persistent: false, timeout: 10 * 60_000, source: { type: 'snapshot', snapshotId: snapshotId! }, networkPolicy: 'deny-all' }),
  );
  phase = made.value;
  verdict('3.create-from-snapshot<15s', made.ms < 15_000, `${Math.round(made.ms)}ms`);
  const present = await sh(phase, 'test -f /opt/env/ignored.txt && test -d /opt/env/repo/node_modules && echo PRESENT');
  verdict('3.tree-present', present.out.includes('PRESENT'), present.out || `exit ${present.code}`);
  const link = await sh(phase, 'mkdir -p /work/clone && cp -al /opt/env/repo/node_modules /work/clone/node_modules && stat -c %h /work/clone/node_modules/typescript/package.json');
  verdict('3.cp-al', link.code === 0 && Number(link.out) >= 2, `link count ${link.out} (exit ${link.code})`);
  const sealed = await sh(phase, PROBES.dns);
  verdict('3.sealed', sealed.code !== 0, sealed.out);
} finally {
  await stopQuietly(phase);
  if (build.status === 'running') await stopQuietly(build);
  if (snapshotId) {
    try {
      const snapshot = await Snapshot.get({ ...creds(), snapshotId });
      record('3', `snapshot ${snapshot.status}, ${Math.round(snapshot.sizeBytes / 1024 / 1024)} MB`);
      await snapshot.delete();
      record('3', 'snapshot deleted');
    } catch (error) {
      record('3', `snapshot delete: ${String((error as Error).message ?? error)} — see item 12`);
    }
  }
}
done();
