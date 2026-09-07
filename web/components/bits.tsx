'use client';

import { useEffect, useId, useRef, useState } from 'react';

/**
 * An exit code, and the word that makes it legible without colour.
 *
 * `.pass` and `.fail` are hues. On their own they are invisible to a reader with a colour
 * deficiency, to anyone printing an evidence page, and to a screen reader — which is a
 * problem specific to this product, because a green 0 and a red 1 beside each other ARE
 * the verdict. So the glyph is rendered for sighted readers and the word for everyone
 * else, and neither is optional.
 */
export function Exit({ code, signal }: { code: number; signal?: string | null }) {
  const good = code === 0;
  return (
    <span className={good ? 'pass' : 'fail'}>
      <span className="mark" aria-hidden="true">
        {good ? '✓' : '✗'}
      </span>
      <span className="sr">{good ? 'passed, ' : 'failed, '}</span>
      exit {code}
      {signal ? ` (${signal})` : ''}
    </span>
  );
}

/** The same, for a yes/no that is not an exit code. */
export function Yes({ value, yes = 'yes', no = 'no', unknown = 'not observed' }: { value: boolean | undefined; yes?: string; no?: string; unknown?: string }) {
  if (value === undefined) return <span className="muted">{unknown}</span>;
  return (
    <span className={value ? 'pass' : 'fail'}>
      <span className="mark" aria-hidden="true">
        {value ? '✓' : '✗'}
      </span>
      {value ? yes : no}
    </span>
  );
}

/**
 * In flight, and it says which — never an empty page.
 *
 * An empty repository list and a repository list that has not arrived are the same picture
 * and opposite facts. `role="status"` so the change is announced once it resolves rather
 * than leaving a screen-reader user on a page that silently became something else.
 */
export const Loading = ({ what }: { what: string }) => (
  // `aria-live` on a node that is already in the tree. `role="status"` alone, on an element
  // mounted together with its text, announces nothing — which is the rule this file states
  // twelve lines below and this function was breaking.
  <p className="loading" role="status" aria-live="polite">
    Loading {what}…
  </p>
);

/**
 * The request failed, with the reason and a way to try again.
 *
 * `role="alert"`, because this interrupts what the reader was doing and is the one class
 * of message on these screens that should not wait to be discovered.
 */
export const Failed = ({ error, retry }: { error: string; retry?: () => void }) => (
  // `h2`, because every caller renders its own `h1` FIRST — a failure state whose only
  // heading is an `h2` is a page that starts at level two, which is what happened when this
  // was returned in place of the view rather than beneath its title.
  <div className="warning" role="alert">
    <h2>That did not load.</h2>
    <p>{error}</p>
    {retry ? (
      <button type="button" className="quiet" onClick={retry}>
        Try again
      </button>
    ) : null}
  </div>
);

/** An empty state that looks deliberate rather than broken. */
export const Empty = ({ children }: { children: React.ReactNode }) => <div className="nothing">{children}</div>;

/**
 * The ARIA tabs pattern, in full, because a half-implemented one is worse than none.
 *
 * The whole tablist is ONE stop in the tab order — arrow keys move between tabs, Home and
 * End go to the ends — which is the behaviour a screen-reader user is told to expect the
 * moment the widget announces itself as a tablist. A row of buttons that each take a tab
 * stop and call themselves tabs has lied about how it works.
 *
 * The selected tab is in the URL fragment, so a link to "this repository's environment"
 * is a link somebody can send.
 */
export function Tabs<T extends string>({
  tabs,
  current,
  onChange,
  label,
  children,
}: {
  tabs: { id: T; label: string; count?: number | undefined }[];
  current: T;
  onChange: (id: T) => void;
  label: string;
  children: React.ReactNode;
}) {
  const base = useId();
  const refs = useRef(new Map<T, HTMLButtonElement | null>());

  const move = (event: React.KeyboardEvent) => {
    const order = tabs.map((tab) => tab.id);
    const at = order.indexOf(current);
    const to =
      event.key === 'ArrowRight' ? (at + 1) % order.length
      : event.key === 'ArrowLeft' ? (at - 1 + order.length) % order.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? order.length - 1
      : null;
    if (to === null) return;
    event.preventDefault();
    const next = order[to]!;
    onChange(next);
    // Focus follows selection, which is the pattern's default for tabs whose panels are
    // cheap to render. Every panel here is already-fetched data.
    refs.current.get(next)?.focus();
  };

  return (
    <>
      <div className="tabs" role="tablist" aria-label={label} onKeyDown={move}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${base}-${tab.id}`}
            // ONLY on the selected tab, because only its panel is rendered. Setting it on
            // all three left two dangling IDREFs at all times — and the docblock above
            // claims this is the pattern "in full", which a wrong `aria-controls` is not.
            // The attribute is optional in the APG; a broken one is worse than none.
            {...(tab.id === current ? { 'aria-controls': `${base}-${tab.id}-panel` } : {})}
            aria-selected={tab.id === current}
            tabIndex={tab.id === current ? 0 : -1}
            ref={(node) => {
              refs.current.set(tab.id, node);
            }}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {tab.count === undefined ? null : <span className="count">{tab.count}</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-${current}-panel`} aria-labelledby={`${base}-${current}`} tabIndex={-1}>
        {children}
      </div>
    </>
  );
}

/**
 * What a form said, announced once and then left alone.
 *
 * `role="status"` rather than `alert` for a success and `alert` for a failure: one is
 * information the reader asked for by pressing the button, the other interrupts. Both are
 * rendered in the DOM from the start so the region exists before the text arrives —
 * inserting a live region and its content together is the classic way to announce nothing.
 */
export function Said({ said }: { said: { ok: boolean; text: string } | null }) {
  return (
    <>
      <p className="said" role="status">
        {said?.ok ? said.text : ''}
      </p>
      <p className="error" role="alert">
        {said && !said.ok ? said.text : ''}
      </p>
    </>
  );
}

/**
 * A timestamp a person can read, with the exact one still available.
 *
 * The register used to print ISO strings everywhere, which is right for a machine fact and
 * wrong for "when did this happen" — the question a reader actually has. `<time>` carries
 * the precise value for anything parsing the page, and the title carries it for a mouse.
 */
export function When({ iso }: { iso: string | null | undefined }) {
  const [text, setText] = useState<string>(iso ?? '');
  useEffect(() => {
    if (!iso) return;
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return;
    // In an effect, not in render: the server pre-renders this file into `index.html` at
    // build time, and a relative time computed there would ship a string that was true
    // whenever the image was built.
    const tick = () => setText(ago(then));
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [iso]);
  if (!iso) return <span className="muted">—</span>;
  return (
    <time dateTime={iso} title={iso}>
      {text}
    </time>
  );
}

const ago = (then: number): string => {
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toISOString().slice(0, 10);
};

/** A run id, at the length a person can actually compare. The full one is in the title. */
export const ShortId = ({ id }: { id: string }) => (
  <code className="hash" title={id}>
    {id.slice(0, 8)}
  </code>
);
