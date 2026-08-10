// The agent's one channel out (M3.3's 3c.2).
//
// 3c.1 gave the phase containers no network at all, which a flag can express.
// This half cannot be a flag: "the model API and nothing else" is a statement
// about WHERE traffic may go, and Docker has no switch for that. So the agent is
// put on a network with no route to the internet, and the only thing it can
// reach is this proxy, which knows one host.
//
// It speaks CONNECT and nothing else. An HTTPS client asks the proxy to open a
// tunnel to a host, and the proxy either opens it or refuses — it never sees the
// plaintext, never holds a certificate, and cannot be talked into fetching a URL
// on someone's behalf. A forward proxy that served ordinary GETs would be a
// second way out with its own parser; this one has almost nothing to get wrong.
//
// What it does NOT do, said here rather than implied: it is an allowlist, not an
// audit. It records that a tunnel was opened, not what went through it, because
// what went through it is TLS and reading that would mean terminating it — a
// credential-bearing man in the middle inside the thing that exists to keep the
// agent away from credentials.

import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';

/** Where a tunnel was allowed to, or refused. Evidence, in the ADR-0006 sense. */
export type EgressAttempt = { host: string; port: number; allowed: boolean };

export type EgressProxy = {
  port: number;
  /** Every CONNECT this proxy saw, in order. */
  attempts: EgressAttempt[];
  close: () => Promise<void>;
};

/**
 * A CONNECT proxy that opens tunnels to `allowed` hosts and refuses every other.
 *
 * `allowed` is matched exactly against the host the client asked for — no suffix
 * matching, because `api.anthropic.com.evil.test` ends with nothing suspicious
 * and a suffix rule would pass it. A caller who wants a subdomain names it.
 */
export function startEgressProxy(allowed: readonly string[], port = 0): Promise<EgressProxy> {
  const permitted = new Set(allowed);
  const attempts: EgressAttempt[] = [];

  const server: Server = createServer((_request, response) => {
    // Anything that is not CONNECT. A proxy that also serves GET is a second
    // exit with its own URL parser; this one has one job.
    response.writeHead(405, { 'content-type': 'text/plain' });
    response.end('this proxy speaks CONNECT only\n');
  });

  server.on('connect', (request, socket, head) => {
    // `host:port`, and the host half may be bracketed IPv6. Split on the LAST
    // colon so `[::1]:443` does not become host `[` — and refuse anything
    // without a port rather than guessing 443 for it.
    const target = request.url ?? '';
    const cut = target.lastIndexOf(':');
    const host = cut > 0 ? target.slice(0, cut) : '';
    const port = cut > 0 ? Number(target.slice(cut + 1)) : NaN;

    if (!permitted.has(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
      attempts.push({ host, port: Number.isInteger(port) ? port : 0, allowed: false });
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    attempts.push({ host, port, allowed: true });

    const upstream = connect(port, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    // Both halves, or a failed upstream leaves the client's socket open until
    // something else times it out — and the agent then waits on a tunnel that
    // will never carry anything.
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the egress proxy did not bind a port'));
        return;
      }
      resolve({
        port: address.port,
        attempts,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            // Sockets already tunnelling keep the server alive otherwise, and a
            // run must not wait on the agent's last connection to drain.
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
