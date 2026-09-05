// Item 7. An exposed port under `deny-all` — recorded only; the design exposes none.
import { create, LOOPBACK_SERVER, record, done, stopQuietly } from './lib.js';

const sandbox = await create({ networkPolicy: 'deny-all', ports: [8080] });
try {
  await sandbox.runCommand({ cmd: 'sh', args: ['-c', LOOPBACK_SERVER.replace("'127.0.0.1'", "'0.0.0.0'")], detached: true });
  await new Promise((r) => setTimeout(r, 1500));
  const url = sandbox.domain(8080);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    record('7', `inbound to ${url} under deny-all: HTTP ${response.status} ${(await response.text()).slice(0, 20)}`);
  } catch (error) {
    record('7', `inbound to ${url} under deny-all: ${String((error as Error).message ?? error)}`);
  }
} finally {
  await stopQuietly(sandbox);
}
done();
