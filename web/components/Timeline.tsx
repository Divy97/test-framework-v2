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
      <p className="loading" role="status" aria-live="polite">
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
          <li key={row.seq} data-state={state} {...(state === 'doing' ? { 'aria-current': 'step' as const } : {})}>
            <span className="dot" aria-hidden="true">
              {state === 'failed' ? '✗' : state === 'doing' ? '●' : '✓'}
            </span>
            {/* The word behind the dot. `doing` was a hue and an animation and nothing
                else — the one place in this product where a STATE, rather than a verdict,
                was carried by colour alone. */}
            <span className="sr">{state === 'failed' ? 'failed: ' : state === 'doing' ? 'in progress: ' : 'done: '}</span>
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

/**
 * One field of a payload, defensively.
 *
 * Every read here goes through this rather than `payload.x`, and it is not ceremony: this
 * renders a LOG, whose rows were written by earlier versions of this engine and are kept
 * forever by design (ADR-0001). A field that moved, or that a `v: 1` payload gained later,
 * must render as absent — not throw, because in a bundle a throw during render blanks the
 * page rather than failing one section.
 */
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
 * EVERY FIELD NAME HERE IS FROM `src/events.ts`, and that sentence is the whole comment
 * because getting it wrong is silent. The first version of this file guessed five of them
 * and each guess produced a plausible sentence:
 *
 *   - `SANDBOX_SEALED` carries `probe: { dns, route }`, NOT `dns` and `route` at the top
 *     level. Read flat, both are `undefined`, `undefined === false` is false, and every
 *     correctly sealed sandbox rendered with a red ✗ and the words *"a probe inside it
 *     still found: DNS, a route"*. The seal is this product's central claim, and the
 *     timeline was calling it a failure on every run of every repository.
 *   - `RUN_ENDED` carries `reason`, not `status`, so every run "ended — ended" and the
 *     branch marking an errored or blocked run as failed was unreachable.
 *   - `ATTEMPT_STARTED` carries `n`, not `attempt` — "Attempt ? started".
 *   - `SANDBOX_CREATED` has no `phase`, and `RUN_REQUESTED` has no `title`.
 *
 * None of it threw, nothing appeared in the console, and `test/screens.test.tsx` passed
 * because its fixtures were written from the same guesses. What catches it now is
 * `payloadsMatchEvents` in that file, which builds these rows from `src/events.ts`'s own
 * payload types rather than from a hand-typed object.
 *
 * Anything not named here is skipped rather than rendered as its type. A timeline that
 * falls back to printing `VERIFICATION_ABORTED` has stopped being for a person, and the raw
 * log below is where an unrecognised event is legible anyway.
 */
function describe(frame: Frame): Row | null {
  const base = { seq: frame.seq, ts: frame.ts };
  const p = frame.payload;
  switch (frame.type) {
    case 'RUN_REQUESTED': {
      // `raw_text` is the report as it arrived — an issue body, a Slack message. Bounded,
      // because it is whatever a stranger wrote.
      const text = str(p, 'raw_text');
      return {
        ...base,
        what: 'The run was requested',
        ...(text ? { detail: text.length > 160 ? `${text.slice(0, 160)}…` : text } : {}),
      };
    }
    case 'SANDBOX_CREATED':
      return {
        ...base,
        what: 'A sandbox was created',
        detail: [str(p, 'sandbox_id'), str(p, 'image_ref')].filter(Boolean).join(' · '),
      };
    case 'ENV_BUILT': {
      const failed = (at(p, 'steps') as { step: string; exit_code: number }[] | undefined)?.filter(
        (step) => step.exit_code !== 0,
      );
      return {
        ...base,
        what: 'The environment was built and snapshotted',
        detail: str(p, 'snapshot') ?? str(p, 'image_ref'),
        ...(failed && failed.length > 0 ? { failed: true } : {}),
      };
    }
    case 'SANDBOX_SEALED': {
      // `probe`, from INSIDE the sandbox, which is the whole reason this event exists
      // rather than a claim about the firewall's configuration.
      const probe = at(p, 'probe');
      const dns = at(probe, 'dns');
      const route = at(probe, 'route');
      // `=== false` in both directions, so a payload that carries neither reads as
      // "not recorded" rather than as a seal that held.
      const sealed = dns === false && route === false;
      const leaked = [dns !== false ? 'DNS' : null, route !== false ? 'a route' : null].filter(Boolean);
      return {
        ...base,
        what: (
          <>
            The <b>{str(p, 'phase') ?? 'sandbox'}</b> sandbox was sealed — {str(p, 'policy') ?? 'deny-all'}
          </>
        ),
        detail: sealed
          ? 'A probe inside it found no DNS and no route out.'
          : probe === undefined
            ? 'No probe was recorded for this sandbox.'
            : `A probe inside it still found: ${leaked.join(', ')}.`,
        ...(sealed ? {} : { failed: true }),
      };
    }
    case 'ATTEMPT_STARTED':
      return { ...base, what: <>Attempt {num(p, 'n') ?? '?'} started</> };
    case 'ENV_READY': {
      const services = (at(p, 'services') as { name: string }[] | undefined) ?? [];
      return {
        ...base,
        what: 'The recipe replayed and the services answered',
        ...(services.length > 0 ? { detail: services.map((service) => service.name).join(', ') } : {}),
      };
    }
    case 'REPRO_REGISTERED':
      return { ...base, what: 'A reproduction was registered', detail: str(p, 'command') };
    case 'AGENT_FINISHED': {
      const exit = num(p, 'exit_code');
      return {
        ...base,
        what: (
          <>
            The agent finished after <b>{num(p, 'messages') ?? 0}</b> message
            {num(p, 'messages') === 1 ? '' : 's'}
          </>
        ),
        ...(exit !== undefined && exit !== 0 ? { detail: `exit ${exit}`, failed: true } : {}),
      };
    }
    case 'AGENT_HANDED_OVER':
      return {
        ...base,
        what: (
          <>
            The agent handed over its <b>{str(p, 'kind') ?? 'work'}</b> commit
          </>
        ),
        detail: str(p, 'commit')?.slice(0, 12),
      };
    case 'TEST_RUN': {
      const exit = num(p, 'exit_code') ?? 0;
      const matched = at(p, 'symptom_matched');
      const phase = str(p, 'phase') ?? '?';
      return {
        ...base,
        what: (
          <>
            The reproduction ran on <b>{phase}</b> — <Exit code={exit} signal={str(p, 'signal')} />
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
    case 'FIX_DIFF_OBSERVED': {
      const files = (at(p, 'changed_files') as string[] | undefined) ?? [];
      return {
        ...base,
        what: (
          <>
            The fix was measured — <b>{files.length}</b> file{files.length === 1 ? '' : 's'} changed
          </>
        ),
        detail: files.length > 0 ? files.join(', ') : str(p, 'diff_hash'),
      };
    }
    case 'VERIFICATION_ABORTED':
      return {
        ...base,
        what: (
          <>
            Observation stopped in <b>{str(p, 'phase') ?? 'a phase'}</b>
          </>
        ),
        // Prose the agent's own repro command can appear in. Displayed, never parsed —
        // `events.ts` is explicit that this field must not be read by machine.
        detail: str(p, 'reason'),
        failed: true,
      };
    case 'PR_OPENED':
      return { ...base, what: <>A pull request was opened — #{num(p, 'pr_number') ?? '?'}</> };
    case 'RUN_ENDED': {
      // `reason`, not `status`. The two words mean the same thing here and only one of them
      // is in the payload.
      const reason = str(p, 'reason') ?? 'ended';
      return {
        ...base,
        what: (
          <>
            The run ended — <b>{ENDING[reason] ?? reason.replace(/_/g, ' ')}</b>
          </>
        ),
        ...(reason === 'error' || reason === 'blocked' ? { failed: true } : {}),
      };
    }
    default:
      return null;
  }
}

/**
 * What each ending means, in the words the rest of the product uses for it.
 *
 * `not_reproduced` is the one that matters: it is a refusal, not a failure, and the
 * evidence page states it as the deliverable. A timeline that ended a run with the bare
 * token would be the only place in the product that presented the gate holding as
 * something having gone wrong.
 */
const ENDING: Record<string, string> = {
  pr_opened: 'a pull request was opened',
  not_reproduced: 'the bug was not reproduced, so no fix was attempted',
  attempts_exhausted: 'the attempts were exhausted',
  error: 'an error',
  blocked: 'blocked — a required variable had no value',
};

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
