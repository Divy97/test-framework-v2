// Item 8. `stop()` reports plausible active-CPU and transfer numbers after a known burn.
import { create, sh, verdict, record, done } from './lib.js';

const sandbox = await create({ networkPolicy: 'deny-all' });
const burn = await sh(sandbox, `node -e "const t=Date.now();while(Date.now()-t<15000){}console.log('burned')"`, { timeoutMs: 60_000 });
record('8', `burn: ${burn.out} in ${Math.round(burn.ms)}ms`);
const stopped = await sandbox.stop();
// `stop()` returns the session's metadata, where the field is `activeCpuDurationMs`; the
// sandbox object exposes the same number as `activeCpuUsageMs`. Both are recorded, so a
// disagreement between them shows up here rather than in the executor.
const cpu = stopped.activeCpuDurationMs ?? sandbox.activeCpuUsageMs;
record('8', `stop(): activeCpuDurationMs=${stopped.activeCpuDurationMs} sandbox.activeCpuUsageMs=${sandbox.activeCpuUsageMs} networkTransfer=${JSON.stringify(stopped.networkTransfer ?? sandbox.networkTransfer)} duration=${stopped.duration}`);
verdict('8.cpu-plausible', typeof cpu === 'number' && cpu >= 10_000 && cpu <= 60_000, `${cpu}ms for a 15s burn`);
done();
