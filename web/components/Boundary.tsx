'use client';

import { Component, type ReactNode } from 'react';

/**
 * One screen failing must not take the application with it.
 *
 * This is not defensive habit. The evidence view renders a LOG — events written by earlier
 * versions of this engine, kept forever and replayed by design (ADR-0001) — so the shapes it
 * meets are older than the code that draws them, and always will be. Server-rendered, a
 * missing field was a 500 on one page. In a bundle it is an unhandled exception during
 * render, and React unmounts the whole tree: a blank white page saying "Application error",
 * on a run whose evidence is entirely intact and whose log is entirely readable.
 *
 * That happened, once, before this existed: a `REPRO_REGISTERED` payload with no `files`
 * reached `Object.entries` and blanked the screen — the console was the only place the cause
 * appeared, which is exactly where nobody looks first.
 *
 * A class component because React has no hook for this; there is no function equivalent of
 * `componentDidCatch`.
 */
export class Boundary extends Component<{ children: ReactNode }, { failed: Error | null }> {
  override state: { failed: Error | null } = { failed: null };

  static getDerivedStateFromError(failed: Error) {
    return { failed };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="warning" role="alert">
        <h2>This screen could not be drawn.</h2>
        <p>
          Something on this page threw while rendering. <b>Nothing is lost</b> — the log is
          append-only and was not touched by this, and the evidence behind this run is
          exactly where it was.
        </p>
        <p>
          <code>{String(this.state.failed?.message ?? this.state.failed)}</code>
        </p>
        <p>
          The API this page draws from is unaffected:{' '}
          <a href={`/api${window.location.pathname}/evidence`}>the raw evidence</a> and{' '}
          <a href={`/api${window.location.pathname}/events`}>the raw log</a> answer normally,
          and either is readable without this screen.
        </p>
        <p className="calls">
          <a className="cta secondary" href="/runs">
            Back to the runs
          </a>
        </p>
      </div>
    );
  }
}
