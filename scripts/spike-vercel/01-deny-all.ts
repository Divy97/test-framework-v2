// Item 1. `deny-all` at create: DNS, a raw TCP connect and HTTP all fail; loopback works.
// The image has neither `nc` nor `wget`, so the probes are node one-liners that print how
// they failed — and PASS requires that word, not merely a non-zero exit a crash would share.
import { create, sh, PROBES, LOOPBACK_SERVER, LOOPBACK_PROBE, sealedFailure, verdict, record, done, stopQuietly, timed } from './lib.js';

const { value: sandbox, ms: createMs } = await timed(() => create({ networkPolicy: 'deny-all' }));
try {
  record('1', `created in ${Math.round(createMs)}ms, policy ${JSON.stringify(sandbox.networkPolicy)}`);
  const dns = await sh(sandbox, PROBES.dns, { timeoutMs: 30_000 });
  const tcp = await sh(sandbox, PROBES.tcp, { timeoutMs: 30_000 });
  const http = await sh(sandbox, PROBES.http, { timeoutMs: 30_000 });
  verdict('1.dns', sealedFailure(dns), `${dns.out} (exit ${dns.code})`);
  verdict('1.tcp', sealedFailure(tcp), `${tcp.out} (exit ${tcp.code})`);
  verdict('1.http', sealedFailure(http), `${http.out} (exit ${http.code})`);
  await sandbox.runCommand({ cmd: 'sh', args: ['-c', LOOPBACK_SERVER], detached: true });
  await new Promise((r) => setTimeout(r, 1500));
  const loop = await sh(sandbox, LOOPBACK_PROBE, { timeoutMs: 30_000 });
  verdict('1.loopback', loop.code === 0 && loop.out.startsWith('LOOPBACK ok'), `${loop.out} (exit ${loop.code})`);
} finally {
  await stopQuietly(sandbox);
}
done();
