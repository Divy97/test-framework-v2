// What the projection concludes, and — more importantly — what it refuses to
// conclude. Every ground has to name bytes a reviewer could open (ADR-0004), and
// the gate has to hold with no partial credit (ADR-0007).
//
// Driven off REAL engine output wherever the claim is about evidence, because a
// hand-built stream can assert any hash it likes and the whole point is that
// these hashes resolve.

import { afterEach, describe, expect, test } from 'vitest';
import { get } from '../src/blobs.js';
import { confidence } from '../src/confidence.js';
import type { RunEvent } from '../src/events.js';
import { fold, type RunState } from '../src/fold.js';
import { verify, type VerifyOptions } from '../src/verify.js';
import {
  APPLIED_REPRO,
  cleanupFixtures,
  clean,
  committedTest,
  FLAKY_REPRO,
  helperOnlyInFix,
  irreproducible,
  PINNED_REPRO,
  REPRO_NEEDING_FIX_HELPER,
  pinnedTampering,
  type Fixture,
} from './fixtures/repo.js';

const RUN_ID = '2b8e4f61-0c3a-4d7e-9a15-6f8b0c2e4d39';

/** A state with nothing in it, for the incoherent-log cases. */
const EMPTY: RunState = {
  runId: 'r', status: 'attempting', source: null, threadRef: null, currentAttempt: 1,
  testRuns: [], registeredRepro: null, registrations: [], reproduced: false,
  reproducedAttempt: null, shownOnBase: false, fixDiff: null, completedAttempts: [], transcript: [],
  agent: null, handedOver: null, pr: null, aborts: [], afterEnd: [], endedReason: null,
  artifactHashes: [], lastSeq: 0,
};

afterEach(cleanupFixtures);

const observe = (fixture: Fixture, overrides: Partial<VerifyOptions> = {}) =>
  verify({
    runId: RUN_ID,
    afterSeq: 0,
    repoPath: fixture.repo,
    baseRef: fixture.base,
    fixRef: fixture.fix,
    repro: APPLIED_REPRO,
    symptomPattern: /wrong/,
    blobRoot: fixture.blobRoot,
    flakeRuns: 2,
    ...overrides,
  });

const conclude = (events: RunEvent[]): RunState =>
  fold([
    { run_id: RUN_ID, seq: 1, ts: 'T', type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } },
    ...events.map((e, i) => ({ ...e, seq: i + 2 })),
  ]);

describe('a clean reproduction', () => {
  test('is Tier 1, and every point names bytes that resolve', async () => {
    const fixture = clean();
    const score = confidence(conclude(await observe(fixture)));

    expect(score.tier).toBe(1);
    // 80 at the default two re-runs, not the 85 ceiling: the third re-run is
    // worth points because it could catch a flake the first two did not.
    expect(score.score).toBe(80);

    // The rule ADR-0004 actually states. A ground that cannot be opened is a
    // vibe with a number attached, so every ref in every ground is resolved —
    // and `get` re-verifies the digest, making this an integrity check too.
    const refs = score.grounds.flatMap((ground) => ground.evidence);
    expect(refs.length).toBeGreaterThan(4);
    for (const ref of refs) {
      await expect(get(fixture.blobRoot, ref)).resolves.toBeInstanceOf(Buffer);
    }
  });

  test('every scored ground cites bytes — the rule, not an aggregate count', async () => {
    // ADR-0004 stated directly. Counting refs across all grounds let any single
    // ground be emptied while the total stayed healthy, so the rule was checked
    // in a way that could not detect breaking it.
    const fixture = clean();
    const score = confidence(conclude(await observe(fixture)));

    for (const ground of score.grounds) {
      if (ground.points === 0) continue;
      expect(ground.evidence, ground.claim).not.toHaveLength(0);
      for (const ref of ground.evidence) {
        await expect(get(fixture.blobRoot, ref)).resolves.toBeInstanceOf(Buffer);
      }
    }
  });

  test('an applied wrapper around a pinned test is not a fully applied anchor', async () => {
    // A spec may mix `files` and `pinned`. The wrapper cannot be touched, but
    // the test it invokes is exactly what a fix commit rewrites — so the anchor
    // is only as strong as its weakest part, and scoring it as untouchable
    // credits a protection that is not there.
    const mixed = confidence(
      conclude(
        await observe(committedTest(), {
          repro: {
            command: 'sh wrap.sh',
            files: { 'wrap.sh': 'sh tests/existing.sh\n' },
            pinned: ['tests/existing.sh'],
          },
        }),
      ),
    );
    const fully = confidence(conclude(await observe(clean())));

    expect(mixed.tier).toBe(1);
    expect(mixed.score).toBeLessThan(fully.score);
    expect(mixed.grounds.some((g) => g.claim.includes('detectable, not preventable'))).toBe(true);
  });

  test('stops at 85 and says what the missing points were for', async () => {
    // 100 would claim the fix diff was checked against the reproduction path.
    // It was not — ADR-0008 retired the filename version as disproved and the
    // real one needs instrumentation. Scoring it as if measured is the exact
    // dishonesty this projection exists to avoid.
    // The ceiling IS reachable — with a third re-run — so 85 is a real number
    // rather than an unattainable one, and the gap to 100 is the honest part.
    expect(confidence(conclude(await observe(clean(), { flakeRuns: 3 }))).score).toBe(85);

    const score = confidence(conclude(await observe(clean())));
    expect(score.score).toBeLessThanOrEqual(85);
    expect(score.unmeasured.join(' ')).toMatch(/diff-coverage/);
    expect(score.unmeasured.join(' ')).toMatch(/Tier 2/);
  });

  test('the re-run bonus is capped, so the advertised ceiling stays true', async () => {
    // Uncapped, a long flake loop scores past 85 and the type's own "0–85"
    // becomes a lie — and the extra points would be bought with repetition
    // rather than with any new kind of evidence.
    const many = confidence(conclude(await observe(clean(), { flakeRuns: 8 })));
    expect(many.score).toBe(85);
  });

  test('scores fewer re-runs lower, because fewer flakes could have been caught', async () => {
    const many = confidence(conclude(await observe(clean(), { flakeRuns: 2 })));
    const one = confidence(conclude(await observe(clean(), { flakeRuns: 0 })));

    expect(many.score).toBeGreaterThan(one.score);
    expect(one.grounds.find((g) => g.claim.includes('re-run'))!.points).toBe(0);
  });

  test('scores a pinned reproduction below an applied one', async () => {
    // Applied bytes cannot be tampered with; a pinned path can only be watched
    // (ADR-0008). That is genuinely less evidence and the number has to say so.
    const applied = confidence(conclude(await observe(clean())));
    const pinned = confidence(
      conclude(await observe(committedTest(), { repro: PINNED_REPRO })),
    );

    expect(applied.tier).toBe(1);
    expect(pinned.tier).toBe(1);
    expect(pinned.score).toBeLessThan(applied.score);
    expect(pinned.grounds.some((g) => g.claim.includes('detectable, not preventable'))).toBe(true);
  });
});

describe('the gate holds, with no partial credit', () => {
  const reasonFor = async (fixture: Fixture, overrides: Partial<VerifyOptions> = {}) => {
    const score = confidence(conclude(await observe(fixture, overrides)));
    expect(score.tier).toBe(3);
    expect(score.score).toBe(0);
    return score.grounds[0]!.claim;
  };

  test('a base that passes scores zero, not "nearly"', async () => {
    // The most important number in the projection. A bug that was never
    // reproduced gets nothing, however clean the rest of the run looked.
    expect(await reasonFor(irreproducible())).toMatch(/passed on the base commit/);
  });

  test('a base failing for the wrong reason says so', async () => {
    expect(await reasonFor(clean(), { symptomPattern: /something-else-entirely/ })).toMatch(
      /did not match the reported symptom/,
    );
  });

  test('a flaky fix names the count rather than shrugging', async () => {
    expect(await reasonFor(clean(), { repro: FLAKY_REPRO })).toMatch(/of 3 runs: a flake is not a fix/);
  });

  test('a tampered reproduction is called what it is', async () => {
    expect(await reasonFor(pinnedTampering(), { repro: PINNED_REPRO })).toMatch(
      /not the one registered/,
    );
  });

  test('a raw Runner stream is not accused of tampering', async () => {
    // `verify()` emits no ATTEMPT_STARTED, so a Runner stream folds with
    // attempt 0 everywhere and the fold refuses to pair the runs. A flawless run
    // was being reported as "the reproduction that ran was not the one
    // registered" — a worse lie than saying nothing.
    const events = await observe(clean(), { flakeRuns: 0 });
    const score = confidence(fold(events.map((e, i) => ({ ...e, seq: i + 1 }))));

    expect(score.tier).toBe(3);
    expect(score.grounds[0]!.claim).toMatch(/no attempt was ever declared/);
  });

  test('a repro that errors on base for want of a fix-only helper is not credited', async () => {
    // Exit code alone calls this a red base — the repro fails to load because
    // the helper only exists in the fix commit. Only the symptom check disagrees.
    expect(
      await reasonFor(helperOnlyInFix(), { repro: REPRO_NEEDING_FIX_HELPER }),
    ).toMatch(/symptom/);
  });

  test('the Tier 3 reason is a deliverable, not an apology', async () => {
    // ADR-0007: the output of a failed gate is a structured info-request. A
    // reason that says only "not reproduced" tells a follow-up nothing about
    // what would have to change.
    const claim = await reasonFor(irreproducible());
    expect(claim.length).toBeGreaterThan(30);
    expect(claim).not.toBe('not reproduced');
  });
});

describe('more than one attempt', () => {
  /** Two real runs folded as consecutive attempts, sharing a blob store so every ref resolves. */
  const twoAttempts = async (first: RunEvent[], second: RunEvent[]): Promise<RunState> =>
    fold([
      { run_id: RUN_ID, seq: 1, ts: 'T', type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } },
      ...first.map((e, i) => ({ ...e, seq: i + 2 })),
      {
        run_id: RUN_ID,
        seq: first.length + 2,
        ts: 'T',
        type: 'ATTEMPT_STARTED',
        payload: { v: 1, n: 2 },
      },
      ...second.map((e, i) => ({ ...e, seq: first.length + 3 + i })),
    ]);

  test('scores the attempt the fold credited, not the last one', async () => {
    // The dangerous shape. Attempt 1 genuinely reproduces; attempt 2 is junk —
    // its base run PASSES. Re-deriving "the credited attempt" as "the last
    // completed one" scored attempt 2 as Tier 1 and cited its green base run as
    // proof the reproduction ran red.
    const store = clean();
    const good = await observe(store, { flakeRuns: 0 });
    const junk = await observe(irreproducible(), { blobRoot: store.blobRoot, flakeRuns: 0 });

    const state = await twoAttempts(good, junk);
    expect(state.reproducedAttempt).toBe(1);

    const score = confidence(state);
    expect(score.tier).toBe(1);
    // Attempt 1's base failed; attempt 2's passed. The cited artifact must be
    // the one that actually failed, or the ground is a sentence over a lie.
    const cited = score.grounds[0]!.evidence[0]!;
    expect((await get(store.blobRoot, cited)).toString()).toContain('wrong');
  });

  test('a later junk attempt cannot lift the score', async () => {
    const store = clean();
    const good = await observe(store, { flakeRuns: 0 });
    const junk = await observe(irreproducible(), { blobRoot: store.blobRoot, flakeRuns: 2 });

    // Attempt 2 has more fix runs. Scoring it would pay for re-runs that
    // happened in an attempt nothing was credited to.
    const alone = confidence(await twoAttempts(good, []));
    const withJunk = confidence(await twoAttempts(good, junk));
    expect(withJunk.score).toBe(alone.score);
  });

  test.each([
    ['reproduced with no attempt recorded', { reproduced: true, reproducedAttempt: null }],
    ['an attempt that has no runs', { reproduced: true, reproducedAttempt: 7 }],
  ])('renders rather than throws: %s', (_name: string, over: Partial<RunState>) => {
    // A projection must render. `cli.ts` calls this straight after replay, so a
    // throw on an incoherent log makes the run permanently unviewable — the same
    // failure the fold was hardened against, one layer up.
    const state = { ...EMPTY, ...over } as RunState;
    expect(() => confidence(state)).not.toThrow();
    expect(confidence(state).tier).toBe(3);
  });

  test('renders rather than throws when the credited runs are missing', async () => {
    // A projection that refuses to render is worse than one that renders the
    // truth plus "this log is malformed" — and `cli.ts` calls this straight
    // after replay, so a throw makes the run permanently unviewable.
    const state = await twoAttempts(await observe(clean(), { flakeRuns: 0 }), []);
    const broken: RunState = { ...state, registrations: [] };

    expect(() => confidence(broken)).not.toThrow();
    expect(confidence(broken).tier).toBe(3);
  });
});

describe('the projection is a projection', () => {
  test('is pure: same state, same score, and the state is untouched', async () => {
    const state = conclude(await observe(clean()));
    const before = structuredClone(state);

    expect(confidence(state)).toEqual(confidence(state));
    expect(state).toEqual(before);
  });

  test('carries a scoring version, so old runs can be re-scored later', async () => {
    // ADR-0004: scoring improves after the fact by re-folding, never by editing
    // history. The version is what makes two runs comparable or not.
    expect(confidence(conclude(await observe(clean()))).scoring).toBe(1);
  });
});
