// Item 9. Cold start: ten from the image, ten from a snapshot — under 10s p50. The time
// includes the first `runCommand`, because a sandbox that exists but cannot yet run is
// not started. Every handle is stopped, including one whose first command threw.
import { Sandbox, Snapshot } from '@vercel/sandbox';
import { creds, REGION, TAG, create, sh, verdict, record, done, stopQuietly, timed, pct, DAY } from './lib.js';

const N = Number(process.env.SPIKE_COLD_N ?? '10');

const once = async (make: () => Promise<Sandbox>): Promise<number | null> => {
  let sandbox: Sandbox | undefined;
  try {
    const { ms } = await timed(async () => {
      sandbox = await make();
      await sandbox.runCommand('true');
    });
    return ms;
  } catch (error) {
    record('9', `attempt failed: ${String((error as Error).message ?? error).slice(0, 120)}`);
    return null;
  } finally {
    await stopQuietly(sandbox);
  }
};

const fromImage: number[] = [];
for (let i = 0; i < N; i += 1) {
  const ms = await once(() => create({ networkPolicy: 'deny-all' }));
  if (ms !== null) fromImage.push(ms);
}
verdict('9.image-p50<10s', fromImage.length > 0 && pct(fromImage, 50) < 10_000, `${fromImage.length}/${N} ok; create+first command p50 ${Math.round(pct(fromImage, 50))}ms p95 ${Math.round(pct(fromImage, 95))}ms`);

let snapshotId: string | undefined;
const seed = await create({ networkPolicy: 'allow-all' });
try {
  await sh(seed, 'echo seeded > "$HOME/seed"');
  snapshotId = (await seed.snapshot({ expiration: DAY })).snapshotId;
  record('9', `seed snapshot ${snapshotId}`);
} finally {
  if (seed.status === 'running') await stopQuietly(seed);
}
const fromSnapshot: number[] = [];
if (snapshotId) {
  for (let i = 0; i < N; i += 1) {
    const ms = await once(() =>
      Sandbox.create({ ...creds(), region: REGION, tags: TAG, persistent: false, timeout: 10 * 60_000, source: { type: 'snapshot', snapshotId: snapshotId! }, networkPolicy: 'deny-all' }),
    );
    if (ms !== null) fromSnapshot.push(ms);
  }
  try {
    await (await Snapshot.get({ ...creds(), snapshotId })).delete();
  } catch {
    record('9', 'seed snapshot not deleted; it expires in an hour');
  }
}
verdict('9.snapshot-p50<10s', fromSnapshot.length > 0 && pct(fromSnapshot, 50) < 10_000, `${fromSnapshot.length}/${N} ok; create+first command p50 ${Math.round(pct(fromSnapshot, 50))}ms p95 ${Math.round(pct(fromSnapshot, 95))}ms`);
done();
