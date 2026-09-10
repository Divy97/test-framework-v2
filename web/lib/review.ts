/**
 * A recipe, as the ordered list of commands it will cause to run (10n).
 *
 * This screen asks a person to approve shell that the engine then executes VERBATIM, in a
 * container with a package registry reachable, and nothing sandboxes it from that
 * container. The warning above the box has said so for four milestones. What sat under the
 * warning was a twenty-row textarea of raw JSON.
 *
 * That is the most consequential control in the product presented as a config file. To
 * review it a person had to hold the schema in their head, find the commands among the
 * ports and the env, and know which of them the engine treats as a verdict. Most people
 * will read the first two lines and press the button, which makes the control decorative —
 * and a decorative control is worse than none, because the page claims it happened.
 *
 * So: the commands, in the order they run, each labelled with what it is and when. The
 * JSON is still editable — a draft usually needs a fix — but it is no longer the only way
 * to see what you are agreeing to.
 *
 * Deliberately NOT a validator. `parseRecipe` on the server decides what is well-formed
 * and refuses what is not; this describes what a well-formed recipe will do. Two opinions
 * about validity is one more than a product can hold.
 */

export type Risk = {
  /** What was matched, quoted back so the reader can find it in the command. */
  found: string;
  /** What it means, in one sentence, without adjectives. */
  says: string;
};

export type ReviewStep = {
  phase: 'install' | 'migrate' | 'seed' | 'service' | 'test';
  /** `install`, or `web` for a service — what to call this line. */
  label: string;
  command: string | null;
  /** When it runs and what it is for. Never a judgement about the command itself. */
  note: string;
  /** Port and healthcheck, for a service. */
  detail?: string;
  risks: Risk[];
};

/**
 * Patterns worth stopping on, and nothing else.
 *
 * The bar is deliberately high. A screen that flags `curl` finds something in every
 * recipe, which trains the reader to click past the flags — and the flags are the only
 * part of this page that could ever stop a bad approval. Each of these describes a thing
 * the command does that is not obvious from reading it quickly.
 *
 * `curl … | sh` is first because it is the payload `test/authz.test.ts` uses as its
 * attack: the reason the authorization on this route matters is that a stranger who got
 * past it could store exactly that.
 */
const PATTERNS: { re: RegExp; says: string }[] = [
  {
    re: /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash)\b/,
    says: 'pipes something into a shell — whatever it downloads will be executed, and the recipe does not say what that is',
  },
  { re: /\bsudo\b/, says: 'runs as root' },
  { re: /\brm\s+-[a-z]*[rf][a-z]*\s+\//, says: 'deletes recursively from an absolute path' },
  { re: /\bchmod\s+(?:-[a-zA-Z]+\s+)*777\b/, says: 'makes something writable by anyone' },
  { re: /\beval\b/, says: 'evaluates a string as code, so what runs is not what is written here' },
  {
    re: /\b(?:ssh|scp|rsync)\b/,
    says: 'reaches another machine over SSH, which a sandbox for building your project has no reason to do',
  },
];

/** Every pattern a command matches. Bounded quoting: the match, not the whole line. */
export const risksIn = (command: string | null | undefined): Risk[] => {
  if (!command) return [];
  const out: Risk[] = [];
  for (const { re, says } of PATTERNS) {
    const hit = re.exec(command);
    if (hit) out.push({ found: hit[0].trim(), says });
  }
  return out;
};

const str = (of: Record<string, unknown>, key: string): string | null => {
  const value = of[key];
  // `''` is ABSENT, which is the rule `parseRecipe` holds: an empty command runs nothing,
  // and rendering it as a step would put a line in this list that does not happen.
  return typeof value === 'string' && value.trim() !== '' ? value : null;
};

/**
 * What this recipe will do, in order — or why it cannot be read.
 *
 * The error case is not a failure state to hide: somebody editing the JSON below spends
 * most of their keystrokes with it invalid, and telling them that plainly beats a review
 * that silently shows the last thing that parsed.
 */
export function review(text: string): { steps: ReviewStep[]; risks: number } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: `This is not valid JSON yet — ${String((error as Error).message ?? error)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'A recipe is a JSON object, with commands in it.' };
  }
  const of = parsed as Record<string, unknown>;

  const steps: ReviewStep[] = [];

  // The order is the order `runner.ts` runs them in, and it is the whole reason this list
  // is a list. A reader looking at the JSON has to know that ordering to review it.
  steps.push({
    phase: 'install',
    label: 'install',
    command: str(of, 'install'),
    note: 'Runs once, before anything else, with the network reachable.',
    risks: risksIn(str(of, 'install')),
  });
  steps.push({
    phase: 'migrate',
    label: 'migrate',
    command: str(of, 'migrate'),
    note: 'Runs after install, against whatever this recipe provisions.',
    risks: risksIn(str(of, 'migrate')),
  });
  steps.push({
    phase: 'seed',
    label: 'seed',
    command: str(of, 'seed'),
    note: 'Runs after migrate, to put data in.',
    risks: risksIn(str(of, 'seed')),
  });

  const services = Array.isArray(of.services) ? (of.services as unknown[]) : [];
  for (const one of services) {
    if (one === null || typeof one !== 'object') continue;
    const service = one as Record<string, unknown>;
    const port = typeof service.port === 'number' ? service.port : null;
    const health = typeof service.healthcheck === 'string' ? service.healthcheck : null;
    steps.push({
      phase: 'service',
      label: typeof service.name === 'string' && service.name !== '' ? service.name : 'a service with no name',
      command: str(service, 'command'),
      // The one thing on this page the engine will ever treat as evidence, said where the
      // reader is deciding whether to trust it.
      note: health
        ? 'Stays running. The engine polls its healthcheck until it answers — the only thing here it treats as evidence.'
        : 'Stays running. With no healthcheck, the port opening is the only check.',
      ...(port === null ? {} : { detail: health ? `port ${port} · ${health}` : `port ${port}` }),
      risks: risksIn(str(service, 'command')),
    });
  }

  steps.push({
    phase: 'test',
    label: 'test',
    command: str(of, 'test'),
    // Said plainly because it decides the regression arm, and a reader choosing between
    // two plausible test commands is choosing what "the fix broke nothing" means.
    note: 'Your own suite. Run on the commit before and the commit after a fix — this is what says the fix cost you nothing.',
    risks: risksIn(str(of, 'test')),
  });

  return { steps, risks: steps.reduce((count, step) => count + step.risks.length, 0) };
}
