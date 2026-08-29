// Triage: the one moment a question is cheap (8e).
//
// Everything here is about what the engine does with an ANSWER, because the answer
// comes from a model and the model will say whatever it says. A one-line question is
// the contract; three paragraphs, a refusal, an outage and a shrug are what actually
// arrives, and every one of them has to end somewhere honest.

import { afterEach, describe, expect, test } from 'vitest';
import { triage } from '../src/triage.js';
import { fakeModel, type FakeModel } from './fixtures/model.js';

const models: FakeModel[] = [];
afterEach(async () => {
  for (const model of models.splice(0)) await model.close();
});

/** A triage call against a scripted one-shot answer. */
const ask = async (answer: string, tree: string[] = ['src/index.ts', 'README.md']) => {
  const model = await fakeModel([], { answer });
  models.push(model);
  return {
    question: await triage({
      issue: 'the export button does nothing',
      tree,
      // Explicit, because this project's DEFAULT provider is OpenRouter (ADR-0015's
      // amendment: the default follows the evidence, and the real run was there).
      // The fixture speaks the Messages API, so the test has to say which one it is —
      // and the first draft of this file did not, sent Anthropic-shaped requests down
      // the OpenRouter branch, and got `null` from every case. Three assertions
      // "passed" on it, all of them the ones expecting null.
      provider: 'anthropic',
      apiKey: 'test',
      baseURL: model.baseURL,
    }),
    model,
  };
};

describe('triage asks one question, or none', () => {
  test('a report that can be started on produces no question at all', async () => {
    // The default answer, and the common case. Commenting anyway would train every
    // reporter to ignore the comment that matters.
    const { question } = await ask('ENOUGH');
    expect(question).toBeNull();
  });

  test('a missing fact comes back as the question to ask', async () => {
    const { question } = await ask('Which plan is the account on when the export fails?');
    expect(question).toBe('Which plan is the account on when the export fails?');
  });

  test('an answer that explains itself first is read down to its question', async () => {
    // A model told to answer in one line answers in three often enough that taking
    // the first non-empty line is the honest reading of a loosely followed
    // instruction — not a parser to be proud of, but the alternative is discarding
    // a good question because a model was chatty.
    const { question } = await ask('Which account was it on?\n\nI ask because the export path branches on plan.');
    expect(question).toBe('Which account was it on?');
  });

  test('an answer with no question in it is not turned into one', async () => {
    // The failure this prevents: a model that ignores the instruction and diagnoses
    // the bug instead. Posting that to the issue would be the engine asserting a
    // cause it has not measured — the one thing this project never does.
    const { question } = await ask('The bug is probably in the CSV writer, which does not flush.');
    expect(question).toBeNull();
  });

  test('a model that cannot be reached costs the run nothing', async () => {
    // `askOnce` swallows everything, and this is why: triage exists to make a run
    // better and must never be able to make one worse. A 500 here has to be
    // indistinguishable from "nothing worth asking".
    const model = await fakeModel([], { status: 500 });
    models.push(model);
    const question = await triage({
      issue: 'the export button does nothing',
      tree: ['src/index.ts'],
      provider: 'anthropic',
      apiKey: 'test',
      baseURL: model.baseURL,
    });
    expect(question).toBeNull();
  });

  test('the file listing is bounded, and says so rather than being silently cut', async () => {
    // A repository is not a prompt. 400 paths is a shape a model can read; 40,000 is
    // a token bill and a truncation nobody was told about.
    const tree = Array.from({ length: 1000 }, (_, n) => `src/module-${n}.ts`);
    const { model } = await ask('Which page were you on?', tree);
    const sent = JSON.stringify(model.requests.at(-1));
    expect(sent).toContain('src/module-399.ts');
    expect(sent).not.toContain('src/module-400.ts');
    expect(sent).toContain('and 600 more paths');
  });

  test('the report reaches the model, because a question about nothing is worthless', async () => {
    const { model } = await ask('Which page were you on?');
    expect(JSON.stringify(model.requests.at(-1))).toContain('the export button does nothing');
  });

  test('triage carries no tools, which is what makes it cheap', async () => {
    // It has nothing to execute and one turn to use. A tool surface here would be an
    // agent loop wearing a question's clothes — and the cheap models this exists for
    // are exactly the ones that handle tools worst.
    const { model } = await ask('ENOUGH');
    expect(model.requests.at(-1)!['tools']).toBeUndefined();
  });
});
