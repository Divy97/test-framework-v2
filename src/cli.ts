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
import { rebuildProjection } from './readmodel.js';
import { loadRecipe, parseRecipe, saveRecipe } from './recipe.js';
import { appendEvent, connect, readRun, ready, close } from './store.js';

const [command, arg, arg2] = process.argv.slice(2);

/** Print the draft, then ask. Anything but a literal `yes` refuses. */
async function confirm(question: string): Promise<boolean> {
  // Nothing to ask, so the answer is no. Without this the prompt is written to a stdin
  // nobody is reading, the promise never settles, node warns about an unsettled top-level
  // await, and the process exits **0** — a refusal that reports success, which is the one
  // outcome a script wrapping this must not see.
  if (!process.stdin.isTTY) {
    console.error(`${question} — refusing: nothing to read an answer from. Pass --yes to skip the prompt.`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [yes/no] `, resolve));
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

const client = connect();
await ready(client);

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
    console.log(`\ntier ${score.tier}, confidence ${score.score}/${score.ceiling}`);
    for (const ground of score.grounds) {
      console.log(`  +${String(ground.points).padStart(2)}  ${ground.claim}`);
      for (const ref of ground.evidence) console.log(`        ${ref}`);
    }
    console.log('  not measured:');
    for (const gap of score.unmeasured) console.log(`        ${gap}`);
  } else if (command === 'rebuild') {
    // The claim, as a command (M6c). "Delete the entire dashboard database and it
    // rebuilds from the log" is the most interesting property this milestone produces,
    // and a property is worth what the thing demonstrating it is worth — so it is a
    // command an operator can run rather than a sentence in a README.
    //
    // Safe by construction: `run_projection` holds no truth. Every column is recomputed
    // by `projectRun` from `events`, which is append-only and untouched here.
    const rebuilt = await rebuildProjection(client);
    console.log(`dropped the projection and replayed ${rebuilt} run(s) out of the log`);
    console.log('nothing was lost: every column is derived, and `events` was only read');
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
  } else if (command === 'schema') {
    // THE SCHEMA, applied to whatever `DATABASE_URL` says — which is the whole point.
    //
    // `npm run db:schema` shells into the local `docker compose` container and can never
    // reach anything else, so the only way to apply this to the hosted database was a
    // hand-typed `psql`. An undocumented manual step against production is the kind of
    // thing that is done wrong once and then nobody can say what state the database is in.
    //
    // No migration framework, and that is a property of the FILE rather than laziness:
    // every statement in `db/schema.sql` is `if not exists`, so it is idempotent, order
    // does not matter, and running it twice is running it once. Nothing to version. A
    // migration that ever has to TRANSFORM data — rename a column, backfill, drop
    // something — breaks that property and is the moment to build the versioned runner,
    // not before.
    //
    // It says which database first. `recipe approve` above argues that an approval which
    // does not show you what you are approving is not one; the same is true of a command
    // that writes to a database without telling you which. `DATABASE_URL` carries a
    // password, so only the host and the database name are printed.
    const sql = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
    const statements = sql.match(/^(create|alter|drop)\s/gim)?.length ?? 0;
    let where = 'the configured database';
    try {
      const url = new URL(process.env.DATABASE_URL ?? '');
      where = `${url.hostname}${url.pathname}`;
    } catch {
      // No URL to parse means `connect()` is about to fail with a better message than
      // anything invented here.
    }
    console.log(`${statements} statements from db/schema.sql, all idempotent.`);
    // `--yes` for a deploy script, which has no terminal to answer a prompt with.
    if (arg !== '--yes' && !(await confirm(`Apply them to ${where}?`))) {
      console.error('Not applied.');
      process.exit(1);
    }
    await client.query(sql);
    console.log(`Applied to ${where}.`);
  } else {
    console.error(
      'usage: cli.ts seed | replay <run_id> | rebuild | schema [--yes] | ' +
        'recipe show <owner/repo> | recipe approve <draft.json> <owner/repo>',
    );
    process.exit(1);
  }
} finally {
  await close(client);
}
