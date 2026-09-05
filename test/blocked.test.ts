// A run that never started, and the three places that have to agree about it (M10).
//
// `blocked` is the outcome for a repository whose recipe names a variable nobody has
// supplied. It is not a Tier 3: a Tier 3 means the engine tried to reproduce the bug and
// could not, which is a finding about the report. This means nothing was tested at all,
// and the difference matters to exactly the person who filed the issue.
//
// Three things have to say the same thing about it — `parseRecipe` about what a recipe may
// declare, the fold about what the log proves, and the comment about what the reporter is
// asked for — so each is tested against the other two rather than on its own.

import { describe, expect, test } from 'vitest';
import type { RunEvent } from '../src/events.js';
import { fold } from '../src/fold.js';
import { missingRequired, parseRecipe } from '../src/recipe.js';
import { issueComment } from '../src/report.js';

describe('what a recipe may declare', () => {
  test('env and required survive a round trip, and are absent when empty', () => {
    const recipe = parseRecipe({
      install: 'npm ci',
      services: [],
      env: { PORT: '8095', NODE_ENV: 'test' },
      required: ['STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY'],
    });
    expect(recipe.env).toEqual({ PORT: '8095', NODE_ENV: 'test' });
    // De-duplicated, because a name listed twice asks for one thing.
    expect(recipe.required).toEqual(['STRIPE_SECRET_KEY']);
    // A recipe that declares neither carries neither, so nothing downstream has to tell
    // "no variables" from "an empty object somebody stored".
    expect(parseRecipe({ services: [] })).not.toHaveProperty('env');
    expect(parseRecipe({ services: [] })).not.toHaveProperty('required');
  });

  test('a name the engine owns is refused, because taking it over breaks isolation', () => {
    // Not a security boundary — a recipe already runs arbitrary commands — but `TMPDIR`
    // and `HOME` are how the phases are kept from seeing each other's leftovers
    // (ADR-0014), and a recipe that redefined one would break that in a way that reads
    // as the user's project being broken.
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'GIT_DIR', 'GIT_WORK_TREE']) {
      expect(() => parseRecipe({ services: [], env: { [name]: '/x' } })).toThrow(/the engine sets it/);
    }
  });

  test('a value carrying a newline is refused: it would declare a second variable', () => {
    const withNewline = ['one', 'two'].join(String.fromCharCode(10));
    const withReturn = ['one', 'two'].join(String.fromCharCode(13));
    const withNul = ['one', 'two'].join(String.fromCharCode(0));
    expect(() => parseRecipe({ services: [], env: { A: withNewline } })).toThrow(/newline or a NUL/);
    expect(() => parseRecipe({ services: [], env: { A: withReturn } })).toThrow(/newline or a NUL/);
    expect(() => parseRecipe({ services: [], env: { A: withNul } })).toThrow(/newline or a NUL/);
    // And an ordinary value with a space in it is fine — the rule is about line breaks,
    // not about shell quoting, which is the command's own business.
    expect(parseRecipe({ services: [], env: { A: 'one two' } }).env).toEqual({ A: 'one two' });
  });

  test('names have to be names, and lists have to be lists', () => {
    expect(() => parseRecipe({ services: [], env: { 'not a name': 'x' } })).toThrow(/not an environment variable name/);
    expect(() => parseRecipe({ services: [], env: { LOWER_ok: 'x' } })).toThrow(/not an environment variable name/);
    expect(() => parseRecipe({ services: [], env: { A: 7 } })).toThrow(/must be a string/);
    expect(() => parseRecipe({ services: [], env: [] })).toThrow(/must be an object/);
    expect(() => parseRecipe({ services: [], required: 'DATABASE_URL' })).toThrow(/must be an array/);
    expect(() => parseRecipe({ services: [], required: ['lower'] })).toThrow(/must list environment variable names/);
  });

  test('a required name is satisfied by configuration OR by a stored secret, never by neither', () => {
    const recipe = parseRecipe({
      services: [],
      env: { PORT: '8095' },
      required: ['PORT', 'DATABASE_URL', 'STRIPE_SECRET_KEY'],
    });
    expect(missingRequired(recipe)).toEqual(['DATABASE_URL', 'STRIPE_SECRET_KEY']);
    expect(missingRequired(recipe, ['STRIPE_SECRET_KEY'])).toEqual(['DATABASE_URL']);
    expect(missingRequired(recipe, ['DATABASE_URL', 'STRIPE_SECRET_KEY'])).toEqual([]);
    // Order follows `required`, so the sentence a person reads lists them as they wrote them.
    expect(missingRequired(parseRecipe({ services: [], required: ['B_NAME', 'A_NAME'] }))).toEqual([
      'B_NAME',
      'A_NAME',
    ]);
  });
});

const RUN = '44444444-4444-4444-8444-444444444444';
const at = (seq: number, type: RunEvent['type'], payload: unknown): RunEvent =>
  ({ run_id: RUN, seq, ts: '2026-09-06T00:00:00.000Z', type, payload }) as RunEvent;

/** The stream a blocked run leaves: requested, an attempt declared, the abort, the ending. */
const blockedStream = (missing: string[]): RunEvent[] => [
  at(1, 'RUN_REQUESTED', { v: 1, source: 'github_issue', thread_ref: 'o/r#7', raw_text: 'it is broken' }),
  at(2, 'ATTEMPT_STARTED', { v: 1, n: 1 }),
  at(3, 'VERIFICATION_ABORTED', {
    v: 1,
    phase: 'setup',
    cause: 'missing_env',
    reason: `required and unset: ${missing.join(', ')}`,
    missing,
  }),
  at(4, 'RUN_ENDED', { v: 1, reason: 'blocked' }),
];

describe('the fold demands a witness before it will say nothing ran', () => {
  test('the abort names the variables, and the status follows it', () => {
    const state = fold(blockedStream(['DATABASE_URL', 'STRIPE_SECRET_KEY']));
    expect(state.status).toBe('blocked');
    expect(state.aborts.at(-1)).toMatchObject({
      cause: 'missing_env',
      missing: ['DATABASE_URL', 'STRIPE_SECRET_KEY'],
    });
    // And nothing was claimed about the bug.
    expect(state.reproduced).toBe(false);
    expect(state.testRuns).toHaveLength(0);
  });

  test('THE control: `blocked` without the abort folds to `unresolved`', () => {
    // `errored` is the one status the fold takes on the producer's word, because an
    // infrastructure failure is unevidenced by construction. This one is not: a run that
    // never started says which names it was missing, in the event before the ending. A
    // producer that claims `blocked` and cannot show that has claimed nothing.
    const withoutWitness = blockedStream(['DATABASE_URL'])
      .filter((event) => event.type !== 'VERIFICATION_ABORTED')
      // Re-sequenced, because the fold refuses a gap.
      .map((event, index) => ({ ...event, seq: index + 1 }));
    expect(fold(withoutWitness).status).toBe('unresolved');
  });

  test('an abort with a different cause is not a witness either', () => {
    const wrongCause = blockedStream(['DATABASE_URL']).map((event) =>
      event.type === 'VERIFICATION_ABORTED'
        ? at(3, 'VERIFICATION_ABORTED', {
            v: 1,
            phase: 'setup',
            cause: 'environment',
            reason: 'the recipe did not boot',
          })
        : event,
    );
    expect(fold(wrongCause).status).toBe('unresolved');
  });
});

describe('what the reporter is told', () => {
  const comment = (missing: string[]) =>
    issueComment(fold(blockedStream(missing)), { issue: 'it is broken', threadRef: 'o/r#7' });

  test('it names the variables, says nothing was tested, and asks for no values', () => {
    const body = comment(['DATABASE_URL', 'STRIPE_SECRET_KEY']);
    expect(body).toContain('`DATABASE_URL`');
    expect(body).toContain('`STRIPE_SECRET_KEY`');
    expect(body).toMatch(/did not start/);
    expect(body).toMatch(/nothing about the report was tested/i);
    // The one instruction that matters: a public issue thread is not where a credential
    // goes, and the person reading this is about to go looking for somewhere to put one.
    expect(body).toMatch(/Do not paste/);
    expect(body).toMatch(/No fix was attempted/);
    // And it is not the Tier 3 deliverable wearing different words: nothing here asks the
    // reporter for steps, versions or a repository.
    expect(body).not.toMatch(/steps to reproduce/i);
  });

  test('one missing name reads as one thing, not as a list of one', () => {
    const body = comment(['DATABASE_URL']);
    expect(body).toContain('`DATABASE_URL`');
    expect(body).toMatch(/as required, and no value is stored for it/);
  });

  test('a blocked run is not reported as a fault on our side', () => {
    // The `errored` branch says "a fault on our side rather than a finding about the bug",
    // which is true of a container that died and misleading here: this one has a cause the
    // reader can act on in one step, and burying it under an apology hides the sentence
    // worth reading.
    expect(comment(['DATABASE_URL'])).not.toMatch(/fault on our side/);
  });
});
