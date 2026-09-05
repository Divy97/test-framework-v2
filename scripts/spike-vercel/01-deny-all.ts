// Item 1. `deny-all` at create: nothing REACHES the network — the system resolver, DNS over
// UDP straight to 1.1.1.1, DNS over TCP with a real query, TLS, HTTP — and loopback works.
//
// Verdicts are on data exchanged, never on `connect()`: the first run saw a raw connect
// succeed under `deny-all` while nothing else did, which is a proxy accepting the handshake,
// not a route to the destination. The connect result is recorded as information.
import { create, sh, PROBES, LOOPBACK_SERVER, LOOPBACK_PROBE, sealedFailure, verdict, record, done, stopQuietly, timed } from './lib.js';

const { value: sandbox, ms: createMs } = await timed(() => create({ networkPolicy: 'deny-all' }));
try {
  record('1', `created in ${Math.round(createMs)}ms, policy ${JSON.stringify(sandbox.networkPolicy)}`);
  const connect = await sh(sandbox, PROBES.connect, { timeoutMs: 30_000 });
  record('1', `raw connect() to 1.1.1.1:53: ${connect.out} — ${connect.out.startsWith('CONNECT_ACCEPTED') ? 'a proxy completes the handshake; the data probes below say whether anything gets through' : 'refused at connect'}`);
  for (const [name, probe] of Object.entries({ dns: PROBES.dns, udp: PROBES.udp, tcp: PROBES.tcp, tls: PROBES.tls, http: PROBES.http })) {
    const result = await sh(sandbox, probe, { timeoutMs: 30_000 });
    verdict(`1.${name}`, sealedFailure(result), `${result.out} (exit ${result.code})`);
  }
  await sandbox.runCommand({ cmd: 'sh', args: ['-c', LOOPBACK_SERVER], detached: true });
  await new Promise((r) => setTimeout(r, 1500));
  const loop = await sh(sandbox, LOOPBACK_PROBE, { timeoutMs: 30_000 });
  verdict('1.loopback', loop.code === 0 && loop.out.startsWith('LOOPBACK ok'), `${loop.out} (exit ${loop.code})`);
} finally {
  await stopQuietly(sandbox);
}
done();
