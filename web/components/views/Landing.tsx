/**
 * The one page whose job is persuasion rather than instrumentation.
 *
 * It has to look like somebody cared — because looking like a README is itself a claim
 * about how much anyone did. What it must not do is manufacture proof: no logo wall, no
 * invented user count, no testimonial. A product arguing that a claim without evidence is
 * worth nothing cannot open with one. So the specimen below is a REAL verdict, in the
 * shape the evidence page renders, and the only numbers on the page are ones the engine
 * actually produces.
 *
 * NOT a client component, and that is deliberate. This is the markup Next pre-renders into
 * `index.html` at build time, which is the one document a crawler, a link preview or a
 * reader with JavaScript disabled ever receives. Everything else in this bundle needs the
 * browser; this needs to work without it.
 */
export function Landing({ installUrl, signIn }: { installUrl: string; signIn: boolean }) {
  return (
    <>
      <section className="hero-band">
        <div>
          <p className="eyebrow">Event-sourced verification engine</p>
          <h1 className="display">Open an issue. Get back a pull request that proves the bug existed.</h1>
          <p className="lede">
            Not a coding agent — the model is a replaceable component. What is not replaceable
            is the evidence: <b>every claim it makes is a command it executed itself</b>, in a
            container of its own, recorded in an append-only log.
          </p>
          <p className="calls">
            <a className="cta" href={installUrl}>
              Install on GitHub
            </a>
            {signIn ? (
              <a className="cta secondary" href="/auth/github">
                Sign in
              </a>
            ) : null}
          </p>
          {signIn ? (
            <p className="muted small">
              Already installed it? GitHub sends the install button to your existing
              installation&rsquo;s settings, which is the right answer and not a way in —
              signing in is.
            </p>
          ) : null}
        </div>
      </section>

      <section className="band">
        <div>
          <h2 className="band-head">What comes back</h2>
          <div className="specimen">
            <div className="specimen-bar">
              <span>run 7f3a91c4</span>
              <span>acme/checkout#41</span>
              <span className="pass">Tier 2 — reproduced</span>
            </div>
            <div className="specimen-body">
              <p className="verdict">
                <span className="n">+40</span> the reported symptom was reproduced on the base commit
                <br />
                <span className="n">+30</span> a failing test the agent wrote, passing after the fix
                <br />
                <span className="n">+20</span> your own suite ran green on both commits
                <br />
                <span className="n">&nbsp;&nbsp;+0</span>{' '}
                <span className="muted">the agent said it was confident</span>
                <br />
                <span className="n">90/103</span> <b>evidence, not testimony</b>
              </p>
            </div>
          </div>
          <p className="muted small">
            Every line is an exit code from a container this engine started. The agent&rsquo;s
            own account of itself scores nothing, and is stored anyway so you can read it.
          </p>
        </div>
      </section>

      <section className="band">
        <div>
          <h2 className="band-head">How it works</h2>
          <div className="steps">
            <div className="step">
              <div>
                <h3>You pick an issue and press Start</h3>
                <p>
                  A GitHub App you install on the repositories you pick. No personal access
                  token is ever requested.
                </p>
              </div>
            </div>
            <div className="step">
              <div>
                <h3>It reproduces the bug first</h3>
                <p>
                  On your base commit, in a sealed microVM with no network — not even DNS. No
                  reproduction means no fix attempt: you get a structured information request
                  instead of a guess.
                </p>
              </div>
            </div>
            <div className="step">
              <div>
                <h3>It fixes, then proves it twice</h3>
                <p>
                  The reproduction says the reported bug is gone. Your project&rsquo;s own
                  suite, run on both commits, says nothing else went with it.
                </p>
              </div>
            </div>
            <div className="step">
              <div>
                <h3>You watch it happen, and read the log after</h3>
                <p>
                  Every command, exit code and artifact, content-addressed and replayable,
                  streaming as it lands. Nothing is ever merged for you.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="band">
        <div>
          <h2 className="band-head">The rules it will not bend</h2>
          <div className="cards">
            <div className="card">
              <h3>Reproduce first, or do not fix</h3>
              <p>
                No reproduction, no fix, no partial credit. A bug that cannot be shown is a
                question, and the answer is a question back.
              </p>
            </div>
            <div className="card">
              <h3>Two arms, not one</h3>
              <p>
                One test passing proves one test passes. Your whole suite on both commits is
                what says the fix cost you nothing.
              </p>
            </div>
            <div className="card">
              <h3>Testimony is not evidence</h3>
              <p>
                The agent&rsquo;s transcript is stored and shown, and it is an input to no
                verdict. Exit codes and content-addressed output are.
              </p>
            </div>
            <div className="card">
              <h3>Nothing is merged</h3>
              <p>
                It opens a pull request. Every decision after that is yours, and the evidence
                is there to make it with.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="band">
        <div>
          <h2 className="band-head">What it costs you to find out</h2>
          <p>
            Installing grants the App access to the repositories you pick, and nothing else.
            The sandbox that runs an agent holds neither our model key nor your GitHub token —
            the agent loop runs outside it and ships tool calls in, so the container needs no
            network egress at all.
          </p>
          <p>
            Each phase of a run is a Firecracker microVM with egress denied by a firewall
            outside it, destroyed when the run ends, and every one of them is probed from the
            inside to prove it.
          </p>
        </div>
      </section>

    </>
  );
}

/**
 * The footer, exported separately so `page.tsx` can render it OUTSIDE `<main>`.
 *
 * A `contentinfo` landmark nested inside `main` is either flagged by every audit tool or
 * dropped entirely, depending on which mapping the browser applies — so the site-wide
 * footer of the only public page was either an error or absent, and neither is what was
 * intended.
 */
export function LandingFooter() {
  return (
    <footer className="foot">
      <div>
        <p>Test Framework v2 — an event-sourced execution and verification platform.</p>
        <p>Evidence over testimony. Reproduce first. Nothing merged.</p>
      </div>
    </footer>
  );
}
