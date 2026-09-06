// Pair the worker WE operate: a runner that belongs to no installation (M10, 10e).
//
// This is the only thing in the repository that writes `installation_id = null`, and it
// is deliberately a script rather than a route. `pairRunner` is reachable from the
// dashboard, where the installation comes from what the signed-in person can see; a
// global runner is not something a user should be able to mint, because it can claim
// everyone's work. So it lives here, needs `DATABASE_URL`, and is run by whoever operates
// the deployment.
//
//   npm run worker:pair -- "the worker"          # asks first
//   npm run worker:pair -- "the worker" --yes    # for a deploy script
//
// The token is shown ONCE. Only its hash is stored, so a lost token is re-paired rather
// than recovered — the same rule the dashboard's pairing page follows.

import { createInterface } from 'node:readline';
import { pairRunner } from '../src/plane.js';
import { close, connect, ready } from '../src/store.js';

/** `--yes` anywhere in the arguments; the rest is the name. */
const args = process.argv.slice(2);
const assumeYes = args.includes('--yes');
const name = args.find((arg) => arg !== '--yes') ?? 'the hosted worker';

/** Which database, without the password. Same reason `cli.ts schema` prints it. */
const where = (): string => {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    return `${url.hostname}${url.pathname}`;
  } catch {
    return 'the configured database';
  }
};

const confirm = async (question: string): Promise<boolean> => {
  if (!process.stdin.isTTY) {
    console.error(`${question} — refusing: nothing to read an answer from.`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [yes/no] `, resolve));
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
};

const client = connect();
await ready(client);
try {
  console.log(`This mints a runner token that can claim ANY installation's jobs.`);
  console.log(`Name: ${name}`);
  // `--yes` for a deploy script, which has no terminal to answer a prompt with — the
  // same escape `cli.ts schema` carries, and for the same reason: without it the guard
  // below refuses a piped answer, correctly, and the script cannot be automated at all.
  if (!assumeYes && !(await confirm(`Pair a global worker against ${where()}?`))) {
    console.error('Not paired.');
    process.exit(1);
  }
  const { runner, token } = await pairRunner(client, { installationId: null, name });
  console.log(`\npaired ${runner.id}\n`);
  console.log(`  ENGINE_RUNNER_TOKEN=${token}\n`);
  console.log('Shown once — only its hash is stored. Set it with:');
  console.log(`  fly secrets set ENGINE_RUNNER_TOKEN='${token}' -a test-framework-worker`);
} finally {
  await close(client);
}
