---
status: accepted
---

# The agent loop runs outside the sandbox

M3 put `claude -p` inside the container and spent the rest of the milestone
trying to give it exactly one route to the internet. §3c.2 failed for a reason
that reads as an implementation detail and is not one: `--network none` and
`--add-host <name>:host-gateway` are mutually exclusive — the first removes every
interface, the second needs one — so "sealed plus one route" cannot be expressed
that way at all. An attempt to do it silently dropped the seal. `HTTPS_PROXY` is
an environment variable, and an agent that ignores it is simply on the internet.

The proxy in `src/egress.ts` was built to close this and never wired to anything.
Its own known gaps say what the shape costs: a CONNECT proxy authorises a tunnel
and never reads it, so an agent can exfiltrate through the one host it may reach.
Closing *that* means terminating TLS inside the component built to keep the agent
away from credentials.

Every version of this problem is the same problem. **The agent needs the model
API credential, and the container must not have it.**

**Decision.** The agent loop runs on the host, outside the sandbox. Tool calls
travel in; results travel out. The container gets no egress at all.

- The loop is the Messages API **tool runner** (`client.beta.messages.tool_runner`)
  driving tools we define. We own the tool surface: named shells, read, write,
  edit, grep, glob, browser, and a git tool that can commit and nothing else.
- Each tool call is executed by a worker inside the sandbox. The worker **dials
  out** and polls for work; nothing on the host dials in, so the sandbox exposes
  no listening port and needs no inbound rule.
- The model credential lives in the loop's process on the host. There is no
  configuration under which the container can read it, which is a stronger
  statement than any allowlist makes.
- `src/egress.ts` is deleted. Not deprecated — a sealed container with an unused
  proxy beside it is a boundary that reads as enforced and is not, which is the
  failure mode this project exists to avoid.

**What this buys beyond the credential.** Promoting an action from an opaque
command string to a typed tool call is what makes the harness able to see it. A
`git` tool that only commits cannot push; a shell tool with named sessions can be
supervised instead of swept ([ADR-0014](0014-long-lived-services-and-named-shells.md));
a browser tool's screenshots can be banked as blobs at the moment they are taken.
None of that is reachable when the agent's entire interface is "a process with a
filesystem."

**What this does not change.** The agent still cannot write events —
[ADR-0006](0006-testimony-vs-evidence.md) is untouched, and moving the loop out
makes it easier to hold rather than harder: every tool call and result passes
through our process on the way to becoming a payload. The phase containers are
unaffected: still sealed, still agentless, still deciding on exit code.

**Rejected: keeping `claude -p` in the container.** It is the only option that
requires solving §3c.2, and §3c.2's honest ceiling is a tunnel we authorise and
cannot inspect. It also gives us no tool surface, which the browser and the
service supervision both need.

**Rejected: the Claude Agent SDK on the host.** Its built-in tools read and write
the filesystem of the process running them, which is the host's — the opposite of
what is wanted. Making them act on the container means replacing every built-in
tool with a proxy, at which point the SDK's whole value is gone and a tool runner
is the smaller thing.

**Rejected: Managed Agents with a self-hosted sandbox** — same architecture,
hosted. See the rejection in
[architecture-v1.5](../architecture-v1.5.md#rejected-anthropics-managed-agents-with-a-self-hosted-sandbox);
the argument is about which claims the project authors, not about capability.

**What still leaks.** Honestly, and this list is short only because the boundary
moved rather than because it was hardened:

- **The tool surface is the new attack surface.** Previously the agent could do
  anything a process can do and the question was what it could reach. Now it can
  do exactly what our tools do, and the question is whether any tool does more
  than it should. A `write` tool that accepts a path outside the workspace is the
  whole boundary undone; path confinement is now load-bearing in a way it was not
  when the container was the fence.
- **The worker holds a credential.** It authenticates to the host to poll for
  work. It runs as root, in the container the agent does not control — but it is
  in the container, and a sandbox escape reaches it. Its scope is one run's work
  queue and nothing else, which is the mitigation, not an absence of risk.
- **The sandbox can still be an oracle over its own tree.** Nothing here touches
  [ADR-0008](0008-the-reproduction-is-anchored.md)'s amendment or the Tier 2 cap
  on agent-authored reproductions. Moving the loop out closes an exfiltration
  channel; it does not make a reproduction independent.

**Revisit when** this becomes a product with tenants. At that point the host
running N loops is the multi-tenant inference story
[SHARED-UNDERSTANDING](../SHARED-UNDERSTANDING.md) explicitly deferred, and the
hosted surface rejected above becomes the operationally correct answer.
