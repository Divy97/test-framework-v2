// The blob store is where the bytes behind every sha256: ref live. If it can
// hand back something other than what was stored, every hash in the event log
// stops meaning anything.

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { blobPath, ensureBlobRoot, get, put } from '../src/blobs.js';

let root: string;
const makeRoot = () => (root = mkdtempSync(join(tmpdir(), 'blob-test-')));
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('round-trips bytes under a ref derived from their content', async () => {
  const store = makeRoot();
  const ref = await put(store, 'observed output\n');

  expect(ref).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect((await get(store, ref)).toString()).toBe('observed output\n');
  // Identical bytes are the same artifact, not a second one.
  expect(await put(store, 'observed output\n')).toBe(ref);
});

test('leaves no staging files behind', async () => {
  const store = makeRoot();
  const ref = await put(store, 'some bytes');

  const dir = blobPath(store, ref).split('/').slice(0, -1).join('/');
  expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
});

test('refuses to return bytes that are not what the ref claims', async () => {
  const store = makeRoot();
  const ref = await put(store, 'the real observation\n');

  // Stand in for the outcomes that matter: a crash mid-write, a truncated
  // artifact, a tampered evidence file. All present as a valid-looking path.
  writeFileSync(blobPath(store, ref), 'something else entirely\n');

  await expect(get(store, ref)).rejects.toThrow(/not the evidence it claims/);
});

test('a store is only usable once it carries its sentinel', async () => {
  // The bug this pins cost a run. `runner-main.ts` created its blob root with a bare
  // `mkdir`, and `orchestrate` refuses a root with no `.evidence-store` — so every
  // runner would have failed its FIRST job, on a message about a mount it does not
  // have. Found by running the plane and a runner against each other before deploying
  // either; there was no test between them because there was no test of startup.
  const root = join(mkdtempSync(join(tmpdir(), 'engine-ensure-')), 'not', 'made', 'yet');
  await ensureBlobRoot(root);
  expect(existsSync(join(root, '.evidence-store'))).toBe(true);

  // Idempotent, and non-destructive: a store that already holds evidence must survive
  // the next process that opens it.
  const ref = await put(root, 'an artifact from an earlier run\n');
  await ensureBlobRoot(root);
  expect((await get(root, ref)).toString()).toContain('an earlier run');
});
