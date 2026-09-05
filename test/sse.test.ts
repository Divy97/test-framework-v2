// The tail resumes, and that is all 5g owes.
//
// The claim under test is narrow and load-bearing: a dropped connection resumes
// with **no missed and no duplicated events**. Both halves matter and they fail
// differently — a missed event is a hole a fold cannot cross, and a duplicate makes
// `apply()` throw on a seq that is not `lastSeq + 1`. So the test folds what it
// received, which is the only assertion that catches both.

import { describe, expect, test } from 'vitest';
import { fold } from '../src/fold.js';
import type { RunEvent } from '../src/events.js';
import { formatEvent, resumeFrom, startStatusServer, tailRun } from '../src/sse.js';

const RUN_ID = 'a0f0c9d4-6b21-4a6e-9f11-3c8e2d5b7a90';

/** A run's log, grown a bit at a time, so the tail has something to catch up to. */
const log = (upTo: number): RunEvent[] => {
  const events: RunEvent[] = [
    {
      run_id: RUN_ID,
      seq: 1,
      ts: '2026-08-11T00:00:00.000Z',
      type: 'RUN_REQUESTED',
      payload: { v: 1, source: 'github_issue', thread_ref: 'o/r#1', raw_text: 'it is broken' },
    },
    { run_id: RUN_ID, seq: 2, ts: '2026-08-11T00:00:01.000Z', type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } },
  ];
  for (let seq = 3; seq <= upTo; seq += 1) {
    events.push({
      run_id: RUN_ID,
      seq,
      ts: `2026-08-11T00:00:${String(seq).padStart(2, '0')}.000Z`,
      type: 'AGENT_MESSAGE',
      payload: { v: 1, n: seq - 3, claimed_type: 'assistant', raw_hash: `sha256:${'a'.repeat(64)}`, bytes: 4 },
    });
  }
  return events.slice(0, upTo);
};

/** Parse an SSE body back into ids and events, the way a client would. */
const received = (body: string) => {
  const frames = body
    .split('\n\n')
    .filter((frame) => frame.trim() !== '' && !frame.startsWith(':'));
  return frames.map((frame) => {
    const id = Number(/^id: (\d+)$/m.exec(frame)?.[1]);
    const data = JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as RunEvent;
    return { id, data };
  });
};

describe('the wire format is the seq and nothing else', () => {
  test('id is the seq, so Last-Event-ID needs no mapping', () => {
    const [first] = log(1);
    const frame = formatEvent(first!);
    expect(frame).toMatch(/^id: 1\n/);
    expect(frame).toMatch(/^event: RUN_REQUESTED$/m);
    // The whole event, envelope included: a consumer that folds needs run_id and
    // seq, and rebuilding them from the frame would be a second parser.
    expect(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!)).toEqual(first);
  });

  test('a Last-Event-ID that is not a seq is treated as absent', () => {
    expect(resumeFrom('7')).toBe(7);
    expect(resumeFrom(undefined)).toBe(0);
    expect(resumeFrom('nonsense')).toBe(0);
    // Clamped rather than rejected. `seq > -5` and `seq > 0` return the same rows,
    // and a 400 here is an error a browser's automatic reconnect cannot act on.
    expect(resumeFrom('-5')).toBe(0);
  });
});

describe('a dropped connection resumes exactly', () => {
  test('no missed and no duplicated events, and the two halves fold', async () => {
    let visible = 4;
    const read = async (_runId: string, afterSeq: number) =>
      log(visible).filter((event) => event.seq > afterSeq);

    // First connection: takes what exists, then drops.
    let firstBody = '';
    let firstOpen = true;
    const first = tailRun({
      runId: RUN_ID,
      afterSeq: 0,
      read,
      write: (chunk) => (firstBody += chunk),
      connected: () => firstOpen,
      pollMs: 5,
      until: (event) => event.seq === 4,
    });
    await first;
    firstOpen = false;

    const before = received(firstBody);
    expect(before.map((frame) => frame.id)).toEqual([1, 2, 3, 4]);

    // The run keeps going while nobody is listening. This is the case the design
    // has to survive: the store is the buffer, so nothing had to be held for us.
    visible = 7;

    // Second connection: resumes from the last id the client saw.
    let secondBody = '';
    let secondOpen = true;
    const second = tailRun({
      runId: RUN_ID,
      afterSeq: resumeFrom(String(before.at(-1)!.id)),
      read,
      write: (chunk) => (secondBody += chunk),
      connected: () => secondOpen,
      pollMs: 5,
      until: (event) => event.seq === 7,
    });
    await second;
    secondOpen = false;

    const after = received(secondBody);
    expect(after.map((frame) => frame.id)).toEqual([5, 6, 7]);

    // The real assertion. Concatenate what the two connections delivered and fold
    // it: a gap throws on the seq that never arrived, a duplicate throws on the seq
    // that arrived twice. Nothing else catches both.
    const delivered = [...before, ...after].map((frame) => frame.data);
    expect(delivered.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const state = fold(delivered);
    expect(state.lastSeq).toBe(7);
    expect(state.transcript).toHaveLength(5);
  });

  test('a read that ignores afterSeq still cannot produce a duplicate', async () => {
    // The store's query is what makes resumption correct, and this asserts the tail
    // does not depend on that being right. A duplicate is the one thing a folding
    // consumer cannot survive, so the tail refuses to emit one even when the layer
    // beneath it is broken.
    const broken = async () => log(5);
    let body = '';
    let open = true;
    await tailRun({
      runId: RUN_ID,
      afterSeq: 3,
      read: broken,
      write: (chunk) => (body += chunk),
      connected: () => open,
      pollMs: 5,
      until: (event) => event.seq === 5,
    });
    open = false;

    expect(received(body).map((frame) => frame.id)).toEqual([4, 5]);
  });
});

describe('over HTTP, as a browser would', () => {
  test('the server streams the run and honours Last-Event-ID', async () => {
    const server = await startStatusServer({
      read: async (_runId, afterSeq) => log(5).filter((event) => event.seq > afterSeq),
    });
    try {
      const url = `http://127.0.0.1:${server.port}/runs/${RUN_ID}/events`;
      // Read until the frames we expect have arrived, then abort — an SSE response
      // never ends on its own, which is the point of it.
      const take = async (headers: Record<string, string>, wanted: number) => {
        const controller = new AbortController();
        const response = await fetch(url, { headers, signal: controller.signal });
        expect(response.headers.get('content-type')).toBe('text/event-stream');
        let body = '';
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        while (received(body).length < wanted) {
          const { value, done } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
        }
        controller.abort();
        return received(body);
      };

      expect((await take({}, 5)).map((frame) => frame.id)).toEqual([1, 2, 3, 4, 5]);
      expect((await take({ 'last-event-id': '3' }, 2)).map((frame) => frame.id)).toEqual([4, 5]);

      const missing = await fetch(`http://127.0.0.1:${server.port}/nope`);
      expect(missing.status).toBe(404);
      // Read the body, or the socket stays open and `close()` waits on it.
      await missing.text();
    } finally {
      await server.close();
    }
  });
});

/**
 * The tail asks who you are, when told to (M10).
 *
 * On the hosted plane this endpoint streamed every event of any run to anyone who knew
 * its id. A uuid is hard to guess; that was never the same as being allowed. The test
 * above — no `authorize` — is the local surface and stays open on purpose.
 */
describe('the tail is authorized like the run page', () => {
  test('nobody gets 401, not yours gets 404, and only yours gets a stream', async () => {
    const server = await startStatusServer({
      read: async (_runId, afterSeq) => log(3).filter((event) => event.seq > afterSeq),
      authorize: async (runId, headers) =>
        headers['cookie'] === undefined ? 'anonymous' : runId === RUN_ID ? 'ok' : 'forbidden',
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;

      const nobody = await fetch(`${base}/runs/${RUN_ID}/events`);
      expect(nobody.status).toBe(401);
      expect(nobody.headers.get('content-type')).toBe('application/json');
      await nobody.text();

      // The same answer a run that does not exist gets: a stranger probing ids learns
      // nothing about which ones this service holds.
      // A uuid, because a real plane's authorizer refuses anything else before it asks
      // the database — the shape this test's fake authorizer stands in for.
      const theirs = await fetch(`${base}/runs/22222222-2222-4222-8222-222222222222/events`, {
        headers: { cookie: 'tf_session=x' },
      });
      expect(theirs.status).toBe(404);
      await theirs.text();

      const controller = new AbortController();
      const mine = await fetch(`${base}/runs/${RUN_ID}/events`, {
        headers: { cookie: 'tf_session=x' },
        signal: controller.signal,
      });
      expect(mine.status).toBe(200);
      expect(mine.headers.get('content-type')).toBe('text/event-stream');
      let body = '';
      const reader = mine.body!.getReader();
      const decoder = new TextDecoder();
      while (received(body).length < 3) {
        const { value, done } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
      }
      controller.abort();
      expect(received(body).map((frame) => frame.id)).toEqual([1, 2, 3]);
    } finally {
      await server.close();
    }
  });
});
