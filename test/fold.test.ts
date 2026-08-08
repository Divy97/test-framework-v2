import { describe, expect, it } from 'vitest';
import type { RunEndedV1, RunEvent, VerificationPhase } from '../src/events.js';
import { fold } from '../src/fold.js';
import { DEMO_RUN_ID, demoRunEvents } from '../src/fixtures/demo-run.js';

describe('fold', () => {
  it('folds the full demo stream into the expected RunState', () => {
    expect(fold(demoRunEvents)).toEqual({
      runId: DEMO_RUN_ID,
      status: 'pr_opened',
      source: 'slack',
      threadRef: 'C0DEMO/p1754395200000100',
      currentAttempt: 1,
      testRuns: [
        {
          attempt: 1,
          phase: 'base',
          commit_sha: '8d41c6b2a09f7e5d3c1b0a98765432104f6e2d1c',
          exit_code: 1,
          signal: undefined,
          stdout_hash: 'sha256:5b7a1de2c3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
          duration_ms: 4312,
          symptom_matched: true,
          repeat: 0,
          repro_hashes: { 'tests/checkout-discount.test.ts': 'sha256:2f4d6e8a0c1b3d5f7a9c0e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f2a4c6e8b0d2f' },
        },
        {
          attempt: 1,
          phase: 'fix',
          commit_sha: 'f3a9d1c7e5b2048a6c1d9e7f3b5a2c8d0e4f6a1b',
          exit_code: 0,
          signal: undefined,
          stdout_hash: 'sha256:9c8b7a6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b',
          duration_ms: 3987,
          symptom_matched: undefined,
          repeat: 0,
          repro_hashes: { 'tests/checkout-discount.test.ts': 'sha256:2f4d6e8a0c1b3d5f7a9c0e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f2a4c6e8b0d2f' },
        },
      ],
      registeredRepro: {
        command: 'npm test -- checkout-discount',
        files: { 'tests/checkout-discount.test.ts': 'sha256:2f4d6e8a0c1b3d5f7a9c0e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f2a4c6e8b0d2f' },
        applied: ['tests/checkout-discount.test.ts'],
      },
      reproduced: true,
      fixDiff: null, // the demo run predates FIX_DIFF_OBSERVED
      pr: {
        repo: 'demo-org/demo-app',
        pr_number: 42,
        head_sha: 'f3a9d1c7e5b2048a6c1d9e7f3b5a2c8d0e4f6a1b',
      },
      aborts: [],
      endedReason: null, // the demo run predates RUN_ENDED
      artifactHashes: [
        'sha256:5b7a1de2c3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
        'sha256:9c8b7a6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b',
        'sha256:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
      ],
      lastSeq: 7,
    });
  });

  it('reconstructs correct intermediate state after every prefix (replay)', () => {
    const expected: Array<Partial<ReturnType<typeof fold>>> = [
      { status: 'requested', source: 'slack', reproduced: false },
      { status: 'sandbox_ready', reproduced: false },
      { status: 'attempting', currentAttempt: 1, reproduced: false },
      { status: 'attempting', reproduced: false }, // repro registered — still nothing proven
      { status: 'attempting', reproduced: false }, // base failed — nothing proven yet
      { status: 'attempting', reproduced: true }, // fix passed — red→green
      { status: 'pr_opened', reproduced: true },
    ];
    expected.forEach((partial, i) => {
      expect(fold(demoRunEvents.slice(0, i + 1))).toMatchObject(partial);
      expect(fold(demoRunEvents.slice(0, i + 1)).lastSeq).toBe(i + 1);
    });
  });

  it('refuses a reproduction registered against no files at all', () => {
    // `.every()` over an empty set is vacuously true, so an empty registration
    // would degenerate into "repro_hashes was present" and credit anything.
    const events: RunEvent[] = [
      { run_id: 'r', seq: 1, ts: 'T', type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } },
      {
        run_id: 'r',
        seq: 2,
        ts: 'T',
        type: 'REPRO_REGISTERED',
        payload: { v: 1, command: 'x', files: {}, applied: [] },
      },
      {
        run_id: 'r',
        seq: 3,
        ts: 'T',
        type: 'TEST_RUN',
        payload: {
          v: 1,
          phase: 'base',
          commit_sha: 'a',
          exit_code: 1,
          stdout_hash: 'sha256:aa',
          duration_ms: 1,
          symptom_matched: true,
          repro_hashes: {},
        },
      },
      {
        run_id: 'r',
        seq: 4,
        ts: 'T',
        type: 'TEST_RUN',
        payload: {
          v: 1,
          phase: 'fix',
          commit_sha: 'b',
          exit_code: 0,
          stdout_hash: 'sha256:bb',
          duration_ms: 1,
          repro_hashes: {},
        },
      },
    ];
    expect(fold(events).reproduced).toBe(false);
  });

  it('is deterministic: same events, same state', () => {
    expect(fold(demoRunEvents)).toEqual(fold(demoRunEvents));
  });

  it('does not mutate its input', () => {
    const copy = structuredClone(demoRunEvents);
    fold(demoRunEvents);
    expect(demoRunEvents).toEqual(copy);
  });

  it('throws on a seq gap', () => {
    const gapped = [demoRunEvents[0]!, demoRunEvents[2]!];
    expect(() => fold(gapped)).toThrow(/seq gap/);
  });

  it('throws on a foreign run_id mixed into the stream', () => {
    const foreign = { ...demoRunEvents[1]!, run_id: '00000000-0000-0000-0000-000000000000' };
    expect(() => fold([demoRunEvents[0]!, foreign])).toThrow(/does not match/);
  });

  it('throws on an unknown event type', () => {
    const bogus = { ...demoRunEvents[1]!, type: 'TEST_FAILED_AS_EXPECTED' } as unknown as RunEvent;
    expect(() => fold([demoRunEvents[0]!, bogus])).toThrow(/unknown event type/);
  });

  it('throws on an empty stream', () => {
    expect(() => fold([])).toThrow(/empty/);
  });

  it('keeps reproduced=false when base passes — interpretation lives in the fold', () => {
    const basePasses = demoRunEvents.map((e) =>
      e.type === 'TEST_RUN' && e.payload.phase === 'base'
        ? { ...e, payload: { ...e.payload, exit_code: 0 } }
        : e,
    );
    const state = fold(basePasses);
    expect(state.reproduced).toBe(false);
    expect(state.status).toBe('pr_opened'); // facts unchanged elsewhere; only meaning differs
  });

  it('keeps reproduced=false when base fail and fix pass are in different attempts', () => {
    const events: RunEvent[] = [
      demoRunEvents[0]!,
      demoRunEvents[1]!,
      demoRunEvents[2]!,
      demoRunEvents[3]!, // attempt 1: base fails
      { ...demoRunEvents[4]!, seq: 5, type: 'ATTEMPT_STARTED', payload: { v: 1, n: 2 } },
      { ...demoRunEvents[4]!, seq: 6 }, // attempt 2: fix passes, but its base never ran
    ];
    expect(fold(events).reproduced).toBe(false);
  });
});

/**
 * A run's ending is a control-flow act, not a verdict. These fix the line: the
 * fold records WHY the process stopped and derives WHAT that means from the
 * facts, so a producer cannot talk the log into a conclusion it did not earn.
 */
describe('a run that ends', () => {
  const end = (reason: RunEndedV1['reason'], seq: number): RunEvent => ({
    run_id: DEMO_RUN_ID,
    seq,
    ts: 'T',
    type: 'RUN_ENDED',
    payload: { v: 1, reason },
  });
  /** The shortest honest run: it was requested, and then it stopped. */
  const ended = (reason: RunEndedV1['reason']): RunEvent[] => [demoRunEvents[0]!, end(reason, 2)];

  it('is unresolved when nothing reproduced — a deliverable, not a failure', () => {
    const state = fold(ended('not_reproduced'));
    expect(state.status).toBe('unresolved');
    expect(state.endedReason).toBe('not_reproduced');
  });

  it('is unresolved, not errored, when the attempts ran out', () => {
    expect(fold(ended('attempts_exhausted')).status).toBe('unresolved');
  });

  it('separates an infrastructure failure from a finding about the bug', () => {
    // Reporting "we could not reproduce it" when the truth is "the sandbox fell
    // over" is a lie about the bug, told by a status field.
    expect(fold(ended('error')).status).toBe('errored');
  });

  it('will not show a PR on a stream that only claims one', () => {
    // The reason says pr_opened; no PR_OPENED event exists. The fold reports what
    // the log can support, and keeps the claim visible beside it.
    const state = fold(ended('pr_opened'));
    expect(state.status).toBe('unresolved');
    expect(state.pr).toBeNull();
    expect(state.endedReason).toBe('pr_opened');
  });

  it('will not hide a PR the log actually contains', () => {
    // The mirror image: a real PR_OPENED, and a reason claiming nothing was
    // reproduced. Facts win in both directions.
    const state = fold([...demoRunEvents, end('not_reproduced', demoRunEvents.length + 1)]);
    expect(state.status).toBe('pr_opened');
    expect(state.endedReason).toBe('not_reproduced');
  });

  it('refuses events that arrive after the end', () => {
    const past = [...ended('not_reproduced'), { ...demoRunEvents[1]!, seq: 3 }];
    expect(() => fold(past)).toThrow(/after the end/);
  });
});

describe('an attempt that could not be observed', () => {
  const REASON = 'ObservationFailed: repro command exceeded 100ms';
  const aborted = (phase: VerificationPhase, seq: number): RunEvent => ({
    run_id: DEMO_RUN_ID,
    seq,
    ts: 'T',
    type: 'VERIFICATION_ABORTED',
    payload: { v: 1, phase, reason: REASON },
  });

  it('is recorded without ending the run — the next attempt may still succeed', () => {
    const state = fold([
      demoRunEvents[0]!,
      demoRunEvents[1]!,
      demoRunEvents[2]!, // ATTEMPT_STARTED n=1
      aborted('fix', 4),
    ]);
    expect(state.status).toBe('attempting');
    expect(state.aborts).toEqual([{ phase: 'fix', reason: REASON }]);
  });

  it('never credits a reproduction on its own', () => {
    expect(fold([demoRunEvents[0]!, aborted('base', 2)]).reproduced).toBe(false);
  });
});
