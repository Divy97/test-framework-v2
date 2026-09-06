// Item 15. Does `sweep()` actually stop anything?
//
// It never has. `SdkSandbox` — a structural type this repository wrote itself, so the
// compiler checked our claim against our claim — declared `sandboxId`, a property
// `@vercel/sandbox@3.2.1` does not have. Every `id` was `undefined`: the ledger recorded
// nothing usable, `Sandbox.get({sandboxId})` answered `Named sandbox 'undefined' not
// found`, and `Sandbox.list` returns a Paginator that `.map` throws on — which `sweep()`
// swallows by design, because a listing that fails must not stop a worker from taking
// work.
//
// Three failures, all silent, and a green suite through every one of them: the fake's ids
// are `s-1`, `s-2`, and a fake cannot disagree with the SDK about the SDK.
//
// What it costs when it is broken: a worker that dies mid-run leaves microVMs billing
// until their own session ceiling, which is 45 minutes each on Hobby.
//
// The control is the second sandbox. A sweep that stopped everything would pass a test
// that only checked its own — and stopping every worker's machines on boot is the outage
// this tagging exists to prevent.
import { vercelClient } from '../../src/vercel-client.js';
import { vercelExecutor } from '../../src/executor-vercel.js';
import { verdict, record, done, REGION } from './lib.js';

const IMAGE = process.env.ENGINE_VERCEL_IMAGE ?? 'vercel/sandbox/node:22';
const mine = `sweep-${process.pid}`;
const theirs = `sweep-other-${process.pid}`;

const client = await vercelClient({ credentials: {}, region: REGION });

// Two sandboxes, same engine, different workers. Neither is stopped.
const ours = await client.create({
  from: { image: IMAGE }, policy: 'deny-all', timeoutMs: 10 * 60_000,
  tags: { engine: 'test-framework-v2', worker: mine },
});
const other = await client.create({
  from: { image: IMAGE }, policy: 'deny-all', timeoutMs: 10 * 60_000,
  tags: { engine: 'test-framework-v2', worker: theirs },
});
record('15', `ours ${ours.id}, theirs ${other.id}`);
verdict('15.named', typeof ours.id === 'string' && ours.id.length > 0, `a created sandbox has an id: ${JSON.stringify(ours.id)}`);

try {
  // No ledger: this exercises the TAG half alone, which is the half that was dead and
  // the half `fly.worker.toml` says covers a lost disk.
  const executor = vercelExecutor({ client, tags: { engine: 'test-framework-v2', worker: mine } });
  const stopped = await executor.sweep();
  record('15', `sweep stopped ${stopped}`);
  verdict('15.stops-ours', stopped === 1, `expected exactly 1, got ${stopped}`);

  const after = await client.get(other.id);
  const still = after ? await after.stop().then(() => true, () => false) : false;
  verdict('15.spares-theirs', still, "the other worker's sandbox was still running for us to stop");
} finally {
  for (const sandbox of [ours, other]) await sandbox.stop().catch(() => {});
}
done();
