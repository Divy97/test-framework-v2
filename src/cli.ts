// CLI: `seed` appends the synthetic demo run; `replay <run_id>` reads the log
// and folds it. Replay is a pure read path — no code runs, no agent runs (ADR-0003).

import { apply, fold, type RunState } from './fold.js';
import { DEMO_RUN_ID, demoRunEvents } from './fixtures/demo-run.js';
import { appendEvent, connect, readRun } from './store.js';

const [command, arg] = process.argv.slice(2);

const client = connect();
await client.connect();

try {
  if (command === 'seed') {
    for (const event of demoRunEvents) await appendEvent(client, event);
    console.log(`seeded ${demoRunEvents.length} events for run ${DEMO_RUN_ID}`);
  } else if (command === 'replay') {
    const runId = arg ?? DEMO_RUN_ID;
    const events = await readRun(client, runId);
    if (events.length === 0) {
      console.error(`no events for run ${runId}`);
      process.exit(1);
    }
    console.log(`replay of run ${runId} — ${events.length} events, pure fold, nothing executes\n`);
    let state: RunState | undefined;
    for (const event of events) {
      state = state ? apply(state, event) : fold([event]);
      console.log(
        `  #${String(event.seq).padStart(2)}  ${event.ts}  ${event.type.padEnd(16)} → status=${state.status} attempt=${state.currentAttempt} reproduced=${state.reproduced}`,
      );
    }
    console.log('\nfinal RunState:');
    console.log(JSON.stringify(state, null, 2));
  } else {
    console.error('usage: cli.ts seed | replay <run_id>');
    process.exit(1);
  }
} finally {
  await client.end();
}
