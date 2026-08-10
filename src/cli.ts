// CLI: `seed` appends the synthetic demo run; `replay <run_id>` reads the log
// and folds it. Replay is a pure read path — no code runs, no agent runs (ADR-0003).
//
// And `recipe`, which is the only place in the product that asks a human for
// anything (ADR-0013). Until there is a UI, approval is a command that PRINTS the
// draft and takes a yes — deliberately in that order, because the approval is the
// only control there is on a stored command we will execute, and an approval that
// does not show you what you are approving is not one.

import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { confidence } from './confidence.js';
import { apply, fold, type RunState } from './fold.js';
import { DEMO_RUN_ID, demoRunEvents } from './fixtures/demo-run.js';
import { loadRecipe, parseRecipe, saveRecipe } from './recipe.js';
import { appendEvent, connect, readRun } from './store.js';

const [command, arg, arg2] = process.argv.slice(2);

/** Print the draft, then ask. Anything but a literal `yes` refuses. */
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [yes/no] `, resolve));
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

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
        `  #${String(event.seq).padStart(2)}  ${event.ts}  ${event.type.padEnd(20)} → status=${state.status} attempt=${state.currentAttempt} reproduced=${state.reproduced}`,
      );
    }
    console.log('\nfinal RunState:');
    console.log(JSON.stringify(state, null, 2));

    // The projection, beside the state it is derived from. Replay is the whole
    // point: this number is recomputed from the log every time, never stored.
    const score = confidence(state!);
    console.log(`\ntier ${score.tier}, confidence ${score.score}/85`);
    for (const ground of score.grounds) {
      console.log(`  +${String(ground.points).padStart(2)}  ${ground.claim}`);
      for (const ref of ground.evidence) console.log(`        ${ref}`);
    }
    console.log('  not measured:');
    for (const gap of score.unmeasured) console.log(`        ${gap}`);
  } else if (command === 'recipe' && arg === 'show') {
    const recipe = await loadRecipe(client, arg2!);
    console.log(recipe === null ? `no recipe for ${arg2}` : JSON.stringify(recipe, null, 2));
  } else if (command === 'recipe' && arg === 'approve') {
    // The draft comes from a file rather than from a live drafting session, because
    // the drafting session needs a model credential and the approval does not. The
    // agent writes the JSON; a human reads it here; only then is it stored.
    const draft = parseRecipe(JSON.parse(await readFile(arg2!, 'utf8')));
    const repo = process.argv[5];
    if (!repo) {
      console.error('usage: cli.ts recipe approve <draft.json> <owner/repo>');
      process.exit(1);
    }
    console.log(`\nThe recipe drafted for ${repo}:\n`);
    console.log(JSON.stringify(draft, null, 2));
    console.log(
      '\nEvery run against this repository will execute these commands verbatim, in the\n' +
        'agent sandbox, with a package registry reachable. Nothing sandboxes them from the\n' +
        'sandbox — you are the control.\n',
    );
    if (!(await confirm(`Store this as the recipe for ${repo}?`))) {
      console.log('Not stored.');
      process.exit(1);
    }
    await saveRecipe(client, repo, draft);
    console.log(`Stored. ${repo} will replay this and never re-derive it.`);
  } else {
    console.error(
      'usage: cli.ts seed | replay <run_id> | recipe show <owner/repo> | ' +
        'recipe approve <draft.json> <owner/repo>',
    );
    process.exit(1);
  }
} finally {
  await client.end();
}
