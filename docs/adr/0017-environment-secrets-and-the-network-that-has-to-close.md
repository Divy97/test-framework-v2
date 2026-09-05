---
status: accepted
---

# Environment secrets, and the network route that has to close first

M6e named this gap and left it unbuilt on purpose: "this phase is blocked on a
decision, not on code, and it must not be built as a form until the decision is
made." Three facts, all already true of this sandbox:

1. `orchestrate.ts` gives the agent sandbox a full network route whenever a recipe
   exists, or a draft is being proposed ([ADR-0013](0013-the-environment-recipe.md)) —
   it needs a registry for `install`.
2. The agent is untrusted by construction, and its prompt contains text an attacker
   can influence: an issue body, a repository's own contents.
3. That network route is affordable today only because, as the README puts it,
   *"nothing worth stealing lives there and nothing it produces is trusted."*

A real `DATABASE_URL` or a third-party API key sitting in that same container makes
(3) false the moment it is injected, regardless of what the UI around it says.

**Decision.** Secrets are stored apart from the recipe — an encrypted table
referenced by name, resolved only at the moment of injection, scoped per service and
separately for `install`/`migrate` — never inside the `recipe` jsonb, never
displayed by `recipe show`, never reachable through a failing step's command text.
Redaction ([`src/redact.ts`](../../src/redact.ts)) already covers that last leak: it
was built ahead of this decision because the leak existed before any UI did, and
`test/redact.test.ts` is the test this ADR's "done when" refers to.

That much is safe to build under today's network regime, because it protects
storage and display — a secret typed in never becomes a fact in the append-only
log. It does not touch the actual objection, which is about the moment a value that
was never in the log sits in a process an untrusted, partly stranger-prompted agent
can reach over a network connection to anywhere.

**So: no production-shaped secret is injected into a container that has a network
route. Not behind an allowlist — an absence.** The same shape as
[ADR-0011](0011-the-agent-loop-runs-outside-the-sandbox.md) and
[ADR-0012](0012-the-github-app-and-where-the-token-lives.md)'s decisions about this
same sandbox: not "which domains can this reach", but "can this reach anything at
all". An egress allowlist was the alternative considered — restrict the sandbox to
the domain the secret is for — and it is rejected because that domain is exactly
where an exfiltration disguised as a legitimate call would go. Narrowing the target
is not removing it.

**The real fix, and the reason this phase is titled "the boundary that has to move
first": pre-warm dependencies into the agent image, so a drafting or fix session
never needs `install`'s registry route, then give the agent sandbox
`--network none`** the same way the phase containers already have it. The network
exception in ADR-0013 exists for exactly one reason — `install` needs a registry —
and the environment-snapshot work in milestone 7 (`docker commit` plus a hardlink
restore) already proves a container's installed dependencies can be captured once
and handed to a container with no network at all. Extending that snapshot to the
agent sandbox itself removes the reason the exception exists, rather than policing
its use.

**Until that extension is built, this decision unblocks storage and redaction, not
the form.** No environment-variable UI ships, and no secret is injected anywhere,
production-shaped or not. The milestone's own instruction stands; what changes is
that the block is now a named piece of infrastructure that does not exist, not an
open question.

**Rejected: "non-production values only," enforced by UI copy.** A label is not a
control. Nothing stops a person from pasting a real key into a field that says not
to, and the sandbox cannot tell a test key from a production one by looking at it —
so the copy is a disclaimer, not a boundary.

**Rejected: scoping the sandbox's network to only the service the secret
belongs to.** Same shape as the allowlist rejection, with a firewall rule set per
run standing in for a domain list — it narrows the target and adds a mechanism that
itself needs trusting, rather than removing the target.

**What still leaks.**

- **The pre-warm snapshot's own build step.** Capturing dependencies for a
  repository still means some container, at some point, has both a registry route
  and that repository's install script running in it — the same trust this ADR
  already accepts for drafting itself ([ADR-0013](0013-the-environment-recipe.md)).
  This ADR does not shrink that window; it only refuses to add a secret to it.
- **Non-network secrets** — a session key, a feature flag, anything only ever read
  from `process.env` and never used to reach outward — do not have the exfiltration
  property this ADR is about, and could ship ahead of the snapshot extension as a
  narrower first cut. Named, not decided: M6e did not ask for that tier, and
  building one now would be scope this ADR was not asked to open.

**Revisit when** the agent-sandbox snapshot extension has a milestone of its own.

---

## Amendment (M10, 10k): storage ships; injection is still blocked

The route this ADR said had to close, closes. [ADR-0021](0021-the-sandbox-is-a-microvm-we-do-not-operate.md)
replaces the Docker bridge with a Firecracker microVM whose egress policy is
`deny-all` — enforced outside the guest, flipped on a running sandbox after `install`
and before the agent's first turn, and observed by a probe from the worker rather than
believed from the SDK. That is the "snapshot extension" this ADR was waiting for, in a
different shape: the sandbox does not lose its network at snapshot time, it loses it at
a moment we choose and then check.

So the block moves. **Storage ships now; injection does not.**

What this amendment decides:

- **Values are stored encrypted, keyed to the row they belong to.** AES-256-GCM under
  `PLANE_SECRETS_KEY`, additional data `repo\0name` for a repository secret and
  `user\0<github id>` for a person's model key. The AAD is the part worth arguing for:
  without it a ciphertext is portable, and anyone who can WRITE a row — a restored
  backup, a bad migration, an injection — can move a key from a repository they own onto
  one they do not and have the worker inject it there. Bound, that ciphertext decrypts
  nowhere else, and the failure is an exception rather than a wrong plaintext.
- **No route returns a value.** `GET` answers with names. There is no verb that reads one
  back, and `src/secrets.ts` exports exactly one reader per kind, reachable only from a
  runner route that authorizes against the `jobs` row.
- **A runner is handed what its run is entitled to, never what it names.** The repository
  comes from `jobs`, so a paired runner holding one run cannot ask for another's
  credentials. The same rule the token route already follows.
- **Injection stays behind `ENGINE_SECRETS_ENABLED`, unset everywhere.** The runner
  `/secrets` route answers 501 while it is unset — not an empty object, because a worker
  has to be able to tell "this repository has no secrets" from "this deployment does not
  hand them out". The flag flips in 10l, on the strength of a test that fakes a sandbox
  whose policy is `allow` and asserts nothing is injected and the run ends `errored`.
- **The model key is not gated by any of this.** It is what pays for the run, it is held
  in the worker, and it never enters a sandbox at all. Storing it is what the button
  needs to work, and it is the reason `PLANE_SECRETS_KEY` is required at boot on every
  plane rather than only on one that injects.

What this amendment does NOT decide, and says so rather than implying otherwise:

- **Rotation.** Every row records `key_id` so a second key is possible. A key accepted for
  reads while the first is retired, a re-seal pass, an operator procedure — none of that
  exists, and shipping half of it would be a mechanism that reads as rotation and is not.
- **What a secret under `deny-all` is actually good for.** It satisfies startup
  validation and a suite that reads `process.env`. It does not make a live third-party
  call, because there is no route out — that is the point. The UI has to say so, or
  somebody stores a real `STRIPE_SECRET_KEY` and files a bug about a timeout.
