// Content-addressed blob store. Events stay small and carry sha256: refs
// (ADR-0001); the bytes themselves — stdout, diffs, transcripts — live here.
//
// ponytail: local directory, no S3. S3 becomes one adapter behind put/get
// when a run needs to outlive the machine; no event schema changes when it does.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ArtifactRef } from './events.js';

const PREFIX = 'sha256:';

/**
 * The ref these bytes are known by. Exported so a caller can ask what a body IS before
 * deciding to store it — the plane refuses an upload whose claimed name is wrong, and
 * refusing after writing would be a check that only reports.
 */
export const digest = (bytes: string | Buffer): ArtifactRef =>
  `${PREFIX}${createHash('sha256').update(bytes).digest('hex')}`;

export function blobPath(root: string, ref: ArtifactRef): string {
  // The store now lives on the host, so a malformed ref is a path-traversal
  // attempt rather than a lookup miss. `put` computes its own ref and is safe;
  // `get` takes whatever a replayed or third-party stream carries.
  if (!/^sha256:[0-9a-f]{64}$/.test(ref)) {
    throw new Error(`not a content-addressed reference: ${ref}`);
  }
  const hex = ref.slice(PREFIX.length);
  // Two levels of fan-out: 256 dirs deep, so no single directory holds every blob.
  return join(root, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}

/** Store bytes, return the ref events will carry. */
export async function put(root: string, bytes: string | Buffer): Promise<ArtifactRef> {
  const ref = digest(bytes);
  const path = blobPath(root, ref);
  await mkdir(dirname(path), { recursive: true });
  // Write aside and rename: rename is atomic within a directory, so a crash or a
  // concurrent writer can never leave truncated bytes sitting at a path whose
  // name asserts the hash of the complete content.
  //
  // Knowingly untested: proving this needs fault injection mid-write, and a test
  // that cannot fail on the direct-write version would only be decoration. The
  // guarantee is structural — get()'s digest check below is what catches a blob
  // that went bad by any route this did not prevent.
  const staged = `${path}.${randomUUID()}.tmp`;
  await writeFile(staged, bytes);
  await rename(staged, path);
  return ref;
}

/** Read bytes back, proving they are what the ref claims. */
export async function get(root: string, ref: ArtifactRef): Promise<Buffer> {
  const bytes = await readFile(blobPath(root, ref));
  const actual = digest(bytes);
  if (actual !== ref) {
    // A content-addressed store that never checks its content is just a filesystem.
    throw new Error(`blob ${ref} contains ${actual} — this artifact is not the evidence it claims`);
  }
  return bytes;
}
