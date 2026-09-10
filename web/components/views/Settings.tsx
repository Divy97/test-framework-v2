'use client';

import { useEffect, useRef, useState } from 'react';
import { send, type Me } from '../../lib/api';
import { Said } from '../bits';

const PROVIDERS = ['openrouter', 'anthropic'] as const;

/**
 * The model key, which is what pays for a run.
 *
 * One per person, and a run spends the key of whoever pressed Start — which is why this is
 * a personal setting and not a repository one: the key follows the human, and two people
 * connected to the same repository pay separately.
 *
 * This page is the whole reason `POST /api/runs` could answer 412 and nobody could act on
 * it. `routes.ts` said so in a comment — *`settings` is where the Next.js UI will put the
 * form; there is no such page yet, and naming it here is a promise this deployment does not
 * keep*. This is that page.
 */
export function Settings({ me, onChanged }: { me: Me | null; onChanged: () => void }) {
  const [provider, setProvider] = useState<string>(me?.modelKey?.provider ?? 'openrouter');
  // `me` arrives from a fetch, so this component mounts before it: the initial state above
  // is `openrouter` for everyone, including somebody whose stored key is Anthropic's. The
  // select would then have shown the wrong provider beside a correct "a key is stored for
  // anthropic" — and replacing the key would have silently changed which service it is for.
  const stored = me?.modelKey?.provider;
  useEffect(() => {
    if (stored) setProvider(stored);
  }, [stored]);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  if (me && !me.accounts) {
    return (
      <>
        <h1>Settings</h1>
        <div className="nothing">
          <p>This deployment has no accounts, so there is nobody to bill.</p>
          <p>
            It takes its model key from the environment it was started with —{' '}
            <code>OPENROUTER_API_KEY</code> or <code>ANTHROPIC_API_KEY</code> — which is what
            every run before the Start button did.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Settings</h1>
      <h2 ref={heading} tabIndex={-1}>
        Your model key
      </h2>
      {/* AN INSTRUCTION, not an essay (10n). This read: "a failure about our configuration
          wearing the shape of a finding about your bug is the one thing that answer exists
          to prevent". That sentence is defensible in an ADR and unreadable on a form —
          somebody here has one job, which is to paste a key, and the page should tell them
          what it is for and get out of the way. */}
      <p className="hero">
        Drafting a recipe and starting a run both spend your key. Store one and this account
        can use the product; without one, nothing here starts.
      </p>

      <p>
        {me?.modelKey ? (
          <span className="pass">
            <span className="mark" aria-hidden="true">
              ✓
            </span>
            A key is stored for <code>{me.modelKey.provider}</code>.
          </span>
        ) : (
          <span className="fail">
            <span className="mark" aria-hidden="true">
              ✗
            </span>
            No key is stored.
          </span>
        )}{' '}
        {/* `AES-256-GCM` was in this sentence. It is true, and it is the wrong fact for a
            person checking whether they have a key: what they need to know is that it is
            encrypted, that nothing can read it back, and that storing another replaces it. */}
        <span className="muted">
          Stored encrypted. Nothing can show it to you again, and storing another replaces it.
        </span>
      </p>

      {/* STACKED, not a row (10n). `.row` is `align-items: flex-end`, so putting a narrow
          select beside a wide input whose hint runs to four lines pushed the select to the
          bottom of that hint — the PROVIDER label ended up floating halfway down the page,
          level with the middle of somebody else's paragraph. It read as a broken layout,
          because it was one. Two fields with different heights do not belong on one row. */}
      <div className="field">
        <label htmlFor="provider">Provider</label>
        <select id="provider" value={provider} onChange={(event) => setProvider(event.target.value)}>
          {PROVIDERS.map((one) => (
            <option key={one} value={one}>
              {one}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="model-key">Key</label>
        <input
          id="model-key"
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          autoComplete="off"
          aria-describedby="model-key-hint"
          placeholder={provider === 'openrouter' ? 'sk-or-v1-…' : 'sk-ant-…'}
        />
        <p className="hint" id="model-key-hint">
          We check it against {provider} before saving, which spends a few tokens on the key
          itself. A key with a spend limit needs headroom for a whole session — a drafting run
          is tens of turns.
        </p>
      </div>

      {/* The security fact, on its own and after the form rather than buried in a hint
          nobody reads while typing. It is the reassurance somebody wants BEFORE pasting a
          credential, and it was the fourth sentence of a four-sentence paragraph. */}
      <p className="muted small">
        The key is spent by the worker, on your runs, and never leaves it: the sandbox that runs
        an agent holds neither this key nor your GitHub token.
      </p>
      <div className="row">
        <button
          type="button"
          disabled={key === '' || busy}
          onClick={() => {
            setBusy(true);
            void send('PUT', '/api/settings/model-key', { provider, key }).then((answer) => {
              setBusy(false);
              setSaid(
                answer.ok
                  ? { ok: true, text: `Stored for ${provider}, and ${provider} accepted it.` }
                  : { ok: false, text: answer.error ?? 'that failed' },
              );
              if (answer.ok) {
                setKey('');
                onChanged();
              }
            });
          }}
        >
          {busy ? 'Storing…' : me?.modelKey ? 'Replace the key' : 'Store the key'}
        </button>
        {me?.modelKey ? (
          <button
            type="button"
            className="quiet"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void send('DELETE', '/api/settings/model-key').then((answer) => {
                setBusy(false);
                setSaid(
                  answer.ok
                    ? { ok: true, text: 'Deleted. Start will be refused until a key is stored.' }
                    : { ok: false, text: answer.error ?? 'that failed' },
                );
                // This button disappears on success — `me.modelKey` becomes null — so focus
                // would fall to `<body>` and a keyboard user would be at the top of the
                // document with no idea the deletion happened.
                if (answer.ok) {
                  onChanged();
                  heading.current?.focus();
                }
              });
            }}
          >
            {busy ? 'Deleting…' : 'Delete it'}
          </button>
        ) : null}
      </div>
      <Said said={said} />
    </>
  );
}
