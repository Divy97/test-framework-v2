// Item 9. Cold start: ten from the image, ten from a snapshot — under 10s p50.
import { Sandbox, Snapshot } from '@vercel/sandbox';
import { creds, REGION, TAG, create, sh, verdict, record, done, stopQuietly, timed, pct } from './lib.js';

const N = Number(process.env.SPIKE_COLD_N ?? '10');
const fromImage: number[] = [];
for (let i = 0; i < N; i += 1) {
  const { value: sandbox, ms } = await timed(async () => {
    const created = await create({ networkPolicy: 'deny-all' });
    await created.runCommand('true');
    return created;
  });
  fromImage.push(ms);
  await stopQuietly(sandbox);
}
verdict('9.image-p50<10s', pct(fromImage, 50) < 10_000, `create+first command: p50 ${Math.round(pct(fromImage, 50))}ms p95 ${Math.round(pct(fromImage, 95))}ms`);

const seed = await create({ networkPolicy: 'allow-all' });
await sh(seed, 'echo seeded > /opt/seed');
const snapshot = await seed.snapshot({ expiration: 60 * 60_000 });
record('9', `seed snapshot ${snapshot.snapshotId}`);
const fromSnapshot: number[] = [];
for (let i = 0; i < N; i += 1) {
  const { value: sandbox, ms } = await timed(async () => {
    const created = await Sandbox.create({ ...creds(), region: REGION, tags: TAG, persistent: false, timeout: 10 * 60_000, source: { type: 'snapshot', snapshotId: snapshot.snapshotId }, networkPolicy: 'deny-all' });
    await created.runCommand('true');
    return created;
  });
  fromSnapshot.push(ms);
  await stopQuietly(sandbox);
}
verdict('9.snapshot-p50<10s', pct(fromSnapshot, 50) < 10_000, `create+first command: p50 ${Math.round(pct(fromSnapshot, 50))}ms p95 ${Math.round(pct(fromSnapshot, 95))}ms`);
await (await Snapshot.get({ ...creds(), snapshotId: snapshot.snapshotId })).delete().catch(() => record('9', 'seed snapshot not deleted; it expires in an hour'));
done();
