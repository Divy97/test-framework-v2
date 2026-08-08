// Content-addressed blob store. Events stay small and carry sha256: refs
// (ADR-0001); the bytes themselves — stdout, diffs, transcripts — live here.
//
// ponytail: local directory, no S3. S3 becomes one adapter behind put/path
// when a run needs to outlive the machine; no event schema changes when it does.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ArtifactRef } from './events.js';

const PREFIX = 'sha256:';

export function blobPath(root: string, ref: ArtifactRef): string {
  const hex = ref.slice(PREFIX.length);
  // Two levels of fan-out: 256 dirs deep, so no single directory holds every blob.
  return join(root, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}

/** Store bytes, return the ref events will carry. Identical bytes rewrite the same path. */
export async function put(root: string, bytes: string | Buffer): Promise<ArtifactRef> {
  const ref: ArtifactRef = `${PREFIX}${createHash('sha256').update(bytes).digest('hex')}`;
  const path = blobPath(root, ref);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return ref;
}

export function get(root: string, ref: ArtifactRef): Promise<Buffer> {
  return readFile(blobPath(root, ref));
}
