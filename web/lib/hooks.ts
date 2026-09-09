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
  // The URL the answer BELONGS TO, carried with it. Two different things want the old data
  // kept and they are not the same thing:
  //
  //   - A RELOAD of the same URL should keep it. A live run re-reads its fold every couple
  //     of seconds, and blanking to "loading" each time makes a four-minute watch flicker.
  //   - A CHANGE of URL must not. `page.tsx` keeps the same `<Run>` element position across
  //     `/runs/A` → `/runs/B`, so the component is reconciled rather than remounted, and
  //     without this the new run's page renders the OLD run's repository, issue number, run
  //     id, tier, confidence and whole event log for a full round trip — with `loading`
  //     false the entire time, so nothing on screen says it is looking at the wrong run.
  const [answer, setAnswer] = useState<{ url: string; answer: Answer<T> } | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    let live = true;
    void get<T>(url, controller.signal)
      .then((next) => {
        if (live) setAnswer({ url, answer: next });
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

  const current = answer !== null && answer.url === url ? answer.answer : null;
  return {
    status: current?.status ?? 0,
    ok: current?.ok ?? false,
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: current === null && url !== null,
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

export function usePath(): { path: string | null; search: string; go: (to: string) => void } {
  // PATHNAME PLUS SEARCH, because `?repo=` selects what a page shows and dropping it made
  // two bugs at once. `go('/runs')` from `/runs?repo=acme%2Fwidgets` compared equal and
  // returned early, so the Runs tab in the header did nothing — the filtered list stayed and
  // `aria-current` was already on it, so there was not even feedback. And Back between two
  // `?repo=` URLs stored the same pathname twice, React bailed out of the re-render, and the
  // list kept the previous repository.
  const [here, setHere] = useState<string | null>(null);
  const at = () => `${window.location.pathname}${window.location.search}`;

  useBeforePaint(() => {
    setHere(at());
    const onPop = () => setHere(at());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((to: string) => {
    if (to === at()) return;
    window.history.pushState(null, '', to);
    setHere(to);
    // To the top, because a `pushState` navigation keeps the scroll position of the page
    // being left — which lands a reader halfway down a screen they have not seen.
    window.scrollTo(0, 0);
  }, []);

  const [path = '', search = ''] = here === null ? [] : here.split(/(?=\?)/);
  return { path: here === null ? null : path, search, go };
}

/** One row of the log, as `store.ts` reads it. `run_id` is on the wire and unused here. */
export type Frame = { run_id: string; seq: number; type: string; payload: unknown; ts: string };

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
  const [state, setState] = useState<'idle' | 'open' | 'retrying' | 'lost'>('idle');
  // The latest callback, kept in a ref so the effect below does not tear the stream down
  // and rebuild it every time the caller re-renders. Written in an EFFECT rather than
  // during render: a ref write in a render body is a side effect in a function React is
  // free to call and discard, which is the shape that breaks first under concurrency.
  const meaningful = useRef(options.onMeaningful);
  useEffect(() => {
    meaningful.current = options.onMeaningful;
  });
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
    // `readyState`, because `error` fires for BOTH a reconnect and a permanent close, and
    // the two need opposite words. The tail is authorized (10g) and answers 401 when a
    // session expires; the browser does not retry a non-2xx, so a page that reported every
    // error as "reconnecting" sat there saying so forever over a frozen timeline, with no
    // hint that the fix was to sign in again.
    source.onerror = () => setState(source.readyState === EventSource.CLOSED ? 'lost' : 'retrying');

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

/**
 * WHAT THE TAB SAYS WHILE A MACHINE IS WORKING (10n).
 *
 * Drafting a recipe takes a couple of minutes. The page shows that now, counting up — but
 * only to somebody looking at it, and nobody watches a browser tab for two and a half
 * minutes. They switch away, and the one thing they wanted to know is the one thing they
 * then cannot see.
 *
 * The tab title can carry it, and unlike a notification it needs no permission prompt, no
 * decision about whether to ask for one, and works with the tab in the background from the
 * first render.
 *
 * The half that matters is `settled`: when the work finishes while the tab is HIDDEN,
 * saying so and keeping it said until they look. A title that quietly reverts the moment
 * the job ends tells a person who was away exactly nothing — they come back to the same
 * words the page had before they left, and reload to find out.
 *
 * Pure, and separated from the effect below, because what the tab should say is a decision
 * with four inputs and the DOM write is one line.
 */
export function tabTitle(at: {
  waiting: boolean;
  /** Finished since this page last had the reader's attention. */
  settledWhileAway: boolean;
  /** What is being waited on — 'Drafting a recipe'. */
  label: string | null;
  base: string;
}): string | null {
  if (at.waiting) return at.label === null ? null : `· ${at.label} — ${at.base}`;
  if (at.settledWhileAway) return `✓ Done — ${at.base}`;
  // `null` is "leave the title alone", not "clear it": the router owns it the rest of the
  // time, and a hook that blanked it on every render would fight `page.tsx` for the name
  // of every page.
  return null;
}

/**
 * Put `tabTitle` on the document, and put it back afterwards.
 *
 * `settledWhileAway` is tracked here rather than asked of the caller: it is a fact about
 * this tab's visibility over time, which no render has access to.
 */
export function useTabTitle(waiting: boolean, label: string | null, base: string): void {
  const wasWaiting = useRef(false);
  const [settledWhileAway, setSettled] = useState(false);

  useEffect(() => {
    const hidden = typeof document === 'undefined' ? false : document.hidden;
    // The TRANSITION out of waiting, not the state: `waiting === false` is also true
    // before anything ever started, and announcing "Done" to somebody who has done
    // nothing is worse than saying nothing.
    if (wasWaiting.current && !waiting && hidden) setSettled(true);
    wasWaiting.current = waiting;
    if (waiting) setSettled(false);
  }, [waiting]);

  // Cleared the moment they look, which is the only signal that the message landed.
  useEffect(() => {
    if (!settledWhileAway) return;
    const seen = () => {
      if (!document.hidden) setSettled(false);
    };
    document.addEventListener('visibilitychange', seen);
    window.addEventListener('focus', seen);
    return () => {
      document.removeEventListener('visibilitychange', seen);
      window.removeEventListener('focus', seen);
    };
  }, [settledWhileAway]);

  useEffect(() => {
    const wanted = tabTitle({ waiting, settledWhileAway, label, base });
    if (wanted === null) return;
    const before = document.title;
    document.title = wanted;
    // Restored on the way out, so leaving this page does not leave its status in the tab
    // of whatever the reader went to next.
    return () => {
      document.title = before;
    };
  }, [waiting, settledWhileAway, label, base]);
}
