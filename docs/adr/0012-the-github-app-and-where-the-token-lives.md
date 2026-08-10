---
status: accepted
---

# The GitHub App, and where the token lives

v1.5 needs three things from GitHub: the issue that starts a run, the repository
to clone, and somewhere to put the pull request. All three are the same
integration, so the only real question is what credential carries them and which
process holds it.

**Decision.** A GitHub App, and the token never enters the sandbox.

The App is registered once with `contents: read and write` and `pull_requests:
write`, and nothing else. On install, GitHub calls our setup URL with an
installation ID, which we store. From the App's private key we mint a JWT, and
from the JWT a **1-hour installation token** scoped to the specific repositories
of that installation.

That short-lived token is what any git operation uses, and it is held by the
**host orchestrator only**:

- The host clones the repository and mounts it into the sandbox read-only
  (M3.1's decision, unchanged).
- The host pushes the branch and opens the pull request, after the fix phase has
  passed.
- The agent's only outbound artifact is a commit, exactly as
  [ADR-0010](0010-the-environment-is-part-of-the-evidence.md) already requires.

So there is no step in the design where a credential and the agent are in the
same process, and none where one is in the same container. This is the same
argument as [ADR-0011](0011-the-agent-loop-runs-outside-the-sandbox.md) applied to
a second secret, and it lands the same way: not an allowlist, an absence.

**Rejected: a personal access token.** It is one form field and it is wrong twice.
A PAT carries its owner's full access for as long as it lives, so a token issued
to read one repository can read every repository that person can — the blast
radius of a leak is a person, not a project. And it dies when its owner leaves the
organisation, taking every run with it, which converts a routine offboarding into
an outage.

**Rejected: passing the installation token into the sandbox so the agent can push
its own branch.** This is what the shape invites, and it is the whole point of the
decision above to refuse it. An agent that can push can also force-push, open a
pull request the engine never verified, or read every other repository in the
installation's scope. The verdict this system issues is worth exactly what the
separation between the party under judgement and the party with the write
credential is worth.

**Rejected: a webhook signature as the only authentication.** It is necessary and
kept — the receiver verifies the HMAC and rejects anything else — but a signature
proves a payload came from GitHub, not that the sender is entitled to a run
against that repository. The installation ID is what authorises; the signature is
what authenticates.

**What still leaks.**

- **We hold the App private key.** It mints tokens for every installation. It is
  the one secret whose compromise is total, and nothing in this design reduces
  that — it moves the risk from many long-lived per-user tokens to one key we can
  actually protect and rotate, which is a better trade and not a solved problem.
- **A one-hour token outlives a short run and not a long one.** A run that
  exceeds an hour needs a refresh mid-flight, so the mint is a function called
  when needed rather than a value captured at the start.
- **`pull_requests: write` is enough to open a PR against any branch in scope.**
  We only ever push to a branch we created and open against the default branch,
  but that is our code's discipline rather than a permission boundary. GitHub does
  not offer a finer grain here.
- **The issue body is attacker-influenced text that reaches the agent's prompt.**
  Anyone who can open an issue on the repository can write it. This is prompt
  injection with a real vector, and the mitigation is structural rather than
  textual: the agent has no credential to leak, no network to reach, and no path
  to append an event, so the worst an injected instruction achieves is a bad
  reproduction or a bad fix — both of which the phase containers judge on exit
  code without consulting anything the agent said.

**Revisit when** a second connector lands. Slack has no repository in its payload,
so intake will need to resolve one, and that resolution is authorisation logic
this ADR does not cover.
