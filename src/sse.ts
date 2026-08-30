// Status out: the event stream, tailed (ADR-0005).
//
// SSE rather than WebSockets because the feed is unidirectional and append-only,
// and because `Last-Event-ID` maps 1:1 onto `seq`. That is the whole design: the
// browser reconnects on its own and tells us the last id it saw, and the query is
//
//     where run_id = $1 and seq > $2 order by seq
//
// No protocol is invented. There is no ack, no cursor of ours, no replay buffer to
// keep in sync with the store — the store IS the buffer, because the event log is
// append-only and immutable. A dropped connection resumes with no missed and no
// duplicated events for that reason alone, not because anything here is careful.
//
// `read` is injected so this is testable over an in-memory log. The Postgres
// version is two lines at the call site and has nothing to do with the streaming.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { RunEvent } from './events.js';

/** How the tail gets more events. `afterSeq` is exclusive, exactly like the SQL. */
export type ReadEvents = (runId: string, afterSeq: number) => Promise<RunEvent[]>;

/** Idle cadence. A poll rather than a listen: Postgres LISTEN/NOTIFY would be a second channel. */
const POLL_MS = 250;
/** Something on the wire, so a proxy does not close a quiet run's connection. */
const HEARTBEAT_MS = 15_000;

/**
 * One event on the wire.
 *
 * `id` is the seq and nothing else. That identity is what makes resumption free:
 * an id the client echoes back becomes the `>` in the query, so there is no mapping
 * table and no way for the two to disagree.
 *
 * `event:` carries the type so a consumer can subscribe per type, and `data:` is the
 * whole event — envelope included — because a consumer that folds needs `run_id` and
 * `seq`, and reconstructing them from the frame would be a second parser.
 */
export const formatEvent = (event: RunEvent): string =>
  `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

/**
 * `Last-Event-ID`, as the browser sends it, or nothing.
 *
 * A non-numeric value is treated as absent rather than as an error: EventSource
 * sends back whatever it last saw, and a client that has been pointed at a
 * different stream should get this one from the start rather than a 400 it cannot
 * act on. Anything negative is clamped to 0 for the same reason — `seq > -5` and
 * `seq > 0` would return the same rows anyway, and pretending otherwise invites a
 * caller to think the field means something it does not.
 */
export const resumeFrom = (header: string | string[] | undefined): number => {
  const raw = Array.isArray(header) ? header[0] : header;
  const seq = Number(raw);
  return Number.isInteger(seq) && seq > 0 ? seq : 0;
};

export type TailOptions = {
  runId: string;
  afterSeq: number;
  read: ReadEvents;
  write: (chunk: string) => void;
  /** True while the client is still there. The tail stops when it is not. */
  connected: () => boolean;
  pollMs?: number;
  heartbeatMs?: number;
  /** Stop once the run has ended, instead of tailing forever. Off for a live dashboard. */
  until?: (event: RunEvent) => boolean;
};

/**
 * Tail one run until the client leaves, or until `until` says the run is over.
 *
 * Deliberately dumb. Every complication a tail can have — buffering, coalescing,
 * back-pressure, a change feed — is a way for the stream to disagree with the log,
 * and the log is the product.
 */
export async function tailRun(options: TailOptions): Promise<void> {
  const pollMs = options.pollMs ?? POLL_MS;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  let afterSeq = options.afterSeq;
  let quietSince = Date.now();

  while (options.connected()) {
    const events = await options.read(options.runId, afterSeq);
    for (const event of events) {
      // Guard against a `read` that ignores `afterSeq`. Duplicates are the one
      // thing a consumer folding this stream cannot survive — `apply()` throws on a
      // seq that is not `lastSeq + 1` — so the tail refuses to emit one even if the
      // query behind it is wrong.
      if (event.seq <= afterSeq) continue;
      options.write(formatEvent(event));
      afterSeq = event.seq;
      quietSince = Date.now();
      if (options.until?.(event)) return;
    }
    if (Date.now() - quietSince >= heartbeatMs) {
      // A comment frame. Not an event, so it cannot advance `Last-Event-ID` and
      // cannot appear in a fold; it exists only so an idle connection survives a
      // proxy's read timeout.
      options.write(': keep-alive\n\n');
      quietSince = Date.now();
    }
    await new Promise((done) => setTimeout(done, pollMs));
  }
}

export type StatusServer = { port: number; close: () => Promise<void> };

/**
 * A route this server does not itself know how to answer.
 *
 * The dashboard (M6f) needs pages and JSON; this module needs to stay a thing a test can
 * drive with no database, which is why `read` is injected rather than a `pg.Client`. So
 * the extra surface arrives the same way: as a function the caller closes over its own
 * client, returning what to send. `null` means "not mine", and the 404 stands.
 */
export type Route = (request: {
  method: string;
  path: string;
  query: URLSearchParams;
  /**
   * The request headers, lowercased by Node.
   *
   * A route that changes state has to be able to tell a browser form POST from another
   * origin apart from one of its own — `Origin` and `Sec-Fetch-Site` are the only things
   * that carry that, and binding to 127.0.0.1 does not: the same-origin policy stops a
   * page READING our response, never sending the request.
   */
  headers: Record<string, string | string[] | undefined>;
  /**
   * The request body, read on demand and bounded.
   *
   * A function rather than a string because every route here except one is a GET, and
   * buffering a body for those would make the server wait on a stream that will never
   * carry anything. The one POST is a human approving commands we will execute.
   */
  body: () => Promise<string>;
  /**
   * The body as BYTES, with a ceiling this caller chooses (9b).
   *
   * `body()` above decodes to a string, which is right for a form post and wrong for a
   * blob: a screenshot round-tripped through UTF-8 is not that screenshot. And it
   * truncates silently at the ceiling, so an oversized upload would have arrived as a
   * digest mismatch — an operational failure wearing a tamper signal's clothes.
   *
   * `null` means the body exceeded `limit`. Explicitly null rather than truncated,
   * because the caller has to be able to say "too large" instead of guessing.
   */
  raw: (limit?: number) => Promise<Buffer | null>;
}) => Promise<{ status: number; type: string; body: string | Buffer; headers?: Record<string, string> } | null>;

/** Ceiling on a request body. The only write takes a recipe, and a recipe is small. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * The HTTP surface.
 *
 * It was `GET /runs/:runId/events` and nothing else, with a comment saying the dashboard
 * was M6 — this is M6, so the SSE route is now one of several and the rest arrive through
 * `routes`. The tail keeps its own branch rather than becoming a `Route`, because its
 * response lifecycle is unlike every other: headers immediately, a body that never ends,
 * and a completion that depends on the client hanging up.
 */
export function startStatusServer(options: {
  read: ReadEvents;
  port?: number;
  routes?: Route;
  /**
   * The interface to bind. `127.0.0.1` by default, and that default is deliberate: a
   * developer's dashboard has no business on the LAN, and the one write on it stores
   * commands this engine executes.
   *
   * A CONTAINER has to override it. Loopback inside a container is the container's own
   * loopback, so a published port can never reach it — the plane's first containerised
   * start printed "plane up" and answered nothing, which is the most confusing shape a
   * failure can take. Set `ENGINE_BIND=0.0.0.0` there and let the container boundary and
   * the host's firewall be the exposure decision, which is where it belongs.
   */
  host?: string;
}): Promise<StatusServer> {
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? '').split('?')[0] ?? '';
    const match = /^\/runs\/([^/]+)\/events$/.exec(path);
    if (request.method !== 'GET' || !match) {
      /**
       * Buffer the body once, to a ceiling the caller picks.
       *
       * Over the ceiling it keeps DRAINING and answers `null`. Destroying the request
       * mid-body gives the client a connection reset rather than the refusal we mean to
       * send — the same reasoning the webhook receiver already applies — and truncating
       * instead would hand a blob route bytes that hash to nothing.
       */
      const read = (limit: number): Promise<Buffer | null> =>
        new Promise<Buffer | null>((resolve, reject) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          let over = false;
          request.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > limit) {
              over = true;
              return;
            }
            chunks.push(chunk);
          });
          request.on('error', reject);
          request.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
        });

      const handler = options.routes;
      if (!handler) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found\n');
        return;
      }
      // Awaited out here with a catch that always answers. An unhandled rejection in a
      // request handler takes the process down, and `startWebhookReceiver` records that
      // reasoning for the webhook path — a dashboard query that throws must cost a 500,
      // not the service.
      void handler({
        method: request.method ?? 'GET',
        path,
        query: new URL(request.url ?? '/', 'http://127.0.0.1').searchParams,
        headers: request.headers,
        body: async () => (await read(MAX_BODY_BYTES))?.toString() ?? '',
        raw: (limit = MAX_BODY_BYTES) => read(limit),
      })
        .then((answer) => {
          if (!answer) {
            response.writeHead(404, { 'content-type': 'text/plain' });
            response.end('not found\n');
            return;
          }
          response.writeHead(answer.status, { 'content-type': answer.type, ...answer.headers });
          response.end(answer.body);
        })
        .catch((error: unknown) => {
          response.writeHead(500, { 'content-type': 'text/plain' });
          response.end(`${String((error as Error)?.message ?? error)}\n`);
        });
      return;
    }
    const runId = decodeURIComponent(match[1]!);
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // Chunked, and flushed per write. A buffering proxy in front of this turns a
      // live tail into a single response at the end, which is the failure mode SSE
      // is most often reported broken for.
      'x-accel-buffering': 'no',
    });

    let connected = true;
    request.on('close', () => (connected = false));
    response.on('close', () => (connected = false));

    void tailRun({
      runId,
      afterSeq: resumeFrom(request.headers['last-event-id']),
      read: options.read,
      write: (chunk) => {
        if (connected) response.write(chunk);
      },
      connected: () => connected,
    }).finally(() => {
      if (connected) response.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the status server did not bind a port'));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
