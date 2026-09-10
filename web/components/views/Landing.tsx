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
          <p className="eyebrow">Reproduce · Fix · Prove</p>
          {/*
            The headline said "proves the bug existed", which describes a third of what
            happens and the least useful third. Reproducing is the PRECONDITION; the
            deliverable is a fix, and the reason to trust it is that the same run proves it
            with commands it executed itself. Leading with the proof and burying the fix
            read as a verification tool for bugs somebody else would go and solve.

            The lede opened "Not a coding agent" — defining the product by negation before
            the reader knows what it is, and picking a fight in the first four words.
          */}
          <h1 className="display">Open an issue. Get a pull request that fixes the bug and proves the fix.</h1>
          <p className="lede">
            It reproduces the bug on your base commit first, in a sealed container with no
            network. Then it writes the fix. Then it runs the failing test and your own suite
            on both commits, so the pull request arrives as exit codes rather than adjectives.{' '}
            <b>If it cannot reproduce your bug, it opens nothing</b> — you get a question
            back, not a patch to review.
          </p>
          {/*
            ONE DOOR (10n). This was two CTAs of near-equal weight — `Install on GitHub`
            primary, `Sign in` secondary — and they are not alternatives. Both are
            required, in sequence, and every order dead-ends: install first and GitHub
            returns you here with no session, still looking at the landing page; sign in
            first and Repositories says nothing is connected. Two buttons for a two-step
            sequence forces a guess where both guesses lose.

            The old copy underneath admitted it in as many words — "the install button …
            is the right answer and not a way in — signing in is" — which documented the
            flaw rather than fixing it.

            So signing in is the only call. It works from every state a visitor can be in:
            never installed, installed already, or coming back. Afterwards the app KNOWS
            which, and can name the one next thing instead of offering a menu — which is
            also where installing belongs, on the Repositories page that can see whether
            anything is connected.
          */}
          <p className="calls">
            {signIn ? (
              <a className="cta" href="/auth/github">
                Continue with GitHub
              </a>
            ) : (
              // No accounts on this deployment — `serve.ts`, one operator on 127.0.0.1.
              // There is nothing to sign in to, so installing IS the way in.
              <a className="cta" href={installUrl}>
                Install on GitHub
              </a>
            )}
          </p>
          <p className="muted small">
            {signIn ? (
              <>
                You pick which repositories to connect after signing in, and you can change
                it whenever. Nothing is read until you do.
              </>
            ) : (
              <>Installing grants access to the repositories you pick, and nothing else.</>
            )}
          </p>
        </div>
      </section>

      {/*
        WHAT YOU GET, before how it is scored. This band did not exist: the page went from
        the headline straight to a 90/103 score breakdown, which is a number about a thing
        the reader had not been shown yet. The deliverable is a pull request, its five
        sections are fixed and written from the log rather than from anybody's summary
        (`src/report.ts`), and showing them is both concrete and the strongest argument the
        product has.
      */}
      <section className="band lead">
        <div>
          <h2 className="band-head">What lands in your pull request</h2>
          <div className="specimen">
            <div className="specimen-bar">
              <span>acme/checkout#41</span>
              <span className="muted">five sections, always all five</span>
            </div>
            <div className="specimen-body">
              <ol className="doc">
                <li>
                  <b>The bug</b> — your report, quoted, so the claim being tested is on the page.
                </li>
                <li>
                  <b>The failing test</b> — the command that reproduces it, registered before
                  the fix agent existed, so it cannot have been written to suit the fix.
                </li>
                <li>
                  <b>Base red, fix green</b> — a table of commits, exit codes and the symptom
                  found in the output, each line an artifact you can open by hash.
                </li>
                <li>
                  <b>The diff</b> — every file touched, and the full patch by hash.
                </li>
                <li>
                  <b>The tier reached</b> — how far the evidence actually goes, including what
                  was not measured.
                </li>
              </ol>
            </div>
          </div>
          <p className="muted small">
            Always all five, in that order. A description that drops the tier when the tier is
            awkward is a description you have to check by hand, which is the job this is
            supposed to do for you.
          </p>
        </div>
      </section>

      <section className="band">
        <div>
          <h2 className="band-head">How the tier is decided</h2>
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
            Every scoring line is an exit code from a container this engine started. Note the
            fourth: the agent&rsquo;s own confidence is worth <b>nothing</b>. It is stored and
            shown to you anyway, because you may want to read it — but no verdict on this page
            rests on anything the model said about itself.
          </p>
        </div>
      </section>

      <section className="band">
        <div>
          <h2 className="band-head">How it works</h2>
          <div className="steps">
            <div className="step">
              <div>
                <h3>Pick an issue and press Start</h3>
                <p>
                  You choose which repositories to connect and which bug to work on. No
                  personal access token is ever requested.
                </p>
              </div>
            </div>
            <div className="step">
              <div>
                <h3>It reproduces the bug — or stops</h3>
                <p>
                  On your base commit, in a container with no network at all, not even DNS. If
                  it cannot make your bug happen, it stops here and asks you what it is
                  missing. It does not guess at a fix for a bug it never saw.
                </p>
              </div>
            </div>
            <div className="step">
              <div>
                <h3>It writes the fix, then checks it twice</h3>
                <p>
                  Once, that the reproduction now passes — the reported bug is gone. Again,
                  that your own test suite still passes on both commits — nothing else went
                  with it.
                </p>
              </div>
            </div>
            <div className="step">
              <div>
                <h3>You watch, then decide</h3>
                <p>
                  Every command, exit code and file streams to you as it happens, and is kept
                  afterwards. It opens the pull request. You merge it, or you do not.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="band">
        <div>
          <h2 className="band-head">What it will not do</h2>
          <div className="cards">
            <div className="card">
              <h3>It will not fix what it cannot reproduce</h3>
              <p>
                No reproduction means no pull request — not a smaller one, not a hedged one.
                A bug nobody can make happen is a question, and you get the question back.
              </p>
            </div>
            <div className="card">
              <h3>It will not call one green test a fix</h3>
              <p>
                A passing test proves that test passes. Your whole suite, on the commit before
                and the commit after, is what shows the fix did not cost you something else.
              </p>
            </div>
            <div className="card">
              <h3>It will not take the model&rsquo;s word for anything</h3>
              <p>
                What the agent says about its own work is kept and shown to you, and counts
                towards no verdict. Only exit codes and stored output do.
              </p>
            </div>
            <div className="card">
              <h3>It will not merge</h3>
              <p>
                It opens the pull request and stops. Every decision after that is yours, and
                the evidence is sitting there to make it with.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="band">
        <div>
          <h2 className="band-head">Where your code runs</h2>
          <p>
            On repositories you pick, one at a time, in a container that is destroyed when the
            run ends. Installing grants access to those repositories and nothing else.
          </p>
          <p>
            <b>Your credentials are never in there with the agent.</b> The container holds no
            model key and no GitHub token — the loop runs outside it and passes tool calls in,
            so the sandbox needs no way out to the network and is given none. Every one is
            probed from the inside to prove the seal held, and a run says so in its own log
            rather than asking you to assume it.
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
