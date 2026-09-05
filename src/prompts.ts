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
// Type-only, so the cycle with `orchestrate.ts` is a compile-time one and there is
// no import at runtime. The observation is the engine's to produce; this file's job
// is only to say it in words.
import type { SealedWorld } from './orchestrate.js';

/** Where the prompts live. Resolved from this module, not from the process cwd. */
export const PROMPT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

export type PromptName = 'repro' | 'fix' | 'recipe' | 'triage';

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
 * You are not root. Say so, in these words, because the alternative is a run whose
 * agent silently guessed wrong.
 *
 * Found by running a real drafting-shaped session against a real repository, not by
 * reading: `corepack enable` — the standard first line of any pnpm or yarn project's
 * setup — writes into `/usr/local/bin`, which needs root, and the agent sandbox runs
 * as uid 1000 by construction (ADR-0006: root in this PID namespace could reach the
 * event channel through `/proc/1/fd/N`). The identical recipe succeeds in a
 * root-run environment build and fails here, silently, with no hint that the two
 * containers disagree about who is allowed to write where.
 *
 * Every agent that gets a shell needs to know this, not only the one drafting a
 * recipe — a fix agent replaying an approved recipe hits the same wall the moment
 * that recipe assumes root.
 */
const UNPRIVILEGED_NOTE = [
  '',
  'You are not root here, and nothing you run will be. Anything that needs root —',
  '`corepack enable`, a global `npm install -g` or `yarn global add`, `apt-get`, writing',
  'outside this checkout — fails with a permission error, silently as far as your exit',
  'code is concerned: nothing distinguishes that failure from any other. Prefer what the',
  'project can already reach without asking for more than it has: `npx <package>@<version>`,',
  '`./node_modules/.bin/<tool>` once something has installed it, or a package manager',
  'already vendored in the repository. If a step truly needs root, say so plainly — that is',
  'a fact about this environment, not a fix you are expected to find.',
].join('\n');

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
  /**
   * What the recipe's own test command did in the judging container, observed
   * before this agent started. Absent when there is no test command to run, or
   * when there was no environment to run it in.
   */
  sealed?: SealedWorld;
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
  /** Configuration the recipe sets for every command, including in the judging container. */
  env?: Record<string, string>;
}): string {
  const lines: string[] = [
    'The repository is checked out at your working directory. Your tools are the only way to act on it:',
    '`shell_create` / `shell_write` (named sessions that stay alive), `read`, `write`, `edit`, `grep`,',
    '`glob`, and `git_commit`.',
    UNPRIVILEGED_NOTE,
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
      'The container that judges your work is a different one. It clones the commit, it has **no',
      'network**, and **nothing is running** in it — no services, no processes of yours, nothing you',
      'started here. What it does have is the same installed dependencies: they were captured from a',
      'build of this recipe before you existed and are restored into its clone, so the project’s own',
      'test runner is there. It runs your registered command and takes the exit code.',
      '',
      'So a reproduction is judgeable if, and only if, it runs with:',
      '',
      '- the files committed in this repository, and',
      '- the language runtime and the dependencies the recipe’s `install` step puts in the tree, and',
      '- nothing that has to be fetched, and nothing that has to be already running.',
      '',
      'Two things do not cross, and they are the common ways a correct reproduction fails there.',
      'Anything YOU install after this point is not in that image. And any command that resolves a',
      'package when it runs — `npx --yes …`, `pnpm dlx …`, `yarn dlx …` — needs a registry, and there',
      'is no network to reach one: invoke the binary the install step already put in the tree instead',
      '(`./node_modules/.bin/…`, `.venv/bin/…`).',
      '',
      'If the bug genuinely cannot be shown under those terms, say so plainly in your final message',
      'and commit nothing — that is a true answer about our limitation, and it is far better than a',
      'reproduction that cannot run.',
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

  // The one thing about the recipe that DOES cross the boundary the paragraph above
  // draws. Services do not: they run here and not in the judging container, and the
  // text says so. Configuration is the opposite — the same `env` is set for every
  // command in both worlds — and an agent that has been told the services are absent
  // there will assume the ports and URLs are absent too unless this says otherwise.
  const env = Object.entries(options.env ?? {});
  if (env.length > 0) {
    lines.push(
      '',
      'These variables are set for every command you run, and for the registered command in the',
      'container that judges you. They are the repository’s own local-development configuration,',
      'and you may rely on them:',
      ...env.map(([name, value]) => `- \`${name}=${value}\``),
      '',
      'Do not write them into a committed file. They are already in the environment on both sides,',
      'and a value hard-coded into a test is one that stops being true the moment it is changed.',
    );
  }

  // NOT "it passes on this commit" — that sentence asserted a result nothing had
  // ever executed, to the one party we then judge on it. It is allowed to say what
  // happened only because the engine now runs it, in the judging container, before
  // this prompt is written. `sealed` absent means it was not run; the disclaimer
  // stands in that case and must, because the alternative is the same lie again.
  if (options.sealed) {
    const sealed = options.sealed;
    lines.push(
      '',
      `The project's own test command is \`${sealed.command}\`, and the engine ran it **in the`,
      'container that will judge you** before you started. That is not a claim about this container;',
      'it is what the judge did with it:',
    );
    if ('failed' in sealed) {
      lines.push(
        '',
        `- it could not be run there: ${sealed.failed}`,
        '',
        'So do not build your reproduction out of that command, and do not imitate its style — the',
        'judge cannot run it. Register something that stands on the committed files and the installed',
        'dependencies alone.',
      );
    } else if (sealed.exitCode === 0) {
      lines.push(
        '',
        `- it exited 0 there. The suite is green on this commit, in that container, so a test you add`,
        '  in the same runner will be run the same way — and a failure there will be yours.',
        ...(sealed.output.trim() ? ['', '```', sealed.output.trim(), '```'] : []),
      );
    } else {
      lines.push(
        '',
        `- it exited ${sealed.exitCode} there. That is the repository's own baseline, not something`,
        '  you caused, and it is worth reading before you write anything: what is already failing may',
        '  be the bug you were asked about.',
        ...(sealed.output.trim() ? ['', '```', sealed.output.trim(), '```'] : []),
      );
    }
  } else if (options.testCommand) {
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

/**
 * What a DRAFTING agent is told about the world it is in — a real, different world
 * from `describeEnvironment`'s, not a variant of it.
 *
 * `describeEnvironment` is about a container that either replays an approved recipe
 * or does not, and always contrasts itself against a second container that judges
 * it. Neither half of that applies here: nothing has been approved yet — there is
 * nothing to replay — and nothing here is judged at all. A drafting session has one
 * container, a network, and a human reading whatever gets written down. Reusing
 * `describeEnvironment` for this would have to either claim "there is no network"
 * while `orchestrate.ts` hands the container a bridge (M6b needs one for the same
 * reason a recipe replay does), or invent a "judge" that does not exist for a
 * drafting session — both false, and both the exact class of prompt/engine
 * disagreement this project has already found expensive more than once.
 */
export function describeDraftingEnvironment(options: { browser?: boolean } = {}): string {
  const lines: string[] = [
    'The repository is checked out at your working directory, on its default branch. Your',
    'tools are the only way to act on it: `shell_create` / `shell_write` (named sessions',
    'that stay alive), `read`, `write`, `edit`, `grep`, `glob`, and `git_commit`.',
    UNPRIVILEGED_NOTE,
    '',
    'You have a network, and nothing else. Nothing is installed, nothing is running, and',
    'nothing has been booted for you — working that out is why you are here. Install what',
    'the project needs, start what it needs started, in a named session so it outlives the',
    'tool call, and prove each one came up before you write it down.',
    '',
    'There is no second container here, and nothing you propose is judged by an exit code.',
    'A human reads what you write, corrects anything you got wrong, and only then is it',
    'stored — which is why this session has no gate: the gate is the human, at the moment',
    'they approve or reject what you hand them (ADR-0013).',
  ];
  if (options.browser) {
    lines.push(
      '',
      'A headless browser is available through `browser_navigate`, `browser_click`,',
      '`browser_type` and `browser_screenshot`, if you need to see a page actually render to',
      'know a service came up the way you think it did.',
    );
  }
  return lines.join('\n');
}
