'use client';

import { useEffect, useRef, useState } from 'react';
import { send, type Me, type RepoDetail } from '../../lib/api';
import { Said, When } from '../bits';

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

  return (
    <>
      <p className="hero">
        Every repository boots differently and nothing in a repository reliably says how, so
        this is asked once and replayed forever. It is stored on our side, keyed by
        repository — never as a pull request against your code.
      </p>

      {detail.recipe ? <Proof proof={detail.proof} /> : null}

      {isDraft ? (
        <div className="warning">
          <h2>This box is pre-filled by an agent, not by a person.</h2>
          <p>
            It explored this repository and proposed what follows — nobody here has reviewed
            it. Treat it as a first draft, not a recommendation: check every command, every
            port and every service name against what you actually know about this project
            before you approve anything below.
          </p>
        </div>
      ) : null}

      {/* NOTHING YET, rather than nothing ever — 10h changed which of those is true.
          This said "on a hosted plane there is no drafting yet" and it was correct: the
          plane holds no model key and starts no containers, so installing the App drafted
          nothing. It now QUEUES the work and a worker does it, so the honest state of an
          empty box is "no proposal has arrived", and that has two possible causes a reader
          can act on differently. */}
      {!detail.recipe && !isDraft ? (
        <div className="panel">
          <h2>No proposal has arrived — the box is yours to fill.</h2>
          <p>
            Drafting reads your project and proposes a recipe for you to review. It runs where
            the containers run, so this service queues it and a machine picks it up — which
            means an empty box either has no machine free yet, or means a drafting session ran
            and had nothing it was willing to propose.
          </p>
          <p className="muted small">
            Either way you are not waiting on it: write the commands that install, boot and
            test your project and approve them, and a proposal that arrives later will not
            overwrite what you approved.
          </p>
        </div>
      ) : null}

      {detail.approvedAt ? (
        <p className="in-force">
          <span className="pass">
            <span className="mark" aria-hidden="true">
              ✓
            </span>
            In force
          </span>{' '}
          since <When iso={detail.approvedAt} /> — this is what every run against {repo} will
          execute.
        </p>
      ) : null}

      <div className="warning refusal">
        <h2>Read this before you approve.</h2>
        <p>
          Every run against this repository will execute these commands <b>verbatim</b>, in
          the agent sandbox, with a package registry reachable. Nothing sandboxes them from
          that sandbox — <b>you are the control</b>.
        </p>
        <p>
          {isDraft
            ? 'An agent drafted this. It is testimony, not a finding: we validate its shape and nothing about what it does.'
            : 'Whoever wrote this box is the only review it has had: we validate its shape and nothing about what it does.'}{' '}
          A service answering its healthcheck is the only thing here the engine will ever
          treat as evidence.
        </p>
      </div>

      <div className="field">
        <label htmlFor="recipe">The recipe, as JSON</label>
        <textarea
          id="recipe"
          rows={20}
          spellCheck={false}
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-describedby="recipe-hint"
        />
        <p className="hint" id="recipe-hint">
          <code>install</code>, <code>migrate</code>, <code>seed</code> and <code>test</code>{' '}
          are single commands and each may be left empty; <code>services</code> is a list of
          long-lived processes, each with a lowercase <code>name</code>, a <code>command</code>{' '}
          that stays in the foreground, a <code>port</code>, and optionally a{' '}
          <code>healthcheck</code> URL the engine polls until it answers. <code>test</code> is
          your project&rsquo;s own suite — it is the regression arm, not the reproduction,
          which the agent writes.
        </p>
      </div>
      <button type="button" onClick={approve} disabled={busy}>
        {busy ? 'Storing…' : detail.recipe ? 'Approve this recipe' : 'Approve and store'}
      </button>
      <Said said={said} />

      <h2>Environment variables: configuration here, secrets below</h2>
      <p>
        A recipe carries its own configuration in an <code>env</code> field — a port, a{' '}
        <code>DATABASE_URL</code> pointing at a database one of the services above starts,{' '}
        <code>NODE_ENV</code>. Those are values that are worthless outside the sandbox, and
        every command in the recipe runs with them.
      </p>
      <p>
        A value that <em>authenticates to something outside the sandbox</em> is a different
        thing, and it never goes in the recipe. Name it in <code>required</code> instead: the
        name is public, the value is not, and a run that cannot find one stops before any
        container starts and says which name it was missing — a <code>blocked</code> run,
        which is not a finding about anybody&rsquo;s bug and does not pretend to be one.
      </p>

      <Secrets repo={repo} detail={detail} onChanged={onChanged} />
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
function Secrets({ repo, detail, onChanged }: { repo: string; detail: RepoDetail; onChanged: () => void }) {
  const [deleting, setDeleting] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [name, setName] = useState('');
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
