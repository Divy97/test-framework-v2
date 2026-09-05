// Item 2. `allow-all` → `deny-all` on a RUNNING sandbox: probes fail within 5s, no restart,
// a loopback server started before the flip still answers.
import { create, sh, PROBES, LOOPBACK_SERVER, LOOPBACK_PROBE, verdict, record, done, stopQuietly, timed } from './lib.js';

const sandbox = await create({ networkPolicy: 'allow-all' });
try {
  const before = await sh(sandbox, PROBES.dns);
  verdict('2.before', before.code === 0, `allow-all resolves: ${before.out}`);
  await sandbox.runCommand({ cmd: 'sh', args: ['-c', LOOPBACK_SERVER], detached: true });
  await new Promise((r) => setTimeout(r, 1500));

  const { ms: flipMs } = await timed(() => sandbox.updateNetworkPolicy('deny-all'));
  record('2', `updateNetworkPolicy took ${Math.round(flipMs)}ms; now ${JSON.stringify(sandbox.networkPolicy)}`);

  // Poll until both egress probes fail, or 10s pass.
  const start = performance.now();
  let sealedAt: number | null = null;
  for (let i = 0; i < 20; i += 1) {
    const dns = await sh(sandbox, PROBES.dns);
    const tcp = await sh(sandbox, PROBES.tcp);
    if (dns.code !== 0 && tcp.code !== 0) {
      sealedAt = performance.now() - start;
      record('2', `sealed: ${dns.out} / ${tcp.out}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  verdict('2.sealed-within-5s', sealedAt !== null && sealedAt <= 5000, sealedAt === null ? 'still open after 10s' : `${Math.round(sealedAt)}ms after the flip`);
  const loop = await sh(sandbox, LOOPBACK_PROBE);
  verdict('2.loopback-survives', loop.code === 0, `${loop.out}`);
  verdict('2.same-session', sandbox.status === 'running', `status ${sandbox.status}`);
} finally {
  await stopQuietly(sandbox);
}
done();
