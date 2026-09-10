'use client';

import { useEffect, useRef, useState } from 'react';
import { send, type Me, type RepoDetail } from '../../lib/api';
import { Said, When } from '../bits';
import { since } from '../Checklist';
import { missingNames } from '../../lib/required';
import { review } from '../../lib/review';

/**
 * A skeleton that is valid JSON, because the alternative is a trap.
 *
 * The obvious skeleton is a commented one, and JSON has no comments: a reader who fills in
 * the fields and submits gets a refusal for a syntax error they were handed, on the one
 * screen where their first act is to be told they got it wrong.
 *
 * Empty strings rather than sample commands, and that is the load-bearing half. An absent
 * command runs nothing — whereas a plausible-looking `npm install` placeholder is a command
 * this engine would then execute verbatim against somebody's repository because it was
 * pre-typed for them.
 */
const SKELETON = JSON.stringify({ install: '', migrate: '', seed: '', services: [], test: '' }, null, 2);

/**
 * The recipe, the proof, and the secrets — everything about how this repository boots.
 *
 * The approval is the only write in this product that stores something the engine later
 * executes verbatim, and ADR-0013 is explicit that the human pressing the button IS the
 * control. Moving it from a form post to a `fetch` changes the envelope and nothing about
 * that, so the warning is unchanged and sits above the button rather than beside it.
 *
 * What is genuinely new is the secrets form. Until now a value could only be stored with
 * `curl` — `src/web.ts` could not send a `PUT` with a JSON body, and writing the script for
 * one into a file this milestone deletes would have been work done twice. So the product
 * asked people to use a terminal to configure the thing they had just installed.
 */
/**
 * What the recipe will actually do, as an ordered list rather than as JSON.
 *
 * Rendered from the TEXT being edited, not from the stored recipe, so it tracks the
 * textarea keystroke by keystroke — the point is to see what you are about to approve,
 * and a review of the last thing that happened to parse is a review of the wrong thing.
 */
function Review({ text }: { text: string }) {
  const read = review(text);

  if ('error' in read) {
    return (
      <div className="nothing">
        <p>{read.error}</p>
        <p className="muted small">
          Nothing can be reviewed until it parses. Fix it below and this fills in as you type.
        </p>
      </div>
    );
  }

  const runs = read.steps.filter((step) => step.command !== null);

  return (
    <section className="review" aria-label="What this recipe will run">
      <h2>What will run, in order</h2>
      {runs.length === 0 ? (
        // A recipe of empty strings PARSES, and it is the trap `parseRecipe` and the
        // skeleton comment both warn about: a run against it boots nothing and reports a
        // bug that was never shown. Said here, where somebody is about to approve one.
        <p className="warn-line">
          <b>This recipe runs nothing.</b> Every command is empty, so a run would boot no
          project and report that it could not reproduce your bug — which would be a fact
          about this recipe, not about the bug.
        </p>
      ) : null}
      {read.risks > 0 ? (
        <p className="warn-line">
          <b>
            {read.risks} thing{read.risks === 1 ? '' : 's'} below {read.risks === 1 ? 'is' : 'are'} worth
            reading twice.
          </b>{' '}
          Marked on the command {read.risks === 1 ? 'it' : 'they'} appear{read.risks === 1 ? 's' : ''} in.
        </p>
      ) : null}
      <ol className="steps-run">
        {read.steps.map((step, n) => (
          <li key={`${step.phase}-${step.label}-${n}`} className={step.command === null ? 'step-empty' : undefined}>
            <span className="tag">{step.label}</span>
            <span className="body">
              {step.command === null ? (
                <span className="muted">nothing — this phase is skipped</span>
              ) : (
                <code>{step.command}</code>
              )}
              {step.detail ? <span className="meta">{step.detail}</span> : null}
              {step.command === null ? null : <span className="meta">{step.note}</span>}
              {step.risks.map((risk) => (
                <span className="risk" key={risk.found}>
                  {/* The word, not only the colour and the glyph. */}
                  <span className="mark" aria-hidden="true">
                    !
                  </span>
                  <span className="sr">Worth reading twice: </span>
                  <code>{risk.found}</code> {risk.says}
                </span>
              ))}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The commands as JSON, and the button that stores them.
 *
 * One component because three stages can store commands — writing them by hand, using a
 * proposal, changing them later — and three near-identical copies of a textarea and a
 * submit is how the same screen ends up with three subtly different affordances. The
 * label differs because the ACT differs: using somebody's proposal is not the same
 * decision as saving an edit to commands already in use.
 */
function Editor({
  text,
  setText,
  parsed,
  onApprove,
  busy,
  said,
  label,
}: {
  text: string;
  setText: (to: string) => void;
  parsed: unknown;
  onApprove: () => void;
  busy: boolean;
  said: { ok: boolean; text: string } | null;
  label: string;
}) {
  return (
    <>
      {/* ADR-0013, BESIDE THE CONTROL THAT AUTHORISES IT.
          This was a two-paragraph panel rendered on every state of the screen, including
          states with no commands to authorise — which is both why the page was long and
          why the warning had stopped being read. It is not decoration: `verbatim`, the
          reachable package registry, the absence of any sandbox around them, and who the
          control is are the four facts a person is agreeing to, and cutting any of them to
          save words would be trading somebody else's safety for my page length.
          So it lives HERE, in the component that stores commands — which means it appears
          wherever storing is possible, by construction rather than by remembering. Same
          four facts, thirty words instead of ninety. */}
      <p className="authorises">
        Every run executes these <b>verbatim</b>, in a container of your own, with a package
        registry reachable. Nothing sandboxes them from that sandbox — <b>you are the
        control</b>.
      </p>
      <details className="as-json" open={parsed === null}>
        {/* OPEN when the text does not parse, because then this is the only place the
            problem can be fixed and hiding it would strand the reader behind a summary
            that says "not valid JSON yet" and nothing they can act on. */}
        <summary>Edit as JSON</summary>
        <div className="field">
          <label htmlFor="recipe">The commands, as JSON</label>
          <textarea
            id="recipe"
            rows={18}
            spellCheck={false}
            value={text}
            onChange={(event) => setText(event.target.value)}
            aria-describedby="recipe-hint"
          />
          <p className="hint" id="recipe-hint">
            <code>install</code>, <code>migrate</code>, <code>seed</code> and <code>test</code>{' '}
            are single commands, each optional. <code>services</code> lists anything that has
            to stay running, each with a <code>name</code>, a <code>command</code>, a{' '}
            <code>port</code>, and optionally a <code>healthcheck</code> URL we poll until it
            answers. <code>test</code> is your project&rsquo;s own test command.
          </p>
        </div>
      </details>
      <p className="calls">
        <button type="button" className="primary" onClick={onApprove} disabled={busy}>
          {busy ? 'Saving…' : label}
        </button>
      </p>
      <Said said={said} />
    </>
  );
}

export function Environment({
  repo,
  detail,
  me,
  onChanged,
}: {
  repo: string;
  detail: RepoDetail;
  me: Me | null;
  onChanged: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState<{ ok: boolean; text: string } | null>(null);

  // What fills the box, in priority order. An approved recipe always wins — it is the one
  // actually in force, and a draft beside it is a stale second opinion nobody asked for.
  const initial = detail.recipe
    ? JSON.stringify(detail.recipe, null, 2)
    : detail.draft
      ? safely(detail.draft)
      : SKELETON;
  const isDraft = !detail.recipe && detail.draft !== null;

  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  // Reset when the repository changes underneath, but NOT on every reload of the same one:
  // a person mid-edit whose textarea is replaced by a refetch has lost their work to a
  // background poll.
  useEffect(() => setText(initial), [repo]); // eslint-disable-line react-hooks/exhaustive-deps

  // Whether the text in the box parses at all, which decides whether the JSON editor
  // starts open: when it does not parse, that editor is the only place the problem can be
  // fixed, and collapsing it would strand the reader behind a summary they cannot act on.
  const parsed = (() => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  })();

  const approve = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      // Caught here rather than sent, so the reader is told the document does not parse
      // instead of being told the server refused it.
      setSaid({ ok: false, text: `That is not valid JSON: ${String((error as Error).message)}` });
      return;
    }
    setBusy(true);
    void send<{ approved: boolean }>('PUT', `/api/repos/${encodeURIComponent(repo)}/recipe`, { recipe: parsed }).then(
      (answer) => {
        setBusy(false);
        setSaid(
          answer.ok
            ? { ok: true, text: 'Stored. Every run against this repository will now execute these commands.' }
            : { ok: false, text: answer.error ?? 'that failed' },
        );
        if (answer.ok) onChanged();
      },
    );
  };

  const missing = missingNames(detail.recipe, detail.secrets.names);
  const working = detail.activity.find((one) => one.kind === 'draft' && one.finishedAt === null) ?? null;
  const failed = detail.activity.find((one) => one.kind === 'draft' && one.note !== null) ?? null;

  /*
   * ONE STEP, ONE ACTION (10n).
   *
   * This screen was a single scroll carrying FOUR submit buttons — start a run, ask for a
   * proposal, approve the commands, store a secret — and every explanatory paragraph the
   * feature had ever needed, all visible at once regardless of which of them applied. A
   * first-time reader met about nine hundred words and had to work out which of four
   * things they were supposed to do, in a vocabulary they had never seen: recipe, caveats,
   * in force, blocked run, reproduction.
   *
   * The information was right and the architecture was wrong: it was organised around what
   * this product STORES rather than around what a person is doing. The checklist above
   * already knows which step they are on, so this renders that step and nothing else.
   * Everything cut is behind a disclosure on the step it belongs to, not deleted — the
   * reader who wants the whole picture is one click away, and the reader who wants to get
   * going is not reading nine hundred words first.
   */
  const stage: 'propose' | 'working' | 'review' | 'values' | 'ready' = detail.recipe
    ? missing.length > 0
      ? 'values'
      : 'ready'
    : working
      ? 'working'
      : detail.draft
        ? 'review'
        : 'propose';

  return (
    <>
      {stage === 'propose' ? (
        <section className="stage">
          <h2>How should we run your project?</h2>
          <p className="lede-sm">
            To test a bug we have to boot your project the way you do — install it, start it,
            run its tests. Tell us those commands once and every run reuses them.
          </p>
          <p className="calls">
            <button
              type="button"
              className="primary"
              disabled={asking || me?.modelKey === null}
              onClick={() => {
                setAsking(true);
                void send('POST', `/api/repos/${encodeURIComponent(repo)}/draft`).then((answer) => {
                  setAsking(false);
                  setAsked(
                    answer.ok
                      ? { ok: true, text: 'On its way. This page will keep itself up to date.' }
                      : { ok: false, text: answer.error ?? 'that failed' },
                  );
                  if (answer.ok) onChanged();
                });
              }}
            >
              {asking ? 'Asking…' : 'Work it out for me'}
            </button>
          </p>
          <Said said={asked} />
          {me?.modelKey === null ? (
            <p className="muted small">
              {/* The COST in both branches. It was only on the branch where the button
                  works, so somebody without a key was told to go and store one without
                  being told what pressing the button afterwards would spend. */}
              This reads your code with a model: a couple of minutes, about 13¢, and it spends
              your model key — which this account has not stored.{' '}
              <a href="/settings">Store a key</a> to use it.
            </p>
          ) : (
            <p className="muted small">
              An agent explores your project and proposes the commands. Takes a couple of
              minutes, costs about 13¢, and you review everything before it is used.
            </p>
          )}
          <details className="quiet">
            <summary>Or write them yourself</summary>
            <Editor
              text={text}
              setText={setText}
              parsed={parsed}
              onApprove={approve}
              busy={busy}
              said={said}
              label="Use these commands"
            />
          </details>
        </section>
      ) : null}

      {stage === 'working' ? (
        <section className="stage">
          <h2>Working out how to run your project</h2>
          <p className="lede-sm">
            An agent is reading your code, installing it and starting it up. About two
            minutes.
          </p>
          <p className="waiting-for">
            {working!.dispatchedAt === null
              ? `Queued ${since(working!.queuedAt)} ago, waiting for a machine.`
              : `Running for ${since(working!.dispatchedAt)}.`}
          </p>
          <p className="muted small">
            You can leave this page. The browser tab will tell you when it is done.
          </p>
        </section>
      ) : null}

      {stage === 'review' ? (
        <section className="stage">
          <h2>Check these commands, then use them</h2>
          <p className="lede-sm">
            An agent proposed these by exploring your project — nobody has reviewed them yet.
            We will run them <b>exactly as written</b>, in a container of your own. Nothing has
            run so far.
          </p>
          {failed?.note ? <p className="muted small">Last attempt: {failed.note}</p> : null}
          <Review text={text} />
          <Editor
            text={text}
            setText={setText}
            parsed={parsed}
            onApprove={approve}
            busy={busy}
            said={said}
            label="Use these commands"
          />
        </section>
      ) : null}

      {stage === 'values' ? (
        <section className="stage">
          <h2>
            {missing.length} value{missing.length === 1 ? '' : 's'} your project needs
          </h2>
          <p className="lede-sm">
            Your commands say this project cannot start without{' '}
            {missing.map((name, n) => (
              <span key={name}>
                {n > 0 ? ', ' : ''}
                <code>{name}</code>
              </span>
            ))}
            . Add {missing.length === 1 ? 'it' : 'them'} and runs can begin; without{' '}
            {missing.length === 1 ? 'it' : 'them'} a run stops before it starts rather than
            report a bug it could not see.
          </p>
          <Secrets repo={repo} detail={detail} onChanged={onChanged} suggest={missing[0]} />
        </section>
      ) : null}

      {stage === 'ready' ? (
        <section className="stage">
          <h2>Ready to test bugs on {repo}</h2>
          <p className="lede-sm">
            We know how to run this project, and we checked that it builds. Pick an issue on
            the <b>Start a run</b> tab.
          </p>
          {/* WHEN, because a second approval writes a new timestamp and the screen has to
              change even when the commands do not. This read "In force since …", which is
              our word for it and nobody else's. */}
          {detail.approvedAt ? (
            <p className="muted small">
              These commands have been in use since <When iso={detail.approvedAt} />.
            </p>
          ) : null}
          <details className="quiet">
            <summary>The commands we will run</summary>
            <Review text={text} />
            <Editor
              text={text}
              setText={setText}
              parsed={parsed}
              onApprove={approve}
              busy={busy}
              said={said}
              label="Save changes"
            />
          </details>
          <details className="quiet">
            <summary>What we checked, and what we could not</summary>
            <Proof proof={detail.proof} />
          </details>
          <details className="quiet">
            <summary>Values this project runs with</summary>
      <Secrets repo={repo} detail={detail} onChanged={onChanged} />
          </details>
        </section>
      ) : null}
    </>
  );
}


const safely = (draft: unknown): string => {
  // `draft` arrived as `unknown` off an agent's own words and never through validation, so
  // stringifying it can throw — and a draft that cannot even be displayed is worth exactly
  // as much as no draft.
  try {
    return JSON.stringify(draft, null, 2);
  } catch {
    return SKELETON;
  }
};

/**
 * What onboarding proved (8f).
 *
 * Defensive about every field, because the proof is stored as opaque JSON and read back the
 * same way: one written by an older engine has to render as what it is rather than throw on
 * a field that did not exist yet.
 */
function Proof({ proof }: { proof: unknown }) {
  if (proof === null || typeof proof !== 'object') {
    return (
      <div className="panel">
        <h2>Not proved yet</h2>
        <p className="muted">
          Approving a recipe queues a proving run: a worker builds this
          repository&rsquo;s environment and runs the project&rsquo;s own test command in the
          sealed container that judges a fix. That answers the question a person actually has
          after approving — <em>will a run here be able to say anything at all</em> — before
          a stranger&rsquo;s issue is the thing that finds out.
        </p>
        <p className="muted small">
          It waits for a machine to pick it up, so this fills in on its own within a minute or
          two of one being free. <b>Until 10h this page said the same thing and nothing was
          queued</b> — the plane holds no model key and starts no containers, so approving here
          proved nothing while the same button on a laptop did.
        </p>
      </div>
    );
  }
  const it = proof as {
    state?: unknown;
    commit?: unknown;
    environment?: { built?: unknown; failed?: unknown };
    suite?: { command?: unknown; exitCode?: unknown; failed?: unknown };
    caveats?: unknown;
    unproved?: unknown;
    provedAt?: unknown;
  };
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

  return (
    <div className="panel">
      <h2>What onboarding proved</h2>
      <p>
        {it.state === 'ready' ? (
          <>
            <b className="pass">Ready.</b> The environment built and the project&rsquo;s own
            tests pass in the container that judges a fix.
          </>
        ) : it.state === 'blocked' ? (
          <>
            <b className="fail">Blocked.</b> This repository&rsquo;s environment did not
            build, so no run here can reproduce anything.
          </>
        ) : (
          <>
            <b>Ready, with caveats.</b> The environment built. What follows is what a run here
            will and will not be able to say.
          </>
        )}
      </p>
      {/* Only when there is something to say. `failed` absent rendered an EMPTY red
          paragraph — a colour with no content, which is the purest form of meaning carried
          by colour alone. */}
      {it.environment?.built === false && it.environment.failed ? (
        <p className="fail">
          <span className="mark" aria-hidden="true">
            ✗
          </span>
          {String(it.environment.failed)}
        </p>
      ) : null}
      {it.suite ? (
        <p>
          The project&rsquo;s own test command, run in the sealed container:{' '}
          <code>{String(it.suite.command ?? '')}</code> —{' '}
          {typeof it.suite.exitCode === 'number'
            ? `exit ${it.suite.exitCode}`
            : `could not be run (${String(it.suite.failed ?? 'no reason recorded')})`}
          .
        </p>
      ) : null}
      {list(it.caveats).length > 0 ? (
        <>
          <p>Caveats:</p>
          <ul>
            {list(it.caveats).map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </>
      ) : null}
      {list(it.unproved).length > 0 ? (
        <>
          <p className="muted small">Not checked by this engine at all:</p>
          <ul className="muted small">
            {list(it.unproved).map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="muted small">
        Proved at {String(it.provedAt ?? 'an unrecorded time')}
        {it.commit ? (
          <>
            , on <code>{String(it.commit).slice(0, 12)}</code>
          </>
        ) : null}
        . Approving a new recipe clears this, because a proof is about the commands it ran.
      </p>
    </div>
  );
}

/**
 * Stored secrets — names in, names out, and never a value.
 *
 * The form this product did not have. Note what it does NOT do: there is no "reveal", no
 * "copy", and no edit-in-place, because no route returns a stored value and adding a
 * control that implied one would be the first step towards writing the route that does.
 * Replacing a value means storing it again.
 */
function Secrets({
  repo,
  detail,
  onChanged,
  // The name the step is asking for, so the reader is not retyping something the screen
  // already knows. `required` names it; leaving the field blank made them copy it across
  // from a sentence two lines up.
  suggest,
}: {
  repo: string;
  detail: RepoDetail;
  onChanged: () => void;
  suggest?: string;
}) {
  const [deleting, setDeleting] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Pre-filled with the name the step is asking for. It was blank, so somebody being told
  // "this project cannot start without SPOTIFY_CLIENT_ID" had to copy that name out of a
  // sentence two lines above into a field directly below it.
  const [name, setName] = useState(suggest ?? '');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  // The same rule a recipe's `required` obeys, checked here so a typo is caught before it
  // becomes a value this service holds and can never use.
  const badName = name !== '' && !/^[A-Z_][A-Z0-9_]*$/.test(name);

  const store = () => {
    setBusy(true);
    void send('PUT', `/api/repos/${encodeURIComponent(repo)}/secrets/${encodeURIComponent(name)}`, { value }).then(
      (answer) => {
        setBusy(false);
        setSaid(answer.ok ? { ok: true, text: `${name} stored.` } : { ok: false, text: answer.error ?? 'that failed' });
        if (answer.ok) {
          setName('');
          setValue('');
          onChanged();
        }
      },
    );
  };

  return (
    <>
      <h2 ref={heading} tabIndex={-1}>
        Stored secrets
      </h2>
      {detail.secrets.names.length > 0 ? (
        <ul className="names">
          {detail.secrets.names.map((stored) => (
            <li key={stored}>
              <code className="grow">{stored}</code>
              <button
                type="button"
                className="quiet small"
                disabled={deleting !== null}
                onClick={() => {
                  // `deleting`, so a double click does not send two requests — and so the
                  // control says it is working rather than looking inert for a round trip.
                  setDeleting(stored);
                  void send('DELETE', `/api/repos/${encodeURIComponent(repo)}/secrets/${encodeURIComponent(stored)}`).then(
                    (answer) => {
                      setDeleting(null);
                      setSaid(
                        answer.ok
                          ? { ok: true, text: `${stored} deleted. Storing it again is the only way back.` }
                          : { ok: false, text: answer.error ?? 'that failed' },
                      );
                      // FOCUS, because this button is about to stop existing: the row
                      // disappears and focus falls to `<body>`, dumping a keyboard user at
                      // the top of the document with no idea where they are.
                      if (answer.ok) {
                        onChanged();
                        heading.current?.focus();
                      }
                    },
                  );
                }}
              >
                {deleting === stored ? 'Deleting…' : 'Delete'} <span className="sr">{stored}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nothing is stored for {repo} yet.</p>
      )}

      {/* WHERE A PORT GOES AND WHERE A PASSWORD GOES (10j), kept and demoted.
          This was two paragraphs on the main scroll, above a form most readers had no
          reason to use yet. It is real teaching — somebody who puts a database password in
          `env` has put a credential in the commands, and somebody who puts a port in
          `required` has made their project un-runnable until they type a 3000 into a
          secrets form — so it is behind a disclosure on the step that asks for values,
          rather than in front of everybody who visits the page. */}
      <details className="quiet">
        <summary>Which of these goes where?</summary>
        <p>
          Environment variables: configuration here, secrets below. A port, or a{' '}
          <code>DATABASE_URL</code> pointing at a database your own commands start, is
          configuration — it is worthless outside the sandbox, so it belongs in the{' '}
          <code>env</code> field of the commands themselves.
        </p>
        <p>
          A value that authenticates to something <i>outside</i> the sandbox is a secret and
          never goes in the commands. Name it in <code>required</code> instead: the name is
          public, the value is not, and a run that cannot find one stops before any container
          starts and says which name was missing — a <code>blocked</code> run, which is not a
          finding about anybody&rsquo;s bug and does not pretend to be one.
        </p>
      </details>

      {detail.secrets.enabled ? (
        <>
          <p>
            These are injected into runs on this deployment — into a sandbox the engine has
            just probed <em>from the inside</em> and found to have no DNS and no route out
            (ADR-0017). A value here therefore satisfies a startup check and a suite that
            reads it, and cannot reach the service it authenticates to. That is the point,
            not a limitation.
          </p>
          {/* THE PART THAT IS EASY TO LEAVE OUT, and ADR-0017's own risk list says it has to
              be said: "a secret under deny-all satisfies a startup check and nothing else,
              and the UI has to say so." Somebody who is not told this stores a real key and
              files a bug about a timeout. */}
          <p className="muted small">
            <b>Which commands actually see them:</b> your project&rsquo;s own{' '}
            <code>test</code> command, and anything the reproduction runs — the phases that
            judge, which are sealed before they are handed a line of your code.{' '}
            <b>
              Not <code>install</code>, <code>migrate</code>, <code>seed</code>, or a
              service&rsquo;s startup.
            </b>{' '}
            Those run while the sandbox still has a package registry reachable, because
            installing dependencies needs one — and a stored credential may not exist in a
            container with a route out. If your <code>install</code> needs a private token,
            this engine cannot run your project yet, and it will say so rather than half-boot
            it.
          </p>
        </>
      ) : (
        <div className="warning">
          <h2>Stored, and not yet injected into any run.</h2>
          <p>
            The agent sandbox is affordable only because nothing worth stealing lives in it —
            the agent is untrusted by construction, its prompt contains text whoever filed the
            issue wrote, and until the sandbox is sealed it has network egress. Injection is
            enabled per deployment once the executor has been shown to close that route before
            the agent&rsquo;s first turn (ADR-0017). Configuration in the recipe&rsquo;s{' '}
            <code>env</code> is injected today; these are not.
          </p>
        </div>
      )}

      <div className="row">
        <div className="field">
          <label htmlFor="secret-name">Name</label>
          <input
            id="secret-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value.toUpperCase())}
            autoComplete="off"
            aria-invalid={badName}
            aria-describedby="secret-name-hint"
            placeholder="STRIPE_API_KEY"
          />
          {/* `aria-live`, because a description is not re-read when it changes: the name
              goes invalid, the Store button silently disables, and nothing says why. */}
          <p className="hint" id="secret-name-hint" aria-live="polite">
            {badName
              ? `"${name}" is not an environment variable name — capitals, digits and underscores, not starting with a digit.`
              : 'The name is public and appears in this list. Match it to the recipe’s required.'}
          </p>
        </div>
        <div className="field">
          <label htmlFor="secret-value">Value</label>
          <input
            id="secret-value"
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            aria-describedby="secret-value-hint"
          />
          <p className="hint" id="secret-value-hint">
            Sealed with AES-256-GCM and bound to this repository. Once stored, a value is
            never returned — not by this page, not by any other, and not by any route. To
            replace one, store it again.
          </p>
        </div>
      </div>
      <button type="button" onClick={store} disabled={busy || name === '' || value === '' || badName}>
        {busy ? 'Storing…' : 'Store this secret'}
      </button>
      <Said said={said} />
    </>
  );
}
