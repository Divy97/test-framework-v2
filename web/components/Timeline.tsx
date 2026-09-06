'use client';

import type { Frame } from '../lib/hooks';
import { Exit, When } from './bits';

/**
 * What is happening, while it happens.
 *
 * This is the screen the product did not have. A run takes four minutes, and until 10i a
 * person who pressed Start — over `curl`, since there was no button either — had a run
 * list to reload and nothing else. The SSE tail has existed and been authorized since 10g
 * with nothing on the other end of it.
 *
 * THE RULE THIS OBEYS. A row here reports an EVENT and never a judgement. There is no
 * phase model, no state machine, no "the run is now in the fix phase" — because every one
 * of those would be a second implementation of what a run is, living next to `fold.ts` and
 * free to disagree with it (ADR-0009, which this codebase has broken twice). The verdict
 * on this page comes from `/api/runs/:id/evidence`, which is the fold; this list is the
 * log, given English.
 *
 * The one interpretation it makes is grouping: consecutive `AGENT_MESSAGE` frames collapse
 * into a count. That is presentation — three hundred rows saying "the agent said something"
 * is not a timeline — and it is reversible, because the raw log is rendered underneath.
 */
export function Timeline({ frames, ended }: { frames: Frame[]; ended: boolean }) {
  const rows = group(frames);
  if (rows.length === 0) {
    return (
      <p className="loading" role="status">
        Waiting for the first event. A worker has to claim this run before anything is
        written to its log.
      </p>
    );
  }
  return (
    <ol className="timeline">
      {rows.map((row, index) => {
        // The LAST row of a run that has not ended is the thing currently happening. Not
        // inferred from the event type — inferred from being last, which is the only thing
        // about it that is actually true.
        const state = row.failed ? 'failed' : !ended && index === rows.length - 1 ? 'doing' : 'done';
        return (
          <li key={row.seq} data-state={state}>
            <span className="dot" aria-hidden="true">
              {state === 'failed' ? '✗' : state === 'doing' ? '●' : '✓'}
            </span>
            <span className="what">
              {row.what}
              {row.detail ? <span className="detail">{row.detail}</span> : null}
            </span>
            <span className="at">
              <When iso={row.ts} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

type Row = { seq: number; ts: string; what: React.ReactNode; detail?: string; failed?: boolean };

const at = (payload: unknown, key: string): unknown =>
  payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined;

const str = (payload: unknown, key: string): string | undefined => {
  const value = at(payload, key);
  return typeof value === 'string' ? value : undefined;
};

const num = (payload: unknown, key: string): number | undefined => {
  const value = at(payload, key);
  return typeof value === 'number' ? value : undefined;
};

function group(frames: Frame[]): Row[] {
  const rows: Row[] = [];
  let turns = 0;
  let turnStart: Frame | null = null;

  const flushTurns = () => {
    if (turns === 0 || !turnStart) return;
    rows.push({
      seq: turnStart.seq,
      ts: turnStart.ts,
      what: (
        <>
          The agent worked for <b>{turns}</b> turn{turns === 1 ? '' : 's'}
        </>
      ),
      detail: 'Stored, and an input to no verdict on this page — it is what the agent said, not what the engine saw.',
    });
    turns = 0;
    turnStart = null;
  };

  for (const frame of frames) {
    if (frame.type === 'AGENT_MESSAGE') {
      turns += 1;
      turnStart ??= frame;
      continue;
    }
    flushTurns();
    const row = describe(frame);
    if (row) rows.push(row);
  }
  flushTurns();
  return rows;
}

/**
 * One event, in English.
 *
 * Anything not named here is skipped rather than rendered as its type. A timeline that
 * falls back to printing `VERIFICATION_ABORTED` has stopped being for a person, and the
 * raw log below is where an unrecognised event is legible anyway.
 */
function describe(frame: Frame): Row | null {
  const base = { seq: frame.seq, ts: frame.ts };
  const p = frame.payload;
  switch (frame.type) {
    case 'RUN_REQUESTED':
      return { ...base, what: 'The run was requested', detail: str(p, 'title') };
    case 'SANDBOX_CREATED':
      return {
        ...base,
        what: (
          <>
            A sandbox was created for <b>{str(p, 'phase') ?? 'a phase'}</b>
          </>
        ),
        detail: str(p, 'sandbox_id'),
      };
    case 'ENV_BUILT':
      return {
        ...base,
        what: 'The environment was built and snapshotted',
        detail: str(p, 'snapshot') ?? str(p, 'image_ref'),
      };
    case 'SANDBOX_SEALED': {
      // The probe result, from INSIDE the sandbox, which is the whole reason this event
      // exists rather than a claim about the firewall's configuration.
      const dns = at(p, 'dns');
      const route = at(p, 'route');
      const sealed = dns === false && route === false;
      return {
        ...base,
        what: (
          <>
            The sandbox was sealed — <b>{str(p, 'policy') ?? 'deny-all'}</b>
          </>
        ),
        detail: sealed
          ? 'A probe inside it found no DNS and no route out.'
          : `A probe inside it still found: ${[dns !== false ? 'DNS' : null, route !== false ? 'a route' : null].filter(Boolean).join(', ')}.`,
        ...(sealed ? {} : { failed: true }),
      };
    }
    case 'ATTEMPT_STARTED':
      return { ...base, what: <>Attempt {num(p, 'attempt') ?? '?'} started</> };
    case 'ENV_READY':
      return { ...base, what: 'The recipe replayed and the services answered' };
    case 'REPRO_REGISTERED':
      return {
        ...base,
        what: 'A reproduction was registered',
        detail: str(p, 'command'),
      };
    case 'AGENT_FINISHED':
      return { ...base, what: 'The agent finished' };
    case 'AGENT_HANDED_OVER':
      return { ...base, what: 'The agent handed over its commit', detail: str(p, 'commit')?.slice(0, 12) };
    case 'TEST_RUN': {
      const exit = num(p, 'exit_code') ?? 0;
      const matched = at(p, 'symptom_matched');
      return {
        ...base,
        what: (
          <>
            The reproduction ran on <b>{str(p, 'phase') ?? '?'}</b> — <Exit code={exit} signal={str(p, 'signal')} />
            {matched === undefined ? null : matched === true ? ', symptom present' : ', symptom gone'}
          </>
        ),
        detail: str(p, 'stdout_hash'),
      };
    }
    case 'SUITE_RUN': {
      const exit = num(p, 'exit_code') ?? 0;
      return {
        ...base,
        what: (
          <>
            The project&rsquo;s own suite ran on <b>{str(p, 'phase') ?? '?'}</b> —{' '}
            <Exit code={exit} signal={str(p, 'signal')} />
          </>
        ),
        detail: str(p, 'command'),
      };
    }
    case 'FIX_DIFF_OBSERVED':
      return { ...base, what: 'The fix was measured', detail: str(p, 'diff_hash') };
    case 'VERIFICATION_ABORTED':
      return {
        ...base,
        what: 'Observation stopped',
        detail: `${str(p, 'cause') ?? 'unstated'}: ${str(p, 'reason') ?? ''}`,
        failed: true,
      };
    case 'PR_OPENED':
      return { ...base, what: <>A pull request was opened — #{num(p, 'pr_number') ?? '?'}</> };
    case 'RUN_ENDED': {
      const status = str(p, 'status') ?? 'ended';
      return {
        ...base,
        what: (
          <>
            The run ended — <b>{status.replace(/_/g, ' ')}</b>
          </>
        ),
        ...(status === 'errored' || status === 'blocked' ? { failed: true } : {}),
      };
    }
    default:
      return null;
  }
}

/** The log itself, folded away: it is the product, and it is also three hundred lines. */
export function RawLog({ frames }: { frames: Frame[] }) {
  return (
    <details>
      <summary>
        The log — {frames.length} event{frames.length === 1 ? '' : 's'}, exactly as stored
      </summary>
      <div className="log">
        {frames.map((frame) => (
          <div key={frame.seq}>
            <span className="seq">{frame.seq}</span>
            <span>{frame.type}</span>
          </div>
        ))}
      </div>
    </details>
  );
}
