// The two prompts (§5c), and whether they tell the truth.
//
// The gap 5c closes is that the engine had a strict contract and had never stated
// it to the party it binds: `src/agent.ts` said the prompt was the caller's
// business, every prompt in the repo was a stub like `'fix it'`, and nothing told an
// agent that `.engine/repro.json` exists. A real agent would have committed no
// manifest and `readReproFromCommit` would have thrown.
//
// So the assertions here are not "the prompt mentions the manifest". They are that
// every number and path the prompt states is the number and path the engine
// ENFORCES. A prompt that promises a 64-file limit against a 32-file check is worse
// than no prompt: it produces a confident agent and a refused run.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MAX_REPRO_BYTES, MAX_REPRO_FILES, REPRO_MANIFEST } from '../src/orchestrate.js';
import { describeEnvironment, extractRecipeDraft, PROMPT_DIR, renderPrompt } from '../src/prompts.js';

const read = (name: string) => readFileSync(join(PROMPT_DIR, name), 'utf8');

describe('the prompts are files, and they are filled in', () => {
  test('both exist in version control rather than as string literals', () => {
    // "They are prompts; they will be iterated." A diff on a file is legible; a diff
    // inside a template literal at a call site is not.
    expect(read('repro.md').length).toBeGreaterThan(500);
    expect(read('fix.md').length).toBeGreaterThan(500);
  });

  test('a placeholder that is not filled is an error, not a prompt', async () => {
    // A run wasted on a template bug reads as the agent being stupid rather than as
    // us being wrong, which is the most expensive kind of silent failure here.
    await expect(
      renderPrompt('fix', { issue: 'x', command: 'y', files: 'z', observed: 'o', suite: 's' }),
    ).rejects.toThrow(/needs environment/);
    const filled = await renderPrompt('repro', {
      issue: 'the heading is wrong',
      environment: 'no services',
      symptom: 'Ordres',
    });
    expect(filled).toContain('the heading is wrong');
    expect(filled).not.toMatch(/\{\{\w+\}\}/);
  });

  test('the repro prompt cannot be rendered without the symptom the engine checks for', async () => {
    // The gap the first real model run found. The engine searches the reproduction's
    // output for a literal string; the prompt used to ask only that the output "mention
    // the symptom the report describes", so a model that paraphrased — as one did — was
    // refused for a reproduction that was correct. Making it a required variable means
    // the prompt can no longer be rendered without the exact text being in it.
    await expect(
      renderPrompt('repro', { issue: 'the heading is wrong', environment: 'no services' }),
    ).rejects.toThrow(/needs symptom/);
  });

  test('the symptom reaches the agent verbatim, because the check is literal', async () => {
    const symptom = 'status=shipped returns every order';
    const filled = await renderPrompt('repro', { issue: 'i', environment: 'e', symptom });
    expect(filled).toContain(symptom);
    // And the prompt must say the match is literal. Told to "mention" it, a model
    // reasonably rewrites it in its own words, which is precisely what failed.
    expect(filled).toMatch(/character for character|verbatim/);
    expect(filled).toMatch(/paraphrase/);
  });
});

describe('the repro prompt states the contract the engine enforces', () => {
  const prompt = read('repro.md');

  test('the manifest path is the one the engine reads, character for character', () => {
    expect(REPRO_MANIFEST).toBe('.engine/repro.json');
    expect(prompt).toContain(REPRO_MANIFEST);
    // And the shape, since a manifest with the right name and the wrong keys is
    // refused with a message about JSON rather than about the contract.
    expect(prompt).toMatch(/"command"/);
    expect(prompt).toMatch(/"files"/);
  });

  test('the ceilings it quotes are the ceilings the engine applies', () => {
    // The two numbers `readReproFromCommit` refuses on. If either changes, this test
    // fails and the prompt has to be corrected — which is the whole reason it reads
    // them from the source rather than restating them.
    expect(MAX_REPRO_FILES).toBe(32);
    expect(MAX_REPRO_BYTES).toBe(256 * 1024);
    expect(prompt).toMatch(new RegExp(`${MAX_REPRO_FILES} paths`));
    expect(prompt).toMatch(/256KB/);
  });

  test('it says the working tree is discarded, and that only a commit survives', () => {
    // ADR-0010's consequence, and the single most likely way a real first run fails:
    // an agent that writes a perfect reproduction and never commits it.
    expect(prompt).toMatch(/Only committed files exist/);
    expect(prompt).toMatch(/git_commit/);
  });

  test('it says the command must FAIL here, and why a green one ends the run', () => {
    expect(prompt).toMatch(/must exit \*\*non-zero\*\*/);
    expect(prompt).toMatch(/information request/);
    // The symptom check, which is the difference between reproducing this bug and
    // reproducing some other one. This assertion used to read `/output must mention the
    // symptom/`, and a real model run showed that wording was the defect: told to
    // "mention" a symptom, it paraphrased, and the engine's LITERAL check refused a
    // reproduction that was correct. So the assertion is now the stronger one — the
    // prompt has to carry the exact string and say that the match is character-for-
    // character. Wording that merely asks the output to "mention" it fails this.
    expect(prompt).toMatch(/output must contain this text, character for character/);
    expect(prompt).toContain('{{symptom}}');
    expect(prompt).toMatch(/a paraphrase of it fails/);
    expect(prompt).not.toMatch(/output must mention the symptom/);
  });

  test('it forbids testing the commit s identity, which is the attack the tier cap exists for', () => {
    // ADR-0007's amendment: the repro agent knows base's tree exactly, so it can
    // write an oracle over the commit instead of over the bug. Saying so is not a
    // defence — the tier cap is — but an agent that does it by accident is a wasted
    // run, and the sham control is described so the instruction has a reason.
    expect(prompt).toMatch(/Reproduce the bug, not the commit/);
    expect(prompt).toMatch(/sham/);
    expect(prompt).toMatch(/Do not fix the bug/);
  });
});

describe('the fix prompt states what will judge it', () => {
  const prompt = read('fix.md');

  test('it carries the registered command and says who will re-run it', () => {
    expect(prompt).toContain('{{command}}');
    expect(prompt).toMatch(/re-run again|run again, against your commit|a process you cannot reach/);
    // Three runs, because "it passed once" is the failure the flake re-runs exist to
    // catch and an agent that does not know the count will not check twice.
    expect(prompt).toMatch(/three times/);
  });

  test('it says the repro files are not the agent s, and why editing them looks like tampering', () => {
    expect(prompt).toContain('{{files}}');
    expect(prompt).toMatch(/not yours to change/);
    expect(prompt).toMatch(/tampering/);
  });

  test('it says nothing outside a commit crosses, and names the container boundary', () => {
    // ADR-0014: base and fix are different containers, so a cache, a temp file or a
    // background process reaches nothing. An agent that does not know this writes a
    // fix that "works locally".
    expect(prompt).toMatch(/Only committed files exist/);
    expect(prompt).toMatch(/different container/);
  });

  test('it renders with a real command and file list', async () => {
    const filled = await renderPrompt('fix', {
      issue: 'the heading is misspelled',
      command: 'sh repro.sh',
      files: '- `repro.sh`\n- `.engine/repro.json`',
      environment: 'no services are running',
      observed: 'Ordres\nexpected Orders',
      suite: 'this repository has no test command',
    });
    expect(filled).toContain('sh repro.sh');
    // The bytes the verdict was taken from, not just the command that produced them.
    expect(filled).toContain('expected Orders');
    expect(filled).toContain('`.engine/repro.json`');
    expect(filled).not.toMatch(/\{\{\w+\}\}/);
  });
});

describe('the environment paragraph describes what was observed', () => {
  test('with no services it says so, rather than implying one is up', () => {
    const text = describeEnvironment({});
    expect(text).toMatch(/No services are running/);
    expect(text).toMatch(/There is no network/);
  });

  test('a booted sandbox is told it has a network, because it does', () => {
    // The defect this asserts against: the paragraph said "There is no network"
    // unconditionally, while `orchestrate.ts` gives the agent sandbox the default
    // bridge whenever a recipe exists — which is every shipping configuration. An
    // agent told it cannot install anything plans around a constraint it does not
    // have, and the constraint it DOES have was named nowhere.
    const text = describeEnvironment({ booted: true, services: [{ name: 'web', port: 8080 }] });
    expect(text).toMatch(/Here, you have a network/);
    expect(text).not.toMatch(/There is no network/);
    // And the services are described as a way to FIND the bug, not as something the
    // registered command may reach: they are not running in the phase container.
    expect(text).toMatch(/not running in the container that judges you/);
  });

  test('a booted sandbox is told what the judge HAS, which is no longer nothing', () => {
    // This test used to assert `nothing is installed in it`, and it was right when it
    // was written: the phase containers cloned the commit and ran against a bare
    // checkout. 7e changed the world and not the sentence — the phases now run from an
    // image carrying this repository's installed dependencies — so the prompt went on
    // telling the agent to write a reproduction out of the standard library alone, in a
    // container that had the project's own test runner sitting in it.
    //
    // A prompt is the one thing the suite cannot check by running it (the scripted agent
    // emits whatever the test author wrote), so the only defence is asserting the words.
    // These assertions are that defence, and the negative one is the whole point.
    const text = describeEnvironment({ booted: true });
    expect(text).toMatch(/no\n?network/i);
    expect(text).toMatch(/nothing is running/);
    expect(text).toMatch(/the same installed dependencies/);
    expect(text).toMatch(/dependencies the recipe’s `install` step puts in the tree/);
    // The two ways a correct reproduction still dies there, named.
    expect(text).toMatch(/npx --yes/);
    expect(text).toMatch(/node_modules\/\.bin/);
    // The claim that stopped being true. If it ever comes back, it comes back here.
    expect(text).not.toMatch(/nothing is installed in it/);
    expect(text).not.toMatch(/standard library, and nothing else/);
  });

  test('the recipe’s configuration is named, and named as crossing the boundary', () => {
    // The prompt/engine disagreement this project has paid for before: the engine sets
    // `recipe.env` in both worlds, and the paragraph above tells the agent the services
    // are absent in the judging container. An agent that reads only that concludes the
    // ports and URLs are absent too, and writes a reproduction that hard-codes them —
    // or worse, commits a value that stops being true when the recipe changes.
    const text = describeEnvironment({
      booted: true,
      env: { PORT: '8095', DATABASE_URL: 'postgres://127.0.0.1:5432/app' },
    });
    expect(text).toContain('`PORT=8095`');
    expect(text).toContain('`DATABASE_URL=postgres://127.0.0.1:5432/app`');
    expect(text).toMatch(/for the registered command in the\ncontainer that judges you/);
    expect(text).toMatch(/Do not write them into a committed file/);
    // And a recipe that declares none says nothing at all — an empty list here would
    // read as "the environment is empty", which is false in every container.
    expect(describeEnvironment({ booted: true, env: {} })).not.toMatch(/set for every command/);
    expect(describeEnvironment({ booted: true })).not.toMatch(/set for every command/);
  });

  test('an unbooted sandbox is told both worlds are sealed', () => {
    const text = describeEnvironment({ booted: false });
    expect(text).toMatch(/not here, and not in the container that judges your work/);
    expect(text).toMatch(/bare checkout/);
  });

  test('the test command is named without claiming a result nothing measured', () => {
    // It said "It passes on this commit." `recipe.test` was never executed anywhere
    // in `src/` — the sentence was the only thing that referenced it. Asserting an
    // unverified result to the party being judged on it is the whole failure class
    // this project exists to refuse, and it was in our own prompt.
    const text = describeEnvironment({ testCommand: 'node --test' });
    expect(text).toMatch(/`node --test`/);
    expect(text).not.toMatch(/It passes on this commit/);
    expect(text).toMatch(/has\s+not been checked here/);
  });

  test('the sealed world is described from what was run in it, not from belief', () => {
    // 8b. The disclaimer above is the honest thing to say when nothing has run the
    // command; it is the wrong thing to say once something has. The engine runs the
    // recipe's own test command in the judging container before either agent starts,
    // and this is where that observation becomes a sentence.
    const green = describeEnvironment({
      booted: true,
      testCommand: 'node --test',
      sealed: { command: 'node --test', exitCode: 0, output: 'ok 12' },
    });
    expect(green).toMatch(/container that will judge you/);
    expect(green).toMatch(/exited 0 there/);
    expect(green).toMatch(/ok 12/);
    // The disclaimer must be GONE — leaving both would tell the agent in one
    // paragraph that we checked and in the next that we did not.
    expect(green).not.toMatch(/has\s+not been checked here/);

    // Red is a fact about the repository, not an accusation about the agent. 7d's
    // `already_red` is the same rule one layer down.
    const red = describeEnvironment({
      booted: true,
      sealed: { command: 'node --test', exitCode: 1, output: 'not ok 3 - totals' },
    });
    expect(red).toMatch(/exited 1 there/);
    expect(red).toMatch(/not something/);
    expect(red).toMatch(/not ok 3 - totals/);

    // And the case this phase exists for: a test command that cannot run where the
    // judging happens. The agent is told not to imitate it, because imitating it is
    // exactly what a real model did — the reproduction copied the recipe's command
    // style and needed a registry that was not there.
    const broken = describeEnvironment({
      booted: true,
      sealed: { command: 'npx --yes pnpm@10 vitest', failed: 'exceeded 120000ms' },
    });
    expect(broken).toMatch(/could not be run there: exceeded 120000ms/);
    expect(broken).toMatch(/do not imitate its style/);
  });

  test('with services it names each one and its healthcheck', () => {
    // Built from the recipe's own services, so the prompt cannot promise a booted
    // service that never came up: `ENV_READY` is emitted for a healthcheck that
    // passed, and this describes the same facts.
    const text = describeEnvironment({
      services: [{ name: 'web', port: 8080, healthcheck: 'http://127.0.0.1:8080/healthz' }],
      testCommand: 'node --test',
    });
    expect(text).toMatch(/`web` on http:\/\/127\.0\.0\.1:8080/);
    expect(text).toMatch(/healthcheck: http:\/\/127\.0\.0\.1:8080\/healthz/);
    expect(text).toMatch(/answered a healthcheck before you started/);
    expect(text).toMatch(/`node --test`/);
  });

  test('the browser is described as testimony, in the paragraph that offers it', () => {
    // The one place an agent learns what a screenshot is worth. ADR-0006's
    // amendment: it makes the agent better at its job and gives the judge nothing
    // new to trust.
    const text = describeEnvironment({ browser: true });
    expect(text).toMatch(/browser_screenshot/);
    expect(text).toMatch(/never the verdict/);
    expect(text).toMatch(/no browser in it/);
    // And it says what to DO about that, which the old wording did not: see the bug with
    // the browser, then register something that does not need one.
    expect(text).toMatch(/assert on the/);
  });
});

describe('the drafting prompt asks for a recipe a human can approve', () => {
  const prompt = read('recipe.md');

  test('it states the schema the store will validate', () => {
    for (const key of ['"install"', '"migrate"', '"seed"', '"services"', '"port"', '"healthcheck"', '"test"']) {
      expect(prompt).toContain(key);
    }
    // The naming rule `parseRecipe` enforces, because a name that fails validation
    // wastes the one drafting session this repository gets.
    expect(prompt).toMatch(/lowercase letters, digits/);
  });

  test('it forbids backgrounding, which is the harness s job', () => {
    // ADR-0014: the service lives in a named session the Runner started and holds.
    // A command that backgrounds itself exits immediately, which is indistinguishable
    // from a service that crashed on startup.
    expect(prompt).toMatch(/foreground/);
    expect(prompt).toMatch(/do not add `&`/);
  });

  test('it says why a guessed command is expensive, in the terms the user will see', () => {
    // The drafting agent is the only participant that can prevent an `errored` run,
    // so it is told what one looks like from the outside.
    expect(prompt).toMatch(/run what you propose/i);
    // `\s` rather than a space: the prompt is hard-wrapped, so this sentence spans a
    // line break. Matching on a literal space would make the assertion depend on
    // where the paragraph happens to fold.
    expect(prompt).toMatch(/no fix is\s+attempted/);
    // And that an unsatisfiable requirement is a useful answer rather than a failure
    // — ADR-0013's own "revisit when" is exactly this case.
    expect(prompt).toMatch(/say so plainly/);
  });

  test('the draft is read from the LAST fenced block, not the first', () => {
    // A drafting agent explains itself before it answers, and its explanation may
    // quote a candidate it rejected. Taking the first block stored the rejected one.
    const message = [
      'I first tried:',
      '```json',
      '{"install":"yarn","services":[]}',
      '```',
      'which failed, because this project uses npm. So:',
      '```json',
      '{"install":"npm install","services":[]}',
      '```',
    ].join('\n');
    expect(extractRecipeDraft(message)).toEqual({ install: 'npm install', services: [] });
  });

  test('a session that answered with no JSON block is an error, not an empty recipe', () => {
    expect(() => extractRecipeDraft('I could not work out how to boot this.')).toThrow(
      /no fenced JSON block/,
    );
  });
});

describe('the fix prompt names the command that will judge it', () => {
  // The gap the first real model run found, from the other side. `orchestrate` accepts a
  // function for `agentPrompt` so the prompt can be rendered AFTER registration; before
  // that, `run.ts` rendered it up front with prose in both slots, and the result promised
  // the agent an exact command while handing it directions to go and find one.

  test('the prompt claims the command is given exactly, so it must be', () => {
    const prompt = read('fix.md');
    // The sentence that makes a placeholder a lie rather than an inconvenience.
    expect(prompt).toMatch(/you have exactly the command above/);
    expect(prompt).toContain('{{command}}');
  });

  test('a rendered fix prompt contains a command, not directions to one', async () => {
    const filled = await renderPrompt('fix', {
      issue: 'the shipped filter is broken',
      environment: 'no services',
      command: 'node --test test/repro.test.mjs',
      files: '- `test/repro.test.mjs`',
      observed: 'Expected 2 shipped orders, got 4',
      suite: 'this repository has no test command',
    });
    expect(filled).toContain('node --test test/repro.test.mjs');
    // The exact prose that used to be substituted. A model told this, while also being
    // told it has the command exactly, is being given two incompatible instructions.
    expect(filled).not.toMatch(/the command registered in \.engine\/repro\.json/);
    expect(filled).not.toMatch(/the files that manifest names/);
  });
});
