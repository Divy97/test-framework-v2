// Secrets must never reach a payload, a blob, or a log line (M6e).
//
// This is the half of 6e that is worth doing whether or not the secrets UI is ever built,
// and it is deliberately the ONLY half being built. The rest of that phase is blocked on
// a decision that does not exist yet: injecting a user's environment into the agent
// sandbox would put real credentials in a container that holds an untrusted agent, partly
// prompted by text a stranger wrote, with network egress — and the README's justification
// for that sandbox being uncontained is precisely that **nothing worth stealing lives
// there**. A form is not what unblocks that; an ADR is.
//
// The leak exists TODAY, before any UI. A recipe carries environment inline
// (`PORT=8080 node server.mjs`), `replayRecipe` builds `recipe step ${step} failed:
// ${command}` when a step fails, and the orchestrator writes that string into
// `VERIFICATION_ABORTED.reason`. Events are append-only and immutable by construction
// (ADR-0001, ADR-0002), so **a secret written there can never be deleted** — and failure
// is exactly when a misconfigured secret shows up.
//
// What this is not: a guarantee. A redactor is a filter over shapes we recognise, so it
// is a mitigation and reads as one. The structural fix is that the secret never enters
// the string, which is what 6e's ADR has to decide.

/**
 * Assignments whose NAME says the value is a credential.
 *
 * Keyed on the name rather than on the value's shape, because a password can look like
 * anything — `hunter2` is indistinguishable from a hostname until you read what it is
 * assigned to.
 */
const SECRET_NAME = /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH)[A-Z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/g;

/**
 * Values whose SHAPE says they are a credential, wherever they appear.
 *
 * These catch the case the name rule cannot: a bare token pasted into a command, or one
 * echoed by a program's own output where there is no assignment to key on.
 */
const SECRET_SHAPE: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub personal, oauth, user, server, refresh
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /\bsk-or-v1-[A-Za-z0-9]{16,}/g, // OpenRouter
  /\bsk-[A-Za-z0-9]{32,}/g, // OpenAI-shaped, and long enough not to catch prose
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
];

/** `scheme://user:password@host` — the password, and only the password. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@]+@/gi;

export const REDACTED = '[redacted]';

/**
 * Mask anything that looks like a credential.
 *
 * Order matters: the name rule runs first so `TOKEN=sk-…` is masked once as an assignment
 * rather than twice, and the URL rule runs last so it sees a string the others have
 * already thinned out.
 *
 * Never throws and never returns undefined — every call site is an error path, and a
 * redactor that can fail while reporting a failure would replace a diagnosis with a
 * different one.
 */
export function redact(text: string): string {
  if (!text) return text;
  let out = text.replace(SECRET_NAME, (_match, name: string) => `${name}=${REDACTED}`);
  for (const shape of SECRET_SHAPE) out = out.replace(shape, REDACTED);
  out = out.replace(URL_PASSWORD, (_match, prefix: string) => `${prefix}:${REDACTED}@`);
  return out;
}
