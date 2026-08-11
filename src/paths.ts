// Proving a path stays inside a root.
//
// This was `resolveInside` in verify.ts, where it guarded the bytes the engine
// writes over a checkout. It moved here because ADR-0011 gave it a second caller
// and a much heavier job: with the agent loop outside the sandbox, the tools ARE
// the fence. "A `write` tool that accepts a path outside the workspace is the
// whole boundary undone" is the ADR's own sentence, and the only defensible
// answer to it is to reuse the check that four adversarial review rounds already
// shaped rather than to write a second one that looks similar.
//
// Nothing here is new. The comments are the record of what each layer is for,
// and each of them is a fixture in the suite.

import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** A path that could not be proved to stay inside its root. Never a failure to observe. */
export class PathRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathRefused';
  }
}

export type Resolved = { rel: string; target: string };

/** `.git` in any position, case-folded — `sub/.git/hooks` and `.Git` are git state too. */
export const hasGitSegment = (path: string) =>
  path.split(sep).some((segment) => segment.toLowerCase() === '.git');

/**
 * Resolve a caller-supplied path and prove it stays inside `root`.
 *
 * Normalise first, then validate — checking the caller's raw string lets `./`
 * slip past every guard, and the caller is the party under judgement (ADR-0008).
 * Containment is re-derived at each use rather than cached, because the tree's
 * shape is not ours: a parent directory committed as a symlink, or planted by a
 * tool call, would redirect a write that was proved safe a moment earlier.
 *
 * `subject` only names the thing in the message. It exists because the two
 * callers describe different nouns and the exact strings are asserted.
 */
export async function resolveInside(
  root: string,
  input: string,
  options: { allowSymlinks?: boolean; subject?: string } = {},
): Promise<Resolved> {
  const subject = options.subject ?? 'path';
  const target = resolve(root, input);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new PathRefused(`${subject} escapes the repository: ${input}`);
  }
  if (hasGitSegment(rel)) {
    throw new PathRefused(`${subject} writes into git's own state: ${input}`);
  }
  // Containment is not the invariant. The committed-path guard compares *names*,
  // so a tree that ships `t -> .` makes the path `t/src.txt` — a name matching
  // nothing tracked — land on the tracked `src.txt`. The path has to be what its
  // name says, so walk down from the root refusing any symlinked component.
  //
  // lstat, not realpath: a dangling link makes realpath throw, and the loop below
  // would then treat "cannot resolve" as "nothing to check".
  if (!options.allowSymlinks) {
    let walked = root;
    for (const segment of rel.split(sep)) {
      walked = join(walked, segment);
      try {
        if ((await lstat(walked)).isSymbolicLink()) {
          throw new PathRefused(`${subject} traverses a symlink: ${input}`);
        }
      } catch (error) {
        if (error instanceof PathRefused) throw error;
        break; // Does not exist yet, so nothing below it can either.
      }
    }
  }
  // Both rules again, this time against the *real* path. The lexical check above
  // only sees the name: a symlink already in the tree can point into `.git` while
  // satisfying containment, which is the same arbitrary-config write by a
  // different door. The walk starts at the target itself, not its parent — the
  // final component is a symlink the attacker controls just as easily.
  let probe = target;
  while (probe !== root) {
    try {
      const realRel = relative(root, await realpath(probe));
      if (realRel.startsWith('..') || isAbsolute(realRel)) {
        throw new PathRefused(`${subject} resolves outside the repository: ${input}`);
      }
      if (hasGitSegment(realRel)) {
        throw new PathRefused(`${subject} resolves into git's own state: ${input}`);
      }
      break;
    } catch (error) {
      if (error instanceof PathRefused) throw error;
      // Does not exist yet: keep walking up to the deepest part that does.
      probe = dirname(probe);
    }
  }
  return { rel, target };
}
