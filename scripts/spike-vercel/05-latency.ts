// Item 5. The transport's cost: runCommand round-trips, small writes, and a long-lived
// detached `logs()` stream — gaps, and re-attach after dropping the iterator.
import { create, sh, verdict, record, done, stopQuietly, timed, pct } from './lib.js';

const SECONDS = Number(process.env.SPIKE_STREAM_SECONDS ?? '60');
const sandbox = await create({ networkPolicy: 'deny-all', timeout: 20 * 60_000 });
try {
  const rtts: number[] = [];
  for (let i = 0; i < 50; i += 1) rtts.push((await timed(() => sandbox.runCommand('true'))).ms);
  verdict('5.runCommand-p50<300ms', pct(rtts, 50) < 300, `p50 ${Math.round(pct(rtts, 50))}ms p95 ${Math.round(pct(rtts, 95))}ms`);

  const writes: number[] = [];
  const kb = Buffer.alloc(1024, 'x');
  for (let i = 0; i < 50; i += 1) writes.push((await timed(() => sandbox.writeFiles([{ path: `/work/rpc/in/${i}.json`, content: kb }]))).ms);
  record('5', `writeFiles 1KB p50 ${Math.round(pct(writes, 50))}ms p95 ${Math.round(pct(writes, 95))}ms`);

  // Ten lines a second for SECONDS, detached; consume `logs()` and measure gaps.
  const total = SECONDS * 10;
  const cmd = await sandbox.runCommand({
    cmd: 'sh',
    args: ['-c', `i=0; while [ $i -lt ${total} ]; do i=$((i+1)); echo line $i; sleep 0.1; done; echo END`],
    detached: true,
  });
  let seen = 0;
  let last = performance.now();
  let worstGap = 0;
  const half = Math.floor(total / 2);
  const logs = cmd.logs();
  for await (const line of logs) {
    const now = performance.now();
    worstGap = Math.max(worstGap, now - last);
    last = now;
    if (line.data.includes('line')) seen += 1;
    if (seen >= half) break; // drop the iterator half-way, on purpose
  }
  logs.close();
  record('5', `stream: ${seen} lines before dropping the iterator, worst gap ${Math.round(worstGap)}ms`);

  // Re-attach by id and read the rest.
  const again = await sandbox.getCommand(cmd.cmdId);
  let after = 0;
  let sawEnd = false;
  for await (const line of again.logs()) {
    if (line.data.includes('line')) after += 1;
    if (line.data.includes('END')) {
      sawEnd = true;
      break;
    }
  }
  record('5', `re-attach: ${after} lines (from the start? ${after >= total - 1 ? 'yes — replayed' : after > 0 ? 'partial/continued' : 'nothing'}), END ${sawEnd ? 'seen' : 'not seen'}`);
  verdict('5.stream-no-gap>5s', worstGap < 5000, `worst gap ${Math.round(worstGap)}ms over ${SECONDS}s`);
  verdict('5.reattach', sawEnd, `getCommand(cmdId).logs() reached END: ${sawEnd}`);
  const finished = await again.wait();
  record('5', `exit ${finished.exitCode} after ${finished.durationMs}ms`);
} finally {
  await stopQuietly(sandbox);
}
done();
