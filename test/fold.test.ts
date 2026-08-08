import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../src/events.js';
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
          exit_code: 1,
          stdout_hash: 'sha256:5b7a1de2c3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
          duration_ms: 4312,
        },
        {
          attempt: 1,
          phase: 'fix',
          exit_code: 0,
          stdout_hash: 'sha256:9c8b7a6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b',
          duration_ms: 3987,
        },
      ],
      reproduced: true,
      fixDiff: null, // the demo run predates FIX_DIFF_OBSERVED
      pr: {
        repo: 'demo-org/demo-app',
        pr_number: 42,
        head_sha: 'f3a9d1c7e5b2048a6c1d9e7f3b5a2c8d0e4f6a1b',
      },
      artifactHashes: [
        'sha256:5b7a1de2c3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
        'sha256:9c8b7a6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b',
        'sha256:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
      ],
      lastSeq: 6,
    });
  });

  it('reconstructs correct intermediate state after every prefix (replay)', () => {
    const expected: Array<Partial<ReturnType<typeof fold>>> = [
      { status: 'requested', source: 'slack', reproduced: false },
      { status: 'sandbox_ready', reproduced: false },
      { status: 'attempting', currentAttempt: 1, reproduced: false },
      { status: 'attempting', reproduced: false }, // base failed — nothing proven yet
      { status: 'attempting', reproduced: true }, // fix passed — red→green
      { status: 'pr_opened', reproduced: true },
    ];
    expected.forEach((partial, i) => {
      expect(fold(demoRunEvents.slice(0, i + 1))).toMatchObject(partial);
      expect(fold(demoRunEvents.slice(0, i + 1)).lastSeq).toBe(i + 1);
    });
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
