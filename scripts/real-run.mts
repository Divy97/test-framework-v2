// A real model run, against the demo repository. Not part of the suite.
//
// `npx tsx scripts/real-run.mts`, with a provider and key in `.env`. Needs Docker.
//
// It exists because the README and the milestone report now make claims about what a
// real model did — a Tier 2 pull request for eight cents — and a claim about an
// execution with no runnable thing behind it is the kind of claim this project refuses.
// Costs cents; prints what it spent from the engine's own totals.
//
// Mirrors `shipped-filter` in test/run.test.ts exactly, except that nothing scripts the
// agent's turns — a real model decides what to do.
//
// Everything else is identical to the test: the demo repository, the recipe, the sealed
// phase containers, the base-red/fix-green judgement, the PR body. The remote is a bare
// repo on disk and the GitHub API is a recording `fetch`, because no App is registered.
// So this proves 5c's done-when (a real agent, real tools, real tiering) and not 5e's.

process.loadEnvFile?.('.env');

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent, ArtifactRef } from '../src/events.js';
import { intake } from '../src/github.js';
import { runFromIssue } from '../src/run.js';
import { get } from '../src/blobs.js';
import { confidence } from '../src/confidence.js';
import { probeToolCalling } from '../src/openrouter.js';
import { demoRecipe, demoRepo, cleanupFixtures } from '../test/fixtures/repo.js';

const IMAGE = 'test-framework-v2-sandbox:test';
const AGENT_IMAGE = 'test-framework-v2-agent:test';
const model = process.env.ENGINE_MODEL!;
const apiKey = process.env.OPENROUTER_API_KEY!;

// The probe first: a model that cannot make a structured tool call must not be allowed
// to spend a whole run looking like an agent that chose to do nothing.
const probe = await probeToolCalling({ apiKey, model });
console.log(`probe: ${probe.ok ? 'PASS' : 'FAIL'} — ${probe.detail}`);
if (!probe.ok) process.exit(1);

console.log('building images …');
execFileSync('docker', ['build', '-q', '-t', IMAGE, '.'], { cwd: process.cwd() });
execFileSync('docker', ['build', '-q', '-t', AGENT_IMAGE, '-f', 'Dockerfile.agent', '.'], { cwd: process.cwd() });

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const fixture = demoRepo();
const bare = mkdtempSync(join(tmpdir(), 'realrun-remote-'));
execFileSync('git', ['clone', '--quiet', '--bare', fixture.repo, join(bare, 'repo.git')]);
const remotePath = join(bare, 'repo.git');
const blobs = mkdtempSync(join(tmpdir(), 'realrun-blobs-'));
writeFileSync(join(blobs, '.evidence-store'), '');

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

const body = '/api/orders?status=shipped returns every order, including pending ones.';
const mapped = intake('issues', {
  action: 'opened',
  issue: {
    number: 41,
    title: 'The shipped filter returns everything',
    body,
    html_url: 'https://github.com/o/r/issues/41',
  },
  repository: { full_name: 'o/r', default_branch: 'main' },
  installation: { id: 987654 },
})!;

const events: RunEvent[] = [];
console.log(`running ${model} against the demo repository …`);
const started = process.hrtime.bigint();

const result = await runFromIssue({
  intake: mapped,
  app: { appId: '123456', privateKeyPem: PEM, api: 'https://api.test.invalid', fetch: recorder },
  recipe: demoRecipe(8096),
  image: IMAGE,
  agentImage: AGENT_IMAGE,
  blobRoot: blobs,
  append: async (event) => {
    events.push(event);
    console.log(`  event ${String(events.length).padStart(3)} ${event.type}`);
  },
  remote: () => remotePath,
  flakeRuns: 2,
  symptomPattern: 'status=shipped returns every order',
  loop: { provider: 'openrouter', apiKey, model, timeoutMs: 900_000 },
});

const seconds = Number(process.hrtime.bigint() - started) / 1e9;

console.log('\n================ RESULT ================');
console.log(`wall clock          ${seconds.toFixed(0)}s`);
console.log(`ENV_READY           ${events.some((e) => e.type === 'ENV_READY')}`);
console.log(`reproduced          ${result.state.reproduced}`);
console.log(`registered repro    ${result.state.registeredRepro?.command ?? '(none)'}`);
for (const run of result.state.testRuns) {
  console.log(`  ${run.phase.padEnd(5)} exit=${run.exit_code} symptom_matched=${run.symptom_matched}`);
}
// The second arm. `unmeasured` here would mean the suite never ran on both commits,
// which for a recipe that declares `test` is a bug rather than a property of the repo.
console.log(`regression          ${result.state.regression}`);
for (const run of result.state.suiteRuns) {
  console.log(`  suite ${run.phase.padEnd(4)} exit=${run.exit_code} \`${run.command}\``);
}
console.log(`fix touched         ${result.state.fixDiff?.changed_files?.join(', ') ?? '(no fix)'}`);
const verdict = confidence(result.state);
console.log(`tier                ${verdict.tier} (confidence ${verdict.score}/${verdict.ceiling})`);
console.log(`PR                  ${result.prUrl ?? '(none)'}`);

// What it cost, from the engine's own totals rather than an estimate.
for (const entry of result.usage ?? []) {
  const u = entry.usage;
  const dollars = (u.input_tokens / 1e6) * 0.6 + (u.output_tokens / 1e6) * 2.5;
  console.log(
    `usage ${entry.phase.padEnd(6)} turns=${u.turns} in=${u.input_tokens} out=${u.output_tokens} ` +
      `≈ $${dollars.toFixed(4)}`,
  );
}

// The decisive question when a run is not credited: what did the reproduction actually
// PRINT, and did the reported symptom appear in it? Without this the difference between
// "the model wrote a test that fails for the wrong reason" and "our matcher is broken"
// is invisible, and only one of those is the model's fault.
console.log(`blobs               ${blobs}`);

// The engine's own account of why it stopped, rather than an inference from what is
// missing. An abort and a Tier 3 look similar from the outside and are not the same.
for (const event of events.filter((e) => e.type === 'VERIFICATION_ABORTED')) {
  console.log(`ABORTED             ${JSON.stringify(event.payload)}`);
}
for (const [index, event] of events.filter((e) => e.type === 'AGENT_FINISHED').entries()) {
  console.log(`agent ${index} finished     ${JSON.stringify(event.payload)}`);
}

console.log('\n--- what the base run printed, and what was looked for ---');
console.log(`symptom pattern: /status=shipped returns every order/`);
for (const event of events.filter((e) => e.type === 'TEST_RUN')) {
  const payload = event.payload as { phase: string; exit_code: number; symptom_matched?: boolean; stdout_hash: ArtifactRef };
  const output = (await get(blobs, payload.stdout_hash)).toString();
  console.log(`\n[${payload.phase}] exit=${payload.exit_code} symptom_matched=${payload.symptom_matched}`);
  console.log(output.slice(0, 2500));
}

// Any loop_error is the thing most worth seeing, and it is buried in a blob.
const messages = await Promise.all(
  events
    .filter((e) => e.type === 'AGENT_MESSAGE')
    .map(async (e) => {
      const payload = e.payload as { claimed_type?: string; raw_hash: ArtifactRef };
      return { type: payload.claimed_type, raw: (await get(blobs, payload.raw_hash)).toString() };
    }),
);
const errors = messages.filter((m) => m.type === 'loop_error');
if (errors.length > 0) {
  console.log('\n--- loop errors ---');
  for (const error of errors) console.log(error.raw.slice(0, 1500));
}

// Split at the second ENV_READY, because a flat transcript hides which agent said what
// — and "the repro agent was excellent" plus "the fix agent did nothing" read as one
// mediocre run when they are merged.
const phaseBoundary = events.findIndex(
  (e, i) => e.type === 'ENV_READY' && events.slice(0, i).some((p) => p.type === 'AGENT_FINISHED'),
);
const agentMessageIndex = events
  .map((e, i) => ({ e, i }))
  .filter(({ e }) => e.type === 'AGENT_MESSAGE')
  .map(({ i }) => i);
const fixStarts = agentMessageIndex.findIndex((i) => i > phaseBoundary);

const phases: [string, typeof messages][] = [
  ['repro', fixStarts === -1 ? messages : messages.slice(0, fixStarts)],
  ['fix', fixStarts === -1 ? [] : messages.slice(fixStarts)],
];
for (const [name, lines] of phases) {
  if (lines.length === 0) continue;
  console.log(`\n--- ${name} agent: ${lines.length} lines, last 8 ---`);
  for (const line of lines.slice(-8)) console.log(`  [${line.type}] ${line.raw.slice(0, 400)}`);
}

console.log(`\ntranscript lines    ${messages.length}`);
const toolCalls = messages.filter((m) => m.type === 'tool_use');
console.log(`tool calls          ${toolCalls.length}`);
for (const toolCall of toolCalls) console.log(`  ${toolCall.raw.slice(0, 160)}`);

const pr = apiCalls.find((c) => c.url.endsWith('/pulls'))?.body as { title?: string; body?: string } | undefined;
if (pr) {
  console.log('\n--- PULL REQUEST BODY ---');
  console.log(pr.title);
  console.log(pr.body);
}

cleanupFixtures();
