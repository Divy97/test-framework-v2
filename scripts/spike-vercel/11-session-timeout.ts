// Item 11. What a session timeout looks like to a detached command's logs() and wait().
//
// The unknown being measured is whether they end at all, so the script bounds itself: five
// minutes after a sixty-second session, whatever has not settled is recorded as hanging and
// the process exits — a live stream would otherwise keep the event loop alive forever.
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
  const ceiling = new Promise<string>((r) => setTimeout(() => r('CEILING'), 5 * 60_000));
  const { value, ms } = await timed(async () => {
    const a = await Promise.race([logs, ceiling]);
    const b = await Promise.race([wait, ceiling]);
    return [a, b];
  });
  const [a, b] = value;
  record('11', `${Math.round(ms)}ms after start (timeout 60s): ${a === 'CEILING' ? 'logs() still hanging at the 5-minute ceiling' : a} | ${b === 'CEILING' ? 'wait() still hanging at the 5-minute ceiling' : b} | sandbox.status=${sandbox.status}`);
} finally {
  await stopQuietly(sandbox);
}
done();
