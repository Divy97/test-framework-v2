// Item 4. `writeFiles` at 1/10/50/100/250 MB, chunk-and-cat as the fallback, and a real
// git bundle cloned inside. One verdict for transfer — the criterion is "100 MB intact OR
// chunking works" — and one for the clone.
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create, prepare, sh, verdict, record, done, stopQuietly, timed } from './lib.js';

const sandbox = await create({ networkPolicy: 'deny-all', timeout: 20 * 60_000 });
try {
  await prepare(sandbox);
  let largest = 0;
  for (const mb of [1, 10, 50, 100, 250]) {
    const bytes = randomBytes(mb * 1024 * 1024);
    const want = createHash('sha256').update(bytes).digest('hex');
    try {
      const { ms } = await timed(() => sandbox.writeFiles([{ path: `/work/blob-${mb}.bin`, content: bytes }]));
      const got = await sh(sandbox, `sha256sum /work/blob-${mb}.bin | cut -d' ' -f1 && rm /work/blob-${mb}.bin`);
      const ok = got.out.startsWith(want);
      record('4', `${mb} MB: ${Math.round(ms)}ms, ${(mb / (ms / 1000)).toFixed(1)} MB/s, hash ${ok ? 'matches' : 'MISMATCH'}`);
      if (ok) largest = mb;
      else break;
    } catch (error) {
      record('4', `${mb} MB: ${String((error as Error).message ?? error).slice(0, 160)}`);
      break;
    }
  }

  let chunkOk = false;
  try {
    const total = randomBytes(120 * 1024 * 1024);
    const want = createHash('sha256').update(total).digest('hex');
    const chunk = 40 * 1024 * 1024;
    const { ms: chunkMs } = await timed(async () => {
      for (let i = 0; i * chunk < total.length; i += 1) {
        await sandbox.writeFiles([{ path: `/work/part-${String(i).padStart(3, '0')}`, content: total.subarray(i * chunk, (i + 1) * chunk) }]);
      }
    });
    const joined = await sh(sandbox, "cat /work/part-* > /work/joined && rm /work/part-* && sha256sum /work/joined | cut -d' ' -f1");
    chunkOk = joined.out.startsWith(want);
    record('4', `chunk-and-cat, 120 MB in 40 MB parts: ${Math.round(chunkMs)}ms, hash ${chunkOk ? 'matches' : 'MISMATCH'}`);
  } catch (error) {
    record('4', `chunk-and-cat: ${String((error as Error).message ?? error).slice(0, 160)}`);
  }
  verdict('4.transfer', largest >= 100 || chunkOk, `largest single write ${largest} MB; chunking ${chunkOk ? 'works' : 'failed'}`);

  // A real bundle of this repository, cloned the way runner.ts clones from /src.
  try {
    const dir = mkdtempSync(join(tmpdir(), 'spike-bundle-'));
    execFileSync('git', ['bundle', 'create', join(dir, 'src.bundle'), 'HEAD'], { stdio: 'ignore' });
    const bundle = readFileSync(join(dir, 'src.bundle'));
    const { ms: bundleMs } = await timed(() => sandbox.writeFiles([{ path: '/work/src.bundle', content: bundle }]));
    const clone = await sh(sandbox, 'git clone --quiet --no-local -- /work/src.bundle /work/repo && git -C /work/repo rev-parse HEAD', { timeoutMs: 120_000 });
    verdict('4.bundle-clone', clone.code === 0, `${(bundle.length / 1024 / 1024).toFixed(1)} MB bundle in ${Math.round(bundleMs)}ms; clone exit ${clone.code} ${clone.out.slice(0, 12)}`);
  } catch (error) {
    verdict('4.bundle-clone', false, String((error as Error).message ?? error).slice(0, 160));
  }
} finally {
  await stopQuietly(sandbox);
}
done();
