// Item 2. `allow-all` → `deny-all` on a RUNNING sandbox: probes fail within 5s, no restart,
// a loopback server started before the flip still answers.
//
// The seal is timed with FAST probes and bracketed: `lower` is when the poll that first saw
// both probes fail STARTED, `upper` when it returned. The verdict is on `upper`, the
// conservative bound — a slow probe cannot make an instant seal look fast, only slow.
import { create, sh, FAST_PROBES, PROBES, LOOPBACK_SERVER, LOOPBACK_PROBE, sealedFailure, verdict, record, done, stopQuietly, timed } from './lib.js';

const sandbox = await create({ networkPolicy: 'allow-all' });
try {
  const before = await sh(sandbox, PROBES.dns, { timeoutMs: 30_000 });
  verdict('2.before', before.code === 0 && before.out.startsWith('RESOLVED'), `allow-all resolves: ${before.out}`);
  await sandbox.runCommand({ cmd: 'sh', args: ['-c', LOOPBACK_SERVER], detached: true });
  await new Promise((r) => setTimeout(r, 1500));

  const flipped = performance.now();
  const { ms: flipMs } = await timed(() => sandbox.updateNetworkPolicy('deny-all'));
  record('2', `updateNetworkPolicy took ${Math.round(flipMs)}ms; now ${JSON.stringify(sandbox.networkPolicy)}`);

  let lower: number | null = null;
  let upper: number | null = null;
  let last = '';
  const deadline = flipped + 30_000;
  while (performance.now() < deadline && upper === null) {
    const start = performance.now();
    const dns = await sh(sandbox, FAST_PROBES.dns, { timeoutMs: 10_000 });
    const tcp = await sh(sandbox, FAST_PROBES.tcp, { timeoutMs: 10_000 });
    last = `${dns.out} / ${tcp.out}`;
    if (sealedFailure(dns) && sealedFailure(tcp)) {
      lower = start - flipped;
      upper = performance.now() - flipped;
    } else {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  record('2', upper === null ? `still open 30s after the flip: ${last}` : `sealed between ${Math.round(lower!)}ms and ${Math.round(upper)}ms after the flip: ${last}`);
  verdict('2.sealed-within-5s', upper !== null && upper <= 5000, upper === null ? 'not sealed' : `upper bound ${Math.round(upper)}ms`);
  const loop = await sh(sandbox, LOOPBACK_PROBE, { timeoutMs: 30_000 });
  verdict('2.loopback-survives', loop.code === 0 && loop.out.startsWith('LOOPBACK ok'), loop.out);
  verdict('2.same-session', sandbox.status === 'running', `status ${sandbox.status}`);
} finally {
  await stopQuietly(sandbox);
}
done();
