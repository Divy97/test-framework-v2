'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { get, type Answer } from './api';

/**
 * A GET, with the two states a rendered page never had: in flight, and it failed.
 *
 * `reload` is returned rather than baked into a dependency array, because most of the
 * refreshes in this product are events rather than prop changes — a run started, a secret
 * stored, an SSE frame that means the fold has moved. A hook that only refetched when its
 * URL changed would need a fake dependency to be told any of that.
 *
 * The abort is not a nicety. The repository screen refetches on every keystroke of the
 * issue filter and on every meaningful event of a live run; without it, an early slow
 * response lands after a later fast one and the screen shows the older answer with no
 * indication that it did.
 */
export function useJson<T>(url: string | null): Answer<T> & { loading: boolean; reload: () => void } {
  const [answer, setAnswer] = useState<Answer<T> | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    let live = true;
    // NOT cleared to null first. Blanking the previous answer on every reload makes a
    // live run's four-minute watch flash "loading" every few seconds; the old data is
    // right until the new data arrives.
    void get<T>(url, controller.signal)
      .then((next) => {
        if (live) setAnswer(next);
      })
      .catch(() => {
        /* aborted: the caller moved on, and painting an error over a screen they have
         * already left is worse than showing nothing. */
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [url, nonce]);

  return {
    status: answer?.status ?? 0,
    ok: answer?.ok ?? false,
    data: answer?.data ?? null,
    error: answer?.error ?? null,
    loading: answer === null && url !== null,
    reload,
  };
}

/**
 * The path, and a way to change it without a reload.
 *
 * This bundle is one document served for every page path (`next.config.mjs` says why), so
 * the view is a function of `location.pathname` and navigation is `pushState` plus a
 * re-render. `popstate` closes the loop, so Back works.
 *
 * `null` until mounted, and every view treats that as "not yet". At build time there is no
 * `location`, and a component that read one would render the landing page's markup into
 * `index.html` for every route — which is exactly what we DO want for the landing page and
 * would be wrong for the rest, so the distinction has to be visible rather than implicit.
 */
/**
 * BEFORE THE PAINT, in the browser; an ordinary effect at build time.
 *
 * `useLayoutEffect` runs after React has committed and before the browser draws, which is
 * the difference between "the landing page appears for a frame and is replaced" and "the
 * right view is the first thing anybody sees". It matters here more than it usually would:
 * the pre-rendered document IS the landing page — deliberately, so a crawler and a link
 * preview get real markup — so the flash is not an empty shell but a full marketing page,
 * shown to somebody who asked for a run.
 *
 * React warns if a layout effect runs where there is no layout, so at build time this is
 * the ordinary one. Nothing paints there, and the branch is the standard shape rather than
 * a trick.
 */
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function usePath(): { path: string | null; go: (to: string) => void } {
  const [path, setPath] = useState<string | null>(null);

  useBeforePaint(() => {
    setPath(window.location.pathname);
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((to: string) => {
    if (to === window.location.pathname) return;
    window.history.pushState(null, '', to);
    setPath(to);
    // To the top, because a `pushState` navigation keeps the scroll position of the page
    // being left — which lands a reader halfway down a screen they have not seen.
    window.scrollTo(0, 0);
  }, []);

  return { path, go };
}

export type Frame = { seq: number; type: string; payload: unknown; ts: string };

/**
 * The run's event stream (ADR-0005), as the browser's own `EventSource`.
 *
 * `Last-Event-ID` is the seq and nothing else, so reconnection is free and is the
 * browser's job rather than ours: a dropped connection resumes with no missed and no
 * duplicated events because the log is append-only, not because anything here is careful.
 *
 * What this hook deliberately does NOT do is decide anything. It collects frames so the
 * timeline can say *what has happened*; every judgement — reproduced, regression, tier,
 * confidence — is re-read from `/api/runs/:id/evidence`, which is the fold. A client that
 * folded for itself would be a second implementation of what happened, free to disagree
 * with the pull request, and this codebase has made that mistake twice (ADR-0009).
 */
export function useTail(
  runId: string | null,
  options: { onMeaningful?: (final: boolean) => void; stop?: boolean } = {},
) {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [state, setState] = useState<'idle' | 'open' | 'retrying'>('idle');
  const meaningful = useRef(options.onMeaningful);
  meaningful.current = options.onMeaningful;
  const stop = options.stop === true;

  useEffect(() => {
    if (runId === null) return;
    // CLOSED once the run is over, and this is not tidiness — it is the difference between
    // a page and a load generator. `tailRun` is deliberately dumb: it polls
    // `where run_id = $1 and seq > $2` every 250ms for as long as the client is there, and
    // the dashboard passes no `until`, so a finished run's tail never ends on its own. Every
    // evidence page left open in a tab would have been four queries a second against the
    // plane's database, for a log that cannot gain another row.
    //
    // The order is what makes it safe: `RUN_ENDED` arrives on this stream, which is what
    // tells the page to re-read the fold, which is what sets `stop`. Nothing is missed by
    // closing after that, because there is nothing after it.
    if (stop) return;
    setFrames([]);
    const source = new EventSource(`/runs/${encodeURIComponent(runId)}/events`);
    source.onopen = () => setState('open');
    // EventSource reconnects on its own; this only reports that it is between attempts,
    // so a stalled screen says so rather than looking like a run that stopped.
    source.onerror = () => setState('retrying');

    // ONE LISTENER PER TYPE, and `onmessage` is not among them.
    //
    // `sse.ts` writes `event: <type>` on every frame, deliberately, so that a consumer can
    // subscribe per type. The consequence is the part that is easy to miss: `onmessage`
    // handles the DEFAULT `message` type only, so a page that assigns it receives nothing
    // at all — no error, no console output, an open connection and an empty list. That is
    // how this shipped the first time, showing "0 events" for the whole of a run.
    //
    // `EventSource` has no wildcard, so the list has to be enumerated. `EVENT_TYPES` below
    // is the dashboard's copy of `src/events.ts`'s, and `test/screens.test.tsx` asserts the
    // two are identical — a type added on one side and not the other would otherwise be an
    // event this page silently never shows.
    const onFrame = (message: MessageEvent<string>) => {
      let frame: Frame;
      try {
        frame = JSON.parse(message.data) as Frame;
      } catch {
        return;
      }
      setFrames((have) => (have.some((f) => f.seq === frame.seq) ? have : [...have, frame]));
      // `final` is passed through so the consumer can refuse to throttle the LAST one.
      if (CHANGES_THE_VERDICT.has(frame.type)) meaningful.current?.(FINAL.has(frame.type));
    };
    for (const type of EVENT_TYPES) source.addEventListener(type, onFrame as EventListener);
    return () => {
      for (const type of EVENT_TYPES) source.removeEventListener(type, onFrame as EventListener);
      source.close();
    };
  }, [runId, stop]);

  return { frames, state };
}

/**
 * Every event type the log can carry — the dashboard's copy of `src/events.ts`'s
 * `EVENT_TYPES`, which `test/screens.test.tsx` asserts is identical to it.
 *
 * Duplicated rather than imported, because this bundle is built by a different toolchain
 * into a different artifact and importing the engine's event module would drag the engine
 * into a browser build to obtain sixteen strings.
 */
export const EVENT_TYPES = [
  'RUN_REQUESTED',
  'REPRO_REGISTERED',
  'SANDBOX_CREATED',
  'ENV_BUILT',
  'SANDBOX_SEALED',
  'ATTEMPT_STARTED',
  'ENV_READY',
  'AGENT_MESSAGE',
  'AGENT_FINISHED',
  'AGENT_HANDED_OVER',
  'TEST_RUN',
  'SUITE_RUN',
  'FIX_DIFF_OBSERVED',
  'VERIFICATION_ABORTED',
  'PR_OPENED',
  'RUN_ENDED',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Which events mean the FOLD has moved, and therefore that the verdict is worth re-reading.
 *
 * Everything else — and `AGENT_MESSAGE` is most of a run by volume, hundreds of frames —
 * changes the timeline and changes no judgement. Re-reading the evidence on each of those
 * would be a few hundred needless round trips per run for an answer that had not changed.
 */
/**
 * The events after which there is nothing else coming.
 *
 * Split out because the consumer THROTTLES its re-reads of the fold — bursts of `TEST_RUN`
 * arrive within a second of each other and three identical folds is two wasted round trips
 * — and a throttle that swallows the last one is the worst bug this page can have: the run
 * finishes, the verdict never arrives, and the screen says *still going* forever.
 *
 * It is not hypothetical. `PR_OPENED` and `RUN_ENDED` are appended microseconds apart by a
 * real worker; the first refetch read a fold that did not yet contain the second, and the
 * second refetch was dropped as too soon.
 */
// `RUN_ENDED` and nothing else. `blocked` is one of its REASONS, not an event type of its
// own — a `RUN_BLOCKED` here was a string that could never match.
const ENDS_IT: readonly EventType[] = ['RUN_ENDED'];
const FINAL = new Set<string>(ENDS_IT);

const VERDICT_MOVING: readonly EventType[] = [
  'RUN_REQUESTED',
  'ENV_BUILT',
  'SANDBOX_SEALED',
  'ATTEMPT_STARTED',
  'REPRO_REGISTERED',
  'TEST_RUN',
  'SUITE_RUN',
  'FIX_DIFF_OBSERVED',
  'AGENT_FINISHED',
  'AGENT_HANDED_OVER',
  // The real name. This list carried `OBSERVATION_ABORTED` — an event that does not
  // exist — and omitted this one, so an abort moved `state.aborts`, `reproducedAttempt`
  // and therefore the tier, and the page went on showing the verdict from before it for
  // the rest of the run. Typed against `EVENT_TYPES` now, so an invented name is a
  // compile error rather than a `Set` entry nothing ever matches.
  'VERIFICATION_ABORTED',
  'PR_OPENED',
  'RUN_ENDED',
];
// Declared as a typed array and then widened, so the NAMES are checked against
// `EVENT_TYPES` while the `Set` still accepts the plain `string` a frame carries. A
// `Set<string>` built from string literals checks nothing, which is how an event type that
// does not exist sat in this list unnoticed.
const CHANGES_THE_VERDICT = new Set<string>(VERDICT_MOVING);
