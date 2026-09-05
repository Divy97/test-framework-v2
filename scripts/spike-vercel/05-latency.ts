// Item 5. The transport's cost: runCommand round-trips, small writes, and a long-lived
// detached `logs()` stream — gaps, and re-attach after dropping the iterator.
//
// The criterion says five minutes; `SPIKE_STREAM_SECONDS` defaults to that and the log
// says what was actually measured. Lines are counted with a regex over each chunk, since a
// chunk may carry several.
import { create, prepare, sh, verdict, record, done, stopQuietly, timed, pct } from './lib.js';

const SECONDS = Number(process.env.SPIKE_STREAM_SECONDS ?? '300');
const sandbox = await create({ networkPolicy: 'deny-all', timeout: 20 * 60_000 });
try {
  await prepare(sandbox);
  const rtts: number[] = [];
  for (let i = 0; i < 50; i += 1) rtts.push((await timed(() => sandbox.runCommand('true'))).ms);
  verdict('5.runCommand-p50-p95<300ms', pct(rtts, 50) < 300 && pct(rtts, 95) < 300, `p50 ${Math.round(pct(rtts, 50))}ms p95 ${Math.round(pct(rtts, 95))}ms`);

  const writes: number[] = [];
  const kb = Buffer.alloc(1024, 'x');
  for (let i = 0; i < 50; i += 1) writes.push((await timed(() => sandbox.writeFiles([{ path: `/work/rpc/in/${i}.json`, content: kb }]))).ms);
  record('5', `writeFiles 1KB p50 ${Math.round(pct(writes, 50))}ms p95 ${Math.round(pct(writes, 95))}ms`);

  const total = SECONDS * 10;
  const count = (data: string) => (data.match(/\bline \d+\b/g) ?? []).length;
  const cmd = await sandbox.runCommand({
    cmd: 'sh',
    args: ['-c', `i=0; while [ $i -lt ${total} ]; do i=$((i+1)); echo line $i; sleep 0.1; done; echo END`],
    detached: true,
  });
  const streamStart = performance.now();
  let seen = 0;
  let last = performance.now();
  let worstGap = 0;
  const half = Math.floor(total / 2);
  const logs = cmd.logs();
  for await (const line of logs) {
    const now = performance.now();
    worstGap = Math.max(worstGap, now - last);
    last = now;
    seen += count(line.data);
    if (seen >= half) break; // drop the iterator half-way, on purpose
  }
  logs.close();
  const measured = (performance.now() - streamStart) / 1000;
  record('5', `stream: ${seen} lines over ${measured.toFixed(0)}s before dropping the iterator (half of ${total}), worst gap ${Math.round(worstGap)}ms`);

  const again = await sandbox.getCommand(cmd.cmdId);
  let after = 0;
  let sawEnd = false;
  for await (const line of again.logs()) {
    after += count(line.data);
    if (line.data.includes('END')) {
      sawEnd = true;
      break;
    }
  }
  const shape = after >= total - 1 ? 'replayed from the start' : after > 0 ? 'continued (partial)' : 'nothing';
  record('5', `re-attach via getCommand(cmdId).logs(): ${after} lines → ${shape}; END ${sawEnd ? 'seen' : 'not seen'}`);
  verdict('5.stream-no-gap>5s', worstGap < 5000, `worst gap ${Math.round(worstGap)}ms over ${measured.toFixed(0)}s`);
  verdict('5.reattach', sawEnd, `reached END after re-attach: ${sawEnd}`);
  const finished = await again.wait();
  record('5', `exit ${finished.exitCode} after ${finished.durationMs}ms`);
} finally {
  await stopQuietly(sandbox);
}
done();
