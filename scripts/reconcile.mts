// Reconcile an installation on demand, the way a webhook delivery would (10n).
//
// Why this exists: reconciliation and drafting are reachable from exactly one place —
// `planeIntake`, on an `installation` or `installation_repositories` delivery. That is
// the right design and it has never once run in production. GitHub reports ZERO
// deliveries to this App, ever; the 177 installation rows in the hosted database were
// put there by an ad-hoc script, and a repository connected today is invisible to the
// plane until something asks GitHub what the installation covers.
//
// So this is the fallback, not the mechanism. If deliveries are working, installing the
// App does all of it and this script is unnecessary. It is here because "the webhook is
// Active" is a checkbox in somebody's App settings and the difference between a working
// onboarding and a silent one, and an operator needs a way to get unstuck that does not
// depend on it.
//
//   npm run reconcile -- 152989253            # asks first
//   npm run reconcile -- 152989253 --yes      # for a deploy script
//   npm run reconcile -- 152989253 --no-draft # repositories only, propose nothing
//
// It does what a delivery does and nothing more: make `installations` match what GitHub
// says the installation covers, then queue one `draft` job per repository that has no
// recipe and no draft. A draft is never a recipe — it lands in `recipe_drafts` and a
// human still approves it (ADR-0013).

import { createInterface } from 'node:readline';
import { installationToken } from '../src/github.js';
import { reconcileInstallation } from '../src/installations.js';
import { enqueueJob } from '../src/plane.js';
import { loadDraft } from '../src/drafts.js';
import { loadRecipe } from '../src/recipe.js';
import { listInstallations } from '../src/installations.js';
import { close, connect, ready } from '../src/store.js';

const args = process.argv.slice(2);
const assumeYes = args.includes('--yes');
const noDraft = args.includes('--no-draft');
const asked = args.find((arg) => !arg.startsWith('--'));

/** Which database, without the password. Same reason `pair-worker` prints it. */
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

const installationId = Number(asked);
if (!Number.isInteger(installationId) || installationId <= 0) {
  console.error('usage: npm run reconcile -- <installation id> [--yes] [--no-draft]');
  process.exit(1);
}

const appId = process.env.GITHUB_APP_ID;
const keyPath = process.env.GITHUB_PRIVATE_KEY_PATH;
if (!appId || !keyPath) {
  console.error('GITHUB_APP_ID and GITHUB_PRIVATE_KEY_PATH are required — this asks GitHub, as the App.');
  process.exit(1);
}

const { readFileSync } = await import('node:fs');
const privateKeyPem = readFileSync(keyPath, 'utf8');

if (
  !assumeYes &&
  !(await confirm(
    `Reconcile installation ${installationId} against ${where()}` +
      `${noDraft ? '' : ', and queue drafting for every repository with no recipe'}?`,
  ))
) {
  console.error('nothing done.');
  process.exit(1);
}

const client = await connect();
try {
  await ready(client);
  const app = { appId, privateKeyPem };
  const { held, removed } = await reconcileInstallation(client, installationId, (id) => installationToken(app, id));
  console.log(`installation ${installationId}: reconciled to ${held} held${removed > 0 ? `, ${removed} marked removed` : ''}`);

  if (noDraft) process.exit(0);

  // Every repository the installation now holds, not a delivery's delta — there is no
  // delta here, and the whole reason to run this is that the deliveries carrying them
  // never arrived.
  const repos = (await listInstallations(client))
    .filter((one) => one.installationId === installationId)
    .map((one) => one.repo);
  let queued = 0;
  for (const repo of repos) {
    try {
      if ((await loadRecipe(client, repo)) !== null) continue;
      if ((await loadDraft(client, repo)) !== null) continue;
      await enqueueJob(client, {
        installationId,
        repo,
        kind: 'draft',
        intake: { kind: 'draft', repo },
      });
      queued += 1;
      console.log(`${repo}: queued a drafting run — a worker will propose a recipe`);
    } catch (error) {
      // Per repository, exactly as the delivery path does: one failure must not cost the
      // others their draft.
      console.log(`${repo}: could not queue a drafting run — ${String(error)}`);
    }
  }
  console.log(`${queued} drafting run(s) queued across ${repos.length} repository(ies).`);
} finally {
  await close(client);
}
