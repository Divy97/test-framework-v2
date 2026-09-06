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
export function useTail(runId: string | null, options: { onMeaningful?: () => void; stop?: boolean } = {}) {
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
    source.onmessage = (message: MessageEvent<string>) => {
      let frame: Frame;
      try {
        frame = JSON.parse(message.data) as Frame;
      } catch {
        return;
      }
      setFrames((have) => (have.some((f) => f.seq === frame.seq) ? have : [...have, frame]));
      if (CHANGES_THE_VERDICT.has(frame.type)) meaningful.current?.();
    };
    return () => source.close();
  }, [runId, stop]);

  return { frames, state };
}

/**
 * Which events mean the FOLD has moved, and therefore that the verdict is worth re-reading.
 *
 * Everything else — and `AGENT_MESSAGE` is most of a run by volume, hundreds of frames —
 * changes the timeline and changes no judgement. Re-reading the evidence on each of those
 * would be a few hundred needless round trips per run for an answer that had not changed.
 */
const CHANGES_THE_VERDICT = new Set([
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
  'OBSERVATION_ABORTED',
  'PR_OPENED',
  'RUN_BLOCKED',
  'RUN_ENDED',
]);
