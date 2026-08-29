---
status: accepted
---

# A reproduction the repository already had

[ADR-0008's amendment](0008-the-reproduction-is-anchored.md) capped every
agent-authored reproduction at Tier 2, and the reasoning was exact: *"a
reproduction supplied by a caller is a fixed artifact; one authored by the agent is
a COMMAND the agent chose, and a command can test which commit it is standing on
rather than whether the bug is present."* Six versions of the sham-fix control were
defeated before that cap was accepted as the thing that withholds the claim.

There is a third case the cap does not describe, and milestone 7 named it: a
repository whose own suite is already failing on the reported behaviour **contains
the reproduction, authored by a maintainer**. Nothing about that test was shaped by
the report, by this run, or by the agent — it predates all three. Calling it Tier 2
because an agent pointed at it prices the pointing, not the evidence.

## Decision

Tier 1 is available when the reproduction is one the repository already had. Four
clauses, every one an observation the engine made rather than a claim anyone made,
and all four required:

1. **Nothing applied.** `applied` is empty: no bytes came out of the agent's commit.
2. **Every registered path was tracked at the base commit.** Recorded by `verify()`
   at registration as `REPRO_REGISTERED.committed`, from git, against the base tree.
3. **The command is the project's own test command**, optionally followed by `--`
   and the pinned paths themselves, and nothing else.
4. **There is a project test command to compare against** — a `SUITE_RUN` from this
   attempt. A repository with no recipe gets the cap, which is honest.

What is left for the agent is which existing test to point at. It did not write
that test, and it cannot rewrite it: every run re-hashes the pinned paths and the
fold refuses a divergence, so a fix that edits the test it is judged by is caught
rather than credited.

**Clause 2 is not "the file is in the tree".** A restored dependency is in the tree
— identical in both phases, anchoring perfectly, authored by nobody. Since 7e every
phase container is handed one. `committed` exists precisely so that being present
and being the repository's work cannot be confused, and `test/verify.test.ts` pins
the difference with a gitignored path that satisfies every other clause.

**Clause 3 is the whole reason a command check exists at all.** The strongest test
file in the world proves nothing if the command around it is
`… || git rev-parse HEAD | grep -q <sha>`. Requiring the project's own command,
narrowed only to the pinned paths, leaves the agent nothing to express.

## What this does not claim

**The runner is not anchored.** The test that ran is hashed on every run; the thing
that runs it — the script, the task definition, the config it reads — is not. A fix
that changes what `npm test` *does* would not be caught by hashing the file it ran.
This is not new with this decision: a caller-supplied `npm test` has always had the
same exposure. It is now stated in the score's own `unmeasured` list, where a
reviewer reads it, and the fix diff is the mitigation — a human sees `package.json`
in the changed files.

**The symptom rule still applies, and it is what usually decides this.** The gate
requires the base output to contain the reported string character for character
(ADR-0008). A maintainer's test that fails for exactly the right reason, in its own
words, is not credited — and `prompts/repro.md` tells the agent so plainly, because
the alternative is an agent contorting someone else's test to print our string,
which would make it the agent's test again. **This is a real ceiling on how often
this decision fires**, and the honest expectation is that the ordinary run stays
Tier 2.

**Provenance is priced as a tier, not as points.** A pinned reproduction already
scores 8 rather than 15 on the anchoring ground, because hashing detects tampering
where applying prevents it. Stronger provenance, weaker anchor: the score says both,
and adding points here would count one fact twice.

## Alternatives rejected

**Trusting the agent's account that the test predates it.** Testimony as a fact,
which is [ADR-0006](0006-testimony-vs-evidence.md)'s whole prohibition. Every clause
above is checkable, so nothing here needs to be believed.

**A heuristic on the command string** — refusing `npx --yes`, allowing anything that
looks like a test runner. The blocklist this project refuses on principle, and it
would have admitted the identity oracle in clause 3.

**Leaving the cap in place and only telling the agent to look.** It would have made
the engine ask for the strongest evidence available and then decline to credit it —
which is what the milestone meant by *"unreachable today"*.
