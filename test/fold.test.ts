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
        attempt: 1,
        command: 'npm test -- checkout-discount',
        files: { 'tests/checkout-discount.test.ts': 'sha256:2f4d6e8a0c1b3d5f7a9c0e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f2a4c6e8b0d2f' },
        applied: ['tests/checkout-discount.test.ts'],
      },
      registrations: [
        {
          attempt: 1,
          command: 'npm test -- checkout-discount',
          files: { 'tests/checkout-discount.test.ts': 'sha256:2f4d6e8a0c1b3d5f7a9c0e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f2a4c6e8b0d2f' },
          applied: ['tests/checkout-discount.test.ts'],
        },
      ],
      reproduced: true,
      reproducedAttempt: 1,
      shownOnBase: true,
      fixDiff: {
        changed_files: ['src/checkout/discount.ts'],
        diff_hash: 'sha256:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
      },
      completedAttempts: [1],
      transcript: [],
      agent: null,
      handedOver: null, handovers: [],
      reproAuthoredByAgent: false,
      pr: {
        repo: 'demo-org/demo-app',
        pr_number: 42,
        head_sha: 'f3a9d1c7e5b2048a6c1d9e7f3b5a2c8d0e4f6a1b',
      },
      aborts: [],
      afterEnd: [],
      endedReason: null, // the demo run predates RUN_ENDED
      artifactHashes: [
        'sha256:5b7a1de2c3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
        'sha256:9c8b7a6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b',
        'sha256:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
        'sha256:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
      ],
      lastSeq: 8,
    });
  });

  it('reconstructs correct intermediate state after every prefix (replay)', () => {
    const expected: Array<Partial<ReturnType<typeof fold>>> = [
      { status: 'requested', source: 'slack', reproduced: false },
      { status: 'sandbox_ready', reproduced: false },
      { status: 'attempting', currentAttempt: 1, reproduced: false },
      { status: 'attempting', reproduced: false }, // repro registered — still nothing proven
      { status: 'attempting', reproduced: false }, // base failed — nothing proven yet
      // The fix passed, but nothing yet vouches the flake series ran to the end.
      { status: 'attempting', reproduced: false },
      { status: 'attempting', reproduced: true }, // diff observed — the series is complete
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
      // The completion witness, so this reaches the guard under test instead of
      // being rejected earlier for a truncated series and passing for the wrong
      // reason.
      {
        run_id: 'r',
        seq: 5,
        ts: 'T',
        type: 'FIX_DIFF_OBSERVED',
        payload: { v: 1, base_sha: 'a', fix_sha: 'b', changed_files: [], diff_hash: 'sha256:cc' },
      },
    ];
    expect(fold(events).reproduced).toBe(false);
  });

  it('refuses an attempt whose series is vouched for but ran no fix at all', () => {
    // Witness present, zero fix runs. `.every()` over nothing is vacuously true,
    // so without the length guard this reads as "the fix passed every time".
    const events: RunEvent[] = [
      { run_id: 'r', seq: 1, ts: 'T', type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 } },
      {
        run_id: 'r',
        seq: 2,
        ts: 'T',
        type: 'REPRO_REGISTERED',
        payload: { v: 1, command: 'x', files: { f: 'sha256:aa' }, applied: ['f'] },
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
          repro_hashes: { f: 'sha256:aa' },
        },
      },
      {
        run_id: 'r',
        seq: 4,
        ts: 'T',
        type: 'FIX_DIFF_OBSERVED',
        payload: { v: 1, base_sha: 'a', fix_sha: 'b', changed_files: [], diff_hash: 'sha256:cc' },
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
      { ...demoRunEvents[6]!, seq: 7 }, // and its series is vouched for
    ];
    expect(fold(events).reproduced).toBe(false);
  });
});

describe('the transcript is testimony', () => {
  const said = (seq: number, claimed: string | null, hash = 'sha256:ff'): RunEvent => ({
    run_id: DEMO_RUN_ID,
    seq,
    ts: 'T',
    type: 'AGENT_MESSAGE',
    payload: { v: 1, n: seq - 2, claimed_type: claimed, raw_hash: hash as never, bytes: 10 },
  });

  it('cannot move the run forward, however loudly it claims to', () => {
    // The agent asserting a green fix is worth exactly nothing. Only the Runner's
    // own observations reach a verdict (ADR-0006).
    const state = fold([demoRunEvents[0]!, said(2, 'TEST_RUN'), said(3, 'PR_OPENED')]);
    expect(state.transcript).toHaveLength(2);
    expect(state.reproduced).toBe(false);
    expect(state.status).toBe('requested');
    expect(state.pr).toBeNull();
    expect(state.testRuns).toEqual([]);
  });

  it('keeps its artifacts out of the evidence report', () => {
    // `artifactHashes` is what the evidence report cites. What the agent said is
    // retrievable through `transcript`, and deliberately not citable as evidence.
    const state = fold([demoRunEvents[0]!, said(2, 'assistant')]);
    expect(state.artifactHashes).toEqual([]);
    expect(state.transcript[0]!.raw_hash).toBe('sha256:ff');
  });

  it('records how supervision ended, including a transcript that was cut off', () => {
    const state = fold([
      demoRunEvents[0]!,
      said(2, 'assistant'),
      {
        run_id: DEMO_RUN_ID,
        seq: 3,
        ts: 'T',
        type: 'AGENT_FINISHED',
        payload: { v: 1, messages: 1, exit_code: 0, stopped: 'line_cap' },
      },
    ]);
    expect(state.agent).toEqual({ messages: 1, exit_code: 0, stopped: 'line_cap' });
  });
});

/**
 * The reproduce-first gate (ADR-0007). Everything here is about whether a fix
 * gets attempted at all, which is a decision made long before any verdict — and
 * a decision the orchestrator must read off the fold rather than re-derive.
 */
describe('the gate', () => {
  const reg = (seq: number): RunEvent => ({
    run_id: DEMO_RUN_ID, seq, ts: 'T', type: 'REPRO_REGISTERED',
    payload: { v: 1, command: 'c', files: { f: 'sha256:aa' }, applied: ['f'] },
  });
  const baseRun = (seq: number, over: Record<string, unknown> = {}): RunEvent => ({
    run_id: DEMO_RUN_ID, seq, ts: 'T', type: 'TEST_RUN',
    payload: {
      v: 1, phase: 'base', commit_sha: 'a', exit_code: 1, stdout_hash: 'sha256:x',
      duration_ms: 1, symptom_matched: true, repeat: 0, repro_hashes: { f: 'sha256:aa' },
      ...over,
    },
  } as RunEvent);
  const abort = (seq: number, phase: VerificationPhase): RunEvent => ({
    run_id: DEMO_RUN_ID, seq, ts: 'T', type: 'VERIFICATION_ABORTED',
    payload: { v: 1, phase, reason: 'r' },
  });
  const attempt1: RunEvent = {
    run_id: DEMO_RUN_ID, seq: 1, ts: 'T', type: 'ATTEMPT_STARTED', payload: { v: 1, n: 1 },
  };

  it('opens when the base failed for the reported reason', () => {
    expect(fold([attempt1, reg(2), baseRun(3)]).shownOnBase).toBe(true);
  });

  it('stays shut when the base passed', () => {
    expect(fold([attempt1, reg(2), baseRun(3, { exit_code: 0 })]).shownOnBase).toBe(false);
  });

  it('stays shut when the symptom did not match', () => {
    expect(fold([attempt1, reg(2), baseRun(3, { symptom_matched: false })]).shownOnBase).toBe(false);
  });

  it('stays shut on a signalled base — a crash is not a reproduction', () => {
    // The one the comment in the fold describes and nothing tested: an OOM-killed
    // base records exit_code -1, which sails through "did it fail", and its
    // partial output may well contain the symptom string.
    const killed = fold([attempt1, reg(2), baseRun(3, { exit_code: -1, signal: 'SIGKILL' })]);
    expect(killed.shownOnBase).toBe(false);
  });

  it('stays shut with no registration to anchor it', () => {
    expect(fold([attempt1, baseRun(2)]).shownOnBase).toBe(false);
  });

  it('stays shut when the run belongs to no declared attempt', () => {
    expect(fold([reg(1), baseRun(2)]).shownOnBase).toBe(false);
  });

  it('shuts on a BASE abort — that observation was cut short', () => {
    expect(fold([attempt1, reg(2), abort(3, 'base'), baseRun(4)]).shownOnBase).toBe(false);
  });

  it('survives a FIX abort — the bug was still shown', () => {
    // The retro-flip. The orchestrator runs the fix container only when the gate
    // is open, so a fix-phase abort left the log denying the very act recorded
    // inside it — and an agent could shut its own gate with a repro that hangs.
    const state = fold([attempt1, reg(2), baseRun(3), abort(4, 'fix')]);
    expect(state.shownOnBase).toBe(true);
    // Still not a reproduction: the series judging the fix was truncated.
    expect(state.reproduced).toBe(false);
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

  it('records events that arrive after the end without applying them', () => {
    // The store enforces unique (run_id, seq); nothing enforces terminality at
    // write. Throwing would let one racing append make the run permanently
    // unrenderable, and events are immutable — there is no repair path. So the
    // fold renders the truth plus "this log is malformed".
    const past = fold([...ended('not_reproduced'), { ...demoRunEvents[1]!, seq: 3 }]);
    expect(past.afterEnd).toEqual(['SANDBOX_CREATED']);
    expect(past.status).toBe('unresolved'); // NOT advanced by the late event
    expect(past.lastSeq).toBe(3);
  });

  it('does not let a late PR_OPENED rewrite the outcome', () => {
    const late = fold([
      ...ended('not_reproduced'),
      { ...demoRunEvents[7]!, seq: 3 },
    ]);
    expect(late.status).toBe('unresolved');
    expect(late.pr).toBeNull();
    expect(late.afterEnd).toEqual(['PR_OPENED']);
  });

  it('reports pr_opened when a run that opened a PR then errored', () => {
    // Deliberate precedence, and the one case the ternary decides by ordering:
    // the PR is the deliverable and it exists. The fault stays visible in aborts.
    const state = fold([...demoRunEvents, end('error', demoRunEvents.length + 1)]);
    expect(state.status).toBe('pr_opened');
    expect(state.endedReason).toBe('error');
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
    expect(state.aborts).toEqual([{ attempt: 1, phase: 'fix', reason: REASON }]);
  });

  it('never credits a reproduction on its own', () => {
    expect(fold([demoRunEvents[0]!, aborted('base', 2)]).reproduced).toBe(false);
  });

  it('revokes a reproduction the truncated runs had already earned', () => {
    // The abort arrives AFTER the runs it truncates, so a fold that only
    // recomputed on TEST_RUN would leave the verdict standing.
    const complete = fold(demoRunEvents.slice(0, 7));
    expect(complete.reproduced).toBe(true);

    const truncated = fold([...demoRunEvents.slice(0, 7), aborted('fix', 8)]);
    expect(truncated.reproduced).toBe(false);
  });

  it('will not take a completion witness from a producer that has no phase machine', () => {
    // The witness rule reads a `diff` or `cleanup` abort as proof the flake loop
    // closed. That holds for `verify()`, whose phase advances past `fix` only when
    // the loop ends — and for nothing else. The HOST emits `cleanup` for every
    // container, agent and base included, written before the fix series has run
    // at all, so a failed blob copy in an early container handed the fold the one
    // witness that exists to stop a truncated fix series being credited.
    // Through the fix run — 5 stops one short, which made the `reproduced`
    // assertion below vacuously true for want of a fix run rather than because
    // of the gate, and the filter a no-op.
    const truncated = demoRunEvents
      .slice(0, 6)
      .filter((e) => e.type !== 'FIX_DIFF_OBSERVED');

    const hostAbort = (cause: 'collection' | undefined): RunEvent => ({
      run_id: DEMO_RUN_ID,
      seq: truncated.length + 1,
      ts: 'T',
      type: 'VERIFICATION_ABORTED',
      payload: { v: 1, phase: 'cleanup', reason: 'blobs went missing', ...(cause ? { cause } : {}) },
    });

    // The control: without the abort at all, the series is plainly incomplete.
    expect(fold(truncated).reproduced).toBe(false);
    // The engine's own cleanup abort still vouches for the series, as it must —
    // that is why the rule exists.
    expect(fold([...truncated, hostAbort(undefined)]).completedAttempts).toContain(1);
    // The host's does not.
    const host = fold([...truncated, hostAbort('collection')]);
    expect(host.completedAttempts).not.toContain(1);
    expect(host.reproduced).toBe(false);
  });

  it('will not credit fix runs that judged a commit other than the one handed over', () => {
    // ADR-0009: the fold owns interpretation. Without this the invariant lived in
    // a sandbox test — a producer could hand over commit A, verify commit B, and
    // still fold to `reproduced: true` with the log's own record of the
    // discrepancy sitting inert beside it.
    const handed = (commit: string, seq: number): RunEvent => ({
      run_id: DEMO_RUN_ID,
      seq,
      ts: 'T',
      type: 'AGENT_HANDED_OVER',
      payload: { v: 1, commit },
    });

    const fixSha = demoRunEvents.find(
      (e) => e.type === 'TEST_RUN' && e.payload.phase === 'fix',
    )!.payload as { commit_sha: string };

    // Handing over the very commit the fix runs judged changes nothing.
    const honest = fold([
      demoRunEvents[0]!,
      handed(fixSha.commit_sha, 2),
      ...demoRunEvents.slice(1, 7).map((e) => ({ ...e, seq: e.seq + 1 })),
    ]);
    expect(honest.handedOver).toBe(fixSha.commit_sha);
    expect(honest.reproduced).toBe(true);

    // Handing over a different one is not a reproduction of the agent's fix.
    const swapped = fold([
      demoRunEvents[0]!,
      handed('f'.repeat(40), 2),
      ...demoRunEvents.slice(1, 7).map((e) => ({ ...e, seq: e.seq + 1 })),
    ]);
    expect(swapped.reproduced).toBe(false);
  });

  it('checks each attempt against its OWN handover, not the run\'s last one', () => {
    // `handedOver` was a scalar, and `RegisteredRepro.attempt` exists because
    // exactly this went wrong for the reproduction. With attempts bounded there
    // are several handovers per run, so attempt 1's fix runs would be compared
    // against attempt 2's commit — a commit-swap accusation against a clean
    // attempt, which this fold has already had to learn once.
    const fixSha = (demoRunEvents.find(
      (e) => e.type === 'TEST_RUN' && e.payload.phase === 'fix',
    )!.payload as { commit_sha: string }).commit_sha;

    const handed = (commit: string, seq: number): RunEvent => ({
      run_id: DEMO_RUN_ID,
      seq,
      ts: 'T',
      type: 'AGENT_HANDED_OVER',
      payload: { v: 1, commit, kind: 'fix' },
    });

    // Attempt 1 is honest and complete. Attempt 2 hands over something else and
    // never finishes — its handover must not reach back and disqualify attempt 1.
    const state = fold([
      ...demoRunEvents.slice(0, 3).map((e) => ({ ...e })), // through ATTEMPT_STARTED n=1
      handed(fixSha, 4),
      ...demoRunEvents.slice(3, 8).map((e) => ({ ...e, seq: e.seq + 1 })),
      { run_id: DEMO_RUN_ID, seq: 10, ts: 'T', type: 'ATTEMPT_STARTED', payload: { v: 1, n: 2 } },
      handed('f'.repeat(40), 11),
    ]);

    expect(state.handovers.map((h) => h.attempt)).toEqual([1, 2]);
    expect(state.reproduced).toBe(true);
    expect(state.reproducedAttempt).toBe(1);
  });

  it('leaves a fully observed attempt alone when a LATER attempt aborts', () => {
    const state = fold([
      ...demoRunEvents.slice(0, 7), // attempt 1, fully observed, red -> green -> diff
      { run_id: DEMO_RUN_ID, seq: 8, ts: 'T', type: 'ATTEMPT_STARTED', payload: { v: 1, n: 2 } },
      aborted('fix', 9), // attempt 2 dies
    ]);
    // Disqualification is scoped to its own attempt, or one bad attempt would
    // erase a good one — `reproduced` scans the whole history.
    expect(state.aborts).toEqual([{ attempt: 2, phase: 'fix', reason: REASON }]);
    expect(state.reproduced).toBe(true);
  });

  it('will not credit a series that simply stops, with no abort to give it away', () => {
    // The dangerous shape, and the reason the fold needs the log's own completion
    // witness rather than the abort record. The Runner emits its events in one
    // loop at the end and a host may append them as they arrive, so a container
    // killed mid-stream writes exactly this: a red base, one green fix run, and
    // nothing else. No abort. Counting passes cannot tell it from a full series.
    const cutShort = fold(demoRunEvents.slice(0, 6));
    expect(cutShort.testRuns.filter((r) => r.phase === 'fix')).toHaveLength(1);
    expect(cutShort.aborts).toEqual([]);
    expect(cutShort.completedAttempts).toEqual([]);
    expect(cutShort.reproduced).toBe(false);
  });

  it('disqualifies on a base abort even when the runs themselves look clean', () => {
    // Pins `base` in the truncation filter: without real runs beside it, a lone
    // base abort is already false for want of anything to credit.
    const events = [
      ...demoRunEvents.slice(0, 7),
      aborted('base', 8),
    ];
    expect(fold(events).reproduced).toBe(false);
  });

  it('does not disqualify on a setup abort — no observation had begun', () => {
    // Pins the other side of the same line. A setup abort means the attempt never
    // started looking, so it cannot have truncated anything.
    expect(fold([...demoRunEvents.slice(0, 7), aborted('setup', 8)]).reproduced).toBe(true);
  });

  it('judges each attempt against the reproduction IT registered', () => {
    // A second registration must not retroactively judge the first attempt's
    // runs — that both credits runs which never executed the repro they are
    // measured by, and erases an honestly earned verdict when a later attempt
    // merely re-registers.
    const other: RunEvent = {
      run_id: DEMO_RUN_ID,
      seq: 9,
      ts: 'T',
      type: 'REPRO_REGISTERED',
      payload: { v: 1, command: 'different', files: { 'other.test.ts': 'sha256:ff' }, applied: [] },
    };
    const state = fold([
      ...demoRunEvents.slice(0, 7), // attempt 1: complete, and genuinely reproduced
      { run_id: DEMO_RUN_ID, seq: 8, ts: 'T', type: 'ATTEMPT_STARTED', payload: { v: 1, n: 2 } },
      other,
    ]);
    expect(state.registrations).toHaveLength(2);
    expect(state.reproduced).toBe(true);
  });

  it('attaches the completion witness to the attempt that earned it', () => {
    // Attempt 1 runs red -> green but never reaches its diff; attempt 2 emits one.
    // Nothing may carry attempt 2's proof back to attempt 1.
    const state = fold([
      ...demoRunEvents.slice(0, 6), // attempt 1, cut short before the witness
      { run_id: DEMO_RUN_ID, seq: 7, ts: 'T', type: 'ATTEMPT_STARTED', payload: { v: 1, n: 2 } },
      { ...demoRunEvents[6]!, seq: 8 }, // FIX_DIFF_OBSERVED, now inside attempt 2
    ]);
    expect(state.completedAttempts).toEqual([2]);
    expect(state.reproduced).toBe(false);
  });

  it('treats a diff or cleanup abort as the completion witness itself', () => {
    // Deliberately WITHOUT FIX_DIFF_OBSERVED, because that is the stream the
    // engine really emits here: the phase advances to `diff` before the diff is
    // computed, so a diff-phase abort never carries the event. Reaching either
    // phase already proves the flake loop closed, which is the same evidence.
    // Folding a witness-bearing stream would assert nothing about that.
    for (const phase of ['diff', 'cleanup'] as const) {
      const state = fold([...demoRunEvents.slice(0, 6), aborted(phase, 7)]);
      expect(state.completedAttempts).toEqual([1]);
      expect(state.reproduced).toBe(true);
    }
  });
});
