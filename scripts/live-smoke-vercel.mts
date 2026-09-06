// The live smoke test 10e deferred: the WHOLE engine, on real Firecracker microVMs.
//
// `scripts/real-run.mts` with one thing swapped. Same demo repository, same recipe, same
// real model, same recording GitHub — and `executor: vercelExecutor(...)` against real
// sandboxes created from the images `npm run images:push` published, instead of Docker
// on this machine.
//
// It exists because every claim `executor-vercel.ts` makes is currently a claim about a
// fake. Three live runs through the plane have each died on a different assumption about
// our images, one per round trip, each costing a merge and a worker restart to find. This
// finds the rest in one place, without the plane, the queue or a worker in the way.
//
//   ENGINE_IMAGE=… ENGINE_AGENT_IMAGE=… npx tsx scripts/live-smoke-vercel.mts
//
// Needs a `vercel login` (or VERCEL_TOKEN + team + project), a model key in `.env`, and
// the two pushed digests. No Docker. Costs cents of model and a few minutes of sandbox.
process.loadEnvFile?.('.env');

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent } from '../src/events.js';
import { intake } from '../src/github.js';
import { runFromIssue } from '../src/run.js';
import { confidence } from '../src/confidence.js';
import { probeToolCalling } from '../src/openrouter.js';
import { vercelClient } from '../src/vercel-client.js';
import { vercelExecutor } from '../src/executor-vercel.js';
import { demoRecipe, demoRepo, cleanupFixtures } from '../test/fixtures/repo.js';

const IMAGE = process.env.ENGINE_IMAGE;
const AGENT_IMAGE = process.env.ENGINE_AGENT_IMAGE;
const model = process.env.ENGINE_MODEL;
const apiKey = process.env.OPENROUTER_API_KEY;
if (!IMAGE?.includes('@sha256:') || !AGENT_IMAGE?.includes('@sha256:')) {
  // A tag rather than a digest is the staleness `push-images.sh` exists to prevent, and
  // a local tag is a name the platform cannot resolve at all.
  console.error('ENGINE_IMAGE and ENGINE_AGENT_IMAGE must be pushed references pinned by digest — see scripts/push-images.sh');
  process.exit(2);
}
if (!model || !apiKey) {
  console.error('need ENGINE_MODEL and OPENROUTER_API_KEY in .env');
  process.exit(2);
}

const probe = await probeToolCalling({ apiKey, model });
console.log(`probe: ${probe.ok ? 'PASS' : 'FAIL'} — ${probe.detail}`);
if (!probe.ok) process.exit(1);

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const fixture = demoRepo();
const bare = mkdtempSync(join(tmpdir(), 'smoke-remote-'));
execFileSync('git', ['clone', '--quiet', '--bare', fixture.repo, join(bare, 'repo.git')]);
const remotePath = join(bare, 'repo.git');
const blobs = mkdtempSync(join(tmpdir(), 'smoke-blobs-'));
writeFileSync(join(blobs, '.evidence-store'), '');

const recorder = (async (url: string | URL | Request, init?: RequestInit) => {
  const target = String(url);
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
  issue: {
    number: 41,
    title: 'The shipped filter returns everything',
    body: '/api/orders?status=shipped returns every order, including pending ones.',
    html_url: 'https://github.com/o/r/issues/41',
  },
  repository: { full_name: 'o/r', default_branch: 'main' },
  installation: { id: 987654 },
})!;

const ledger = { path: join(blobs, '..', `smoke-sandboxes-${process.pid}.jsonl`) };
const executor = vercelExecutor({
  client: await vercelClient({ credentials: {}, region: process.env.ENGINE_VERCEL_REGION ?? 'iad1' }),
  ledger,
  tags: { engine: 'test-framework-v2', worker: `smoke-${process.pid}` },
});

const events: RunEvent[] = [];
console.log(`running ${model} on Vercel sandboxes …`);
console.log(`  base  ${IMAGE}`);
console.log(`  agent ${AGENT_IMAGE}`);
const started = process.hrtime.bigint();

let result;
try {
  result = await runFromIssue({
    intake: mapped,
    app: { appId: '123456', privateKeyPem: PEM, api: 'https://api.test.invalid', fetch: recorder },
    recipe: demoRecipe(8096),
    image: IMAGE,
    agentImage: AGENT_IMAGE,
    blobRoot: blobs,
    executor,
    append: async (event) => {
      events.push(event);
      const detail =
        event.type === 'VERIFICATION_ABORTED'
          ? ` — ${(event.payload as { cause?: string; reason?: string }).cause}: ${(event.payload as { reason?: string }).reason}`
          : event.type === 'SANDBOX_SEALED'
            ? ` — ${JSON.stringify((event.payload as { probe?: unknown }).probe)}`
            : '';
      console.log(`  event ${String(events.length).padStart(3)} ${event.type}${detail}`);
    },
    remote: () => remotePath,
    flakeRuns: 2,
    symptomPattern: 'status=shipped returns every order',
    loop: { provider: 'openrouter', apiKey, model, timeoutMs: 900_000 },
  });
} finally {
  // Whatever happened, nothing keeps billing. `sweep()` reads this run's own ledger and
  // this run's own tag, so it cannot touch a sandbox some other process created.
  const stopped = await executor.sweep().catch((error: unknown) => {
    console.error(`sweep failed: ${String((error as Error).message ?? error)}`);
    return 0;
  });
  console.log(`\nswept ${stopped} sandbox(es)`);
  cleanupFixtures();
}

const seconds = Number(process.hrtime.bigint() - started) / 1e9;
console.log('\n================ RESULT ================');
console.log(`wall clock          ${seconds.toFixed(0)}s`);
console.log(`ENV_READY           ${events.some((e) => e.type === 'ENV_READY')}`);
// The reason this substrate was chosen, read off the log rather than off the policy we
// asked for: every seal here is what a probe INSIDE the sandbox found.
for (const event of events.filter((e) => e.type === 'SANDBOX_SEALED')) {
  const p = event.payload as { phase: string; policy: string; probe: unknown };
  console.log(`seal ${p.phase.padEnd(6)} ${p.policy} ${JSON.stringify(p.probe)}`);
}
console.log(`reproduced          ${result.state.reproduced}`);
console.log(`registered repro    ${result.state.registeredRepro?.command ?? '(none)'}`);
for (const run of result.state.testRuns) {
  console.log(`  ${run.phase.padEnd(5)} exit=${run.exit_code} symptom_matched=${run.symptom_matched}`);
}
console.log(`regression          ${result.state.regression}`);
console.log(`fix touched         ${result.state.fixDiff?.changed_files?.join(', ') ?? '(no fix)'}`);
const verdict = confidence(result.state);
console.log(`tier                ${verdict.tier} (confidence ${verdict.score}/${verdict.ceiling})`);
console.log(`PR                  ${result.prUrl ?? '(none)'}`);
for (const entry of result.usage ?? []) {
  const u = entry.usage;
  console.log(`usage ${entry.phase.padEnd(6)} turns=${u.turns} in=${u.input_tokens} out=${u.output_tokens}`);
}
console.log(`blobs               ${blobs}`);
