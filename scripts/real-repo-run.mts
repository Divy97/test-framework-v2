// A real model against a REAL repository, with real dependencies.
//
// `scripts/real-run.mts` drives the demo, which has zero dependencies by design — so it
// exercises everything except the one thing milestone 7's 7e is about: whether the judge
// can run a reproduction in a project that needs `install`. Until the environment
// snapshot landed the answer was no, and the failure was silent in the worst way: exit
// 127, no symptom match, and a confident "we could not reproduce your bug".
//
// Deliberately parameterised by environment rather than hard-coded, because the whole
// point is that the subject is not ours:
//
//   REPO=/path/to/repo  ISSUE_TITLE=…  ISSUE_BODY=…  RECIPE=/path/to/recipe.json
//   ENGINE_MODEL=anthropic/claude-sonnet-5  npx tsx scripts/real-repo-run.mts
//
// The repository is never written to. It is bare-cloned to a temp directory, the agent
// works in a clone of THAT, and the pull request is opened against a recording `fetch` —
// no App is registered, so nothing reaches GitHub.

process.loadEnvFile?.('.env');

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactRef, RunEvent } from '../src/events.js';
import { intake } from '../src/github.js';
import { runFromIssue } from '../src/run.js';
import { get } from '../src/blobs.js';
import { confidence } from '../src/confidence.js';
import { parseRecipe } from '../src/recipe.js';
import { probeToolCalling } from '../src/openrouter.js';

const REPO = process.env.REPO;
const RECIPE = process.env.RECIPE;
const TITLE = process.env.ISSUE_TITLE;
const BODY = process.env.ISSUE_BODY ?? '';
if (!REPO || !RECIPE || !TITLE) {
  console.error('need REPO, RECIPE and ISSUE_TITLE — see the header');
  process.exit(1);
}

const IMAGE = 'test-framework-v2-sandbox:test';
const AGENT_IMAGE = 'test-framework-v2-agent:test';
const model = process.env.ENGINE_MODEL!;
const apiKey = process.env.OPENROUTER_API_KEY!;

const probe = await probeToolCalling({ apiKey, model });
console.log(`probe: ${probe.ok ? 'PASS' : 'FAIL'} — ${probe.detail}`);
if (!probe.ok) process.exit(1);

// Validated before a container starts. A recipe that fails `parseRecipe` inside the
// sandbox reads as the user's project being broken rather than the recipe being wrong.
const recipe = parseRecipe(JSON.parse(readFileSync(RECIPE, 'utf8')));
console.log(`recipe: install=${recipe.install ?? '(none)'} test=${recipe.test ?? '(none)'}`);

console.log('building images …');
execFileSync('docker', ['build', '-q', '-t', IMAGE, '.'], { cwd: process.cwd() });
execFileSync('docker', ['build', '-q', '-t', AGENT_IMAGE, '-f', 'Dockerfile.agent', '.'], { cwd: process.cwd() });

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

// A BARE clone. The subject repository is read once and never written to.
const bare = mkdtempSync(join(tmpdir(), 'realrepo-'));
const remotePath = join(bare, 'repo.git');
execFileSync('git', ['clone', '--quiet', '--bare', REPO, remotePath]);
const blobs = mkdtempSync(join(tmpdir(), 'realrepo-blobs-'));
writeFileSync(join(blobs, '.evidence-store'), '');
console.log(`subject: ${REPO} -> ${remotePath}`);

const apiCalls: { url: string; body: unknown }[] = [];
const recorder = (async (url: string | URL | Request, init?: RequestInit) => {
  const target = String(url);
  apiCalls.push({ url: target, body: init?.body ? JSON.parse(String(init.body)) : null });
  if (target.endsWith('/access_tokens')) return new Response(JSON.stringify({ token: 'ghs_minted' }), { status: 201 });
  if (target.endsWith('/pulls'))
    return new Response(
      JSON.stringify({ number: 1, head: { sha: 'a'.repeat(40) }, html_url: 'https://github.com/o/r/pull/1' }),
      { status: 201 },
    );
  return new Response('{}', { status: 201 });
}) as typeof fetch;

const mapped = intake('issues', {
  action: 'opened',
  issue: { number: 1, title: TITLE, body: BODY, html_url: 'https://github.com/o/r/issues/1' },
  repository: { full_name: 'o/r', default_branch: 'main' },
  installation: { id: 987654 },
})!;
if (mapped.kind !== 'issue') throw new Error('the delivery did not map to an issue');

const events: RunEvent[] = [];
console.log(`\nrunning ${model} against a repository with real dependencies …`);
const started = process.hrtime.bigint();

const result = await runFromIssue({
  intake: mapped,
  app: { appId: '123456', privateKeyPem: PEM, api: 'https://api.test.invalid', fetch: recorder },
  recipe,
  image: IMAGE,
  agentImage: AGENT_IMAGE,
  blobRoot: blobs,
  append: async (event) => {
    events.push(event);
    console.log(`  event ${String(events.length).padStart(3)} ${event.type}`);
  },
  remote: () => remotePath,
  flakeRuns: 2,
  loop: { provider: 'openrouter', apiKey, model, timeoutMs: 900_000 },
});

const seconds = Number(process.hrtime.bigint() - started) / 1e9;
const verdict = confidence(result.state);

console.log('\n================ RESULT ================');
console.log(`wall clock          ${seconds.toFixed(0)}s`);
console.log(`ENV_READY           ${events.some((e) => e.type === 'ENV_READY')}`);
console.log(`reproduced          ${result.state.reproduced}`);
console.log(`registered repro    ${result.state.registeredRepro?.command ?? '(none)'}`);
for (const run of result.state.testRuns) {
  console.log(`  ${run.phase.padEnd(7)} exit=${run.exit_code} symptom_matched=${run.symptom_matched}`);
}
console.log(`regression          ${result.state.regression}`);
for (const run of result.state.suiteRuns) {
  console.log(`  suite ${run.phase.padEnd(4)} exit=${run.exit_code} \`${run.command}\``);
}
console.log(`fix touched         ${result.state.fixDiff?.changed_files?.join(', ') ?? '(no fix)'}`);
console.log(`tier                ${verdict.tier} (confidence ${verdict.score}/${verdict.ceiling})`);
console.log(`PR                  ${result.prUrl ?? '(none)'}`);
for (const entry of result.usage ?? []) {
  const u = entry.usage;
  console.log(`usage ${entry.phase.padEnd(6)} turns=${u.turns} in=${u.input_tokens} out=${u.output_tokens}`);
}
console.log(`blobs               ${blobs}`);

for (const event of events.filter((e) => e.type === 'VERIFICATION_ABORTED')) {
  console.log(`ABORTED             ${JSON.stringify(event.payload)}`);
}
for (const event of events.filter((e) => e.type === 'AGENT_FINISHED')) {
  console.log(`agent finished      ${JSON.stringify(event.payload)}`);
}

console.log('\n--- what each phase printed ---');
for (const event of events.filter((e) => e.type === 'TEST_RUN' || e.type === 'SUITE_RUN')) {
  const p = event.payload as { phase: string; exit_code: number; stdout_hash: ArtifactRef };
  const output = (await get(blobs, p.stdout_hash)).toString();
  console.log(`\n[${event.type} ${p.phase}] exit=${p.exit_code}`);
  console.log(output.slice(0, 1800));
}

const pr = apiCalls.find((c) => c.url.endsWith('/pulls'))?.body as { title?: string; body?: string } | undefined;
if (pr) {
  console.log('\n--- PULL REQUEST ---');
  console.log(pr.title);
  console.log(pr.body);
}
