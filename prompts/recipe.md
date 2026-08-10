You are drafting an **environment recipe** for the repository checked out at your
working directory: the commands that stand this project up so a bug can be
reproduced in it. This happens once per repository. Every later run replays what you
write here verbatim and never re-derives it.

A human will read your draft before it is stored. Write it for them.

## What the environment gives you

{{environment}}

## The contract

Commit nothing. Your one deliverable is a JSON object, in a fenced block, as the
last thing in your final message:

```json
{
  "install": "the command that installs dependencies, or omit it",
  "migrate": "the command that creates the schema, or omit it",
  "seed": "the command that loads data the app needs to be usable, or omit it",
  "services": [
    {
      "name": "web",
      "command": "the command that starts this service in the foreground",
      "port": 8080,
      "healthcheck": "http://127.0.0.1:8080/some-path-that-returns-200"
    }
  ],
  "test": "the project's own test command, or omit it"
}
```

- `install`, `migrate`, `seed` and `test` run from the repository root, in order,
  each in a shell. Omit any that this project does not have — an invented step that
  fails is worse than a missing one.
- Each `name` must be lowercase letters, digits, `-` and `_`, starting with a letter.
  It becomes a shell session id, so two services cannot share one.
- Each `command` must start the service in the **foreground**. Do not background it
  yourself and do not add `&`; the harness owns that, and a command that exits
  immediately looks exactly like a service that crashed.
- `port` is the port that service listens on. `healthcheck` is a URL that returns a
  2xx once it is genuinely ready to serve — not just once the process has started.
  A healthcheck that answers before the app can serve a request is worse than none,
  because it turns a boot failure into a confusing reproduction failure.

## How to work

Read the project. `package.json` scripts, a Makefile, a `docker-compose.yml`, a
README's setup section and a CI workflow are the five places that usually say how
this repository actually boots — a CI workflow especially, because it has to work.

Then **run what you propose** and prove it. Use `shell_create` and `shell_write`:
sessions stay alive between calls, so start a service in one session and check its
healthcheck from another. A recipe you have not executed is a guess, and a guess
here is expensive in a specific way — a run that fails to boot reports that our
infrastructure could not stand up the project, on the user's issue, and no fix is
attempted.

State clearly in your final message:

1. What you ran, and what you saw.
2. Anything you could not verify, and why. If a service needs something this
   environment cannot provide — an external API, a paid dependency, a database
   version that is not here — say so plainly instead of writing a command that will
   fail later. That is a useful answer, not a failure.
3. Then the JSON block, last.
