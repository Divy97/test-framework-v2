'use client';

import { useEffect, useState } from 'react';
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
      <h2>Your model key</h2>
      <p className="hero">
        A run spends the key of whoever starts it. Without one, Start is refused before any
        machine is created — a failure about our configuration wearing the shape of a finding
        about your bug is the one thing that answer exists to prevent.
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
        <span className="muted">
          Sealed with AES-256-GCM. No page and no route can show it to you again — storing a
          new one replaces it.
        </span>
      </p>

      <div className="row">
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
            It is spent by the worker, on your runs, and never leaves it — the sandbox that
            runs an agent holds neither this key nor your GitHub token.
          </p>
        </div>
      </div>
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
                  ? { ok: true, text: `Stored for ${provider}.` }
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
            onClick={() => {
              void send('DELETE', '/api/settings/model-key').then((answer) => {
                setSaid(
                  answer.ok
                    ? { ok: true, text: 'Deleted. Start will be refused until a key is stored.' }
                    : { ok: false, text: answer.error ?? 'that failed' },
                );
                if (answer.ok) onChanged();
              });
            }}
          >
            Delete it
          </button>
        ) : null}
      </div>
      <Said said={said} />
    </>
  );
}
