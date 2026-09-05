// Item 8. `stop()` reports plausible active-CPU and transfer numbers after a known burn.
import { create, sh, verdict, record, done, stopQuietly } from './lib.js';

const sandbox = await create({ networkPolicy: 'deny-all' });
let stopped = false;
try {
  const burn = await sh(sandbox, `node -e "const t=Date.now();while(Date.now()-t<15000){}console.log('burned')"`, { timeoutMs: 60_000 });
  record('8', `burn: ${burn.out} in ${Math.round(burn.ms)}ms`);
  const result = await sandbox.stop();
  stopped = true;
  // `stop()` returns the session's metadata, where the field is `activeCpuDurationMs`; the
  // sandbox object exposes the same number as `activeCpuUsageMs`. Both are recorded, so a
  // disagreement between them shows up here rather than in the executor.
  const cpu = result.activeCpuDurationMs ?? sandbox.activeCpuUsageMs;
  record('8', `stop(): activeCpuDurationMs=${result.activeCpuDurationMs} sandbox.activeCpuUsageMs=${sandbox.activeCpuUsageMs} networkTransfer=${JSON.stringify(result.networkTransfer ?? sandbox.networkTransfer)} duration=${result.duration}`);
  verdict('8.cpu-plausible', typeof cpu === 'number' && cpu >= 10_000 && cpu <= 60_000, `${cpu}ms for a 15s burn`);
} catch (error) {
  verdict('8.cpu-plausible', false, String((error as Error).message ?? error).slice(0, 160));
} finally {
  if (!stopped) await stopQuietly(sandbox);
}
done();
