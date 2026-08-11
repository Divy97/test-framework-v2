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
  not read for meaning, so a paraphrase of it fails — print it verbatim, on its own
  line, alongside whatever else you want to say. This is not bureaucracy: a failure
  for some unrelated reason is not a reproduction of this bug, and matching the
  reported symptom is how the engine tells the two apart.
- `files` lists **every** path the reproduction depends on that is not already part
  of the project: the test file you wrote, any helper it needs, and the manifest
  itself. At most 32 paths, 256KB of content in total. Each must be a regular file
  committed in this repository — not a directory, not a symlink.
- List only what the reproduction needs. The engine reads those bytes out of your
  commit and writes them over **both** the buggy commit and the eventual fix, so
  the same reproduction provably runs in both places. A path you list that is
  already tracked in the project is refused, because writing over it would
  overwrite the code under test.

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
