// Triage: the one moment a question is cheap.
//
// Milestone 7 named this and did not build it. The reporter is at the keyboard at
// t=0 and nowhere near it twenty minutes later, so a question asked now is answered
// and a question asked at the end is a template nobody replies to. A cheap model
// reading the report against the repository's file listing can name the one missing
// fact for a fraction of a cent — long before a container starts, and long before a
// model has been spent on a reproduction that could not have worked.
//
// It NEVER stops a run. That is the whole design, and it is not timidity: this
// project's own precedent is that "a check that convicts honest work does not get to
// end runs" (7c), and the thing doing the convicting here would be a cheap model's
// opinion of somebody's bug report. So the question is asked, the run proceeds, and
// the two race — if the run wins, the reporter gets a pull request and the question
// cost a cent; if the gate holds, the answer is already on its way.

import { askOnce } from './loop.js';
import { renderPrompt } from './prompts.js';
import { redact } from './redact.js';

/** How much of the file listing the model is shown. A tree, not a repository dump. */
const MAX_TREE_PATHS = 400;

/** One question, one line. Longer than this is a checklist wearing a question mark. */
const MAX_QUESTION_CHARS = 300;

/**
 * Ask a cheap model whether this report can be started on, and what is missing.
 *
 * Returns the question to ask the reporter, or null — which covers every one of:
 * the report is good enough, the model refused, the model is unreachable, no
 * credential is configured, the answer was empty, the answer was a paragraph.
 * Every one of those means the same thing to the caller (there is nothing worth
 * asking), and distinguishing them would be inventing a diagnosis for something
 * that changes nothing.
 */
export async function triage(options: {
  issue: string;
  /** Paths in the repository at the base commit. Bounded before it is rendered. */
  tree: string[];
  provider?: string;
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  model?: string;
}): Promise<string | null> {
  const listing = options.tree.slice(0, MAX_TREE_PATHS);
  const prompt = await renderPrompt('triage', {
    issue: options.issue,
    tree:
      listing.map((path) => `- ${path}`).join('\n') +
      (options.tree.length > listing.length
        ? `\n- …and ${options.tree.length - listing.length} more paths`
        : ''),
  });

  const said = await askOnce({
    prompt,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.model === undefined ? {} : { model: options.model }),
  });
  if (said === null) return null;

  // The FIRST non-empty line, and only if it is a question. A model told to answer
  // with one line sometimes answers with three; taking the first is the honest read
  // of an instruction that was followed loosely, and the `?` is what separates a
  // question from a model deciding to explain itself.
  const first = said
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (first === undefined) return null;
  if (/^enough\b/i.test(first)) return null;
  if (!first.includes('?')) return null;
  return redact(first).slice(0, MAX_QUESTION_CHARS);
}
