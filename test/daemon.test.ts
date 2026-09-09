// The daemon's loop, against a fake plane.
//
// What is under test is everything that is NOT the engine: claiming, shipping, retrying,
// uploading, finishing, and surviving. The engine is injected, because a test of a retry
// policy that needs Docker and a model credential is a test nobody runs.
//
// Every case here is a thing that will actually happen to a process living on somebody's
// laptop — a plane that is briefly down, a run that throws, a blob that will not upload.

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { put } from '../src/blobs.js';
import type { RunEvent } from '../src/events.js';
import { runDaemon, type DaemonIo, type DaemonJob } from '../src/daemon.js';

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((done) => server.close(() => done()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const blobRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'engine-daemon-blobs-'));
  roots.push(root);
  return root;
};

type Seen = { method: string; path: string; body: string };

/**
 * A plane that hands out one job and records everything said to it.
 *
 * `appendStatus` lets a test make the far end fail the way a home connection does — the
 * retry policy is the point of several cases below and cannot be asserted against a
 * server that always says yes.
 */
const fakePlane = async (options: {
  job?: DaemonJob | null;
  appendStatus?: (attempt: number) => number;
  /** What the poll answers. 401/403 is the plane refusing this runner's credential. */
  pollStatus?: number;
  /** What the bill route answers, so a plane that refuses one can be exercised. */
  costStatus?: number;
  /** What a blob PUT answers, per attempt — the retry policy is the point of two cases. */
  blobStatus?: (attempt: number) => number;
} = {}) => {
  const seen: Seen[] = [];
  let handed = false;
  let appends = 0;
  let blobs = 0;

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = (request.url ?? '').split('?')[0] ?? '';
      const body = Buffer.concat(chunks);
      seen.push({ method: request.method ?? '', path, body: body.toString('binary') });

      const send = (status: number, payload?: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(payload === undefined ? '' : JSON.stringify(payload));
      };

      if (path === '/runner/jobs') {
        if (options.pollStatus !== undefined) return send(options.pollStatus, { error: 'nope' });
        if (handed || options.job === null) return send(204);
        handed = true;
        return send(200, options.job ?? JOB);
      }
      if (path.endsWith('/events')) {
        const status = options.appendStatus?.(appends++) ?? 200;
        return send(status, status === 200 ? { appended: 1 } : { error: 'no' });
      }
      if (path.endsWith('/token')) return send(200, { token: `ghs_${seen.length}` });
      if (path.includes('/blobs/')) {
        const status = options.blobStatus?.(blobs++) ?? 201;
        return send(status, status < 400 ? { ref: 'ok' } : { error: 'no' });
      }
      if (path.endsWith('/cost')) return send(options.costStatus ?? 204);
      if (path.endsWith('/finished')) return send(204);
      return send(404, { error: 'no such route' });
    });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

const JOB: DaemonJob = {
  runId: '3f1c9a52-7b0e-4d2f-9c41-8a6e5d0b21c7',
  installationId: 152989253,
  repo: 'o/r',
  intake: { source: 'github_issue', thread_ref: 'o/r#1' },
  recipe: { services: [], test: 'node --test' },
  // `run`, which is what every job in this file is about and what the column defaults to.
  kind: 'run',
};

const event = (seq: number, payload: Record<string, unknown> = {}): RunEvent =>
  ({
    run_id: JOB.runId,
    seq,
    ts: new Date().toISOString(),
    type: 'RUN_REQUESTED',
    payload: { v: 1, source: 'github_issue', thread_ref: 'o/r#1', raw_text: 'x', ...payload },
  }) as RunEvent;

/** Run the daemon for exactly one job and return once it has finished with it. */
const oneJob = async (
  plane: { url: string },
  execute: (job: DaemonJob, io: DaemonIo) => Promise<void>,
  root = blobRoot(),
) => {
  const logs: string[] = [];
  const daemon = await runDaemon({
    planeUrl: plane.url,
    token: 'tfr_test',
    blobRoot: root,
    waitSeconds: 0,
    once: true,
    log: (line) => logs.push(line),
    execute,
  });
  await daemon.stop();
  return { logs, root };
};

describe('the daemon dials out and ships what the engine observed', () => {
  test('claims a job, ships every event in order, and marks it finished', async () => {
    const plane = await fakePlane();
    await oneJob(plane, async (job, io) => {
      expect(job.repo).toBe('o/r');
      // The recipe travels with the dispatch: the runner replays what is approved NOW.
      expect(job.recipe?.test).toBe('node --test');
      await io.append(event(1));
      await io.append(event(2));
    });

    const posts = plane.seen.filter((s) => s.path.endsWith('/events'));
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[0]!.body).events[0].seq).toBe(1);
    expect(JSON.parse(posts[1]!.body).events[0].seq).toBe(2);
    expect(plane.seen.some((s) => s.path.endsWith('/finished'))).toBe(true);
  });

  test('uploads the artifacts the events name, by ref', async () => {
    const plane = await fakePlane();
    const root = blobRoot();
    const ref = await put(root, 'not ok 3 - totals\n');

    await oneJob(plane, async (_job, io) => {
      // The ref reaches the plane because it appears in an event, which is how the
      // engine actually cites bytes — no separate manifest to drift.
      await io.append(event(1, { stdout_hash: ref }));
    }, root);

    const uploads = plane.seen.filter((s) => s.path.includes('/blobs/'));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.path).toContain(ref);
    expect(uploads[0]!.body).toContain('not ok 3 - totals');
  });

  test('asks for a GitHub token per call, and never holds one', async () => {
    // `installationToken` is documented as "called when needed, never captured at run
    // start" — a run over an hour needs a refresh. Handing one over at dispatch would
    // trade that away silently, so the daemon asks every time it is asked.
    const plane = await fakePlane();
    const tokens: string[] = [];
    await oneJob(plane, async (_job, io) => {
      tokens.push(await io.token());
      tokens.push(await io.token());
    });

    expect(plane.seen.filter((s) => s.path.endsWith('/token'))).toHaveLength(2);
    expect(new Set(tokens).size).toBe(2);
  });
});

describe('the daemon survives the things that happen to laptops', () => {
  test('a plane that fails and recovers costs a retry, not the stream', async () => {
    // Two 503s then success. The far end is idempotent on (run_id, seq), so a retry
    // costs a request and nothing else — and an append that gave up would lose the
    // observation that is the entire product.
    const plane = await fakePlane({ appendStatus: (attempt) => (attempt < 2 ? 503 : 200) });
    await oneJob(plane, async (_job, io) => {
      await io.append(event(1));
    });

    expect(plane.seen.filter((s) => s.path.endsWith('/events'))).toHaveLength(3);
    expect(plane.seen.some((s) => s.path.endsWith('/finished'))).toBe(true);
  });

  test('a refusal is NOT retried, because a 4xx is an answer', async () => {
    // The plane deciding this runner may not write this run is a decision, not an
    // outage. Hammering it would turn a clear refusal into an incident.
    const plane = await fakePlane({ appendStatus: () => 403 });
    const { logs } = await oneJob(plane, async (_job, io) => {
      await io.append(event(1));
    });

    expect(plane.seen.filter((s) => s.path.endsWith('/events'))).toHaveLength(1);
    expect(logs.join('\n')).toContain('ended badly');
  });

  test('a run that throws does not end the daemon, and the job still finishes', async () => {
    // A job left dispatched is a job no other runner will take and no operator will see
    // complete. The next delivery is somebody else's bug report.
    const plane = await fakePlane();
    const { logs } = await oneJob(plane, async () => {
      throw new Error('the sandbox would not start');
    });

    expect(logs.join('\n')).toContain('the sandbox would not start');
    expect(plane.seen.some((s) => s.path.endsWith('/finished'))).toBe(true);
  });

  test('a blob that will not upload costs the artifact, never the run', async () => {
    // The events are the record. A run whose blobs failed is an incomplete evidence
    // page; a run whose EVENTS failed is not a run at all — the same trade
    // `runContainer` makes about artifact collection.
    const plane = await fakePlane();
    const missing = `sha256:${'a'.repeat(64)}`;
    const { logs } = await oneJob(plane, async (_job, io) => {
      await io.append(event(1, { stdout_hash: missing }));
    });

    expect(plane.seen.filter((s) => s.path.endsWith('/events'))).toHaveLength(1);
    expect(logs.join('\n')).toContain('could not upload');
    expect(plane.seen.some((s) => s.path.endsWith('/finished'))).toBe(true);
  });

  test('an unreachable plane is waited out, not exited on', async () => {
    // The ordinary state of a laptop. A runner that exits when the plane blinks needs
    // somebody to notice and restart the one process whose job is to be there.
    const logs: string[] = [];
    const daemon = await runDaemon({
      planeUrl: 'http://127.0.0.1:1',
      token: 'tfr_test',
      blobRoot: blobRoot(),
      waitSeconds: 0,
      log: (line) => logs.push(line),
      execute: async () => {
        throw new Error('never reached');
      },
    });
    await new Promise((done) => setTimeout(done, 300));
    await daemon.stop();

    expect(logs.join('\n')).toContain('waiting for the plane');
  });

  test('an empty poll loops rather than treating 204 as a failure', async () => {
    const plane = await fakePlane({ job: null });
    const logs: string[] = [];
    const daemon = await runDaemon({
      planeUrl: plane.url,
      token: 'tfr_test',
      blobRoot: blobRoot(),
      waitSeconds: 0,
      log: (line) => logs.push(line),
      execute: async () => {
        throw new Error('nothing should have been executed');
      },
    });
    await new Promise((done) => setTimeout(done, 150));
    await daemon.stop();

    expect(plane.seen.filter((s) => s.path === '/runner/jobs').length).toBeGreaterThan(1);
    expect(logs.join('\n')).not.toContain('nothing should have been executed');
  });
});

describe('what a run spent goes beside the log, and never into it', () => {
  const bill = { usage: [{ phase: 'agent', turns: 3 }], compute: [{ sandbox_id: 'sbx-1', phase: 'base' }] };

  test('the bill is posted, as its own call, and never as an event', async () => {
    const plane = await fakePlane();
    await oneJob(plane, async (_job, io) => {
      await io.append(event(1));
      await io.cost(bill);
    });
    const posted = plane.seen.filter((one) => one.path.endsWith('/cost'));
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0]!.body)).toEqual(bill);
    // THE CONTROL on the design, not on the plumbing: `readmodel.ts` says a fact about
    // our own spending must not enter a log about the user's bug. Nothing the engine
    // appended may carry it.
    const appended = plane.seen.filter((one) => one.path.endsWith('/events'));
    expect(appended).toHaveLength(1);
    expect(appended[0]!.body).not.toContain('sbx-1');
    expect(appended[0]!.body).not.toContain('turns');
  });

  test('an empty bill is not a request', async () => {
    // A Docker run spends no sandboxes and a run that died before an agent spends no
    // tokens. Posting `{}` would be a round trip per job to say nothing.
    const plane = await fakePlane();
    await oneJob(plane, async (_job, io) => {
      await io.cost({ usage: [], compute: [] });
      await io.cost({});
    });
    expect(plane.seen.filter((one) => one.path.endsWith('/cost'))).toHaveLength(0);
  });

  test('a plane that refuses the bill costs a log line, never the job', async () => {
    // Unlike `append`, which retries: the evidence is already shipped by the time this is
    // called. A runner that retried bookkeeping would hold a slot open over it, and one
    // that threw would lose a finished run over a number.
    const plane = await fakePlane({ costStatus: 500 });
    let threw = false;
    const { logs } = await oneJob(plane, async (_job, io) => {
      await io.append(event(1));
      await io.cost(bill).catch(() => void (threw = true));
    });
    // THE assertion, and it has to be this one: a `cost` that throws still ends with the
    // job finished, because the daemon catches everything `execute` throws. Asserting on
    // `/finished` therefore proves nothing, and asserting on the log matches either way —
    // `ended badly — Error: the plane answered HTTP 500 to the bill` contains the same
    // words. What is actually being claimed is that this call does not throw at all.
    expect(threw).toBe(false);
    expect(plane.seen.filter((one) => one.path.endsWith('/cost'))).toHaveLength(1); // not retried
    expect(logs.join('\n')).toMatch(/HTTP 500 to the bill/);
    expect(logs.join('\n')).not.toMatch(/ended badly/);
    expect(plane.seen.some((one) => one.path.endsWith('/finished'))).toBe(true);
  });
});

describe('an artifact is a file of ours, and is not given up on once', () => {
  /** A `sha256:` in an event, with a blob on disk to match. */
  const artifact = async (root: string, body: string) => {
    const { put } = await import('../src/blobs.js');
    return put(root, Buffer.from(body));
  };

  test('an IMAGE digest is not an artifact, and is never asked for', async () => {
    // `ENV_BUILT` records the image a phase was created from, and a pinned reference ends
    // `…/test-framework-v2-sandbox@sha256:abc…` — the same 64 hex digits naming a
    // container image in somebody else's registry. Every hosted run uploaded its own
    // image digest and logged `ENOENT` for it, once per run, forever.
    const root = blobRoot();
    const ref = await artifact(root, 'a real artifact');
    const plane = await fakePlane();
    const { logs } = await oneJob(
      plane,
      async (_job, io) => {
        await io.append(
          event(1, {
            image: `vcr.vercel.com/x/test-framework-v2-sandbox@sha256:${'a'.repeat(64)}`,
            stdout_hash: ref,
          }),
        );
      },
      root,
    );
    const asked = plane.seen.filter((one) => one.path.includes('/blobs/'));
    // THE control: the real one still goes. A regex that excluded everything would pass a
    // test that only checked the image was skipped.
    expect(asked.map((one) => one.path.split('/blobs/')[1])).toEqual([ref]);
    expect(logs.join('\n')).not.toMatch(/could not upload/);
  });

  test('a blob the plane drops once is sent again, because a lost ref is an ENOENT for a reader', async () => {
    // The first hosted run lost one to a single `TypeError: fetch failed`. `append` had
    // four attempts and this had one, so the log ended up citing a ref the evidence store
    // does not hold — the shape `collect()` says it exists to prevent, one layer out.
    const root = blobRoot();
    const ref = await artifact(root, 'worth keeping');
    const plane = await fakePlane({ blobStatus: (attempt) => (attempt === 0 ? 503 : 201) });
    const { logs } = await oneJob(plane, async (_job, io) => void (await io.append(event(1, { stdout_hash: ref }))), root);
    expect(plane.seen.filter((one) => one.path.includes('/blobs/'))).toHaveLength(2);
    expect(logs.join('\n')).toMatch(/1 artifact/);
    expect(logs.join('\n')).not.toMatch(/was refused/);
  });

  test('but a 4xx is an ANSWER, and is not asked again', async () => {
    // Same lesson the append path learned in M9. A blob the plane refuses will be refused
    // again, and a ref it already holds answers 409 — retrying either is noise.
    const root = blobRoot();
    const ref = await artifact(root, 'refused');
    const plane = await fakePlane({ blobStatus: () => 409 });
    const { logs } = await oneJob(plane, async (_job, io) => void (await io.append(event(1, { stdout_hash: ref }))), root);
    expect(plane.seen.filter((one) => one.path.includes('/blobs/'))).toHaveLength(1);
    expect(logs.join('\n')).toMatch(/HTTP 409/);
  });
});

describe('a credential the plane refuses is not a network problem', () => {
  // The daemon treated every poll failure the same, on the reasoning that an unreachable
  // plane is the ordinary state of a laptop. True of a blip and a 5xx. Not true of a 401:
  // that is the plane saying WHO you are, it will never become true by waiting, and
  // re-pairing issues a new token this process could not pick up anyway. A wrong token
  // printed the same line every few seconds forever, which reads as a network problem.
  //
  // Same lesson the append path learned in M9 — a 4xx is an ANSWER — arriving late here.
  for (const status of [401, 403]) {
    test(`stops on HTTP ${status}, saying what to do about it`, async () => {
      const plane = await fakePlane({ pollStatus: status });
      const logs: string[] = [];
      const daemon = await runDaemon({
        planeUrl: plane.url,
        token: 'tfr_wrong',
        blobRoot: blobRoot(),
        waitSeconds: 0,
        log: (line) => logs.push(line),
        execute: async () => {
          throw new Error('nothing should have been executed');
        },
      });
      // Long enough that a retrying loop would have logged this many times over.
      await new Promise((done) => setTimeout(done, 300));
      await daemon.stop();

      const said = logs.join('\n');
      expect(said).toContain('will not take this runner');
      expect(said).toContain('Pair this machine again');
      // Said ONCE. The bug was the same line forever.
      expect(logs.filter((line) => line.includes('will not take this runner'))).toHaveLength(1);
      // And never as though the plane were merely unreachable.
      expect(said).not.toContain('waiting for the plane');
    });
  }

  test('but a 500 IS waited out, because that one can come back', async () => {
    const plane = await fakePlane({ pollStatus: 500 });
    const logs: string[] = [];
    const daemon = await runDaemon({
      planeUrl: plane.url,
      token: 'tfr_test',
      blobRoot: blobRoot(),
      waitSeconds: 0,
      log: (line) => logs.push(line),
      execute: async () => {
        throw new Error('nothing should have been executed');
      },
    });
    await new Promise((done) => setTimeout(done, 200));
    await daemon.stop();

    expect(logs.join('\n')).toContain('waiting for the plane');
  });
});
