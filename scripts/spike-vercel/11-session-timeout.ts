// Item 11. What a session timeout looks like to a detached command's logs() and wait().
import { create, record, done, stopQuietly, timed } from './lib.js';

const sandbox = await create({ networkPolicy: 'deny-all', timeout: 60_000 });
try {
  const cmd = await sandbox.runCommand({ cmd: 'sh', args: ['-c', 'i=0; while true; do i=$((i+1)); echo tick $i; sleep 5; done'], detached: true });
  const logs = (async () => {
    let n = 0;
    try {
      for await (const line of cmd.logs()) if (line.data.includes('tick')) n += 1;
      return `logs() ended cleanly after ${n} ticks`;
    } catch (error) {
      return `logs() threw after ${n} ticks: ${(error as Error).constructor.name} ${String((error as Error).message).slice(0, 120)}`;
    }
  })();
  const wait = (async () => {
    try {
      const finished = await cmd.wait();
      return `wait() resolved exit ${finished.exitCode}`;
    } catch (error) {
      return `wait() threw: ${(error as Error).constructor.name} ${String((error as Error).message).slice(0, 120)}`;
    }
  })();
  const { value, ms } = await timed(() => Promise.all([logs, wait]));
  record('11', `${Math.round(ms)}ms after start (timeout 60s): ${value[0]} | ${value[1]} | sandbox.status=${sandbox.status}`);
} finally {
  await stopQuietly(sandbox);
}
done();
