---
status: accepted
---

# Testimony vs evidence: the agent cannot write facts

The central question for any autonomous fixing system is: **how do you know
the agent isn't lying?** Agents under pressure misreport — claim tests pass,
summarize away failures, write tests that trivially fail-then-pass without
touching the reported bug. The answer cannot be "we asked it nicely."

**Decision.** Two event classes with different trust levels, mechanically
enforced by who can write them:

- **Testimony** — the agent's own account: transcript turns, tool-call
  narration, its claims about what it did. Captured by the Runner from Claude
  Code's structured output stream (`--output-format stream-json`), stored,
  displayed in the timeline — and **never trusted**. Testimony influences no
  verdict.
- **Evidence** — facts observed at the Runner's own process boundary: exit
  codes of commands the Runner itself executed, hashes of outputs it read,
  diffs it computed from the filesystem, git states it checked out. Evidence
  is the only input to verification and confidence.

Enforcement is structural, not behavioral:

- The **Runner is the sole event writer**. It runs as PID 1 in the sandbox;
  events leave through one narrow authenticated channel. The agent has no
  credential and no path to append events. If Claude Code wants to claim
  something, it is testimony by construction.
- The sandbox has **no egress** except the model API and the Runner's event
  channel.
- **Loose agent, strict judge.** No output schema is imposed on the agent —
  we don't trust its self-report, so we don't need to structure it. Rigidity
  lives where we own the pen: the event schema and the verification criteria.
- **Anti-gaming criteria** on the agent-authored reproduction: it must fail
  on base *with output matching the reported symptom*, pass on the fix,
  survive flake re-runs, and the fix diff must overlap the reproduction path.

  Exit-code-only gating is gameable; symptom-anchored gating is the judge's
  actual job.
- **Bounded attempts, honest exit.** `ATTEMPT_STARTED {n}`, max 3, each
  attempt fed the previous verification facts. After 3, the run ends
  `UNRESOLVED` with its full evidence trail and a structured report to the
  source thread. UNRESOLVED is a first-class state, not a hidden one.

The timeline renders testimony and evidence as visually distinct classes, so
the trust model is legible in the UI itself.

**Amended by [ADR-0008](0008-the-reproduction-is-anchored.md).** The fourth
anti-gaming criterion is retired: the reproduction is no longer part of the
commit, so "the fix diff overlaps the reproduction path" is unsatisfiable by
construction. It is replaced by anchoring the reproduction so both phases
provably run the same thing.

---

## Amendment — where the pen moved, and what a browser is (v1.5)

Two clauses above describe an arrangement v1.5 replaces. Both are amended in the
direction of the original decision rather than against it.

**"The Runner is the sole event writer. It runs as PID 1 in the sandbox."** The
sole writer is now the **host orchestrator**
([ADR-0011](0011-the-agent-loop-runs-outside-the-sandbox.md)). The sandbox worker
executes tool calls and returns results; it has no event channel at all, narrow or
otherwise. This is the same rule with less surface: previously the agent shared a
container with the process holding the only pen, and the argument for why it could
not reach it was uid separation plus a `--separate-git-dir` fix for a
`post-checkout` hook that had already defeated an earlier version. Now the pen is
on the other side of a boundary the agent cannot address.

**"The sandbox has no egress except the model API and the Runner's event
channel."** The sandbox has no egress to either. The model credential lives in
the loop on the host; the agent sandbox reaches a package registry and localhost
during setup ([ADR-0013](0013-the-environment-recipe.md)) and nothing else. The
phase containers reach nothing.

**A browser produces testimony.** v1.5 gives the agent a headless browser so it
can find bugs it cannot find by reading — a wrong string rendered on a page is
the canonical v1.5 bug. Screenshots, console logs and network traces are stored,
shown in the pull request, and are **inputs to no verdict**. What the engine
judges is still a committed command's exit code, run in a container with no
browser in it. The browser makes the agent better at its job and gives the judge
nothing new to trust, which is the only way this system can accept a new
capability.

**"Loose agent, strict judge" survives the move and needs restating.** Owning the
tool surface is a temptation to constrain the agent's output — typed tools, forced
schemas, validated arguments. Constrain the tools because we execute them; do not
constrain the agent's *reasoning or reporting* to make its self-report easier to
trust. We still do not trust it, so we still do not need it structured.

## Amended by ADR-0019 — whose process boundary

Everything above holds for a run on a machine we control, which is every run this engine
has executed. [ADR-0019](0019-who-writes-when-the-runner-is-not-ours.md) covers the
hosted path, where the Runner is a binary on hardware the user owns.

The split between testimony and evidence is unchanged there — the agent still cannot
write facts, and the Runner still observes at a process boundary. What changes is who
that boundary belongs to. The honest hosted form is *"this installation's runner
observed"*, evidence is never shown outside the installation that produced it, and the
day a public evidence link is proposed this amendment expires along with it.
