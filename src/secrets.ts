// Values a run needs and nobody may read back (M10, ADR-0017).
//
// Two kinds of thing live here and they are the same shape: a repository's secrets — an
// API key its test suite needs to boot — and a person's own model key, which is what pays
// for their runs. Both are values this service stores, hands to one process at one moment,
// and can never show to anyone again, including the person who typed them.
//
// **AES-256-GCM, with the row's own identity as additional data.** The AAD is not
// decoration: without it a ciphertext is a portable blob, and anyone who can write a row —
// a SQL injection, a restored backup, a compromised migration — can move `STRIPE_SECRET_KEY`
// from a repository they own onto one they do not and have the worker inject it there.
// Bound to `repo\0name`, that ciphertext decrypts nowhere else, and the failure is an
// exception rather than a wrong plaintext.
//
// **Key rotation is not designed here, and `key_id` exists so that it can be.** Every row
// records which key sealed it; today there is one, named `k1`. What rotation needs beyond
// this — a second key accepted for reads while the first is retired, a re-seal pass, an
// operator procedure — is a decision nobody has made, and shipping half of it would be a
// mechanism that reads as rotation and is not.
//
// What this file deliberately does NOT do is decide when a value may leave. That is
// ADR-0017's rule and it is enforced at the moment of injection, by the worker, against a
// sandbox it has just observed to have no route out.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Db } from './store.js';

/** The key this deployment seals with. One, for now; the column makes a second possible. */
export const KEY_ID = 'k1';

/**
 * Longer than any credential and shorter than a file somebody pasted by mistake.
 *
 * A bound rather than a validation: a service key, a connection string and a PEM private
 * key are all legitimate here and share no shape at all, so the only honest check is that
 * this is not a document.
 */
export const MAX_SECRET_CHARS = 8192;

/**
 * Whether this deployment INJECTS what it stores, or only holds it.
 *
 * Off by default and off in production until 10l's guard has been executed against a
 * sandbox observed to be `deny-all` (ADR-0017). The flag is read by the pages, so what a
 * person is told matches what the engine does rather than what it intends to do — the
 * alternative being a form that accepts a live credential under an implication it does
 * not honour.
 */
export const secretsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  ['1', 'true', 'yes'].includes((env.ENGINE_SECRETS_ENABLED ?? '').toLowerCase());

/** AES-256-GCM: a 12-byte nonce is the size the mode is defined for, and a 16-byte tag. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The key, as 32 bytes, or a refusal that says what to do.
 *
 * Read per call rather than at import: a module that throws while being imported takes
 * down a process that might not have needed it, and the plane can serve every page it has
 * without ever sealing anything.
 */
export function sealingKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.PLANE_SECRETS_KEY;
  if (!raw) {
    throw new Error(
      'PLANE_SECRETS_KEY is not set, so nothing can be stored or read; ' +
        'generate one with `openssl rand -base64 32`',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`PLANE_SECRETS_KEY decodes to ${key.length} bytes; AES-256 needs 32 (base64 of 32 random bytes)`);
  }
  return key;
}

/**
 * Seal a value to one row.
 *
 * `aad` is what the row IS — `repo\0name`, or a github id — and the ciphertext will not
 * open under any other. The nonce is fresh per call and stored with the ciphertext, which
 * is what makes sealing the same value twice produce different bytes: equal ciphertexts
 * would otherwise tell anyone who can read the table which repositories share a key.
 */
export function seal(value: string, aad: string, key: Buffer = sealingKey()): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const sealed = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]);
}

/**
 * Open a value sealed to this row, or throw.
 *
 * Throws rather than returning null, and that is the point of the mode: a tampered
 * ciphertext, a ciphertext moved from another row, or a wrong key all fail the tag check
 * and end here. There is no shape of corruption that yields a plausible plaintext, so no
 * caller has to decide whether what it got back is real.
 */
export function open(stored: Buffer, aad: string, key: Buffer = sealingKey()): string {
  if (stored.length <= IV_BYTES + TAG_BYTES) throw new Error('the stored value is too short to be a sealed one');
  const iv = stored.subarray(0, IV_BYTES);
  const tag = stored.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(stored.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
}

/** What a repository's secret is bound to. A NUL between, so `a/b` + `c` cannot equal `a` + `b/c`. */
export const repoAad = (repo: string, name: string): string => `${repo}\0${name}`;
/**
 * What a person's model key is bound to: the person AND the provider.
 *
 * The provider is in here rather than beside it because it decides where the plaintext is
 * SENT (`loop.ts`, `providerName`). Under this design's own threat model — somebody who
 * can write a row, from a restored backup or an injection — a provider left outside the
 * seal can be flipped in place, and the worker then puts an OpenRouter key in an
 * Anthropic auth header. The attacker cannot forge the ciphertext and does not need to.
 *
 * Changing this invalidates every row sealed under the old binding. Done before any exist.
 */
export const userAad = (githubId: number, provider: string): string => `user\0${githubId}\0${provider}`;

// ── Storage ────────────────────────────────────────────────────────────────────
//
// Two readers exist — `repoSecrets` and `modelKey` — and both are called from exactly one
// place each: the runner routes, which authorize against the `jobs` row. Everything else
// here takes a value in or gives a NAME out.
//
// That is a convention, not a mechanism: this module exports the readers and `open`, and
// nothing stops a route importing them. The enforcement is the test that stores a
// recognisable value and greps every response the dashboard can produce for it.


/** What a repository has a value for. Names, in the order a person reads them. */
export async function listRepoSecretNames(client: Db, repo: string): Promise<string[]> {
  const { rows } = await client.query('select name from repo_secrets where repo = $1 order by name', [repo]);
  return rows.map((row) => String(row.name));
}

/** Store or replace one. An upsert, because typing it again is how a key is rotated. */
export async function putRepoSecret(
  client: Db,
  repo: string,
  name: string,
  value: string,
  createdBy: string,
): Promise<void> {
  await client.query(
    `insert into repo_secrets (repo, name, ciphertext, key_id, created_by, updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (repo, name) do update
         set ciphertext = $3, key_id = $4, created_by = $5, updated_at = now()`,
    [repo, name, seal(value, repoAad(repo, name)), KEY_ID, createdBy],
  );
}

export async function deleteRepoSecret(client: Db, repo: string, name: string): Promise<boolean> {
  const { rows } = await client.query('delete from repo_secrets where repo = $1 and name = $2 returning name', [
    repo,
    name,
  ]);
  return rows.length > 0;
}

/**
 * The values themselves, for one repository — the ONE function that opens them.
 *
 * Called by the runner route and nowhere else. It throws rather than skipping a row it
 * cannot open: a ciphertext that fails the tag check is a row that has been moved,
 * corrupted or sealed under a key this deployment no longer has, and injecting the rest
 * would start a run with a silently incomplete environment (ADR-0017).
 */
export async function repoSecrets(client: Db, repo: string): Promise<Record<string, string>> {
  const { rows } = await client.query('select name, ciphertext from repo_secrets where repo = $1', [repo]);
  const out: Record<string, string> = {};
  for (const row of rows) {
    const name = String(row.name);
    out[name] = open(Buffer.from(row.ciphertext as Uint8Array), repoAad(repo, name));
  }
  return out;
}

/** Whether a person has a model key, which is all any page is told. */
export async function hasModelKey(client: Db, githubId: number): Promise<{ provider: string } | null> {
  const { rows } = await client.query('select provider from user_model_keys where github_id = $1', [githubId]);
  return rows.length === 0 ? null : { provider: String(rows[0].provider) };
}

export async function putModelKey(
  client: Db,
  githubId: number,
  provider: string,
  value: string,
): Promise<void> {
  await client.query(
    `insert into user_model_keys (github_id, provider, ciphertext, key_id, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (github_id) do update
         set provider = $2, ciphertext = $3, key_id = $4, updated_at = now()`,
    [githubId, provider, seal(value, userAad(githubId, provider)), KEY_ID],
  );
}

export async function deleteModelKey(client: Db, githubId: number): Promise<boolean> {
  const { rows } = await client.query('delete from user_model_keys where github_id = $1 returning github_id', [
    githubId,
  ]);
  return rows.length > 0;
}

/** The key itself, for the worker. The other half of the pair with `repoSecrets`. */
export async function modelKey(
  client: Db,
  githubId: number,
): Promise<{ provider: string; key: string } | null> {
  const { rows } = await client.query(
    'select provider, ciphertext from user_model_keys where github_id = $1',
    [githubId],
  );
  if (rows.length === 0) return null;
  const provider = String(rows[0].provider);
  return { provider, key: open(Buffer.from(rows[0].ciphertext as Uint8Array), userAad(githubId, provider)) };
}
