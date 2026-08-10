// The agent's one channel out.
//
// Every test here is an attempt to reach something the allowlist does not name.
// The proxy is the whole of 3c.2's enforcement — the agent's container has no
// other route — so a hole here is a hole in the boundary, not a rough edge.

import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { startEgressProxy, type EgressProxy } from '../src/egress.js';

const running: Array<{ close: () => Promise<void> | void }> = [];
afterEach(async () => {
  for (const thing of running.splice(0)) await thing.close();
});

/** A server standing in for whatever the agent is trying to reach. */
const upstream = (): Promise<{ port: number; close: () => Promise<void> }> =>
  new Promise((resolve) => {
    const server: Server = createServer((_q, r) => r.end('upstream\n'));
    server.listen(0, () => {
      const address = server.address() as { port: number };
      const handle = {
        port: address.port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      };
      running.push(handle);
      resolve(handle);
    });
  });

/** Ask the proxy for a tunnel; resolve with the status line it answers. */
const tunnel = (proxy: EgressProxy, target: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect(proxy.port, '127.0.0.1', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error('the proxy never answered'));
    });
    socket.once('data', (chunk) => {
      socket.destroy();
      resolve(chunk.toString().split('\r\n')[0]!);
    });
    socket.on('error', reject);
  });

const proxyFor = async (allowed: string[]): Promise<EgressProxy> => {
  const proxy = await startEgressProxy(allowed);
  running.push(proxy);
  return proxy;
};

describe("the agent's one channel", () => {
  test('opens a tunnel to the one host it knows', async () => {
    const server = await upstream();
    const proxy = await proxyFor(['127.0.0.1']);

    expect(await tunnel(proxy, `127.0.0.1:${server.port}`)).toMatch(/200/);
    expect(proxy.attempts).toEqual([{ host: '127.0.0.1', port: server.port, allowed: true }]);
  });

  test('refuses every host it does not know, and records the attempt', async () => {
    const server = await upstream();
    const proxy = await proxyFor(['api.anthropic.com']);

    expect(await tunnel(proxy, `127.0.0.1:${server.port}`)).toMatch(/403/);
    expect(proxy.attempts).toEqual([{ host: '127.0.0.1', port: server.port, allowed: false }]);
  });

  test('does not suffix-match, because a suffix rule passes an attacker domain', async () => {
    // `api.anthropic.com.evil.test` ends in nothing suspicious. A rule written as
    // "ends with api.anthropic.com" would let it through; exact matching is the
    // whole reason the allowlist is a Set of names rather than a pattern.
    const proxy = await proxyFor(['api.anthropic.com']);
    expect(await tunnel(proxy, 'api.anthropic.com.evil.test:443')).toMatch(/403/);
    expect(await tunnel(proxy, 'evil-api.anthropic.com:443')).toMatch(/403/);
    expect(proxy.attempts.every((a) => !a.allowed)).toBe(true);
  });

  test.each([
    ['no port at all', 'api.anthropic.com'],
    ['a port that is not a number', 'api.anthropic.com:https'],
    ['a port out of range', 'api.anthropic.com:70000'],
    ['a port of zero', 'api.anthropic.com:0'],
    ['nothing', ''],
  ])('refuses a target with %s', async (_label, target) => {
    // Refused rather than defaulted. Guessing 443 for a malformed target is a
    // guess about what the caller meant, made by the component whose only job is
    // to not let traffic through.
    const proxy = await proxyFor(['api.anthropic.com']);
    expect(await tunnel(proxy, target)).toMatch(/403/);
  });

  test('speaks CONNECT only: an ordinary request is refused, not fetched', async () => {
    // A forward proxy that also serves GET is a second way out with its own URL
    // parser. This one answers 405 and fetches nothing.
    const proxy = await proxyFor(['127.0.0.1']);
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = connect(proxy.port, '127.0.0.1', () => {
        socket.write('GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n');
      });
      socket.once('data', (chunk) => {
        socket.destroy();
        resolve(chunk.toString().split('\r\n')[0]!);
      });
      socket.on('error', reject);
    });
    expect(answer).toMatch(/405/);
    // And it never became a CONNECT attempt, so the record stays honest.
    expect(proxy.attempts).toEqual([]);
  });

  test('a refused tunnel carries no bytes', async () => {
    // The status line is not the point — the point is that nothing reaches the
    // upstream. If a 403 still piped, the allowlist would be advisory.
    // TCP CONNECTIONS, not HTTP requests. Counting requests measured the wrong
    // thing: a refused tunnel that still dialled upstream opens a socket and
    // never completes a request, so the count stayed zero and the assertion
    // passed with the refusal's `return` deleted. The property is that the
    // upstream is never DIALLED.
    // Waited for, not sampled. Asserting straight after the 403 read the counter
    // BEFORE a dial could land, so the check passed with the refusal's `return`
    // deleted — a race dressed as a guard.
    let reached = 0;
    let dialled: () => void = () => {};
    const sawDial = new Promise<'dialled'>((resolve) => {
      dialled = () => resolve('dialled');
    });
    const server: Server = createServer((_q, r) => r.end('upstream\n'));
    server.on('connection', () => {
      reached += 1;
      dialled();
    });
    await new Promise<void>((done) => server.listen(0, () => done()));
    const port = (server.address() as { port: number }).port;
    running.push({ close: () => new Promise<void>((done) => server.close(() => done())) });

    const proxy = await proxyFor(['api.anthropic.com']);
    await tunnel(proxy, `127.0.0.1:${port}`);
    const quiet = new Promise<'quiet'>((resolve) => setTimeout(() => resolve('quiet'), 500));
    expect(await Promise.race([sawDial, quiet])).toBe('quiet');
    expect(reached).toBe(0);
  });
});
