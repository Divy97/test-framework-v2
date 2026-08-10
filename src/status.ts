// The status surface, wired to Postgres.
//
// `src/sse.ts` is the tail and takes its `read` as a function, so it can be tested
// over an in-memory log; this is the two lines that make it real. Separate files
// because the interesting properties — resumption, no duplicates, the heartbeat —
// have nothing to do with where the events are stored, and a test that needed a
// database to assert them would be a test nobody runs.
//
// The dashboard is M6. In v1.5 the user-facing surface is the issue comment; this
// exists so a run is watchable while it happens.

import { startStatusServer, type StatusServer } from './sse.js';
import { connect, readRunAfter } from './store.js';

export async function serveStatus(port?: number): Promise<StatusServer & { close: () => Promise<void> }> {
  const client = connect();
  await client.connect();
  const server = await startStatusServer({
    read: (runId, afterSeq) => readRunAfter(client, runId, afterSeq),
    ...(port === undefined ? {} : { port }),
  });
  return {
    ...server,
    close: async () => {
      await server.close();
      await client.end();
    },
  };
}

// Only when executed directly, so a test can import `serveStatus` without binding.
if (process.argv[1]?.endsWith('status.ts') || process.argv[1]?.endsWith('status.js')) {
  const server = await serveStatus(Number(process.env.PORT ?? 8787));
  console.log(`status: GET http://127.0.0.1:${server.port}/runs/<run_id>/events`);
}
