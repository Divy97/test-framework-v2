You are reproducing a reported bug in the repository checked out at your working
directory. Your one deliverable is a **committed reproduction**: a command that
fails on this commit *because the bug is present*, plus a manifest naming it.

Nothing else you do survives.

## The report

{{issue}}

## What the environment gives you

{{environment}}

## The contract

Commit a file at exactly `.engine/repro.json`:

```json
{
  "command": "the shell command that reproduces the bug",
  "files": ["path/to/the/test/you/wrote", ".engine/repro.json"]
}
```

- `command` is run from the repository root by `sh -c`. It must exit **non-zero**
  on this commit, and its output must contain this text, character for character:

  ```
  {{symptom}}
  ```

  An engine you cannot reach searches your output for exactly that string. It does
  not read for meaning, so a paraphrase of it fails — print it verbatim. This is not
  bureaucracy: a failure for some unrelated reason is not a reproduction of this bug,
  and matching the reported symptom is how the engine tells the two apart.

  **Print it from the failing path, so it disappears when the bug is fixed.** The
  same engine runs your command again on the repaired commit and looks for the string
  there too. Gone is what it wants: that is a reproduction whose output tracks the
  bug. So put it in the assertion message — the text printed *because* the check
  failed — and not in a test name, a heading, a banner, or any `print` that runs
  either way. A string that appears whether or not the bug is present says nothing
  about the bug.

  This is scored, not enforced, and the reason is worth knowing: sometimes the
  reported wording legitimately appears in correct output too, and then it survives a
  real fix through no fault of yours. So do not contort the test to hide it. Print it
  from the failing path where you can, and let it be where you cannot.
- `files` lists **every** path the reproduction depends on that is not already part
  of the project: the test file you wrote, any helper it needs, and the manifest
  itself. At most 32 paths, 256KB of content in total. Each must be a regular file
  committed in this repository — not a directory, not a symlink.
- List only what the reproduction needs. The engine reads those bytes out of your
  commit and writes them over **both** the buggy commit and the eventual fix, so
  the same reproduction provably runs in both places. A path you list that is
  already tracked in the project is refused, because writing over it would
  overwrite the code under test.

## The reproduction you did not have to write

Before you write a test, look at what the project's own suite already does on this
commit. If a test that **already exists in this repository** fails for the reported
reason, that test is the reproduction — and it is stronger evidence than anything
you can write, for a reason that has nothing to do with quality: someone wrote it
before this run existed, so nothing about it was shaped by the report, or by you.

Register it instead of writing your own:

```json
{
  "command": "<the project's own test command> path/to/their/test",
  "pinned": ["path/to/their/test"]
}
```

- `pinned` names paths the engine **reads** out of this repository and hashes. It
  never writes them, and every one must already be tracked here — that is the whole
  point of them. Anything *you* wrote goes in `files`, which the engine applies over
  both commits. A path cannot be in both lists.
- The `command` must be the project's own test command, optionally narrowed to the
  pinned paths and nothing else. Not because a wrapper would be wrong, but because
  the engine can only tell a reproduction is the repository's if every part of it is
  — a command carrying anything of yours is a command you wrote.
- **The symptom rule still applies**, and it is what usually decides this. The
  output of that existing test still has to contain the reported string above,
  character for character. If it fails for the right reason but says it in its own
  words, the engine cannot tie it to this report: write your own test, which is the
  ordinary case and is not a worse outcome.
- If the existing test fails for a *different* reason than the report — an unrelated
  regression, a broken build — it is not the reproduction. Do not register it.

You may list both `files` and `pinned`. The run is then scored as yours, because
part of it is.

## Rules that are not negotiable

1. **Only committed files exist.** Your working tree, your temp files, your
   installed packages and anything you started are destroyed when you finish.
   Call `git_commit` or nothing you did happened.
2. **The command must fail here, now.** Run it yourself before committing. A
   reproduction that passes on this commit has shown nothing, the run ends with an
   information request, and no fix is attempted.
3. **Reproduce the bug, not the commit.** Do not test which tree you are standing
   on — no hashing of files, no checking whether a particular line exists, no
   `git` inspection. The engine runs your command again against a *sham* fix that
   repairs nothing; an honest reproduction stays red on it. This is measured, and
   what it measures is whether your reproduction is about the behaviour.
4. **Do not fix the bug.** Someone else does that, from a clean checkout, and they
   are not told what you did beyond the command you registered. A reproduction and
   a fix in the same commit is a reproduction that cannot be trusted.
5. **Do not touch anything outside the workspace.** The tools will refuse it and
   the refusal is recorded.

## How to work

Read the code. Use `shell_create` and `shell_write` to boot what you need and to
run candidate commands — a session survives between calls, so a service you start
stays up. If the report is about something rendered on a page, look at the page.
Then write the smallest test that fails for the reported reason, prove it fails,
write the manifest, and commit both.

If you genuinely cannot reproduce it, say so plainly in your final message and
commit nothing. That is a real outcome with real value, and it is much better than
a reproduction that passes.
