// The two prompts (milestone 5, §5c).
//
// `src/agent.ts` said the prompt's content is "the caller's business", every
// prompt in the repo was a test stub like `'fix it'`, and nothing had ever told an
// agent that `.engine/repro.json` exists. The engine was a strict judge that had
// never stated its rules to the party they bind, and a real agent would have
// produced a commit with no manifest at all.
//
// They live as FILES rather than string literals because they are prompts and they
// will be iterated: a diff on `prompts/repro.md` is legible, a diff inside a call
// site's template literal is not. Rendering is deliberately the dumbest possible
// substitution — a template language here would be a second thing to debug when a
// run goes wrong for prompt reasons.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the prompts live. Resolved from this module, not from the process cwd. */
export const PROMPT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

export type PromptName = 'repro' | 'fix' | 'recipe';

/**
 * Pull the recipe out of a drafting session's last message.
 *
 * The LAST fenced JSON block, because a drafting agent explains itself before it
 * answers and its explanation may quote a candidate it rejected. Taking the first
 * block stored the rejected one, which is the kind of bug that looks like the agent
 * being wrong.
 */
export function extractRecipeDraft(text: string): unknown {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((match) => match[1]!);
  if (blocks.length === 0) throw new Error('the drafting session produced no fenced JSON block');
  return JSON.parse(blocks.at(-1)!);
}

/**
 * What the agent is told about the world it is in.
 *
 * A single string rather than a structured description, because the honest answer
 * varies per run: whether services are booted, which ports, whether a browser is
 * there. The orchestrator knows; this file must not pretend to.
 */
export type PromptVars = Record<string, string>;

/**
 * Load a prompt and fill it in.
 *
 * Throws when a placeholder is left unfilled, which is the whole reason this is a
 * function rather than a `readFile` at each call site: a prompt that reaches a
 * model still saying `{{command}}` is a run wasted on a template bug, and it would
 * read as the agent being stupid rather than as us being wrong.
 */
export async function renderPrompt(name: PromptName, vars: PromptVars): Promise<string> {
  const template = await readFile(join(PROMPT_DIR, `${name}.md`), 'utf8');
  const filled = template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`the ${name} prompt needs ${key} and was not given it`);
    return value;
  });
  const leftover = filled.match(/\{\{\w+\}\}/);
  if (leftover) throw new Error(`the ${name} prompt still contains ${leftover[0]}`);
  return filled;
}

/**
 * The environment paragraph, from what the orchestrator actually observed.
 *
 * Built from the recipe's own services rather than from prose, so a prompt cannot
 * promise a booted service that never came up: `ENV_READY` is emitted for a
 * healthcheck that passed, and this describes the same facts.
 */
export function describeEnvironment(options: {
  services?: { name: string; port: number; healthcheck?: string }[];
  testCommand?: string;
  browser?: boolean;
  /**
   * Whether a recipe was replayed in this container — which decides BOTH halves of
   * the asymmetry below, and is why it is one flag rather than two.
   *
   * `orchestrate.ts` gives the agent sandbox a network only when there is a recipe
   * to install, and the phase containers get their dependencies only from the
   * snapshot taken of that boot. So "a recipe ran here" is exactly the condition
   * under which the agent has a registry and the judge has node_modules.
   */
  booted?: boolean;
}): string {
  const lines: string[] = [
    'The repository is checked out at your working directory. Your tools are the only way to act on it:',
    '`shell_create` / `shell_write` (named sessions that stay alive), `read`, `write`, `edit`, `grep`,',
    '`glob`, and `git_commit`.',
  ];

  // THE ASYMMETRY, stated first, because it is the fact that decides whether a
  // reproduction is runnable and it was the one fact never told.
  //
  // The previous version of this paragraph said "There is no network" unconditionally.
  // With a recipe present that is false — the agent sandbox gets the default bridge —
  // and the true constraint, that the container judging the work has neither a network
  // nor anything the agent installs after this point, was stated nowhere at all. An
  // agent cannot write a reproduction that survives a boundary it has not been told
  // about.
  if (options.booted) {
    lines.push(
      '',
      '## Two worlds, and the difference decides what you can write',
      '',
      'Here, you have a network, and the project’s dependencies are installed — the recipe’s',
      '`install` step ran and was observed to succeed before you started.',
      '',
      'The container that judges your work has **none of that**. It is a different container: it',
      'clones the commit, it has no network, nothing is installed in it, and no services are running.',
      'It runs your registered command against a bare checkout and takes the exit code. So a',
      'reproduction is only judgeable if it runs with:',
      '',
      '- the files committed in this repository, and',
      '- the language runtime and standard library, and nothing else.',
      '',
      'This is the single most common way a correct reproduction fails: it works here, where the',
      'dependencies exist, and exits "command not found" there. If the bug genuinely cannot be shown',
      'without an installed package, say so plainly in your final message and commit nothing — that is',
      'a true answer about our limitation, and it is far better than a reproduction that cannot run.',
    );
  } else {
    lines.push(
      '',
      'There is no network — not here, and not in the container that judges your work. Nothing can',
      'reach the internet, a package registry, or an API, so do not plan around installing anything.',
      'No environment recipe has been approved for this repository, so no dependencies have been',
      'installed and nothing has been booted. A reproduction has to run against a bare checkout.',
    );
  }

  const services = options.services ?? [];
  if (services.length > 0) {
    lines.push(
      '',
      'These services are already running and answered a healthcheck before you started:',
      ...services.map(
        (service) =>
          `- \`${service.name}\` on http://127.0.0.1:${service.port}` +
          (service.healthcheck ? ` (healthcheck: ${service.healthcheck})` : ''),
      ),
      '',
      'They are on localhost, which you can reach. Do not restart them unless you have to;',
      'if you do, use a named session so the process outlives the tool call.',
      '',
      'Use them to FIND the bug. They are not running in the container that judges you, so a',
      'registered command that expects to reach one of these ports will fail there — it must start',
      'whatever it needs itself, or test the code directly rather than over HTTP.',
    );
  } else {
    lines.push('', 'No services are running. This repository has no recipe, or its recipe declares none.');
  }

  // NOT "it passes on this commit". Nothing had ever executed this command, and the
  // sentence asserted its result to the one party we then judge on it.
  if (options.testCommand) {
    lines.push(
      '',
      `The project's own test command is \`${options.testCommand}\`. Whether it currently passes has`,
      'not been checked here — run it if that matters to you.',
    );
  }
  if (options.browser) {
    lines.push(
      '',
      'A headless browser is available through `browser_navigate`, `browser_click`, `browser_type` and',
      '`browser_screenshot`. Use it to SEE the application — a screenshot is stored and shown in the',
      'pull request, but a screenshot is never the verdict: what gets judged is the exit code of the',
      'command you register, and that command runs in a container with no browser in it. So use the',
      'browser to see what is wrong, then register something that does not need one — assert on the',
      'HTML the code produces rather than on what a page looks like.',
    );
  }
  return lines.join('\n');
}
