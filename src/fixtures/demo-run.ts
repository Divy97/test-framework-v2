// Hand-authored synthetic event stream for one fake run:
// intake -> sandbox -> attempt -> TEST_RUN base fail -> TEST_RUN fix pass ->
// FIX_DIFF_OBSERVED -> PR_OPENED.
// Permanent test fixture for the fold and every future projection.
// Typed against src/events.ts so the fixture is compile-time checked.

import type { RunEvent } from '../events.js';

export const DEMO_RUN_ID = '3f1c9a52-7b0e-4d2f-9c41-8a6e5d0b21c7';

const t = (s: number) => new Date(Date.UTC(2026, 7, 5, 12, 0, s)).toISOString();

export const demoRunEvents: RunEvent[] = [
  {
    run_id: DEMO_RUN_ID,
    seq: 1,
    ts: t(0),
    type: 'RUN_REQUESTED',
    payload: {
      v: 1,
      source: 'slack',
      thread_ref: 'C0DEMO/p1754395200000100',
      raw_text: 'Checkout totals are wrong when a discount code is applied twice — charges full price.',
    },
  },
  {
    run_id: DEMO_RUN_ID,
    seq: 2,
    ts: t(8),
    type: 'SANDBOX_CREATED',
    payload: {
      v: 1,
      sandbox_id: 'sbx-demo-001',
      image_ref: 'demo-app@sha256:c0ffee11d0d0feed5eed90a7f4c3b2a1e8d7c6b5a4938271605f4e3d2c1b0a99',
    },
  },
  {
    run_id: DEMO_RUN_ID,
    seq: 3,
    ts: t(15),
    type: 'ATTEMPT_STARTED',
    payload: { v: 1, n: 1 },
  },
  {
    run_id: DEMO_RUN_ID,
    seq: 4,
    ts: t(28),
    // The reproduction is fixed before anything is judged by it.
    type: 'REPRO_REGISTERED',
    payload: {
      v: 1,
      command: 'npm test -- checkout-discount',
      files: { 'tests/checkout-discount.test.ts': 'sha256:2f4d6e8a0c1b3d5f7a9c0e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f2a4c6e8b0d2f' },
      applied: ['tests/checkout-discount.test.ts'],
    },
  },
  {
    run_id: DEMO_RUN_ID,
    seq: 5,
    ts: t(94),
    type: 'TEST_RUN',
    payload: {
      v: 1,
      phase: 'base',
      commit_sha: '8d41c6b2a09f7e5d3c1b0a98765432104f6e2d1c',
      exit_code: 1,
      stdout_hash: 'sha256:5b7a1de2c3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      duration_ms: 4312,
      // The demo is a genuine Tier 1: the base failed for the reported reason.
      symptom_matched: true,
      repeat: 0,
      repro_hashes: { 'tests/checkout-discount.test.ts': 'sha256:2f4d6e8a0c1b3d5f7a9c0e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f2a4c6e8b0d2f' },
    },
  },
  {
    run_id: DEMO_RUN_ID,
    seq: 6,
    ts: t(203),
    type: 'TEST_RUN',
    payload: {
      v: 1,
      phase: 'fix',
      commit_sha: 'f3a9d1c7e5b2048a6c1d9e7f3b5a2c8d0e4f6a1b',
      exit_code: 0,
      stdout_hash: 'sha256:9c8b7a6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b',
      duration_ms: 3987,
      repeat: 0,
      repro_hashes: { 'tests/checkout-discount.test.ts': 'sha256:2f4d6e8a0c1b3d5f7a9c0e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f2a4c6e8b0d2f' },
    },
  },
  {
    run_id: DEMO_RUN_ID,
    seq: 7,
    ts: t(228),
    // Emitted only once the fix series has run to completion, which makes it the
    // log's own witness that nothing was cut short. Without it the stream cannot
    // be told apart from one that died after a single green fix run.
    type: 'FIX_DIFF_OBSERVED',
    payload: {
      v: 1,
      base_sha: '8d41c6b2a09f7e5d3c1b0a98765432104f6e2d1c',
      fix_sha: 'f3a9d1c7e5b2048a6c1d9e7f3b5a2c8d0e4f6a1b',
      changed_files: ['src/checkout/discount.ts'],
      diff_hash: 'sha256:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
    },
  },
  {
    run_id: DEMO_RUN_ID,
    seq: 8,
    ts: t(241),
    type: 'PR_OPENED',
    payload: {
      v: 1,
      repo: 'demo-org/demo-app',
      pr_number: 42,
      head_sha: 'f3a9d1c7e5b2048a6c1d9e7f3b5a2c8d0e4f6a1b',
      diff_hash: 'sha256:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
    },
  },
];
