// The blob store is where the bytes behind every sha256: ref live. If it can
// hand back something other than what was stored, every hash in the event log
// stops meaning anything.

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { blobPath, get, put } from '../src/blobs.js';

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
