// Item 1. `deny-all` at create: DNS, a raw TCP connect and HTTP all fail; loopback works.
import { create, sh, PROBES, LOOPBACK_SERVER, LOOPBACK_PROBE, verdict, record, done, stopQuietly, timed } from './lib.js';

const { value: sandbox, ms: createMs } = await timed(() => create({ networkPolicy: 'deny-all' }));
try {
  record('1', `created in ${Math.round(createMs)}ms, policy ${JSON.stringify(sandbox.networkPolicy)}`);
  const dns = await sh(sandbox, PROBES.dns);
  const tcp = await sh(sandbox, PROBES.tcp);
  const http = await sh(sandbox, PROBES.http);
  verdict('1.dns', dns.code !== 0, `${dns.out} (exit ${dns.code})`);
  verdict('1.tcp', tcp.code !== 0, `${tcp.out} (exit ${tcp.code})`);
  verdict('1.http', http.code !== 0, `${http.out} (exit ${http.code})`);
  await sandbox.runCommand({ cmd: 'sh', args: ['-c', LOOPBACK_SERVER], detached: true });
  await new Promise((r) => setTimeout(r, 1500));
  const loop = await sh(sandbox, LOOPBACK_PROBE);
  verdict('1.loopback', loop.code === 0, `${loop.out} (exit ${loop.code})`);
} finally {
  await stopQuietly(sandbox);
}
done();
